# Project Integration

UI Eval currently integrates from a local checkout of the public source repository at `https://github.com/budded-water/ui-eval`. The package remains private in package metadata, `UNLICENSED`, and unavailable from a registry. Public source visibility does not grant integration rights, so this guide assumes separately authorized use and points the checkout's Bun scripts at a candidate project with `--project-root`.

## Integration boundary

A candidate repository should retain only project-owned inputs and a generated working directory:

```text
candidate/
  ui-eval/
    project.json
    scenarios/
    policies/
    fixtures/                 # reviewed and scrubbed only
  .ui-eval/                   # generated, ignored
```

Do not copy UI Eval engine source into the candidate. Do not treat generated reports or CAS objects as authoring truth. Once a supported package distribution channel exists, the candidate should pin that engine version through its package manager and lockfile; the public Git repository is source hosting, not such a channel.

## 1. Prepare the candidate

The candidate must:

- be an existing readable directory;
- be a Git working tree with a readable revision and files;
- expose a deterministic local HTTP(S) development server;
- avoid placing credentials in committed files;
- be runnable with a command and argument array from its project root.

UI Eval fingerprints committed and uncommitted source state. A directory without reliable Git identity cannot produce a sealed run.

## 2. Prepare the standalone checkout

From this repository:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
```

The runtime requirement is declared in `package.json`; `doctor` currently requires Node.js 20 or newer.

## 3. Initialize project inputs

Run from the standalone checkout:

```bash
bun run ui-eval init \
  --project-root /absolute/path/to/candidate \
  --route /account \
  --scenario account-desktop \
  --yes
```

`init`:

- creates only missing project, default-policy, and scenario files;
- never overwrites an existing authoring file;
- creates or safely appends `.ui-eval/` to `.gitignore`;
- rejects unsafe route and scenario identifiers;
- reports created, updated, and preserved paths.

Treat the generated files as a starting point, not an authoritative test design. Review every command, URL, assertion, checkpoint, capability, and policy gate before use.

## 4. Configure the project

`ui-eval/project.json` defines:

- `projectId` — local project/store scope;
- `artifactRoot` — generated working area, normally `.ui-eval`;
- `devServer` — command, argument array, URL, ownership/reuse behavior, readiness, and timeout;
- `baseUrls` — named origins referenced by scenarios;
- `deviceProfiles` — viewport and device-scale-factor definitions;
- default locale, theme, and IANA timezone;
- optional storage-state references;
- declared fixture/feature-flag inputs;
- capture capabilities the project is prepared to request.

Read the checked-in [`project.schema.json`](../schemas/project.schema.json) for exact fields.

### Server ownership

Prefer `reuseExisting: false`. UI Eval then refuses an already responding port and owns the server process it starts.

If reuse is necessary, provide a project-specific readiness path and response marker. A generic `200 OK` is not sufficient identity:

```json
{
  "reuseExisting": true,
  "readiness": {
    "path": "/health/ui-eval",
    "bodyIncludes": "project-specific-marker"
  }
}
```

The candidate must make that endpoint deterministic. UI Eval never stops a reused process.

### Browser selection

With no channel flag, UI Eval uses Playwright's bundled Chromium. To use an installed Chrome channel, pass the same channel to both `doctor` and `evaluate`:

```bash
bun run ui-eval doctor \
  --project-root /absolute/path/to/candidate \
  --browser-channel chrome
