# Release Process

UI Eval's source repository is public at `https://github.com/zw-befreed/ui-eval`. The package remains private and `UNLICENSED`; no registry publication, release artifact, signing, provenance, or support policy is established.

Accordingly, this document defines a package release-readiness gate and the decisions required before any future artifact distribution. Public source hosting is not authorization to publish a package or release.

## Current distribution status

- `package.json` is private.
- The license is `UNLICENSED`.
- The public source remote is `https://github.com/zw-befreed/ui-eval`.
- No public registry package or download URL is documented.
- No release-tagging or immutable-artifact convention is configured.
- GitHub Private Vulnerability Reporting is enabled for security intake.
- `CHANGELOG.md` contains only unreleased work.
- Separately authorized local checkout execution is the current integration path.

Do not remove `private`, change the license, create a tag/release artifact, or run a publish command without explicit owner approval covering intellectual property, audience, destination, and support obligations.

## Version model

When releases are authorized, keep these version dimensions independent:

- package SemVer for executable and programmatic API compatibility;
- `uieval.io/v1alpha1` for the current wire family;
- evidence payload versions for channel-specific JSON;
- evaluator semantic versions for rule behavior;
- adapter/orchestrator versions for provenance;
- local CAS store ID for on-disk format invariants.

A package patch must not silently change report disposition, exit-code meaning, evaluator semantics, accepted/rejected contract shape, or storage interpretation. Breaking wire changes need a new wire version and migration guide. Storage invariant changes need a new namespace or explicit migration tool.

## Required decisions before first distribution

The repository owner must explicitly decide and record:

1. **License and ownership** — proprietary distribution or an approved open-source license; dependency obligations and notices.
2. **Package identity** — final registry name/scope and ownership. Do not assume the private working name is available.
3. **Release authority** — protected branch/tag policy and authorized releasers for the configured GitHub remote.
4. **Supported environments** — Node, Bun for development, operating systems, browser channels, and support window.
5. **Artifact policy** — whether schemas, source maps, browser dependencies, notices, and changelogs ship.
6. **Security intake** — private reporting channel and supported-version policy.
7. **Provenance** — trusted publishing/signing, immutable tags, checksums, and build environment.
8. **Compatibility policy** — how long old authoring inputs and reports remain readable.

Until all decisions are complete, source visibility remains public while package and release-artifact distribution remain disabled.

## Release candidate gates

Run every gate from a clean source snapshot. Record actual commands, environment, and outcomes in the release review; do not copy transient test counts into architecture docs.

### Source and dependency gate

- The working tree contains only intended changes.
- Lockfile and declared dependencies agree.
- No candidate-specific fixtures, secrets, reports, screenshots, CAS bytes, or internal URLs are present.
- Dependency license/security review is complete for the intended distribution model.

### Contract gate

```bash
bun run schema:check
bun run test
```

Additionally:

- generated schemas match TypeBox sources;
- all schema examples and compatibility fixtures validate;
- digest and cross-object validators cover changed invariants;
- additive/breaking classification is documented;
- wire/evidence/evaluator/store version changes are explicit;
- old sanitized reports and inputs required by the support policy remain readable.

### Static quality gate

```bash
bun run lint
bun run typecheck
bun run build
```

The build must produce the documented library and CLI entries without relying on source-only paths or undeclared files.

### Browser conformance gate

```bash
bunx playwright install chromium
bun run test:capture
```

Run this gate on each authoritative environment declared by the future support policy. Browser tests must cover origin escape, popup handling, auth containment, evidence bounds/redaction, capture status, and cooperative cleanup when those areas changed.

### End-to-end gate

Use a synthetic independent web project, not a business application fixture, to verify:

- `init` is non-destructive;
- `doctor` distinguishes owned, reusable, and occupied servers;
- source identity seals a clean and dirty Git state truthfully;
- `evaluate` produces validated JSON/HTML and expected exit codes;
- local reference equal/change/corrupt/dimension cases behave truthfully;
- sensitive evidence remains CAS-only;
- a packaged artifact can be installed and executed from a clean consumer without repository-relative source assumptions.

### Package-content gate

Inspect the exact archive that would be distributed. It should contain only intended runtime output, schemas, and approved documentation. Verify:

- CLI shebang and executable mapping;
- ESM and type-declaration exports;
- schema subpath exports;
- no source secrets or generated `.ui-eval/` data;
- license/notice files consistent with the approved model;
- no dependency on files excluded from the archive.

An archive dry run is not enough: install the produced archive into a clean synthetic consumer and run its CLI and programmatic smoke tests.

## Changelog discipline

User-visible changes begin under `CHANGELOG.md#Unreleased` in one of these categories:

- Added;
- Changed;
- Fixed;
- Security;
- Deprecated;
- Removed.

At an authorized release, move only verified entries into the released section. Every entry should explain impact, not implementation trivia. Contract, evaluator, storage, exit-code, evidence privacy, and migration changes must be called out explicitly.

Do not mark a version released until the immutable artifact and its provenance exist at the approved destination.

## Proposed release sequence

After release authority and tooling exist:

1. Freeze the intended source revision.
2. Complete all gates above.
3. Review generated schema/package diffs and changelog.
4. Build in the approved trusted environment.
5. Sign/attest the exact artifact if required by policy.
6. Publish to the approved destination using least-privilege credentials.
7. Verify clean installation from that destination.
8. Create the immutable source tag/release record.
9. Announce supported environments, known limitations, and migration actions.

The concrete commands for steps 5–8 must be added only after a destination and toolchain are configured. This document intentionally does not invent them.

## Failure and rollback

If a candidate fails any gate, fix it and rebuild from a new clean snapshot. Do not mutate or overwrite an artifact already distributed.

For a defective future release:

- stop promoting the affected version;
- publish a corrected new version rather than replacing bytes;
- document impact and workaround;
- rotate any exposed credentials;
- follow the coordinated process in [SECURITY.md](../SECURITY.md) for vulnerabilities;
- preserve enough provenance to explain which contract/evaluator/store behavior was affected.

## First-release definition of done

The first distribution is not ready until:

- licensing and ownership are explicit;
- package identity and releaser authority are configured;
- clean-install and independent-consumer tests exist;
- schema, CLI, adapter, report, and storage compatibility gates are green on declared environments;
- security intake is operational;
- README integration instructions use the real distribution channel;
- no statement confuses public source visibility with package publication, licensing, or support.
