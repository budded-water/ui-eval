# Contracts and Canonical Truth

UI Eval is contract-first: authoring, execution identity, evidence, policy, and reports are explicit JSON values that are validated and content-digested before downstream use.

This document explains ownership, lifecycle, and compatibility. It intentionally does not duplicate every schema field. The checked-in schemas and runtime validators are the field-level source of truth.

## Truth hierarchy

The current repository has four related representations with distinct roles:

1. TypeBox sources under `src/contracts/`, `src/project/`, `src/agent/`, and the separate experimental `src/native-pilot/` define the wire and active authoring shapes.
2. `schemas/*.schema.json` are generated JSON Schema 2020-12 wire artifacts for the current checkout.
3. TypeScript types are derived from TypeBox with `Static<>`; they must not be maintained as a second handwritten model.
4. Runtime validators add digest and cross-object invariants that JSON Schema alone cannot express.

The generated JSON schemas are canonical for structural wire shape. The matching runtime validators are canonical for semantic integrity such as digest recomputation, project/store scope, and exact binding between a report and its inputs.

Documentation and examples are explanatory consumers. They must link to schemas rather than maintain independent field inventories. When prose and a schema disagree, fix the prose or implementation; do not treat the duplicate as an alternate contract.

This repository does not provide a supported schema API or immutable network endpoint. Use the checked-in `schemas/` files from an exact source revision or the package's `./schemas/*` export from a separately authorized local build. A browsable GitHub file or schema `$id` is not a stable distribution URL.

## Version dimensions

The isolated [native pilot](native-pilot.md) uses `uieval.io/native-pilot-v1`
project/scenario/result schemas. It neither consumes generic native forward
contracts nor emits the Web policy report. Consumers must not interpret a native
pilot interaction pass as a Web hard-gate or release-readiness pass.
Its optional boolean `restartApp` defaults to `true`; `false` declares App reuse.
The flow compiler and evidence validator bind the same value, and the project
input participates in the native plan digest.

These versions solve different problems and must not be conflated:

| Version | Purpose |
| --- | --- |
| Package SemVer | Source/API and executable distribution compatibility. No package distribution is currently configured. |
| `apiVersion` | Wire-contract family; current authoring and envelopes use `uieval.io/v1alpha1`. |
| Evidence `schemaVersion` | Payload shape for DOM, layout, styles, console, network, and crash evidence. |
| Evaluator version | Meaning of an evaluator's measurements and findings; pinned in policy and report provenance. |
| Adapter/orchestrator version | Capture and coordination provenance. |
| Local store ID | On-disk CAS format namespace; currently the metadata-aware `local-cas-v2`. |

An alpha wire family is not a promise of permanent compatibility. Even so, released or shared snapshots must remain immutable. A breaking wire change requires a new wire version and a migration path; changing an on-disk invariant requires a new store namespace or an explicit audited migration. Bumping only the package version does not make either break safe.

## Executable contract chain

The current web execution path is:

```text
ProjectConfig + ScenarioSource + PolicySource
              │
              v
      ResolvedScenarioPlan
              │
              v
       SealedRunManifest
              │
              v
         CaptureBundle
              │
              v
EvaluationPlan + EvaluationPolicy
              │
              v
       EvaluationReport
```

`report.json` is the final authoritative raw result. `report.html` is a presentation projection and has no independent decision semantics.

## Schema inventory

| Schema | Current role |
| --- | --- |
| `project.schema.json` | Active human-authored project/server/device/default/capability configuration. |
| `deployment-identity.schema.json` | Active bounded metadata checked against the selected remote profile. |
| `scenario-source.schema.json` | Active human-authored web scenario input. |
| `policy-source.schema.json` | Active web authoring: compact `web-default` profile or existing full policy. |
| `agent-suite.schema.json` | Active Agent scenario/check/mutation configuration. |
| `agent-summary.schema.json` | Validated Agent terminal result; HTML is derived from the same value. |
| `resolved-scenario-plan.schema.json` | Active compiler output and complete capture input. |
| `sealed-run-manifest.schema.json` | Active execution/source/build/adapter identity. |
| `capture-bundle.schema.json` | Active immutable evidence index and execution result. |
| `evaluation-plan.schema.json` | Active sealed evaluator inputs and evaluation key. |
| `evaluation-policy.schema.json` | Active materialized policy with CAS-bound evaluator configs. |
| `evaluation-report.schema.json` | Active raw outcome, coverage, gates, findings, and provenance. |
| `scenario-manifest.schema.json` | Forward contract; the CLI currently compiles `ScenarioSource` directly and does not materialize this envelope. |
| `geometry-evaluator-config.schema.json` | Active sealed geometry evaluator config: a normalized token set plus the five constraint kinds. |
| `design-contract.schema.json` | Forward contract; carries rendered-image targets and a normalized token set, but the current orchestrator does not sync, bind, or evaluate either. |