```

Browser choice participates in environment intent and provenance. Do not mix channels when comparing runs without accounting for renderer differences.

## 5. Author scenarios

A `ScenarioSource` declares one web target plus deterministic execution context:

- named base URL and same-origin path;
- optional exact-scoped Playwright storage state;
- timezone/clock/random-seed declarations;
- required capture channels;
- device/locale/theme matrix and exclusions;
- setup, action, assertion, cleanup, and checkpoint steps.

Prefer stable semantic locators in this order:

1. `uiId` or `testId`;
2. accessible role and name;
3. stable text;
4. CSS only when the candidate deliberately owns that selector.

Each checkpoint must name its required channels. A screenshot alone does not prove interactions or runtime health.

`init` starts with screenshot, console, network, and crash channels. Geometry
requires `layout-metadata`; also add `computed-styles` for style or text
constraints to the checkpoint's required channels. DOM and trace are opt-in
diagnostic evidence. Selecting geometry without usable structured evidence
produces an inconclusive result.

The generated default policy is a compact authoring profile:

```json
{
  "apiVersion": "uieval.io/v1alpha1",
  "kind": "PolicySource",
  "id": "default",
  "revision": 1,
  "profile": "web-default"
}
```

Add project-specific `evaluators` and `gates` when needed. Profile additions
cannot replace core/default IDs. Existing full policies remain usable, and the
run's `policy.json` always contains the complete expanded and sealed policy.

The current executable authoring target is web-only. The only executable
fixture provider is the bounded loopback `mock-server`; feature flags, network
profiles, secret references, other fixture providers, and app locators remain
unsupported and fail before capture. See [Current limitations](limitations.md).

## 6. Handle auth and fixtures safely

Committed fixture inputs must be synthetic, deterministic, and scrubbed. Never commit production credentials or a real user's browser state.

When using Playwright storage state:

- reference it by a project-contained file;
- require every cookie domain to exactly match the Candidate hostname;
- reject leading-dot or foreign cookie domains;
- require local-storage origins to exactly match scheme, host, and port;
- expect authenticated capture to block service workers and all foreign HTTP(S)/WebSocket egress.

An authenticated application that needs a third party must expose a same-origin proxy or deterministic fixture for the scenario. UI Eval does not currently provide an auth secret provider or third-party egress allowlist.

For a server-side data dependency, declare a `mock-server` fixture whose config
is a contained, reviewed JSON file:

```json
{
  "fixtures": [
    {
      "id": "catalog-api",
      "provider": "mock-server",
      "configPath": "fixtures/catalog-api.mock.json"
    }
  ]
}
```

The config uses the generated `mock-server-fixture-config.schema.json` shape. It
declares a fixed loopback port and exact `GET`/`HEAD` paths with bounded
`application/json` or `text/plain` responses. Mark a route `required: true`
when a completed capture must prove the candidate requested it. Unmatched
requests receive `404`/`405`; fixtures never forward a request, read another
file, execute a script, inject an environment variable, or carry a secret ref.

UI Eval starts fixtures before the candidate server and stops both after every
matrix variant. The candidate must already be configured to call the declared
loopback port; UI Eval does not rewrite `.env` or application code. A port
collision, invalid artifact, missed required route, or cleanup failure is
fixture infrastructure failure and cannot pass.

## 7. Author policy

The current runnable evaluator set is fixed:

- required `execution`;
- required `interaction`;
- required `runtime`;
- optional advisory `visual`;
- optional `geometry`, covered in the next section.

Execution, interaction, and runtime each need their exact independent hard gate. The current runtime rejects zero-gate policies, multiple repeatability attempts, non-empty tolerances/dynamic regions, and non-zero evaluator weights because those semantics are not implemented.

Use `--policy <id-or-path>` to select a policy. A simple ID resolves under `ui-eval/policies/`; an explicit JSON path resolves relative to `ui-eval/project.json` and must remain inside the project.

## 8. Bind design tokens and geometry constraints

This step is optional. A policy that does not register `geometry@0.1.0` behaves
exactly as before, and nothing below changes any other dimension.

The evaluator compares captured values against a **token set** of design facts
using the five constraint kinds in [ADR 0002](adr/0002-design-constraint-contract.md).
Facts and strictness stay separated: a producer emits only the token set, and a
human authors the constraints, tolerances, and gates.

### 8.1 Produce a token set from the project's own token layer

```bash
bun run design:import --css /absolute/path/to/candidate/app/globals.css --json
```

The reference producer reads declarative CSS only. It never imports, executes,
or evaluates candidate application code. Where the authoritative values exist
only inside executable code, the candidate owns a small export step that emits
JSON and the producer consumes that instead.

Read the non-JSON output first. It reports every declaration the producer could
not resolve, and which scales the stylesheet actually declares. **Absent is not
unconstrained**: framework default scales that the project never declares will
be missing, and a constraint may only reference a scale that is present.

### 8.2 Triage before gating

```bash
bun run design:audit --project-root /absolute/path/to/candidate \
  --css /absolute/path/to/candidate/app/globals.css
