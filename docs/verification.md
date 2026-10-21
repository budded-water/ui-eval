# Feature verification workflow

Use this workflow to connect a candidate Web project's user features to reviewed
UI Eval scenarios and external checks. It reuses the existing CLI and report
contracts. No feature-map loader, automatic scenario generator or model-based
acceptance is implemented.

The checkout includes [ui-eval-verify](../skills/ui-eval-verify/SKILL.md), a small
agent skill for this workflow. Point an agent at that file, for example:

```text
Read skills/ui-eval-verify/SKILL.md in this engine checkout. Verify the declared
home journey in examples/basic-web and report the evidence and coverage gaps.
```

The skill lives in source under `skills/`; it is not automatically installed or
registered in another agent runtime. It works through separately authorized
checkout invocation, without a pstack dependency or a package-install promise.

## Map features to executable proof

Maintain an optional `ui-eval/feature-map.md` in the candidate repository. Use
one row per user journey, starting with the features in the requested scope.
The map points to existing definitions; it does not copy selectors, expected
values, thresholds, reference images or execution-profile configuration.

| User journey | Preconditions and entry | Executable proof | Coverage gaps |
| --- | --- | --- | --- |
| Name the behavior a user needs | State the required data/auth and UI entry point | Link scenario file and assertion/checkpoint IDs; link suite and check ID when external state matters | List missing paths, states or side-effect assertions |

For a save operation, exercise the real form and assert the resulting state.
If persistence matters, reload and assert the saved value, or run a reviewed
candidate-owned check against the resulting test data. A success toast or final
screenshot alone does not prove persistence. Unsupported proof remains a gap.

The [Basic Web feature map](../examples/basic-web/ui-eval/feature-map.md) is a
small concrete example. It references the existing smoke and explicitly lists
what that smoke does not prove.

### Authority and maintenance

- Scenario/policy/suite configuration is canonical for executable assertions,
  mandatory scope and acceptance. UI Eval seals those inputs for each run.
- The map is a human/agent review aid. The engine neither reads it nor turns its
  rows into coverage, report fields or acceptance decisions.
- Reports are canonical for what actually ran. A row with no matching run and
  assertion evidence remains unverified, regardless of the map's prose.

When a journey changes, inspect the live implementation and configuration,
update the executable proof and its map references together, then rerun it.
When the map and config disagree, report the drift; a stale map does not
authorize changing a policy or weakening acceptance. Keep run outcomes in
generated reports rather than a mutable "passed" column in the map.

## Discover before authoring

Choose the target platform first. An iOS request uses `native-pilot doctor` and
a native integration suite, rather than starting Web as a prerequisite. See
[native recovery](integration-runner.md#bounded-native-recovery) and the
[separate human review record](native-pilot.md#preflight-gestures-and-human-review).
Fix the required suite and remaining human observations before starting. When a
driver is blocked, report its recovery action and remaining item without adding
new acceptance scope or repeating already valid work.

Resolve the engine checkout and candidate Git root. Read the candidate's
existing startup, test harness, `ui-eval/project.json`, scenarios and suites.
Prefer the candidate's actual user paths and stable semantic locators. Keep
business-specific setup and configuration in the candidate, outside engine
modules.

For new inputs, follow [Project Integration](integration.md), including review
of `init` output before execution. Drafting configurations is not evidence that
their paths work. Run each claimed journey; if only one path has run, leave the
others explicitly unverified. Do not infer complete acceptance from a smoke.

## Run the declared path

Run commands from the engine checkout. Replace the candidate path and IDs with
the reviewed project's values. These are source-checkout commands, not a
registry installation workflow.

```bash
bun run ui-eval doctor --project-root /absolute/path/to/candidate --format json
bun run ui-eval evaluate <scenario-id> --project-root /absolute/path/to/candidate --format json
```

Doctor checks prerequisites, browser launch and server ownership/readiness
configuration; it does not start the candidate server or prove the user path.
It may create the artifact directory. Inspect warnings and failed checks before
driving the app. Evaluation owns the local server it starts and performs bounded
cleanup; reused servers remain owned by their original caller.

When setup and external checks are part of acceptance, use an existing reviewed
[integration suite](integration-runner.md):

```bash
bun run ui-eval integrate <suite-id> --project-root /absolute/path/to/candidate --format json
```

An integration suite pins the engine revision and requires a clean engine
checkout. Finish and pin the intended revision before using it for integration.
`doctor` and `evaluate` accept `--browser-channel` and `--execution-profile`;
use consistent selections for those direct commands. `integrate` accepts only
the suite ID/path, `--project-root` and `--format`. Its browser and execution
profile are configured in the reviewed suite, not forwarded as CLI flags, and
a suite's pinned profile cannot be replaced. A remote run requires reviewed deployment
identities, and a failed identity check does not authorize local repair or a
fallback target. See [Execution profiles](execution-profiles.md).

Use the [bounded Agent loop](agent.md) for an explicitly configured Agent suite.
Retain its mandatory floor and add only declared optional scenarios. Repair is
a separate authorized action; the verification skill does not enable it.

## Inspect and hand off evidence

Capture the process exit and parse stdout even for failure/review outcomes.
JSON mode emits one payload on stdout; progress is on stderr. Do not discard
the result because a shell command returned nonzero.

For `evaluate`, inspect every entry in `runs`, its `executionOutcome`,
`rawStatus`, report gates, capability coverage and evidence references. Read
canonical `report.json` via `reportPath` and open the derived HTML via
`htmlPath`. Confirm that assertions for the mapped journey actually executed
and that required checkpoint evidence exists. Image capture alone is not
visual equivalence or design conformance.

For `integrate` and terminal Agent results, read both `summary.json` and
`summary.html` using the paths returned by the command. Follow the detailed
reports; successful browser evidence cannot cover a failed external check.
HTML is a reading view of canonical JSON and does not change acceptance.

Web evaluation/integration exit codes distinguish pass (`0`), candidate failure
(`1`), infrastructure/invalid/inconclusive (`2`), and human review (`3`). Agent
terminal results use `0` for accepted and `1` for other terminal states; inspect
the summary reason. Pre-terminal exceptions use `2`, and signals retain
`130`/`143`. See [README result semantics](../README.md#result-and-exit-semantics).

The handoff names the requested features, actual selected scope/profile,
command and outcome, source/run identity from the generated records, JSON/HTML
paths, and remaining gaps. Keep evidence after cleanup, under the candidate's
ignored generated directory. Do not commit screenshots, traces or `.ui-eval/`
output, or share sensitive artifacts without authorization.

## Boundaries

This workflow covers the current Web pipeline. Experimental native/WeChat
pilots have separate contracts and limitations. It adds no protected baseline,
holdout isolation, automatic feature coverage, or calibrated quality score.
See [Current limitations](limitations.md) before treating a result as a release
gate.
