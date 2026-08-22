# Current Limitations

UI Eval currently proves deterministic execution, explicit interaction assertions, runtime health, required-evidence completeness, and optional raw pixel change for a constrained web scenario. It does not produce a universal UI quality score.

This page is part of the product contract. A schema field or future-facing type does not override these runtime limits.

## Support matrix

| Area | Current status | Consequence |
| --- | --- | --- |
| Platform | Web only. | iOS/Android types are forward contracts; there is no app driver. |
| Browser | Playwright Chromium, with an optional installed Chrome channel. | WebKit, Firefox, cross-OS renderer profiles, and device farms are not supported. |
| Page model | Exactly one declared browser page. | Any popup/additional page fails capture closed, including same-origin popups. |
| Core evaluation | Execution, interaction, and runtime deterministic gates. | All three evaluators and independent hard gates are mandatory. |
| Visual | Same-size PNG raw changed-pixel comparison. | A difference is `needs-review`; no calibrated pass/fail threshold exists. |
| Design | Token sets only, sealed inside the geometry evaluator config. | No online design sync, pinned design revision, `DesignContract` loading path, or design-node to runtime-node mapping. A token set is bound by policy, not by a design revision. |
| Geometry/typography | Constraint evaluation over structured web evidence, when a policy registers `geometry@0.1.0`. | Runs only from DOM/CSSOM evidence and never from raster pixels. Tolerances are policy inputs and are not calibrated against a labeled corpus, so a passing geometry gate is not a calibrated score. Padding, margin, and gap are not captured, so spacing is only observable through box rectangles. `box.overflowRight` measures a node against its containing element but does not inspect that element's clipping or scrolling behavior, so an intentional horizontal scroll container can be reported as a violation. |
| Accessibility | Evidence capability is declared in shared contracts, but no current evaluator/gate is implemented. | Do not claim an accessibility result. |
| Repeatability | One attempt. | No flake agreement or multi-attempt gate is executed. |
| Storage | Local filesystem CAS and run store. | No shared service, encryption at rest, RBAC, or managed retention. |
| Governance | Raw report only. | No baseline promotion, waiver, reviewer role, or append-only decision ledger. |
| Agents | None. | No MCP, fix task, protected patch workspace, mutation enforcement, or auto-rerun loop. |
| Service surface | CLI and local programmatic API. | No hosted API, queue, web console, or multi-tenant control plane. |
| Distribution | Public source repository; private, unpublished package. | Source visibility is not an open-source license, registry distribution, or compatibility/support promise. |

## Visual truthfulness

A local reference:

- must be project-relative and resolve to a regular non-symlink file;
- requires exactly one screenshot checkpoint;
- must have the same dimensions as the candidate screenshot;
- is bound to the selected checkpoint and candidate artifact digest;
- is marked `local-unprotected`.

Equal pixels can support a pass only when all required execution, interaction, runtime, and evidence gates also pass. Changed pixels require review. Corrupt, ambiguous, missing, escaped, or mismatched evidence is inconclusive.

There is no current support for calibrated tolerances, approved masks, dynamic-region governance, perceptual scoring, responsive metamorphic rules, or protected baselines.

## Declared but non-executable scenario state

The authoring and shared contract schemas reserve fields for future providers. The current runtime fails closed rather than ignoring requested state:

- `auth.secretRefs`;
- static, seed-script, and remote fixture providers (`mock-server` fixtures and
  fixture sets containing only that provider are executable);
- feature-flag sets;
- network profiles;
- native-app targets and steps.

Playwright storage state is supported under the exact-origin restrictions in the [Security model](security-model.md). There is no runtime secret injection provider.

## Policy restrictions

The current evaluator registry accepts only the implemented evaluator set and exact supported configuration shapes. It rejects:

- missing or optionalized execution/interaction/runtime core evaluators;
- missing independent core hard gates;
- required unknown evaluators or versions;
- a policy with zero gates;
- repeatability above one attempt;
- non-empty tolerances or dynamic regions;
- non-zero evaluator weights.

Optional unsupported evaluators remain visible as skipped. They do not contribute coverage or provenance as though they ran.

`agentMutation` fields can be preserved in policy contracts, but no agent or patch validator currently enforces them. They are not a security boundary.

## Evidence and privacy limits

