# UI Eval

UI Eval is a local-first, evidence-first conformance harness for web user interfaces. It compiles reviewable project inputs into sealed execution plans, captures browser evidence with Playwright, applies deterministic policy gates, and writes a validated JSON result plus a static HTML view.

The current implementation is deliberately narrow: a single-package TypeScript modular monolith for local and CI use. It is not a hosted service or a general UI quality scorer. Its optional agent command is a bounded orchestration layer around deterministic evaluation and a separately configured repair adapter.

Optional [execution profiles](docs/execution-profiles.md) support fast local
iteration and remote preview/staging validation through the same engine. Remote
runs verify deployment identities before and after capture. Agent suggestions
can add reviewed optional scenarios while preserving mandatory scope.

> **Repository status:** the source is publicly visible at [budded-water/ui-eval](https://github.com/budded-water/ui-eval) and remains `UNLICENSED`. Public visibility is not an open-source license and does not grant permission to use, copy, modify, or redistribute the code. No npm publication or support promise is configured.

## What works today

A separate experimental [WeChat DevTools pilot](docs/wechat-pilot.md) runs
declared mini-program interactions and captures PNG evidence using the installed
official CLI. It does not extend the Web policy pipeline or real-device coverage.

- Non-destructive `init`, environment/configuration `doctor`, and end-to-end `evaluate` commands.
- Shared pinned-engine `integrate` suites with once-per-invocation preparation,
  required Web/WeChat scenarios and checks, stage durations, and synchronized
  complete-acceptance JSON/HTML. See [Integration runner](docs/integration-runner.md).
- Strict JSON authoring for project configuration, web scenarios, and evaluation policies.
- Matrix expansion into sealed, content-digested run plans.
- Per-variant, loopback-only mock HTTP fixtures with fixed bounded responses and
  required-route verification for deterministic server-side data flows.
- Playwright Chromium capture with fixed viewport, DPR, locale, timezone, stabilization, interaction assertions, and checkpoint evidence.
- Screenshot, DOM, computed-style, layout, console, network, trace, and crash/page-error evidence where requested and supported.
- Deterministic execution, interaction, and runtime gates.
- Optional same-size PNG comparison that reports raw changed pixels for human review.
- Project-scoped local content-addressed storage and atomically materialized
  per-run records. Local files are not write-once or tamper-proof.
- Validated `report.json` as the machine result and a static `report.html` reading view.
- Optional constrained `agent` loop with immutable findings, project checks,
  mutation budgets, protected paths, plateau detection, and deterministic
  reruns. Every terminal state emits canonical `summary.json` plus a default
  human-readable `summary.html` acceptance dashboard.

See [Current limitations](docs/limitations.md) before treating a result as a release gate. In particular, current visual comparison is advisory; typography, authoritative design sync, baselines, waivers, native apps, and a hosted control plane are not implemented. Geometry evaluation is optional and runs only when a policy registers `geometry@0.1.0` with a sealed config. The constrained repair loop is documented in [Constrained Agent Loop](docs/agent.md).

## Requirements

- Node.js 20 or newer.
- Bun, using the version declared by `packageManager` in `package.json`.
- Git in each candidate project. UI Eval seals source provenance and fails before a run when it cannot establish a consistent source identity.
- Playwright's bundled Chromium, or a locally installed Chrome channel selected explicitly.

## Start from an authorized checkout

Install the standalone repository dependencies:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
```

Create authoring files in a candidate project. Existing authoring files are preserved, and the command requires `--yes` because it writes project files:

```bash
bun run ui-eval init \
  --project-root /absolute/path/to/candidate \
  --route / \
  --scenario home-desktop \
  --yes
```

Review the generated `ui-eval/project.json`, scenario, and policy before running them. The configured development-server command is trusted configuration and executes in the candidate project.

New projects use a compact `web-default` policy profile. The loader expands its
mandatory evaluators and hard gates before sealing the policy; the resulting
`policy.json` remains fully auditable. The default smoke captures screenshot,
console, network, and crash evidence. Request DOM, computed styles, layout, or
trace explicitly when a scenario needs them.

Check prerequisites and server ownership without evaluating a scenario:

```bash
bun run ui-eval doctor --project-root /absolute/path/to/candidate
```

Run the scenario:

```bash
bun run ui-eval evaluate home-desktop \
  --project-root /absolute/path/to/candidate
```

For a locally installed Chrome channel:

```bash
bun run ui-eval doctor \
  --project-root /absolute/path/to/candidate \
  --browser-channel chrome

bun run ui-eval evaluate home-desktop \
  --project-root /absolute/path/to/candidate \
  --browser-channel chrome
```

For CI or another machine consumer, request JSON. Stdout is reserved for one JSON payload; progress goes to stderr:

```bash
bun run ui-eval evaluate home-desktop \
  --project-root /absolute/path/to/candidate \
  --format json
```

## Inputs and outputs

Candidate repositories own and review these inputs:

```text
ui-eval/
  project.json
  scenarios/*.json
  policies/*.json
  engine.json                # exact source pin for integrate
  integrations/*.json        # reviewed complete acceptance suites
  fixtures/*                 # reviewed, scrubbed inputs only
```

Generated state belongs outside Git:

```text
.ui-eval/
  artifacts/                 # project/store-scoped content-addressed objects
  runs/<execution-id>/
    run-manifest.json
    capture.json
    evaluation-plan.json
    policy.json
    report.json               # authoritative machine result
    report.html               # presentation view
    candidate.png             # only when safe to materialize
    reference.png / diff.png  # only for local image comparison
  agent-runs/<agent-run-id>/
    iteration-*.json          # immutable per-iteration assessment
    repair-request-*.json     # only when a repair is requested
    summary.json              # authoritative Agent terminal result
    summary.html              # default human review entry point
  integration/<execution-id>/
    suite.json                # reviewed input bound by digest
    summary.json              # complete integration acceptance record
    summary.html              # default integration handoff
```

Sensitive evidence such as console, network, trace, and crash data remains in the content-addressed store and does not receive a plaintext run alias. `.ui-eval/` is a local working area, not a canonical source of project policy or scenarios, and it is not encrypted at rest.

## Result and exit semantics

For Web `evaluate`:

| Exit code | Meaning |
| ---: | --- |
| `0` | Valid evidence and all hard gates passed. |
| `1` | Valid evidence captured a candidate failure. |
| `2` | Configuration, infrastructure, invalid evidence, or inconclusive result. |
| `3` | Valid evidence requires human review. |
| `130` | Interrupted by `SIGINT`. |
| `143` | Terminated by `SIGTERM`. |

`integrate` uses the same outcome categories across the full declared suite,
including external candidate checks. Agent terminal results return `0` for
`accepted` and `1` for other terminal states; inspect the summary status and
reason to distinguish blocking conditions. Pre-terminal CLI exceptions return
`2`, and termination signals retain `130`/`143`.

Missing or corrupt required evidence never becomes a pass. Product failures, runner/infrastructure failures, and advisory observations remain separate in the report.

The first termination signal requests cooperative browser/server cleanup. A second signal, or expiry of the bounded cleanup window, forces the conventional signal exit code. UI Eval stops only the development-server process tree it started.

## Local image review

`--reference` accepts a project-relative, regular, non-symlink PNG. The resolved scenario must have exactly one checkpoint that requires screenshot evidence, and the image dimensions must match the candidate screenshot.

```bash
bun run ui-eval evaluate home-desktop \
  --project-root /absolute/path/to/candidate \
  --reference references/home.png
```

The reference is explicitly `local-unprotected`. A changed image produces `needs-review`; it is not a calibrated visual regression gate or protected holdout.

## Programmatic surface

The package entry point exports executable web contract types/validators, the active
`ProjectConfigSchema`, `WebScenarioSourceSchema`, and `WebPolicySourceSchema` authoring surfaces with
their structural validators, `evaluateScenario`, `initUiEvalProject`,
`runDoctor`, Agent APIs, and the local artifact/run stores. Forward multi-platform,
design-binding, and governance contracts are available through the explicit
`forwardContracts` namespace. Its generic `ScenarioSource` contract is not proof that the current
web CLI can execute native scenarios. This repository currently has no
supported package distribution channel, so downstream code must not assume
that the package can be installed from a registry.

Do not import internal `src/*` modules from a consumer. See [Contracts](docs/contracts.md) for the wire/runtime boundary and [Integration](docs/integration.md) for the current local-checkout workflow.

## Documentation

- [Browser-readable technical documentation](docs/index.html)
- [System design and flow diagrams](docs/design-overview.md)
- [Architecture](docs/architecture.md)
- [Contracts and canonical truth](docs/contracts.md)
- [Security model](docs/security-model.md)
- [Project integration](docs/integration.md)
- [Development](docs/development.md)
- [Release process](docs/release.md)
- [Current limitations](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)

## License

This repository is `UNLICENSED`. Public visibility or possession of the source does not grant permission to use, copy, modify, or redistribute it beyond separately granted authorization.
