# Architecture

The experimental [WeChat DevTools pilot](wechat-pilot.md) is an additive module
under `src/wechat-pilot/` with separate CLI and result contracts. It uses the
installed official CLI rather than the Web capture/evaluator pipeline below.

UI Eval is currently a local-first TypeScript modular monolith. One CLI process loads project-owned authoring files, seals immutable execution inputs, owns a candidate development server when needed, captures evidence with Playwright, evaluates deterministic rules, and persists machine and human-readable results.

This document describes implemented behavior in the current source tree. Proposed design sync, native-app capture, shared control planes, and baseline governance live in the [roadmap](roadmap.md), not in the current architecture. The bounded Agent loop described below is implemented; it is not a general or security-isolated autonomous fixing service.

## System boundary

UI Eval evaluates a candidate project but does not become part of that application's runtime:

```text
Candidate repository                         UI Eval process
--------------------                         ---------------
ui-eval/project.json  ─┐
scenarios/*.json       ├─ load/validate ──> compile + seal
policies/*.json        ┘                           │
candidate Git state ──────────────────────────────┤
                                                  v
                                      own/reuse candidate server
                                                  │
                                                  v
                                      Playwright Chromium capture
                                                  │
                                                  v
                                      evidence verification + CAS
                                                  │
                                                  v
                                      deterministic evaluators
                                                  │
                                                  v
                                      policy gates + report contract
                                                  │
                                                  v
                                      report.json + report.html
```

The candidate repository remains canonical for its project configuration, scenarios, policies, and reviewed fixtures. UI Eval is canonical for contract validation and execution semantics. Generated `.ui-eval/` data is neither authoring input nor a replacement for the source files.

## Module map

All modules ship from one package and use relative internal imports. The directory boundaries are architectural seams, not separately deployed services.

| Module | Responsibility |
| --- | --- |
| `src/contracts/` | TypeBox schemas, derived TypeScript types, canonical JSON/digests, JSON Schema export, and structural/semantic contract validation. |
| `src/project/` | Safe loading of project, scenario, and policy authoring files; project-root containment and authoring semantics. |
| `src/manifest-compiler/` | Matrix expansion, fixture/auth materialization, capability negotiation, plan sealing, and policy materialization. |
| `src/capture-playwright/` | Chromium lifecycle, origin and egress guards, scenario actions, stabilization, and evidence collection. |
| `src/normalize/` | Platform- and source-neutral value normalization (sRGB color, logical-pixel length) shared by design producers and evidence normalizers. |
| `src/evaluators/` | Registry for the implemented evaluator set plus functional/runtime, advisory visual, and optional geometry evaluation. `geometry/` holds the normalized property space and the five constraint kinds used by `geometry@0.1.0`. |
| `src/policy-engine/` | Restricted gate-expression evaluation and disposition calculation. |
| `src/runtime/` | Shared owned-process signaling and bounded argv command execution. |
| `src/orchestrator/` | End-to-end coordination, Git/source identity, candidate-server lifecycle, capture/report cross-binding, and evidence aliases. Coverage, normalized digests, and geometry evidence loading are separate narrow modules. |
| `src/storage-local/` | Project-scoped content-addressed artifacts, sensitivity metadata, atomic run storage, and path/symlink containment. |
| `src/report-html/` | Escaped static HTML rendering; capability labels derive from canonical coverage and actual evaluator provenance. |
| `src/agent/` | Bounded suite orchestration, constrained repair requests, terminal decision model, and synchronized JSON/HTML Agent summary publication. |
| `src/design-adapters/` | Reference producers that read declarative design sources into a normalized token set, plus an offline sealed-token drift guard. Not on the evaluation path and never imported by an evaluator. |
| `src/cli/` | `init`, `doctor`, `evaluate`, `agent`, `integrate`, and pilot commands; stdout/stderr discipline, exit mapping, and signal handling. |
| `src/integration/` | Engine pin checks, once-per-invocation prepare, mandatory Web/WeChat suites and external checks, stage timing, and canonical acceptance JSON/HTML. |
| `src/index.ts` | Supported programmatic exports. |

The dependency intent is inward toward contracts and narrow interfaces:

```text
CLI / public API
      │
      v
Orchestrator
  ├── Project loader + compiler
  ├── Capture adapter
  ├── Evaluator registry + policy engine
  ├── Local storage
  └── HTML renderer
             │
             v
          Contracts
```

Capture does not interpret design intent or make policy decisions. Evaluators do not start servers, drive the browser, or mutate candidate source. The policy engine consumes measurements and gates; it does not repair the application.

## Executable pipeline

### 1. Load and validate authoring

The project root resolves to a real path. UI Eval loads `ui-eval/project.json`, a scenario source, and a policy source using strict JSON Schema validation plus semantic checks. Referenced project files must remain inside the project root under both lexical and real-path resolution.

Configuration, compiler, source-identity, and evaluator-registration errors occur before an execution is sealed. They return a structured CLI error and exit `2`; there is no run report to persist at that point.

