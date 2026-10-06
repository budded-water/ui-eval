# ADR 0003: Execution profiles and bounded scenario selection

Status: accepted for this source revision.

## Context

Local iteration needs short feedback loops; deployment integration needs pinned
versions and bounded readiness waits. A model can identify affected scenarios,
but authority to reduce acceptance scope or change thresholds undermines truth.

## Decision

Keep one deterministic engine with optional local/remote profiles in trusted
project configuration. Verify remote identities before and after capture; bind
targets and verification to sealed execution/report data. Keep local server
ownership separate from remote deployment ownership.

Use reviewed Agent suites for mandatory scope and a declared optional pool.
External suggestions append declared IDs only. Record scope in both summaries;
provide a full-pool fallback without automatic diff classification. Remote runs
never invoke repair or reuse scenario evidence across infrastructure retries.

## Consequences

Legacy configurations and reports remain readable by this revision. Older strict
readers require updated schemas for new optional fields. Store format, evaluator
versions, exit codes and service boundaries do not change.

Candidate pipelines must synchronize their metadata with reviewed expectations.
Metadata is not cryptographic attestation and pre/post sampling cannot lock an
environment. See [Local and Remote Evaluation](../execution-profiles.md) for
configuration, decision boundaries and dual-ledger limitations.
