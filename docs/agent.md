# Constrained Agent Loop

`ui-eval agent <suite>` turns immutable evaluation findings into a bounded
repair loop without giving the repair worker authority over evaluation truth.

An `AgentSuite` lives under the candidate project's `ui-eval/agents/`
directory. It declares required acceptance dimensions, scenarios, references
and visual ceilings, executable project checks, mutation boundaries, iteration and plateau budgets, and an
optional argv-only repair adapter. Commands never run through a shell.

Suites can pin an execution profile and declare `optionalScenarios`. Mandatory
`scenarios` always run; external model suggestions can only append declared IDs,
and `--full-scope` selects the entire optional pool. Both summaries record scope.
Remote suites disable repair and re-capture all selected scenarios on retries.
See [Execution profiles](execution-profiles.md) for the enforced decision boundary.

Command output is bounded while collecting it. Timeouts and cancellation stop
the owned process group, escalate from graceful to forced termination, and wait
for bounded cleanup. A command that exits zero after its timeout is still a
failed check. Processes that escape their group require external OS isolation.

Each iteration runs checks before scenarios. A failed check skips browser
scenarios for that iteration. Checks with `onFailure: "block"` are external or
non-repairable preconditions; their failure stops the loop without invoking a
repair worker. Other checks default to `onFailure: "repair"`. Every scenario and
check names the dimension it proves. Every scenario also has an outer deadline;
a stuck driver becomes a bounded failed result rather than hanging the loop.
After abort, the Agent gives evaluator-owned browser resources 15 seconds to
settle. If cleanup does not settle, the Agent blocks immediately; it cannot
repair, reuse evidence, or later accept while an evaluator may still own live
resources. Capture cancellation has its own bounded cleanup wait; a timeout or
failed context/browser close raises `OWNED_RESOURCE_CLEANUP_INCOMPLETE`, which
the Agent blocks even if the outer evaluator Promise has already settled.
Failure results record `cleanupSettled`; `false` prohibits another iteration.
A deadline or evaluator exception with no report and settled cleanup is
retried as infrastructure failure and is never sent to the product repair
worker. Infrastructure-only iterations consume the finite run budget but do
not contribute to product score plateau detection.
For local execution, after project checks UI Eval compares the current source-file snapshot with
the snapshot that authorized reuse. When source state is unchanged, the next infrastructure-only retry reuses
already accepted immutable scenario reports from the same Agent run and
reruns only failed or not-yet-executed scenarios. The result records the source
iteration for every reused scenario. Any product repair invalidates this reuse
set so the modified candidate is evaluated across the full suite again.
Snapshot identity includes file contents, executable mode, and symlink targets;
links are not followed and Git paths are NUL-delimited so quoting cannot hide a
Unicode or whitespace filename. Source-file hashing streams file bytes.
Missing evidence is `not-evaluated`, not a
pass, and the diagnostic score is the fraction of required dimensions that pass.
Each iteration also records `progressScore`, the mean of every declared check's
binary result and every declared scenario's continuous diagnostic score. Missing
results contribute zero. Plateau uses this separate progress measurement, so
improving visual ratios can justify another repair before a dimension passes.
Neither progress nor partial scenario scores authorize acceptance. A flat score
still plateaus when the declared minimum improvement is zero.
Any scenario report whose execution outcome is not `valid` remains
infrastructure or invalid-evidence failure; the mere existence of a diagnostic
report never authorizes product repair.
An `inconclusive` report also retries without product repair, even when
scenario execution itself was valid, such as an unavailable pixel comparison.
Acceptance requires
successful checks, valid scenario evidence, passing hard gates, no non-visual
findings, and every declared reference below its declared ceiling. A visual
reference without a threshold cannot pass.
Each variant must supply its own finite pixel ratio from canonical report
`metrics` when a reference is declared. A zero ratio is valid without a visual
finding. Missing ratios, `fail`, and `inconclusive` reports cannot be accepted;
another variant's measured ratio cannot cover their evidence gap. A visual
`needs-review` result may pass only through the declared reference threshold.

When repair is enabled, UI Eval writes a machine-readable `RepairRequest` under
`.ui-eval/agent-runs/`, sends a constrained prompt to the configured adapter,
then hashes the candidate files again. A change outside the allowlist, a change
under a protected prefix, too many changed files, a failed adapter, a progress
plateau, or the iteration budget terminates the loop without acceptance.

Raw evaluation reports remain authoritative. Agent acceptance is an additional
suite-level decision and never rewrites a report, finding, policy, scenario,
reference, or historical artifact.

## Terminal report contract

Suite and terminal summary shapes have generated JSON schemas. Terminal summary
values are structurally validated before publication; HTML and JSON share the
validated value. Repair requests fingerprint the file-content snapshot, rather
than only the list of changed paths.

Every terminal state (`accepted`, `blocked`, `plateau`, or `exhausted`) publishes
one synchronized pair under `.ui-eval/agent-runs/<agent-run-id>/`:

- `summary.json` is the canonical machine record. It contains the terminal
  reason, generated time, all iterations, checks, dimensions, scenarios,
  changed-pixel ratios, detailed report paths, changed files, and repair
  request paths.
- `summary.html` is the default human handoff rendered from the same in-memory
  result. It aggregates the latest acceptance matrix, project/API checks,
  interaction and visual scenarios, candidate/reference/diff images, detailed
  report links, and the full Agent iteration timeline.

The static HTML never changes acceptance semantics. Raw visual ratios remain
diagnostic and pass only through the suite's predeclared threshold. Links are
limited to generated artifacts under the candidate's `.ui-eval/` root and all
result data is HTML-escaped. UI Eval writes the human report before the
canonical terminal JSON; if either publication fails, the command throws and
does not return a completed Agent result.

Text-mode CLI output lists `summary.html` first because it is the review entry
point, followed by `summary.json`. `--format json` remains stdout-safe for
automation and includes both absolute paths.

Completed Agent terminal results return CLI exit `0` for `accepted` and `1`
for `blocked`, `plateau` or `exhausted`. Inspect the summary status, reason and
underlying reports to distinguish product and infrastructure blocking conditions.
CLI exceptions before a completed terminal result return `2`; termination
signals retain `130`/`143`.

```bash
ui-eval agent rentals \
  --project-root /path/to/candidate \
  --browser-channel chrome \
  --repair
```

Without `--repair`, the command performs one complete assessment and returns
`blocked` when fixes are required. This is useful for CI and contract review.