```

`design:audit` composes the producer, the evidence normalizer, and the
constraint kinds over the most recent run. It is an analysis tool, never a gate,
and it does not affect any run disposition.

Its purpose is to separate two things that look identical in a violation list:

- a value that is genuinely ad hoc, and
- a value that is legitimate but that the token set never declared.

Only the first is a defect. The second means the token layer is incomplete, and
gating on it would bury real findings under noise.

### 8.3 Derive the tolerance from a measured noise floor

Scale and equality constraints take a tolerance. It must come from observed
run-to-run deviation, not from a chosen round number:

```bash
for i in $(seq 1 10); do
  bun run ui-eval evaluate <scenario> --project-root /absolute/path/to/candidate || true
done
node scripts/measure-capture-noise.mjs --project-root /absolute/path/to/candidate --limit 10
```

Do not touch the working tree between runs. The script refuses to certify a
batch whose runs disagree on uncommitted source state, because a real source
change would inflate the measured deviation and widen a tolerance until the
constraint can no longer fail.

The observed maximum is the floor a tolerance must clear, not the tolerance
itself. It must also stay below the smallest scale step it has to distinguish.
If those two bounds cross, the capture is too noisy to gate on, and the fix is
determinism rather than a wider tolerance.

### 8.4 Author the config and register the evaluator

The config is a project file matching
[`geometry-evaluator-config.schema.json`](../schemas/geometry-evaluator-config.schema.json).
`configPath` resolves relative to the **policy file's own directory**, so a
sibling file is referenced by bare name:

```json
{
  "id": "geometry",
  "version": "0.1.0",
  "configPath": "geometry.json",
  "required": false,
  "weight": 0
}
```

Stage the rollout. Register the evaluator with `required: false` and **no gate**
first, read the reported metrics for a while, and only then add a hard gate:

```json
{
  "id": "geometry-violations",
  "hard": true,
  "expression": { "metric": "geometry.violations", "operator": "eq", "value": 0 },
  "onUnknown": "fail"
}
```

Available metrics are `geometry.violations`, `geometry.failedConstraints`, and
`geometry.indecisiveConstraints`. The last one counts constraints that could not
be decided; gate on it separately if a run must not pass on evidence it could
not read.

### 8.5 Keep the sealed token set in step with its source

The token set is copied into the evaluator config and sealed there. It does not
track the stylesheet it came from. When the stylesheet changes, the sealed copy
is stale until it is regenerated, and a stale copy produces false violations or
false silence.

Regenerate it in the same change that edits the token layer, then verify the
producer-owned part of the sealed copy:

```bash
bun run design:check \
  --css /absolute/path/to/candidate/app/globals.css \
  --config /absolute/path/to/candidate/ui-eval/policies/geometry.json
```

The reference Tailwind producer owns `valueSets` and `scales`. Policy-authored
`ranges` are preserved and are not compared. The command never rewrites the
config. It returns `0` when the owned collections are in sync, `1` when they
drift, and `2` when the source cannot be resolved or either input is invalid.
Run it after changing either the token layer or geometry config, and make it a
CI gate once the candidate CI has an immutable way to obtain this UI Eval
version.

## 9. Run doctor

```bash
bun run ui-eval doctor --project-root /absolute/path/to/candidate
```

`doctor` checks:

- Node runtime;
- project configuration;
- writable contained artifact root;
- selected browser launch;
- candidate-server port ownership/readiness.

Warnings are visible, and any failing check returns exit `2`. `doctor` does not run the scenario.

JSON output is available for automation:

```bash
bun run ui-eval doctor \
  --project-root /absolute/path/to/candidate \
  --format json
```

## 10. Evaluate

```bash
bun run ui-eval evaluate account-desktop \
  --project-root /absolute/path/to/candidate