### 2. Compile and seal

The compiler resolves base URL references, device profiles, locale, theme, timezone, supported capture capabilities, and permitted auth storage state. It expands the scenario matrix and creates one immutable `ResolvedScenarioPlan` per variant.

The policy source is materialized into an `EvaluationPolicy`. Inline or referenced evaluator configuration is written to the project-scoped artifact store and cross-bound by digest. The runtime registry then refuses unsupported required evaluators, invalid configurations, missing core hard gates, repeatability above one attempt, and policy features that are declared but not executed.

### 3. Establish source and execution identity

UI Eval fingerprints the candidate Git state before capture. Commit, worktree state, tracked differences, and untracked content participate in provenance. Failure to read a mutually consistent source identity is a pre-run failure rather than a placeholder provenance value.

For each resolved variant, the orchestrator seals a `SealedRunManifest` containing source/build, adapter, environment intent, scenario-plan digest, and capture key. Digest-bearing contracts are recomputed during validation; a caller cannot make a changed object authoritative by copying an old digest onto it.

### 4. Own the candidate server

This lifecycle applies to legacy/local execution. An explicitly selected remote
profile uses pre/post deployment identity checks instead, without acquiring or
stopping a candidate server. Target expectations are sealed in the run manifest
and copied into the report. See [Execution profiles](execution-profiles.md).

The development server is configured as a command plus argument array and starts in the candidate project. UI Eval does not accept an occupied responding port when `reuseExisting` is false. Reuse requires a project-specific readiness path and response marker.

Each matrix variant acquires and releases its server handle independently. A
server started by UI Eval is stopped before the next variant starts, preventing
one variant's generated run artifacts from perturbing a long-lived candidate
watcher during the next capture. A reused server is identity-checked for every
variant and its no-op handle never grants UI Eval permission to stop it.

Resolved `mock-server` fixtures are also variant-scoped. The orchestrator
revalidates their sealed config artifacts, binds fixed HTTP responders to
loopback before starting the candidate server, verifies every required route
after capture, then stops the candidate server followed by the fixture servers.
Partial startup and cleanup failures are fail-closed and never authorize reuse
of a pre-existing fixture port.

The run store writes capture and evaluation intermediates while the variant is
active, but does not publish `report.json` or `report.html` until every owned
server and fixture has stopped successfully. A cleanup failure therefore cannot
leave behind a finalized report whose disposition omits that failure.

Only a process tree started by UI Eval is stopped by UI Eval. Candidate stderr is withheld from run-visible output. After planning, a server failure still produces an infrastructure/inconclusive report when the run store remains writable.

### 5. Capture one declared browser page

The Playwright adapter consumes only the sealed web plan. It fixes the declared rendering environment, applies stabilization, executes setup/steps/cleanup, records step and assertion outcomes, and captures requested checkpoint channels.

The current contract binds a run to exactly one declared `Page`. Browser-context routing guards the initial navigation, later navigations, redirects, and popup first requests. Any additional page fails capture closed. See [Security model](security-model.md) for authenticated containment and origin rules.

Capture produces a `CaptureBundle` with:

- adapter and observed environment identity;
- step and assertion results;
- checkpoint-level evidence records;
- execution errors with product, runner, driver, fixture, or external-service origin;
- required-evidence completeness;
- `completed`, `partial`, or `failed` capture status.

A runner, driver, fixture, or security-boundary error cannot coexist with a truthful `completed` capture. Later storage/alias checks may preserve or lower capture status, never upgrade a failed or partial result based only on artifact counts.

### 6. Verify and store evidence

Binary and JSON evidence is sealed by SHA-256 in a project/store-scoped local CAS. Artifact references carry identity, digest, media type, size, and a caller-provided sensitivity label, but the label is not trusted by the presentation boundary.

Evidence aliases are materialized only after integrity verification. Channel minimums and the strongest classification observed for each digest determine whether plaintext run aliases are permitted. Sensitive data remains CAS-only. A failed presentation alias is reported separately from evidence integrity; a corrupt or missing CAS object invalidates evidence.

### 7. Evaluate deterministic rules

The implemented registry recognizes these evaluator IDs:

- `execution` — reachability, capture validity, and product execution failures;
- `interaction` — explicit step and assertion results;
- `runtime` — critical same-origin runtime/network/crash observations;
- `visual` — optional raw same-size PNG comparison when a local reference is supplied.
- `geometry` — optional constraint evaluation over normalized DOM/CSSOM evidence
  when policy registers `geometry@0.1.0`.

Execution, interaction, and runtime are mandatory and each requires an independent non-bypassable hard gate. Visual comparison is advisory. Geometry runs only when the policy registers its implemented version and sealed config. Unsupported optional evaluator entries remain visible as skipped; unsupported required entries stop before capture.

