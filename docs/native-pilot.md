# Experimental native evidence pilot

## Preflight, gestures and human review

Doctor checks writable candidate storage and requires 1 GiB free by default,
before any Maestro command. A reviewed `minimumFreeBytes` project override may
select 64 MiB–64 GiB. `NATIVE_DISK_LOW`, driver/version and unavailable-device
errors include a recovery action; doctor never deletes files, resets an App,
boots a simulator or logs in. Maestro does not depend on a visible Device Hub
window. App readiness, picker availability and backend access require their own
candidate assertions; a doctor pass does not establish those states.

`drag` accepts integer percentage `start`/`end` points (`x`, `y`, 0–100) and
`durationMs` (400–2000). Equal points are rejected, and the next step must assert
an observable outcome. It compiles to Maestro's point-to-point swipe and binds
the exact pinned command metadata. Driver completion is not a geometry check.
Movement/resize requires an actual changed-state assertion or separate human
review; neither a screenshot nor an unchanged visible control proves movement.

Optional project `reviews` declare a fixed list of `{id, scenarioId,
checkpointId, criterion}`. Scenario/checkpoint references are validated.
After inspecting complete native evidence, an operator can record a bounded,
synthetic-data observation with a local reviewer alias:

```sh
bun run ui-eval native-pilot review --project-root /path/to/app \
  --report .ui-eval/native-runs/EXECUTION/report.json --review header-legibility \
  --decision pass --reviewer owner --note 'Controls remain readable at this checkpoint'
```

This creates new `review.json`/`review.html` under `.ui-eval/native-reviews/`,
bound to current source and verified original report/PNG digests. Method is
explicitly `human-observation`; reviewer identity is self-reported, not authenticated.
Missing, changed, failed or inconclusive evidence cannot be waived. Neither the
original automatic report nor its status changes. No observation is generated
automatically, and missing reviews remain pending in the candidate's handoff.
Notes and screenshots are private local artifacts, not safe-to-publish by default.

