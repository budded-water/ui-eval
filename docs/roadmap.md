# Roadmap

UI Eval's roadmap is capability-gated, not date-driven. Each increment must preserve the core truthfulness rule: missing capability or evidence is unknown/inconclusive, never an implicit pass.

The current implementation and its non-capabilities are documented in [Architecture](architecture.md) and [Current limitations](limitations.md). Items below are proposals, not commitments or shipped features.

## Guiding sequence

```text
stabilize standalone contracts and capture
                │
                v
prove reuse in an independent synthetic/consumer project
                │
                v
add structured design evidence and calibrated evaluators
                │
                v
add shared governance and CI workflows
                │
                v
add constrained agent and native-app integrations
                │
                v
consider a hosted multi-project platform
```

## Milestone 1: Standalone hardening

Current increment: [pinned integration suites](integration-runner.md) consolidate
engine verification, once-per-invocation preparation and complete acceptance
reporting for Web/WeChat. A synthetic prepared Web verifier checks the built CLI;
consumer migration and wider framework/device compatibility corpora remain work
to verify separately.

Goal: make the current public-source modular monolith self-contained and independently verifiable without implying package publication or open-source licensing.

Candidate scope:

- remove repository-relative assumptions inherited from earlier embedding;
- provide a synthetic framework-neutral example project;
- validate `init`, `doctor`, and `evaluate` outside the engine repository;
- add clean-package/install smoke tests;
- keep JSON schemas, derived types, validators, CLI help, and docs synchronized;
- define sanitized compatibility corpora for authoring inputs and reports;
- exercise real-browser origin/auth/popup/redaction/lifecycle cases in CI;
- decide license, package identity, package distribution, and support model;
- establish protected branch/tag policy and release authority for the public remote.

Exit evidence:

- an independent project runs without copying engine source;
- no engine module imports candidate application code, aliases, fixtures, or environment variables;
- authoring files survive migration unchanged or through a documented explicit migration;
- old sanitized reports remain explainable under the declared compatibility policy;
- package contents work from a clean installation artifact;
- security and release policies reflect an operational, not hypothetical, channel.

## Milestone 2: Structured design evaluation

Goal: evaluate selected design dimensions only when authoritative structured design evidence exists.

Candidate scope:

- pinned immutable design snapshots;
- design source adapter separated from gate-time execution;
- structured node tree, layout, style, typography, token, and asset capabilities;
- explicit design-target to scenario-checkpoint binding;
- deterministic design/runtime element mapping with confidence;
- geometry and typography evaluators backed by required capabilities;
- calibrated visual evaluator and a manually labeled Gold Corpus;
- desktop/mobile profiles selected from actual design targets.

Exit evidence:

- design revisions and artifacts are content-addressed and reproducible offline;
- geometry/typography never run from raster evidence alone;
- injected layout, typography, content, and runtime defects are detected against a labeled corpus;
- critical false-pass observations and sample size are reported;
- repeated captures meet a predeclared stability target;
- thresholds are versioned policy, not hard-coded folklore.

## Milestone 3: Shared Web governance

Goal: support team CI without allowing mutable baselines or policy to hide raw evidence.

Candidate scope:

- project-scoped shared CAS with short-lived credentials;
- Design/Baseline/Candidate comparisons;
- append-only baseline and waiver decisions;
- reviewer authorization and compare-and-swap baseline promotion;
- Git provider check summaries and controlled artifact retention;
- impact-based scenario selection plus critical smoke suites;
- repeatability and flake reporting;
- protected policy/scenario/fixture materialization outside writable candidate workspaces.

Exit evidence:

- raw reports remain immutable while effective disposition names its ledger revision;
- baseline/waiver updates require an independent reviewer and audit reason;
- project/artifact authorization prevents cross-project reads;
- CI cannot turn invalid evidence into green;
- impact selection expands conservatively when mapping is incomplete;
- retention and deletion leave auditable records.

## Milestone 4: Constrained repair integration

