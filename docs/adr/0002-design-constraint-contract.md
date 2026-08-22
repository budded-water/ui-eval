# ADR 0002: Platform-Neutral Design Constraint Contract

- Status: Accepted
- Scope: Design contract shape, evidence normalization, geometry/typography evaluation inputs
- Implemented: the contract shape, the normalized property space, the web
  evidence normalizer, the five constraint kinds, a reference Tailwind producer,
  and a runnable `geometry@0.1.0` evaluator. Not implemented: binding a
  standalone `DesignContract` at gate time, design-node to runtime-node mapping,
  tolerance calibration against a labeled corpus, and any native adapter. The
  token set is therefore sealed inside the evaluator config rather than loaded
  from a pinned design revision; see docs/limitations.md.

## Context

The current `DesignContractSpec` accepts exactly one capability, `rendered-image`, and one source kind, `image`. Geometry and typography are unsupported: `dom`, `computed-styles`, and `layout-metadata` are captured and stored, but every geometry-dimension record is counted as `unsupported` in coverage.

Two forces now push against that shape.

**Design sources vary per project.** Candidate projects do not share a design origin. One project's authoritative values live in Figma variables; another's live in a Tailwind `@theme` block; another's live in a framework theme object that was hand-transcribed from a design file. A contract that encodes one origin's field names makes every other origin a schema fork.

**Platforms vary per project.** Web evidence is DOM plus CSSOM in CSS pixels. Native evidence is a view hierarchy in points or density-independent pixels. A contract that encodes CSS property names cannot describe a native target without pretending native apps have a CSSOM, which Milestone 5 explicitly forbids.

The naive response — extract Figma values into a Figma-shaped contract and compare CSS strings against them — fails both forces at once, and additionally makes the engine depend on candidate application code, which ADR 0001 prohibits.

There is also a weaker but more valuable class of check available today that needs no design source at all. Most implementation drift is not a transcription error against a known value; it is an ad-hoc value that belongs to no scale at all. Detecting "this radius is not any radius in the system" requires only a value set, and a value set can be produced from the candidate's own token layer. Treating a design file as a precondition for any geometry evaluation therefore blocks the majority of available signal on the minority case.

## Decision

Separate three concerns that the current shape conflates: **design facts**, **constraint form**, and **strictness**. Each is owned by a different artifact, and no artifact may name another's vocabulary.

```text
DesignContract   facts       normalized token sets: value sets, scales, ranges, ratios
EvaluationPolicy strictness  which constraints run, tolerance, severity, required-ness
Engine           form        five constraint primitives, unaware of any design source or platform
```

The engine gains a normalized property space. Both sides — design facts and captured evidence — are translated into that space before any comparison happens. Comparison never sees a Figma field name, a CSS property string, or a platform unit.

```text
  Figma ────┐                                      ┌──── web (DOM + CSSOM)
  Tailwind ─┼─→ design adapter ─┐      ┌─ evidence normalizer ─┼──── native (view hierarchy)
  theme JSON┘                   ↓      ↑                       └──── (future adapters)
                          ┌──────────────────────────┐
                          │ normalized property space │
                          └──────────────────────────┘
                                       ↓
                        geometry / typography evaluator
                             (five constraint kinds)
```

### Normalized property space

The engine addresses properties by abstract name, never by platform property. Adapters own the mapping; the evaluator owns none of it.

| Abstract property | Web source | Native source (Milestone 5) |
| --- | --- | --- |
| `box.width`, `box.height`, `box.x`, `box.y` | `layout` evidence `rect` | view frame |
| `box.radius` | `computedStyle.borderRadius` | corner radius |
| `fill.color`, `text.color`, `stroke.color` | `backgroundColor`, `color`, `borderColor` | view background, label color, border |
| `text.size`, `text.weight`, `text.lineHeight` | `fontSize`, `fontWeight`, `lineHeight` | font point size, weight, line height |
| `text.family` | `fontFamily` | font family |
| `effect.shadow` | `boxShadow` | layer shadow |