UI Eval bounds and redacts structured evidence, but:

- redaction is pattern- and marker-based, not general DLP;
- screenshots can contain private information;
- ordinary text that does not match a credential pattern may remain in bounded payloads;
- candidate/reference PNGs have encoded-byte, dimension, and pixel-area
  ceilings, and trace files have an encoded-byte ceiling; exceeding a required
  limit is infrastructure/inconclusive rather than pass;
- browser rendering and trace recording may consume resources before their
  final artifacts can be inspected, and repeated runs have no global disk or
  retention quota;
- local CAS bytes are not encrypted;
- a process with filesystem access can read CAS data;
- collection budgets mean retained arrays may omit observations, with drops/truncation reported separately;
- no centralized retention or deletion policy is enforced.

Use synthetic accounts, deterministic scrubbed fixtures, ephemeral runners, and external access controls.

## Network and process isolation limits

Candidate-origin checks and authenticated browser-context egress denial are browser-automation controls. They do not isolate:

- the candidate development server;
- install/build hooks;
- DNS or browser maintenance traffic outside the controlled context;
- other host processes;
- a malicious trusted `devServer.command` configuration.

Authenticated scenarios that legitimately need third parties must use same-origin proxies or deterministic fixtures. The current runtime has no third-party allowlist.

The mock fixture provider is intentionally not a general proxy. It binds only
`127.0.0.1`, serves fixed bounded `GET`/`HEAD` responses, forbids redirects,
never forwards traffic, and requires the candidate to already target its fixed
port. It does not inject environment variables, match request bodies, generate
dynamic responses, or isolate the candidate process from other host network
access. Other local processes can reach the loopback listener while it is
running; authoritative CI still needs OS/container isolation.

CI that requires a real security boundary must add least-privilege containers, network policy, filesystem isolation, and short-lived credentials.

## Determinism limits

UI Eval fixes or records viewport, DPR, locale, timezone, browser/driver, OS/architecture, and font identity. It applies the largest declared checkpoint timeout to browser actions, navigation, and origin-guard response preflights, and waits for configured font, image, application-readiness, and stable-frame signals within the checkpoint timeout. It cannot make arbitrary applications deterministic, and authoritative runners still need an outer job deadline for browser or operating-system failure modes.

Normal context shutdown waits for installed HTTP route handlers to drain. Abort
cleanup instead removes routes with close-race errors ignored so cancellation
does not manufacture an unhandled response-disposal failure.

Potential sources of variation remain:

- remote data and assets not fixture-backed;
- system font differences;
- GPU/rasterizer/OS/browser changes;
- animation or timers outside the stabilization strategy;
- long polling and application-specific readiness;
- non-deterministic server state;
- use of real clock mode;
- browser-channel drift.

There is no cross-run capture cache and no repeatability gate. Compare runs only when their environment provenance is compatible.

## Failure/report limits

Preflight configuration, compilation, source-identity, and evaluator-registration failures occur before a sealed run and therefore return a structured CLI error without `report.json`.

After planning, the orchestrator attempts to write an infrastructure/inconclusive report when server, capture, evidence, or storage work fails and the run store is still writable. Final `report.json` and `report.html` publication occurs only after owned candidate and fixture cleanup succeeds. Cleanup failure may leave bounded intermediate run artifacts for diagnosis, but no finalized report. A completely unwritable run store cannot promise a report.

The static HTML view is convenience output. It does not contain every sensitive artifact and cannot replace `report.json` or authorized CAS inspection.

## Contract maturity

The wire family is currently alpha. Generated schemas, TypeScript types, validators, CLI semantics, and documentation must move together, but this public source repository has no released package compatibility history.

Forward contracts such as `DesignContract`, `ScenarioManifest`, and app unions may change before their runtime paths exist. Consumers must not infer a support promise from their presence.

## What not to claim

Do not describe the current implementation as:

- design-to-code validation;
- authoritative visual regression testing;
- a Figma evaluator;
- accessibility certification;
- a secure browser or operating-system sandbox;
- a DLP system;
- a protected holdout evaluator;
- an autonomous fixing agent;
- a shared team platform or SaaS;
- native mobile support;
- an open-source project;
- a publicly released package or supported software.

Planned increments and their evidence gates are listed in the [Roadmap](roadmap.md).
