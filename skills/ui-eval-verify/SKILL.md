---
name: ui-eval-verify
description: Verify a candidate Web project's user journeys through an authorized UI Eval checkout, map features to reviewed scenarios and checks, and hand off actual JSON/HTML evidence. Use for UI Eval onboarding or feature acceptance.
---

# UI Eval verification

Use UI Eval's existing CLI to prove the requested user behavior. Read
[the verification guide](../../docs/verification.md) for the feature-map
convention and command recipes. This skill is checkout-local guidance; it does
not install a plugin, register a command, or authorize new external actions.

## Establish the target and proof

- Resolve the engine checkout and candidate Git root separately. Run the CLI
  from the engine with an explicit candidate `--project-root`.
- Inspect the candidate's startup command, reviewed `ui-eval/project.json`,
  scenarios, policies and any integration/Agent suite. Read the selected
  execution profile before running commands; remote identity failures are
  infrastructure failures, not permission to repair or switch targets.
- Identify the user journey and its observable end state. Resolve any existing
  `ui-eval/feature-map.md` entries against the live scenario/check definitions.
  A screenshot or successful startup alone does not prove a mutation persisted.
- When onboarding is authorized, draft missing inputs and a feature map from
  the candidate's existing test harness and actual user paths. Inspect generated
  `init` files before executing them. Keep business-specific selectors, setup
  and fixtures in the candidate. Reuse existing assertions instead of copying
  expected values or policy thresholds into the map.
- Mark unimplemented or unasserted journeys as gaps. A generated map or config
  is a draft until its declared path has run; never remove an assertion, widen a
  threshold or replace a reference to make acceptance easier.

## Drive and inspect

Run `doctor` first with the intended browser/profile. Inspect warnings as well
as failures. Doctor may create the artifact directory and briefly launch a
browser; it does not prove the application journey or start the candidate server.

For one journey, run its declared `evaluate` scenario. For complete integration
acceptance, run the reviewed `integrate` suite so preparation and external
checks also execute. Use `agent` only for a configured bounded suite, with
repair only when authorized. Preserve mandatory scope; optional suggestions
can only add reviewed scenario IDs. A smoke result covers that smoke only.

Record the command, process exit and actual JSON payload even on a nonzero exit.
Inspect every variant's canonical report, execution outcome, gates, coverage
and finding/evidence references, then open its HTML view. For suite results,
read canonical `summary.json` and the derived `summary.html`; both must exist.
Agent acceptance is a suite decision and does not rewrite raw visual review.
Do not interpret missing/corrupt evidence, skipped checks or an inconclusive
run as success. See the guide for command-specific exit semantics.

UI Eval owns the local server it starts. Let command cleanup finish, and
investigate an incomplete-cleanup result before another run. Never kill a
process by name or delete evidence during cleanup. Keep generated evidence
local and ignored; redact sensitive data before any separately authorized share.

## Hand off and maintain

Give the user the verified features, selected suite/scenarios and profile,
source/run identity from the actual result, outcome, canonical JSON and HTML
paths, and remaining gaps. Separate a failed product assertion from an
infrastructure blocker and a visual review request. Avoid a broader completion
claim than the recorded scope proves.

When application behavior or config changes, update affected map references
and rerun their paths. Link to the executable definitions; the feature map is
a review aid, not runtime scope, a policy, or a second acceptance ledger.