Values are normalized before comparison:

- **Color** becomes an sRGB 8-bit tuple plus alpha. The engine never compares color strings, so `#2e8b57`, `rgb(46, 139, 87)`, and a native color object are the same value.
- **Length** becomes a logical unit paired with the capture's scale factor, recorded in the existing `renderSpace`. The engine never sees `"16px"`.
- **Family** becomes the first non-fallback family, unquoted and case-folded.
- A value that cannot be normalized is `unnormalizable` and counts as invalid evidence. It never counts as a pass.

Spacing is derived from adjacent `rect` values rather than captured directly. The current evidence payload records `display`, `position`, `color`, `backgroundColor`, `borderColor`, `borderRadius`, `boxShadow`, `fontFamily`, `fontSize`, `fontWeight`, and `lineHeight`; it does not record padding, margin, or gap. Derived spacing is also closer to rendered truth than declared box properties, so this is a deliberate choice rather than a temporary gap.

### Five constraint kinds

The engine implements exactly these, and adding a sixth requires an ADR. Each names an abstract property, resolves its expectation from a token-set reference, and declares its own unknown semantics.

| Kind | Asserts | Expectation source | Typical use |
| --- | --- | --- | --- |
| `value-in-set` | value belongs to a finite set | `valueSets[id]` | color in palette, family in approved list |
| `value-on-scale` | value lands on a scale step within tolerance | `scales[id]` | size on a type scale, spacing on a 4/8 grid |
| `value-in-range` | value lies within `[min, max]` | `ranges[id]` | minimum touch target, maximum line length |
| `cross-node-equal` | grouped nodes agree on a property | none (self-referential) | one component's geometry consistent across pages |
| `ratio` | ratio of two properties lies within a range | `ranges[id]` with `unit: ratio` | line height over font size, aspect ratio, contrast |

`value-in-range` and `ratio` share one expectation shape and differ only in the
unit and in how many properties the evaluator reads, so the token set carries one
`ranges` collection rather than two near-identical ones.

`cross-node-equal` requires no design source at all. It groups by `uiId`, `testId`, or role plus accessible name — identities the layout and styles payloads already carry — and compares across checkpoints, matrix variants, and scenarios.

Every constraint declares `requireMatch`, defaulting to `true`. A constraint whose scope matches zero nodes is invalid, not vacuously passing. Silent zero-match is the standard way a conformance suite decays into a green run that asserts nothing.

### Failure, unknown, and infrastructure semantics

| Condition | Disposition |
| --- | --- |
| Constraint evaluated, expectation met | pass |
| Constraint evaluated, expectation missed | product failure |
| Required abstract property absent from captured evidence | `unsupported` for the dimension |
| Captured value cannot be normalized | invalid evidence |
| Constraint scope matches zero nodes and `requireMatch` is true | invalid evidence |
| Policy references a token-set id absent from the contract | configuration error, exit `2` |
| Platform does not expose the capability the property needs | `unsupported`, never pass |

This preserves the core rule without exception: absent capability or absent evidence is unknown or inconclusive, never an implicit pass.

### Contract shape

`DesignContractSpec` widens additively. `capabilities` becomes a union whose existing `rendered-image` member keeps its meaning, `source` gains a `structured` kind, and a `tokenSet` member carries facts only. Existing image-only contracts remain valid without migration.

The token set holds no constraint semantics, no severity, and no tolerance. It is a normalized vocabulary: named value sets, named scales with a unit and steps, and named ranges. An adapter that knows nothing about policy can produce it, and two adapters reading different origins can produce byte-identical output for the same design system.

Capabilities reuse the existing forward-facing design vocabulary rather than introducing a second narrower one that would drift from it. Which members this version can carry is enforced structurally instead: `rendered-image` requires `targets`, `tokens` requires `tokenSet`, a payload without its capability is rejected, and a capability with no payload in this version is rejected rather than silently accepted.

