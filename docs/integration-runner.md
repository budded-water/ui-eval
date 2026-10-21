# Integration acceptance runner

`ui-eval integrate <suite>` verifies the executing engine pin, prepares a candidate
once, runs required Web, experimental WeChat or iOS Simulator scenarios and external checks,
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
Their runtime/network/design/real-device gaps stay explicit. `native-pilot`
suites use the [iOS Simulator pilot](native-pilot.md) and require an explicit
`--device <uuid>` (or library `deviceId`). Device selection is invocation input,
not a persisted suite UUID. Other adapters reject that option. Native suites
reject Web-only options and `driver`; they retain the pilot's existing report
and scope, including the lack of installed-binary/Metro attestation.

## Native suite sessions

A native suite can declare an optional `session` with trusted `command`, `args`,
`startupTimeoutMs` and `cleanupTimeoutMs`. The schema bounds startup to five
minutes and cleanup to one minute. The session is one owned long-lived process,
started after prepare and stopped after checks in a cleanup `finally`, including
cancellation. It can own candidate-specific Metro, fixtures and App readiness.
The engine does not import those implementations or inject business environment
keys. A suite without a session relies on an externally prepared simulator/App.

The stdio protocol is `uieval.io/integration-session-v1`; generated
[`start`](../schemas/integration-session-start.schema.json),
[`ready`](../schemas/integration-session-ready.schema.json),
[`stop`](../schemas/integration-session-stop.schema.json) and
[`stopped`](../schemas/integration-session-stopped.schema.json) schemas are
canonical. Engine stdin supplies a start context with an opaque `sessionId`,
execution/project/suite identity, integration directory and selected device.
The session replies with one matching `ready` JSON line. On the matching `stop`
request it cleans resources, replies with matching `stopped` and status `pass`
or `inconclusive`, then exits. Stdout is exclusively bounded protocol JSON;
raw stderr is bounded and withheld. A session cannot inject arbitrary engine
environment or change mandatory scenarios.

Pass requires a successful stopped acknowledgement, exit zero and settled owned
process cleanup. Forced termination alone does not establish App cleanup or
fixture acceptance. Unexpected session death interrupts active evaluation.
Children must remain in the owned process group; deliberately escaped processes
need external OS isolation. Cleanup uses a fresh bounded budget after abort;
the `integrate` CLI allows up to 90 seconds for overall signal cleanup before
forcing the conventional signal exit. A second signal still forces exit.

The native order is engine/source checks → prepare → session start → before
checks → scenarios → after checks → session stop → evidence/source/engine
verification. Unsettled driver cleanup prevents later ordinary commands while
still attempting session teardown. Candidate session acknowledgements are
trusted assertions, not a security sandbox or independent device attestation.

```sh
node /path/to/engine/dist/cli.js integrate smoke --project-root /path/to/candidate --device <uuid> --format json
```

## Results and migration

### Bounded native recovery

Native suites may opt into `recovery: {maxAttempts, context}` where maxAttempts
is 1–3 and context is a trusted read-only argv command. It receives JSON stdin
with `apiVersion: uieval.io/native-recovery-v1`, `projectId` and selected `deviceId`.
It must return exactly one `sha256:` digest of the relevant installed App,
fixture/account/backend state; raw stdout/stderr are not retained in summaries.
This is a candidate-owned assertion, not independent App or backend attestation.
Do not enable reuse when the candidate cannot account for external state changes.

Only scenarios explicitly declaring `replaySafe: true` may retry. A returned,
validated inconclusive native report can retry within that finite budget after
source/context rechecks. Product assertion failures, thrown prerequisites,
deadlines, cancellation and incomplete cleanup do not authorize an interaction
retry. Every attempt retains its original report and appears in JSON/HTML;
successful earlier scenarios are not rerun within the invocation.

```sh
node /path/to/engine/dist/cli.js integrate smoke --project-root /path/to/app \
  --device SELECTED-UUID --resume PREVIOUS-EXECUTION --format json
```

Resume requires exact source, suite, engine, device and context identity plus
both previous report projections and settled cleanup. Passed replay-safe stages
are reused only after revalidating original inputs, flow, command metadata and
both PNG copies. Invalid or changed evidence blocks instead of silently rerunning
and hiding the discrepancy. Other scenarios execute normally. Preparation,
session startup/teardown, external checks and final source/engine/evidence/state
checks always run. A changed fixture or binary requires a fresh invocation.
Report `resumedFrom`, stage `reusedFrom`, `attempts` and `recoveryContextDigest`
make provenance explicit. Reused evidence remains a historical observation under
the declared state witness; it is not a new live screenshot or human review.

The sealed suite fixes this run's completion boundary. New optional checks belong
in a reviewed future suite revision, not an unbounded continuation of this run.
Simulation, human visual review, store upload/processing and physical-device
launch are separate outcomes. An integration pass closes only its declared scope.

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
Native evidence also binds the exact device, App ID, pinned Maestro, compiled
flow and source; it rechecks command metadata and both driver/output PNG copies.
An additional evidence digest detects changes to those underlying bytes after
checks. It does not retroactively attest driver exit from disk: the first
evaluation and its returned canonical report remain part of the trust boundary.
Native summaries record `deviceId`; newly produced summaries include observed
`source` together with its canonical `sourceDigest`. These are additive alpha
contract fields; old Web/WeChat records without `source` remain valid. Native
support requires the matching reviewed engine pin, not a schema-only upgrade.

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
