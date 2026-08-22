# Contributing

UI Eval is a public-source, `UNLICENSED` repository. Contributions remain limited to people with separately granted authorization. This file describes the engineering bar; public visibility does not grant rights to use, copy, modify, or redistribute the source.

No public contribution intake, contributor license agreement, DCO workflow, or external pull-request process is configured. Unsolicited public issues and pull requests are not accepted; follow the review channel designated by the repository owner.

## Before changing code

1. Read [Architecture](docs/architecture.md), [Contracts](docs/contracts.md), [Security model](docs/security-model.md), and [Current limitations](docs/limitations.md).
2. Confirm the requested change is current implementation work rather than an unsupported roadmap capability.
3. Identify every copy of the fact being changed: schema, type, validator, compiler, adapter, evaluator, policy, report, CLI, docs, and changelog.
4. State a short plan before implementation.
5. Preserve unrelated or concurrent changes; do not reset or overwrite another contributor's work.

## Setup

```bash
bun install --frozen-lockfile
```

For browser work:

```bash
bunx playwright install chromium
```

Runtime and package-manager requirements are authoritative in `package.json`.

## Engineering principles

- Missing, corrupt, unsupported, or untrusted evidence never becomes pass.
- Product failures stay distinct from infrastructure failures and advisory observations.
- Human authoring is compiled into sealed immutable execution input.
- Adapter output and artifact sensitivity labels are untrusted until verified.
- Evaluators are deterministic and do not mutate source.
- Policy gates use a restricted AST, not arbitrary code.
- Candidate application code, aliases, fixtures, environment variables, and business-specific paths do not belong in the engine.
- Forward schemas must not be documented as executable capability.
- The CLI remains a thin boundary over the domain pipeline.

## Tests first where behavior changes

Add the smallest failing test that proves the requested behavior. Then implement and run focused tests before broader verification.

Use the risk-based verification ladder in [Development](docs/development.md). At minimum, non-browser implementation changes require:

```bash
bun run check
```

Capture, routing, auth, evidence, browser lifecycle, or stabilization changes also require:

```bash
bun run test:capture
```

Do not write “tests pass” unless you ran the stated command on the submitted source. Report failures and skipped environment-dependent checks explicitly.

## Contract changes

A contract change must update all of these as applicable:

- TypeBox schema source;
- derived TypeScript types;
- semantic and digest validators;
- generated `schemas/*.schema.json`;
- compiler, capture, evaluator, policy, storage, and report consumers;
- valid/invalid/round-trip/compatibility fixtures;
- documentation and `CHANGELOG.md`.

Regenerate schemas through `bun run schema:generate`; never hand-edit generated JSON. Run `bun run schema:check` before review.

Breaking wire, evaluator, exit-code, or on-disk storage semantics require an explicit compatibility decision and migration plan. Do not hide a breaking change behind a package patch.

## Security-sensitive changes

Treat these surfaces as requiring focused negative tests and explicit security review:

- filesystem paths, real paths, symlinks, and atomic writes;
- development-server commands, readiness, process groups, signals, and cleanup;
- browser routes, redirects, popups, auth state, service workers, and egress;
- evidence budgets, redaction, assertion serialization, and HTML escaping;
- artifact project/store identity, digest verification, and sensitivity metadata;
- capture status, report binding, source provenance, and evaluator provenance.

Update [Security model](docs/security-model.md) when a trust boundary changes. Report suspected vulnerabilities privately under [SECURITY.md](SECURITY.md), not in ordinary review discussion.

## Fixtures and generated data

Fixtures must be synthetic, deterministic, minimal, and scrubbed. Never add real credentials, cookies, tokens, user data, internal URLs, production screenshots, or authenticated traces.

Do not commit:

- `.ui-eval/` artifacts or run output;
- build output unless the repository explicitly tracks it;
- local browser caches;
- generated HTML reading views edited independently of Markdown;
- secrets in examples, logs, snapshots, or error strings.

## Documentation

Markdown is canonical. Keep current capability, forward contracts, and roadmap proposals visibly separate. Prefer links to schemas over copied field tables. Do not invent URLs, release channels, package availability, support guarantees, or test results.

User-visible changes belong under `CHANGELOG.md#Unreleased`.

## Review checklist

- [ ] The change is scoped and preserves concurrent work.
- [ ] Tests demonstrate both success and fail-closed behavior.
- [ ] Schema/type/validator/runtime/docs copies are synchronized.
- [ ] No business-project identity or sensitive fixture entered the engine.
- [ ] No unsupported feature is presented as implemented.
- [ ] Machine stdout, exit codes, report semantics, and provenance remain truthful.
- [ ] Security and storage classifications cannot be downgraded.
- [ ] Required verification commands and actual outcomes are included in the review.
- [ ] `CHANGELOG.md` describes user impact when applicable.

## Licensing

This repository does not accept public contributions and has no open-source license. A future external contribution process must first establish ownership, license, contributor terms, code of conduct, and an operational review channel.