New policy authoring uses the compact `web-default` profile. Its expansion
shares core requirements with registry validation and emits a complete sealed
policy. Existing full policy inputs remain accepted. Default smoke capture
requests screenshot, console, network, and crash; structured channels and trace
remain explicit scenario choices.

Geometry local constraints count once per planned checkpoint. Missing or invalid
structured payloads remain invalid work instead of disappearing from coverage.
Equality constraints pool nodes across the checkpoints of one evaluation and
require comparable peers; they do not aggregate variants or scenarios. A geometry
gap without an observed product defect produces invalid-evidence/inconclusive.
Normalized decision-evidence digests include layout/style artifacts when geometry
runs. HTML capability labels derive from that report's coverage and provenance.

The policy engine evaluates a restricted data AST rather than arbitrary code. Missing or unknown required inputs follow the gate's explicit `onUnknown` behavior and cannot silently become a pass.

### 8. Cross-bind and persist the report

The orchestrator builds an `EvaluationPlan` that binds candidate evidence, the materialized policy, evaluator versions/config digests, and an optional local reference. The report contract cross-checks the plan, capture, policy, findings, gates, visual disposition, and actual evaluator execution provenance.

Each completed planning path attempts to persist:

```text
.ui-eval/runs/<execution-id>/
  run-manifest.json
  capture.json
  evaluation-plan.json
  policy.json
  report.json
  report.html
```

`report.json` is authoritative. `report.html` is an escaped, static presentation view with relative links to materialized non-sensitive evidence. Report files are pretty-printed for review; digests are computed from canonical JSON, not from file whitespace.

## Outcome model

The report keeps evidence validity separate from candidate quality:

| `executionOutcome` | Meaning |
| --- | --- |
| `valid` | The evidence is sufficient for the reported raw disposition. |
| `invalid-evidence` | Required evidence is missing, corrupt, incompatible, or otherwise not usable. |
| `infra-error` | The runner, browser, server, fixture, or storage path prevented reliable evaluation. |

With valid evidence, `rawStatus` is `pass`, `fail`, `needs-review`, or `inconclusive`. Infrastructure and invalid-evidence outcomes map to CLI exit `2` even if another observation happened to look healthy.

Product failures can remain definitive when the browser directly observed an assertion failure, crash, same-origin request failure, or relevant HTTP failure. Evidence dimensions that were not captured remain invalid or unsupported; the implementation does not manufacture an overall quality score.

## Cancellation and cleanup

`AbortSignal` flows from the CLI through fixture, server, and capture work. The first `SIGINT` or `SIGTERM` requests cooperative cancellation and cleanup. A second signal, or the bounded cleanup deadline, forces exit with `130` or `143`. The orchestrator attempts both owned candidate-server and fixture-server cleanup before propagating an operation or cleanup failure.

## Programmatic boundary

`src/index.ts` exports:

- executable web schemas, derived types, canonicalization, and validators;
- explicit `forwardContracts` namespace for forward multi-platform/design/governance contracts;
- `evaluateScenario`;
- `initUiEvalProject`;
- `runDoctor`;
- `runAgentSuite`, validated Agent result schemas, and summary rendering;
- the local artifact and run stores.

Internal module paths are not a supported consumer API. The source repository is public, but the package is `UNLICENSED`, private in package metadata, and has no configured package distribution. This boundary supports source development and separately authorized local integration rather than a published SDK compatibility promise.

## Constrained repair agent

The optional `agent` command composes immutable scenario evaluations with
project-owned command checks and an argv-only repair adapter. The repair worker
receives generated findings but cannot authorize acceptance: UI Eval reruns the
original scenarios and checks, audits file hashes against allowed and protected
prefixes, enforces budgets, and stops on repair-progress plateau. Acceptance
remains a strict check/scenario/dimension decision; continuous progress never
authorizes acceptance. Evidence reuse checks the source snapshot after project
checks. Agent result types derive from their TypeBox source. Raw reports are never
rewritten. See [Constrained Agent Loop](agent.md).

Each terminal Agent state publishes `summary.json` as the canonical aggregate
record and `summary.html` as its escaped human-readable projection. The HTML
links only to artifacts contained by the candidate's `.ui-eval/` root and
combines checks, acceptance dimensions, scenarios, visual evidence, and the
iteration history. Publishing both is part of completion: a summary rendering
or write failure causes the Agent command to fail rather than return an accepted
result.

## Explicit non-capabilities

The current architecture does not include:

- online design/Figma sync or authoritative structured design comparison;
- calibrated geometry, typography, accessibility, or visual release scoring;
- baseline/waiver ledgers or shared storage;
- multi-page scenarios, WebKit/Firefox, or native-app adapters;
- static, seed-script, or remote fixture providers; feature-flag,
  network-profile, or secret providers;
- MCP, holdout isolation, a web console, or a service API.

The schemas contain some forward-looking types for these areas. A schema declaration is not proof of executable support. The complete truthfulness boundary is maintained in [Current limitations](limitations.md).