Constraint instances live in the geometry evaluator's policy configuration and reference token-set entries by id. Tolerance and severity are therefore versioned policy rather than adapter behavior, satisfying the Milestone 2 requirement that thresholds are policy and not hard-coded folklore.

### Adapter boundary

Design adapters consume declarative or serialized inputs only: stylesheets, JSON, design-tool API responses. An adapter must never execute, import, or evaluate candidate application code, including theme modules written in TypeScript. Where the authoritative token values exist only inside executable code, the candidate project owns a small export step that emits JSON, and the adapter consumes that JSON.

This keeps ADR 0001's rule intact — no engine module imports candidate code — and avoids making the engine responsible for parsing arbitrary application source. Reference adapters may live under `src/design-adapters/`, reachable from the CLI and never imported by an evaluator.

### Portability acceptance

The design is portable when a second candidate project with a different token carrier is onboarded by writing `ui-eval/project.json` and running one adapter, with no change under `src/`. The workspace already contains a suitable second consumer: one project carries tokens as CSS custom properties in a Tailwind `@theme` block, another carries them as a framework theme object. Same platform, unrelated carriers. A third consumer on a native platform validates the unit normalization independently.

A grep-level dependency test enforces the boundary: no identifier belonging to a design tool, CSS framework, or UI library may appear under `src/contracts/` or `src/evaluators/`.

## Consequences

### Positive

- Design source and platform become adapter concerns; the evaluator has one input shape.
- The majority of available signal — values that belong to no scale — becomes reachable before any design file exists.
- Constraint tolerance and severity live in versioned policy, where the roadmap requires them.
- Native support later reuses the constraint kinds unchanged, because none of them mention CSS or DOM.
- Two projects sharing a design system produce comparable token sets even from different carriers.

### Negative

- Two translation layers exist where there was none, and each is a place a mapping bug can hide.
- The abstract property table is a new compatibility surface that must be versioned.
- Projects that only want "compare to the design file" pay for indirection they do not use.
- Spacing derived from adjacent rectangles is harder to explain in a report than a declared padding value.

### Risks and mitigations

- **Abstraction that fits only web:** validate the property table against a native evidence sample before implementing the evaluator, not after.
- **Adapter divergence:** define one conformance corpus that every adapter must reproduce, so two carriers of one design system are provably equal.
- **Vacuous passes:** default `requireMatch` to true, and report matched-node counts per constraint in the report.
- **Tolerance folklore:** derive initial tolerances from a measured repeat-capture noise floor, and record the measurement alongside the policy revision.
- **Boundary erosion:** enforce the design-source vocabulary ban with a test, not with review alone.

## Revisit triggers

- A real constraint cannot be expressed as one of the five kinds, and composing them is materially worse than a sixth kind.
- A native adapter cannot populate a required abstract property without inventing evidence.
- Two adapters for the same design system cannot be made to agree on the conformance corpus.
- Measured noise makes a scale tolerance wider than the smallest step it must distinguish, which would make `value-on-scale` unable to fail.

## Rejected alternatives

### Encode Figma's structure directly in the design contract

Rejected because it makes every non-Figma origin a schema fork, and because it would place a specific vendor's field names inside a contract that native and non-design-tool origins must also satisfy.

### Compare captured CSS strings against expected CSS strings

Rejected because equal values have unequal serializations, unequal values can share a serialization across units, and the comparison cannot be expressed for a platform without a CSSOM.

### Put constraints in the design contract rather than in policy

Rejected because it would give adapters authority over strictness. An adapter would then decide what constitutes a failure, thresholds would vary by origin rather than by project decision, and the roadmap requirement that thresholds are versioned policy could not hold.

### Require a design source before any geometry evaluation runs

Rejected because self-referential constraints need no design source, and because gating all geometry work on design availability discards the larger share of detectable drift while waiting for the smaller share.

### Let adapters import the candidate's theme module

Rejected because it executes candidate application code inside the engine process, which ADR 0001 forbids, and because it makes evaluation depend on the candidate's build configuration resolving correctly.