```

The command performs validation, compilation, source sealing, server startup/reuse, capture, evaluation, policy gates, cleanup, and final report publication. A matrix scenario may produce multiple run results. Each variant acquires its own server handle: an owned server is stopped before the next variant starts, while a reused server is identity-checked again and is never stopped by UI Eval. `report.json` and `report.html` are published only after owned candidate and fixture servers stop successfully; cleanup failure leaves no finalized report for that variant.

Programmatic cancellation and browser shutdown retain a distinct
`IncompleteCleanupError` (`OWNED_RESOURCE_CLEANUP_INCOMPLETE`) when owned
resources cannot be confirmed closed. Treat that error as a blocked job rather
than retrying in the same process. Raw evaluator values live in canonical report
`spec.metrics`; a measured `visual.changedPixelRatio` of zero is preserved even
when no visual finding exists. Reference acceptance checks every matrix variant.

Text output prints disposition and report paths. JSON mode reserves stdout for one machine payload and writes progress to stderr:

```bash
bun run ui-eval evaluate account-desktop \
  --project-root /absolute/path/to/candidate \
  --format json > ui-eval-result.json
```

Preserve the process exit code; do not treat a successfully parsed JSON payload as a successful evaluation.

| Exit | CI treatment |
| ---: | --- |
| `0` | Green only for the evaluated scenario/variants and declared evidence. |
| `1` | Candidate defect; fail the job. |
| `2` | Configuration, infrastructure, or evidence problem; fail the job. |
| `3` | Human review required; do not auto-merge. |
| `130` / `143` | Interrupted/terminated; fail or cancel according to CI policy. |

## 11. Optional local image comparison

```bash
bun run ui-eval evaluate account-desktop \
  --project-root /absolute/path/to/candidate \
  --reference references/account.png
```

The image must be a project-contained, regular, non-symlink PNG, and the plan must contain exactly one screenshot checkpoint. Dimensions must match. A pixel change returns `needs-review`; equal pixels do not upgrade missing functional/runtime evidence.

Local image evidence is `local-unprotected`. Do not call it an approved baseline or holdout.

## 12. Retain artifacts deliberately

The authoritative result is:

```text
.ui-eval/runs/<execution-id>/report.json
```

The HTML file is a local reading view. Upload or retain run data only through an access-controlled CI mechanism appropriate for its sensitivity. Console/network/trace/crash artifacts are intentionally CAS-only and may contain private data even after bounded redaction.

Do not commit `.ui-eval/`. Retention and deletion are currently operator responsibilities.

## Ongoing run flow

Once integrated, the loop has three cadences.

### Every change

```bash
bun run ui-eval evaluate <scenario> --project-root <path> --format json
```

Preserve the process exit code; a parsed JSON payload is not a successful
evaluation. `doctor` is worth running when the environment changed, not on every
commit.

| Exit | Meaning | Usual action |
| ---: | --- | --- |
| `0` | Evidence valid, hard gates passed | Proceed |
| `1` | Candidate defect | Fix the product |
| `2` | Configuration, infrastructure, or invalid evidence | Fix the setup; never re-run until green |
| `3` | Human review required | Look at the diff or the indecisive constraints |

Exit `3` is not a soft `0`. Treating it as a retry target is how a suite decays
into a green run that asserts nothing.

### When an input changes

| Changed | Required follow-up |
| --- | --- |
| Design token layer (stylesheet, theme export) | Regenerate the sealed token set (8.1) and re-triage (8.2) |
| New page or new state to cover | New scenario; a screenshot alone does not prove interactions or runtime health |
| Component identity (`uiId`, `testId`, roles) | Re-check constraints whose scope or grouping relied on it; a zero-match constraint fails as invalid rather than passing |
| Browser channel, viewport, device scale, or stabilization | Re-measure the noise floor (8.3); the old tolerance no longer describes this capture |
| Policy strictness | Re-read the metrics before tightening a gate |

### Periodically

Re-run the noise measurement even when nothing changed. Capture determinism
drifts with browser updates and page content, and a tolerance derived months ago
silently stops describing the current capture.

Re-run `design:audit` to catch token-layer drift that no gate covers yet, such
as scales the stylesheet still does not declare.

## Programmatic integration

The root entry point exports contracts, orchestration helpers, initialization, doctor checks, and local storage. Because no package distribution is configured, there is no supported registry install command. Separately authorized source-checkout tools may use the built entry point, but must not import `src/*` internals or claim compatibility beyond the exact source snapshot they pin.

When a package distribution channel is introduced, integration documentation must be updated together with package exports, lockfile pinning, clean-install tests, licensing, and release policy. Until then, separately authorized local checkout invocation is the only workflow described here.