Goal: let an external coding agent consume findings and verify scoped changes without owning evaluation truth.

Status: partially implemented. The local CLI now supports bounded check/evaluate/repair/rerun loops with immutable reports, predeclared thresholds, repository mutation auditing, iteration budgets, score deltas, plateau detection, and stop conditions. A separate writable patch workspace, read-isolated holdouts, an MCP service, reviewer governance, and calibrated maintenance metrics remain planned.

Candidate scope:

- stable CLI/API or MCP read/run/report interface;
- server-generated fix tasks from immutable findings;
- path/file/line/iteration budgets enforced outside prompts;
- separate writable patch workspace and read-only policy/design/holdout material;
- automatic change-impact classification remains planned; current selection is
  explicit and append-only from a reviewed optional pool, with a mandatory floor
  and full-pool fallback. Local/remote execution profiles are implemented as
  described in [Execution profiles](execution-profiles.md);
- patch audit for skips, masks, screenshot replacement, hard-coded viewport hacks, and test weakening;
- attempt provenance, cost, score delta, plateau, and stop conditions;
- withheld/holdout validation only where read isolation is real.

Exit evidence:

- the agent cannot change evaluator, policy, required scenario, baseline, waiver, or historical run truth;
- an invalid or out-of-scope patch is rejected before verification;
- holdout details remain unavailable and attempts are rate/budget limited;
- repairs improve predeclared quality metrics without increasing critical regressions;
- human review time and maintenance cost are measured against a baseline.

## Milestone 5: Native-app adapters

Goal: reuse upper contracts and governance without pretending apps have DOM/CSSOM evidence.

Candidate scope:

- a validated Maestro capture adapter for a real target project;
- screenshot, accessibility/view hierarchy, interaction, crash/log, and device-environment evidence;
- normalized logical/physical units, pixel ratio, safe areas, orientation, keyboard, and system UI;
- optional project debug metadata for component/token/layout identity;
- platform-specific policy capability negotiation.

Exit evidence:

- app evidence absence produces unsupported/unknown by dimension;
- Web-specific structured rules do not run against insufficient app evidence;
- adapter conformance covers simulator/emulator lifecycle and artifact integrity;
- at least one real project proves the shared contract without schema forks.

## Milestone 6: Hosted multi-project platform

Goal: consider service boundaries only after local and shared workflows prove their value.

Candidate scope:

- control-plane database, object storage, job queue, cancellation, and audit events;
- isolated untrusted runners;
- project RBAC and reviewer/admin separation;
- review console and history/trend views;
- policy profiles and managed retention;
- bounded multi-agent coordination only for non-overlapping source ownership.

Exit evidence:

- project isolation and threat model pass independent review;
- local/offline execution remains possible for sensitive projects;
- service cost and operational burden are justified by measured use;
- shared state does not create a second mutable source of contract truth;
- migration/export paths avoid vendor lock-in for raw reports and artifacts.

## Deferred research

The following stay outside committed milestones until evidence justifies them:

- WebKit/Firefox and multiple authoritative OS renderer profiles;
- motion/video evaluation;
- Canvas, map, chart, WebGL, and complex dynamic-region evaluation;
- design-system token enforcement;
- calibrated VLM semantic judging;
- device farms and broad physical-device gates;
- hosted multi-tenant commercial packaging.

VLM output, if explored, remains advisory until a fixed Gold Corpus demonstrates bounded error. It must not become the sole source of a formal pass.

## Roadmap governance

Before moving an item into current architecture:

1. define the contract and required capabilities;
2. define failure, unknown, and infrastructure semantics;
3. identify new trust boundaries and storage/retention impact;
4. add conformance and negative tests;
5. calibrate against independent labeled evidence where scoring is involved;
6. update schemas, validators, CLI/API, reports, docs, and changelog together;
7. remove the corresponding limitation only after verification.

Roadmap prose is not an API promise. The current code, validated contracts, and release evidence determine what is supported.
