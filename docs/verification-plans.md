# Risk-based verification plans

## Ownership and evidence levels

Failure: passing smoke can be mistaken for verification of a changed feature when
its affected states or real environment were never exercised. Shared rules and
reconciliation belong to UI Eval; consumers own business outcomes, commands,
scenarios, fixtures and delivery gates. The UX skill guides risk selection;
updating a user-installed skill does not update this engine or execute a candidate.

| Level | Evidence scope |
| --- | --- |
| L1 | Static/source/configuration checks. |
| L2 | Automated behavioral checks, including synthetic harness tests. |
| L3 | An explicitly identified bundle, native build or package subcheck. |
| L4 | A scoped browser, simulator or DevTools UI execution. |
| L5 | Relevant physical-device and real-service/environment observations. |

Levels are not cumulative. Fake-driver tests remain L2 even when producing
synthetic runtime reports. Builds do not establish UI acceptance; code review is
independent. Before implementation identify the reported outcome, affected
callers/platforms and dependencies hidden by mocks. Visible interactions need
affected runtime evidence; native changes add builds; real GPS/network/payment
or device-specific claims need that real environment. Pure logic may use L1/L2;
documentation uses relevant document checks. Record omissions with reasons, never
drop necessary checks because environments are unavailable, and record mid-task
planning honestly in `planningContext`. Plan quality remains a trusted decision.

## Implemented boundary

Suites may reference candidate-owned `verificationPlan` files following
[VerificationPlan](../schemas/verification-plan.schema.json). This differs from
the existing `EvaluationPlan` evaluator-input contract. Requirements name a
check/scenario/external selector, level, environment, expected outcome, rationale,
category and whether visual inspection is necessary. Commands and scenario
assertions must implement the prose outcome: the engine cannot interpret prose
or shell semantics. Each required environment field must match; omitted fields
impose no extra constraint. All applicable emitted variants must pass. Declare
separate requirements for environments that must not be omitted.

The loader uses bounded contained regular files before executing commands. The
complete plan is copied to the execution directory and bound by canonical digest
in the summary. Direct content rechecks at both source boundaries detect plan
changes even for Git-ignored files. Source verification additionally detects
candidate changes during execution. Plans
cannot remove mandatory suite stages. Scenario observations derive from existing
adapter evidence verification: platform, profile/device and report variant remain
explicit. Web, iOS Simulator and WeChat DevTools observations never imply real
phone/service coverage. Host checks need explicit `verificationLevel` (`L1`, `L2`
or `L3`): a trusted project classification of command exit, not build attestation.
Unclassified checks still execute and affect suite acceptance.

The pure `assessVerification` API consumes already validated observations. It
does not load/attest files, execute commands, authenticate reviewers or prove
environment declarations true. Its inputs are trusted; this is not an external
evidence-import interface. `assertVerificationRecord` recomputes assessment and
digests. Integration also checks observations against its stages. Original
adapter reports remain unchanged. Do not copy shared reconciliation into consumers.

## Reconciliation and results

`src/verification/` matches selectors, project/source, level and environment.
Missing evidence is `not-run`; wrong-scope evidence is `invalid-evidence`;
failures/infrastructure/review remain visible. Required visual inspection stays
`needs-review` after driver success. This integration plan reconciler does not
ingest the separate native human-review/progress records or physical-device/external
records. Such requirements can be declared
but cannot become accepted through this runner.

The optional summary `verification` record contains the plan, derived observations
and assessment. Canonical JSON and derived HTML give separate code/UI/release
conclusions. An empty category is `not-assessed`, never pass. Conclusions cover
declared requirements only, not all repository checks, independent review or
store conditions. Consumers must include their necessary gates. No result grants
merge/publication authorization.

Missing/invalid/inconclusive requirements map to exit 2, candidate failure to 1,
review to 3, fully satisfied declared requirements to 0. Infrastructure/incomplete
scope take precedence; cancellation retains 130/143. Raw passing stages can yield
inconclusive/review acceptance. Plan-free suites retain behavior and do not acquire
feature-level claims. Older strict readers need matching schemas/engine for these
additive alpha fields; consumers pin a reviewed source revision.

## Verification and reuse

Regression tests cover missing/stale/wrong-environment evidence, retained failures,
visual review, forged assessments and separate conclusions. Synthetic Web/native
consumer integrations use the same shared code. The prepared-Web built-CLI
verifier exercises browser execution with a plan and a missing real-device
requirement. Synthetic native coverage does not establish an installed App result.
Keep actual run outcomes in PR records rather than timeless contract prose.
