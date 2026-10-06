# Repository Instructions

## Scope

UI Eval is a public-source, `UNLICENSED`, single-package TypeScript modular monolith hosted at `https://github.com/budded-water/ui-eval`. Public visibility does not make it open source or authorize package publication. Do not describe it as an open-source project, a published package, or supported beyond the exact source revision in use.

## Before implementation

- Present a short plan before editing.
- Inspect the current source, tests, contracts, and docs; written plans are snapshots, not live truth.
- Preserve unrelated and concurrent changes. Do not reset, revert, or overwrite another worker's files.
- Keep the requested scope; ask before adding a new distribution, remote, service, dependency, or external state change.

## Architecture rules

- Keep module boundaries under `src/`; do not split into services or packages without an accepted decision.
- Depend toward contracts and narrow interfaces.
- Do not import candidate application code, aliases, fixtures, routes, business paths, or environment variables.
- Keep capture, evaluation, policy, storage, reporting, and CLI concerns separated.
- Every Agent terminal result has two synchronized projections: `summary.json`
  is the canonical machine record and `summary.html` is the default human
  handoff derived from that same result. Failure to publish either artifact
  fails the command; never claim Agent completion with JSON alone.
- Evaluators are deterministic and do not mutate candidate source.
- Missing/corrupt/unsupported evidence never becomes pass.
- Product, infrastructure, invalid-evidence, and review outcomes remain distinct.
- A schema declaration is not proof of runtime support.

## Contract and drift rules

- TypeBox schema sources, generated JSON schemas, derived types, validators, compiler/runtime consumers, examples, docs, and changelog must move together.
- Do not hand-edit generated schemas or maintain handwritten mirror types.
- Use named canonical-digest exclusion profiles; never add broad exclusions to silence a mismatch.
- Treat CLI exit codes, JSON stdout, evidence sensitivity, store format IDs, evaluator versions, and report status as public facts.
- Treat default human report paths and Agent JSON/HTML synchronization as public
  facts that must move with CLI output, docs, tests, and changelog.
- Before claiming complete or tests passed, scan every other surface that repeats the changed fact.

## Security rules

- Treat project configuration as trusted executable input and candidate page/evidence data as untrusted.
- Preserve path/realpath/symlink containment, origin and authenticated egress guards, CAS scope/integrity, monotonic sensitivity, bounded evidence, HTML escaping, and owned-process cleanup.
- Never add real credentials, browser state, production data, internal URLs, screenshots, traces, or `.ui-eval/` output.
- Security-boundary changes require focused negative tests, real-browser tests where applicable, and updates to `docs/security-model.md` and `docs/limitations.md`.
- Report vulnerabilities through the private channel in `SECURITY.md`; do not expose them in public issues or ordinary channels.

## Editing and verification

- Use `apply_patch` for manual file edits.
- Prefer `rg`/`rg --files` for search.
- Run focused tests while iterating.
- Non-browser implementation changes finish with `bun run check`.
- Capture/browser/lifecycle changes also run `bun run test:capture`.
- Documentation claims must be verified against live source; do not invent URLs, releases, test outcomes, or support promises.
- Markdown is canonical. Generated HTML, schemas, and build output must be produced by their owning tools.

See `CONTRIBUTING.md` and `docs/development.md` for the full workflow.
