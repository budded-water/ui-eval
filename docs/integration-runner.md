# Integration acceptance runner

`ui-eval integrate <suite>` verifies the executing engine pin, prepares a candidate
once, runs required Web or experimental WeChat scenarios and external checks,
and publishes complete acceptance JSON/HTML. It does not repair source. Existing
`evaluate`, `agent` and project wrappers retain their behavior.

## Engine source pin

Candidate `ui-eval/engine.json` follows
[`engine-pin.schema.json`](../schemas/engine-pin.schema.json): an authorized HTTPS
repository and exact full Git revision, plus optional `bunVersion` matching the
engine's declared package manager. The latter is installation metadata, not proof
of the executing Bun version. The runner locates its own source checkout, checks
its Git root, `origin`, package repository, revision and clean source before and
after execution. It never clones, installs, upgrades or follows latest main.
Use the reviewed clean checkout with locked dependencies and installed browser.
These checks do not attest ignored build output or installed dependency contents.

## Suite and command context

Suites live at `ui-eval/integrations/<id>.json`; explicit project-contained JSON
paths also work. Inputs are bounded regular files without symlink ancestors.
[`integration-suite.schema.json`](../schemas/integration-suite.schema.json)
defines the authoring contract:

```json
{
  "apiVersion": "uieval.io/integration-v1alpha1",
  "kind": "IntegrationSuite",
  "id": "smoke",
  "projectId": "example-web",
  "adapter": "web",
  "prepare": { "command": "node", "args": ["prepare.mjs"], "timeoutMs": 120000 },
  "checks": [{
    "id": "api-contract", "phase": "after", "dimension": "api-data",
    "failureOutcome": "candidate",
    "command": "node", "args": ["check-requests.mjs"], "timeoutMs": 30000
  }],
  "scenarios": [{ "id": "home", "timeoutMs": 120000 }]
}
```

Trusted argv commands execute in the candidate root without a shell. Each receives
JSON on stdin containing `apiVersion`, `projectId`, `integrationDirectory`,
`suiteDigest` and current `stages`. After checks can read project-relative report
paths from scenario stages. Retained stdout/stderr are bounded and withheld from
summaries. Checks implement their own business assertions. Nonzero exits use the
declared candidate/infrastructure classification; spawn failures, deadlines and
missing exit codes are always infrastructure failures.

## Preparation and mandatory scope

Order is engine/source verification, prepare, before checks, scenarios, after
checks, and final evidence/source/engine verification. Every scenario/check is mandatory;
CLI options cannot remove scope or replace the profile. Candidate check failures
do not skip the remaining floor. Infrastructure failures stop new scenarios;
after checks can gather additional results only when cleanup settled. Incomplete
owned cleanup stops all further commands.

Move compilation from server launchers into prepare, then serve its generated
output. Prepare runs once across this invocation's scenarios and variants.
Variant server/browser isolation remains unchanged. There is no cross-run cache.
Generated outputs must be ignored by Git; source/configuration changes caused by
prepare, checks or concurrent edits invalidate acceptance. Timings cover prepare,
each check/scenario and verification. Scenario timing combines capture, evaluation
and report validation, not separately measured subphases.

Web suites may declare `executionProfile`, `browserChannel`, scenario `policy`
and `reference`. Raw visual review stays `needs-review`; this command does not
apply Agent visual ceilings or waive review. Remote deployment/fixture rules
remain enforced. WeChat suites may declare `driver`, but reject Web-only options.
Their runtime/network/design/real-device gaps stay explicit. Native iOS is not
registered by the integration runner and is rejected rather than emulated. The
separate [iOS Simulator pilot](native-pilot.md) has its own execution/report path.

## Results and migration

`.ui-eval/integration/<execution-id>/` contains sealed `suite.json`, canonical
`summary.json` and default human `summary.html`. HTML derives from the validated
record and publishes before terminal JSON; failure to write either fails the
command. Original adapter reports remain unchanged. Web aggregation requires all
compiled variants, matching source/scenario identity, canonical JSON and regular
HTML, plus matching capture, manifest, evaluation plan, policy and verified CAS
objects. Verification references existing sealed inputs without recreating missing
artifacts. Original report digests and underlying evidence are rechecked after
external checks. Modified, missing or corrupt evidence cannot substantiate
completion. WeChat passes also require declared steps/assertions and digest-verified
PNGs. Empty, foreign, contradictory or incomplete evidence cannot pass.

Exit codes are `0` pass, `1` candidate failure, `2` configuration/infrastructure/
inconclusive scope, and `3` review. Infrastructure and unexecuted mandatory stages
take precedence. SIGINT/SIGTERM retain `130`/`143`: initialized runs attempt both
interrupted summaries before propagating. Forced termination or unwritable
storage can prevent publication and never proves completion. Scenario deadlines
wait bounded cleanup grace; a late success after a deadline cannot pass.

```sh
node /path/to/engine/dist/cli.js integrate smoke --project-root /path/to/candidate
node /path/to/engine/dist/cli.js integrate smoke --project-root /path/to/candidate --format json
```

JSON mode emits one payload and progress goes to stderr. Invalid inputs before
run initialization produce a structured CLI error, without claiming a run report.

Migrate wrappers explicitly: retain candidate-owned fixtures/auth/proxies and
business assertions; replace duplicated pin checks, result aggregation and
acceptance reporting. Move builds into prepare and request checks into after
checks, using stdin context to locate run artifacts. Do not import candidate code
into the engine or weaken runtime gates. Review engine upgrades, update the pin
and rerun the declared suite plus required project checks.

Two ledgers remain explicit: candidate pins own expected engine source and the
checkout owns actual source. Divergence blocks acceptance. Adapter reports own
observations; the integration suite/result owns added acceptance conditions.

The [prepared Web example](../examples/prepared-web/README.md) uses no framework
dependencies. `bun run verify:integration` checks its built CLI in an independent
temporary Git candidate with two variants and injected after-check failure. It
requires clean engine source, a current build and Chromium, and is additional to
the non-browser `check` command.