`DesignContract` describes design facts in a source-neutral and platform-neutral
form, so that a producer reading Figma, a stylesheet, or a serialized theme emits
one shape. It carries normalized value sets, scales, and ranges; it carries no
constraint selection, tolerance, or severity, which are policy. Colors are
normalized sRGB components rather than serialized strings, and lengths are
declared in logical units. Declared capabilities must match the payloads present:
`rendered-image` requires `targets`, `tokens` requires `tokenSet`, and a
capability this version cannot carry is rejected rather than silently accepted.
See [ADR 0002](adr/0002-design-constraint-contract.md).

Some shared schemas include iOS/Android locators and plans so future adapters can share an envelope. The current authoring loader and executable adapter are web-only. **Schema-valid does not mean runtime-supported.** Capability negotiation and the evaluator registry make the executable boundary explicit.

### Public authoring API

The package entry point gives the executable web authoring formats explicit
names:

- `ProjectConfigSchema`, `validateProjectConfig`, and `assertProjectConfig`;
- `WebScenarioSourceSchema`, `validateWebScenarioSource`, and
  `assertWebScenarioSource`;
- `WebPolicySourceSchema`, `validateWebPolicySource`, and
  `assertWebPolicySource`.

Those structural validators use the same TypeBox schemas that generate
`project.schema.json`, `scenario-source.schema.json`, and
`policy-source.schema.json`. The generic
`ScenarioSource` / `validateScenarioSource` contract under the explicit
`forwardContracts` namespace is a forward multi-platform envelope; passing it does **not**
mean the current CLI can execute that input.

Structural validation is only the first boundary. `loadProjectConfig`,
`loadScenarioSource`, and `loadPolicySource` additionally enforce repository-aware semantic rules,
real-path containment, safe referenced files, and current capability support.
Programmatic callers that intend to execute a run should use those loaders (or
the high-level `evaluateScenario`) rather than treating structural validation as
authorization to capture.

This source revision narrows the root programmatic API to executable web
contracts. Consumers of generic native/design/governance names should migrate
to `forwardContracts`, for example
`forwardContracts.validateScenarioSource(input)`. Their wire schemas remain
available; changing the import does not add runtime support.

The `web-default` profile accepts evaluator and gate additions. It expands
mandatory core declarations plus advisory visual support and required-evidence
coverage before semantic validation and CAS materialization. Additions cannot
replace default IDs: duplicate IDs are rejected. Existing complete policies
remain accepted. The loaded policy digest describes the expanded value, and
the generated run's `policy.json` records every effective setting. A profile is
an authoring convenience, not an alternate evaluation contract or repair scope.

## Authoring ownership

Candidate repositories own these reviewed inputs:

- `ui-eval/project.json`;
- `ui-eval/scenarios/*.json`;
- `ui-eval/policies/*.json`;
- explicitly reviewed, scrubbed fixture or browser-state files referenced by those inputs.

Authoring files may use a `$schema` editor hint, but it does not affect runtime validation. The runtime always validates against its own matching contract implementation.

Project references are resolved relative to the directory containing `ui-eval/project.json` and must remain within the real candidate project root. Absolute or relative spelling does not bypass real-path and symlink containment.

## Compilation and immutability

`WebScenarioSource` is convenient human input for the current CLI, not the adapter input. Compilation resolves:

- base URL references;
- matrix variants and exclusions;
- device viewport and scale;
- locale, theme, and timezone defaults;
- required capture capabilities;
- permitted storage state and artifact digests, including validated
  `mock-server` configs;
- setup, steps, cleanup, assertions, and checkpoints.

The resulting `ResolvedScenarioPlan` is immutable and self-contained for capture. The adapter must not reread mutable project defaults while executing it.

`MockServerFixtureConfig` is a separate generated contract for the contents of a
`mock-server` config artifact. It permits only a fixed loopback port, bounded
exact `GET`/`HEAD` routes, non-redirect response statuses, fixed JSON/text
bodies, and an explicit required-use bit. The compiler validates it before CAS
materialization, and the runtime validates the resolved artifact again before
binding a port.

Policy materialization similarly replaces inline or referenced evaluator configuration with project-scoped `ArtifactRef` values and canonical config digests. Evaluators consume the sealed policy; they do not resolve a floating file path at evaluation time.

## Canonical JSON and digests

Canonical JSON:

