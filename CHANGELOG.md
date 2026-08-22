# Changelog

All notable user-visible changes to this source repository should be recorded here.

The source repository is public, but the project has no package release or configured package distribution channel. Version headings must not be marked as released until an approved immutable artifact exists.

## Unreleased

### Added

- Public source hosting at `https://github.com/zw-befreed/ui-eval` with GitHub
  Private Vulnerability Reporting enabled; the project remains `UNLICENSED`,
  unpublished as a package, and without a support promise.
- Standalone `init`, `doctor`, and `evaluate` CLI with a buildable package bin
  and programmatic entry point.
- Contract compiler, Playwright web capture adapter, deterministic evaluators,
  policy engine, local CAS/run store, and JSON/HTML reporting pipeline.
- Generated JSON Schemas, a dependency-free executable web example, and CI
  coverage for unit, schema, documentation, build, package, and real Chromium
  paths.
- Standalone current-capability documentation for architecture, contracts, security, integration, development, release readiness, limitations, roadmap, and repository governance.
- ADR 0002 defining a design-source-neutral and platform-neutral constraint
  contract, and a `measure-capture-noise` script that derives an observed
  run-to-run noise floor instead of hand-picking tolerances.
- Reference Tailwind v4 design-token producer under `src/design-adapters/`, with
  a `design:import` entry point. It parses declarative CSS only, resolves
  `var()` and a restricted `calc()` subset, normalizes OKLCh/hex/rgb to sRGB
  components and rem/px to logical pixels, and reports every token it could not
  resolve instead of dropping it. It emits a token set, not a sealed contract.
- `design:check`, a read-only drift guard that compares the Tailwind producer's
  `valueSets` and `scales` with a sealed geometry config while leaving
  policy-authored `ranges` outside the producer ownership profile. Drift exits
  `1`; invalid or unresolved input fails closed with exit `2`.
- Bounded `mock-server` fixture configs and per-matrix-variant loopback fixture
  lifecycle. Exact fixed routes are sealed before capture, cannot forward or
  redirect, and may be marked required so an unused fixture becomes
  infrastructure failure instead of manufactured data-flow coverage.
- Final run reports are published only after owned candidate and fixture server
  cleanup succeeds, so a cleanup failure cannot leave a misleading pass report.
- Font stabilization no longer follows its bounded status check with an
  unbounded `document.fonts.ready` wait between matrix variants.
- Browser navigation receives the same bounded default as other Playwright
  operations before the first candidate request, including origin-guard
  response preflights.
- Browser-context shutdown drains origin-guard route callbacks and tolerates
  response disposal racing an explicit abort.
- Shared value normalization under `src/normalize/`, a normalized property space
  and web evidence normalizer, and the five constraint kinds from ADR 0002 under
  `src/evaluators/geometry/`. A found defect is reported as a defect while
  unreadable values are counted separately, so a coverage gap never masks a
  failure and an unmatched or unreadable constraint never passes.
- `design:audit`, an offline analysis entry point that composes the token
  producer, the evidence normalizer, and the constraint kinds over an existing
  run. It is not a gate and does not affect any run disposition.
- Runnable `geometry@0.1.0` evaluator. A policy that registers it evaluates the
  five constraint kinds against structured web evidence and contributes
  `geometry.violations`, `geometry.failedConstraints`, and
  `geometry.indecisiveConstraints` metrics, geometry coverage counts, and
  `design-candidate` findings. Its config is the new
  `geometry-evaluator-config.schema.json`, sealed through the existing
  `configPath` mechanism. A policy that does not register it is unaffected.

### Changed

- Widened `DesignContract` from image-only to also carry a normalized token set
  of value sets, scales, and ranges, plus a `structured` source kind and an
  optional `targets` list. Existing image-only contracts remain valid unchanged.
  Declared capabilities and present payloads must now agree, unbounded and
  inverted ranges are rejected, and token identifiers must be unique. A
  standalone `DesignContract` is not bound at evaluation time; the optional
  geometry evaluator instead consumes a token set sealed in its policy config.
- Named the currently executable public authoring contracts
  `ProjectConfigSchema` and `WebScenarioSourceSchema`, distinct from the forward
  multi-platform scenario envelope.

### Fixed

- Normalized `lab()` and `oklab()`, the notations Chromium serializes computed
  colors into when a stylesheet declares `oklch()`. Without them every correctly
  tokenized color was counted as unreadable while only hardcoded hex and rgb
  values were compared, so a color constraint silently checked a biased subset
  of the page.

- Made the packaged CLI entry independent of its invocation path so package
  manager bin symlinks execute instead of silently exiting.
- Serialized owned Playwright context/browser shutdown so an abort after trace
  finalization cannot race concurrent close operations and stall cleanup.
- Isolated candidate-server lifecycle per matrix variant. An owned server is now
  stopped before the next variant starts, preventing generated run artifacts
  from driving a live framework watcher into a stalled second capture; cleanup
  failure causes the matrix to fail closed. Reused servers remain unowned and are
  identity-checked for each variant.

### Security

- Added fail-closed byte, image-dimension, pixel-area, and file-stability
  budgets for screenshots, local PNG references, and Playwright traces.