See [integration recovery](integration-runner.md#bounded-native-recovery) for
limited retry and cross-invocation evidence reuse.

`native-pilot` is an additive iOS Simulator experiment. It does not extend Web
`evaluate`, Agent suites, Web policies or generic native forward contracts.
Its separate `uieval.io/native-pilot-v1` result assesses declared interactions and
screenshot completeness. It is not a release or design-conformance gate.
The [integration runner](integration-runner.md) can aggregate these original
reports in a mandatory native suite with candidate-owned session startup and
cleanup. Standalone doctor/evaluate commands retain their behavior.

## Inputs and execution

Candidate repositories own `ui-eval/native.json` and referenced scenario JSON.
TypeBox sources in `src/native-pilot/config.ts` and generated
`schemas/native-pilot-{project,scenario}.schema.json` define these inputs.
Only Maestro **2.9.0** command evidence is currently supported. Prerequisites are
macOS, Xcode, an explicitly selected booted iOS Simulator and an installed app.
The native adapter does not install/reset apps, boot devices, start Metro, supply
credentials or isolate backend calls. Reviewed integration prepare/session
commands may perform candidate setup; those commands own that behavior.

```sh
bun run ui-eval native-pilot doctor --project-root /path/to/app --device <uuid>
bun run ui-eval native-pilot evaluate guest-home --project-root /path/to/app --device <uuid> --format json
```

Steps support tap, bounded point-to-point `drag`, literal `input-text` (1–512 characters without line breaks or
expression templates), bounded `erase-text` (1–512 characters),
and a single `swipe` in UP/DOWN/LEFT/RIGHT at a fixed 400 ms duration, optionally
starting from an ID/text selector, plus visible/hidden assertions and screenshots.
Input targets the currently focused field; candidate scenarios must focus it first
and assert the resulting state afterward. Gestures and text entry are interactions,
not assertions. Swipes do not certify geometry or successful scrolling. Selectors
are Maestro ID/text regular expressions. Expression templates, scripts, text
substitution and arbitrary driver commands are rejected. Use only synthetic text:
literal input is persisted in scenario plans and raw command evidence without
redaction. Do not place real credentials or personal data in scenario files.
Keyboard dismissal remains candidate-owned: use the App's explicit dismissal
control or supported outside tap. Generic driver keyboard dismissal can fail on
iOS numeric inputs and is not an authored action. Inspect keyboard screenshots.
Every screenshot must
immediately follow an assertion. Generated flows stop/relaunch the app without
clearing its state by default. An explicit project `restartApp: false` reuses an
already running App instead; candidate setup then owns startup readiness and
navigation state. The observed launch command must match this declared policy.
Use a dedicated simulator and synthetic data in either mode.

The adapter binds device, app, scenario, selectors, command order and checkpoint
identities to evaluated command metadata. Pass requires exit 0, every required
non-optional command completed, and every PNG passing encoded-size/dimension
budgets and CRC-checked decoding. Exit 1 plus a bound failed visibility assertion
with matching Maestro 2.9.0 assertion-mismatch message/debug diagnostics reports
failed interaction. Missing/unknown diagnostics or infrastructure errors during
an assertion remain inconclusive; other driver failures, timeouts, incomplete or invalid
evidence are inconclusive. Source identity is checked before/after capture;
source changes invalidate acceptance.

## Reports and limits

Each run writes `.ui-eval/native-runs/<execution-id>/report.json` and `report.html`.
The result schema is `schemas/native-pilot-result.schema.json`; HTML derives from
that validated record. Both must be written for command success. `plan.json` and
`source.json` retain the inputs corresponding to the report digests, including
working-tree identity. Screenshots have
SHA-256 digests and sit beside the report. Generated flows and raw Maestro output
remain in the run directory. Native evidence does not use the Web CAS store.

Exit 0 means declared checks passed, 1 means a visibility assertion failed, and 2
means prerequisites, infrastructure or evidence were inconclusive. Existing CLI
signal exit semantics remain in effect. Cancellation requests bounded cleanup of
the owned driver; after capture starts it attempts to publish both reports as
inconclusive/interrupted, including cancellation during final source checks or
report publication. Completed projections are replaced through exclusive writes
before cancellation propagates; publication/storage failures still fail the command.

After both interrupted projections are written and owned-driver cleanup succeeds,
JSON mode emits one value containing the existing `error` (code `INTERRUPTED`,
signal `SIGINT` or `SIGTERM`) plus `partialRun: {result, reportPath, htmlPath}`.
The result is always inconclusive and identifies this invocation's execution,
source and plan; it is diagnostic evidence, never a successful capture or a
retry/resume authorization. Text mode prints the two paths to stderr. Exit codes
remain 130/143. Preflight interruption, incomplete cleanup, failed publication,
or forced termination can leave files without a `partialRun`; do not infer a
handoff by scanning historical directories. Consumers must verify containment,
identity and persisted report contents before archiving referenced evidence.
The programmatic API throws `NativePilotInterruptedError` with `partialRun` and
the original abort reason as `cause` after successful interrupted publication;
callers relying on abort-error identity must handle this wrapper explicitly.

New captures add optional `driverTiming` to the result and HTML: signed
`wallElapsedMs` from `Date.now()`, `monotonicElapsedMs` from `performance.now()`,
and the unchanged configured `timeoutMs`. The interval covers the driver command
through owned-process cleanup, excluding preflight, evidence validation and
report publication. A wall-clock adjustment can produce a negative value;
monotonic clock behavior across host suspension depends on the platform/runtime.
Neither clock is a portable measure of active CPU time. Clock disagreement and
deadline overshoot are observations, not proof of sleep, a timeout cause or a
product failure. No power logs are collected and timeout policy is unchanged.
Older records without timing remain readable; older strict readers need an
explicit engine/schema update before consuming new records or `partialRun`.
An existing consumer pin does not gain this behavior automatically.

Reports explicitly do not certify:

- installed binary or Metro provenance: source identity and installed app
  presence are observations, not a cryptographic build-to-source binding;
- crashes/runtime health, network isolation, accessibility, geometry, typography,
  visual diffs or authoritative design conformance;
- language, clock, orientation, keyboard, permission, safe-area or backend
  determinism: candidate setup owns those inputs;
- Android, Harmony, real-device or device-farm support.

Raw Maestro logs, command metadata and screenshots may contain private data.
They are ignored local artifacts, unencrypted, and do not receive Web evidence
redaction. Use synthetic state, review before sharing and manage retention
externally. Evidence reads are bounded and reject symlinks; total driver disk
output is not quota-managed.

The separate `nativePilot` library namespace exposes the experimental API.
Distribution remains a separately authorized source checkout/build. This pilot
does not complete the broader native-adapter roadmap milestone.

## Failure diagnostics

Bound visibility failures add optional `diagnostic` fields derived only from
existing Maestro artifacts. Step indexes are zero-based scenario indexes. The
previous checkpoint precedes the last completed interaction; it may be older
than the immediately preceding frame. The failure image is the pinned driver's
single matching failed-step artifact. Comparisons use decoded RGBA pixels with
matching dimensions, not encoded PNG bytes. Different pixels do not establish
the intended transition, and identical pixels do not identify a cause.

A unique literal ID/text match in the post-failure hierarchy may supply target
bounds in driver hierarchy coordinates. These are neither actual injected touch
coordinates nor screenshot pixel coordinates. Regex-only/ambiguous targets have
no inferred bounds. No pre-interaction hierarchy is captured or compared.
Missing, invalid, oversized or symlinked diagnostic artifacts stay unavailable.
Raw hierarchy text and driver errors are not embedded in result fields.

JSON and HTML keep the failed status and explicitly state cause `undetermined`.
Inspect candidate state, development overlays and input delivery before rerunning;
the engine does not dismiss overlays, infer a product defect or retry. Integration
revalidation recomputes retained diagnostics and binds their artifact bytes.
Old results without diagnostics remain readable. Local diagnostic image paths
are sensitive just like other native screenshots; no artifact is uploaded.

## Explicit acceptance progress

Create a project-relative scope file, selecting at most one report per scenario
and one observation per human criterion. No directory scan, timestamp selection
or preference for passing history is performed. For example:

```json
{
  "apiVersion": "uieval.io/native-progress-v1",
  "kind": "NativeProgressScope",
  "projectId": "sample",
  "deviceId": "11111111-1111-1111-1111-111111111111",
  "scenarios": ["home"],
  "reports": [],
  "reviews": []
}
```

```sh
bun run ui-eval native-pilot progress --project-root /candidate \
  --scope ui-eval/progress.json --format json
```

Add `reports: [{"scenarioId":"home","path":".ui-eval/native-runs/EXECUTION/report.json"}]`
and `reviews: [{"reviewId":"layout","path":".ui-eval/native-reviews/OBSERVATION/review.json"}]`
only for evidence actually selected by the operator. Placeholders are not results.
Every current human criterion belonging to a selected scenario is required;
scope, current declarations and source identity have separate digests.

The offline command checks original source/plan/flow/command/PNG evidence through
the existing native verifier. Human records must match the exact selected passed
capture, checkpoint, criterion and current source, and retain both projections.
Human aliases/decisions remain self-reported, not authenticated. Reviewer notes
and raw hierarchy contents are not copied into the progress report. Final
revalidation rejects inputs or verified evidence changing during summarization.

Outputs are `.ui-eval/native-progress/<execution-id>/summary.json` and `summary.html`.
States are passed, failed, inconclusive, pending, stale and invalid. Any failed or
invalid item yields blocked/exit 1; all passed yields complete/exit 0; other states
yield pending/exit 2. CLI signal exits remain unchanged. Unsupported scope inputs
fail validation. Neither original evidence nor automated decisions are rewritten.

This is selected native scenario/criterion progress, not acceptance of integration
prepare/check/session/cleanup stages, backend state, an installed binary or a
physical-device release. A new source requires new captures and observations;
it does not authorize evidence reuse. No device, Metro, auth or backend command
runs during summarization. The `nativePilot` namespace exports the scope/result
schemas and `summarizeNativeProgress`.