- accepts only JSON-compatible plain objects and arrays;
- sorts object keys;
- normalizes negative zero;
- rejects non-finite numbers, sparse arrays, cycles, functions, symbols, `undefined`, and other non-wire values;
- excludes nothing unless a contract call site selects a named exclusion profile.

Digests use lowercase SHA-256 in the form `sha256:<hex>`. Named profiles make self-referential or operational exclusions explicit, for example:

- a resolved plan excludes `planDigest` when computing that digest;
- a run manifest excludes `executionId` and `captureKey` from its capture-key input;
- an evaluation plan excludes `evaluationId` and `evaluationKey` from its evaluation-key input;
- an envelope spec digest is computed from the immutable spec rather than creation metadata.

Validators recompute these values. A stale copied digest fails validation.

## Capture and evaluation identities

Capture and evaluation have separate identities because a policy or evaluator change does not necessarily require a new browser run:

```text
Capture identity
  = source/build + resolved scenario + requested evidence
    + adapter + intended environment

Evaluation identity
  = normalized decision-relevant candidate evidence
    + optional local reference + evaluator/config versions
    + sealed policy
```

The current implementation does not reuse a cross-run capture cache. Observed browser, OS, architecture, driver, locale, timezone, and font identity are still recorded and bound into normalized evaluation evidence so a report does not hide renderer drift.

## Artifact references

Large or sensitive values are referenced, not embedded as base64 or arbitrary paths:

```text
ArtifactRef
  id
  projectId
  storeId
  digest
  mediaType
  sizeBytes
  sensitivity
  optional redaction metadata
```

An `ArtifactRef` is untrusted until a registered store verifies scope, containment, size, and digest. It is not a filesystem path or URL. Physical deduplication must not bypass project/store identity.

Sensitivity on a caller-provided reference is also not an authority. The local CAS persists the strongest classification observed for a digest, and the presentation layer applies channel minimums. Classification can become stricter but cannot be downgraded by a later reference.

## Evidence contracts

Each checkpoint contains an `EvidenceRecord` per requested channel. A record distinguishes:

- `captured`;
- `missing`;
- `corrupt`;
- `not-applicable`.

Required-evidence completeness is explicit. Missing or corrupt required evidence produces invalid/inconclusive semantics rather than pass.

Current structured evidence payloads have their own versions, including:

- `uieval.dom/v1alpha1`;
- `uieval.layout/v1alpha1`;
- `uieval.styles/v1alpha1`;
- `uieval.console/v1alpha1`;
- `uieval.network/v1alpha1`;
- `uieval.crash/v1alpha1`.

Console, network, and crash payloads include collection counts for captured, dropped, and truncated entries. Consumers must not interpret an empty retained array as proof that no observation was dropped.

Step and assertion results retain status and error origin. Interaction correctness comes from explicit results, not from guessing behavior from pixels.

## Evaluation report semantics

An `EvaluationReport` separates:

- `executionOutcome`: `valid`, `invalid-evidence`, or `infra-error`;
- `rawStatus`: `pass`, `fail`, `needs-review`, or `inconclusive`;
- coverage counts, including unsupported and invalid work;
- hard/soft gate results and unknown handling;
- immutable findings with stable fingerprints;
- optional `metrics`, containing raw evaluator values, including zero-valued
  measurements, rather than calibrated quality scores;
- actual evaluator execution provenance.

Configured or skipped evaluators are not reported as executed. Visual findings from a local reference identify the exact checkpoint, candidate screenshot digest, and reference digest. A reference path by itself is not sufficient identity.

The current runtime does not produce waiver-adjusted dispositions or baseline decisions. Any future governance layer must append decisions without rewriting this raw report.

Current runs seal their evaluator metrics into the report spec and bind them to
the values used for gates. `visual.changedPixelRatio` is present for a measured
comparison, including identical pixels, and absent when comparison is unknown.
Reports without `metrics` remain structurally readable; absence is not proof of
a zero result. The additional field extends the current alpha contract; readers
using older strict schemas need the updated source revision to read new output.

## Change discipline

A contract change is incomplete unless all affected surfaces move together:

1. Update the TypeBox authoring source.
2. Update semantic validation and canonical digest logic if needed.
3. Regenerate `schemas/*.schema.json`.
4. Add valid, invalid, round-trip, and compatibility fixtures.
5. Update authoring/compiler/adapter/report consumers.
6. Update docs and executable examples without copying full field definitions.
7. Explain compatibility and migration impact in the changelog.

Run `bun run schema:check` to detect generated-schema drift. See [Development](development.md) for the complete verification ladder and [Release](release.md) for compatibility gates.
