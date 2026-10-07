# Experimental native evidence pilot

`native-pilot` is an additive iOS Simulator experiment. It does not extend Web
`evaluate`, Agent suites, Web policies or generic native forward contracts.
Its separate `uieval.io/native-pilot-v1` result assesses declared interactions and
screenshot completeness. It is not a release or design-conformance gate.

## Inputs and execution

Candidate repositories own `ui-eval/native.json` and referenced scenario JSON.
TypeBox sources in `src/native-pilot/config.ts` and generated
`schemas/native-pilot-{project,scenario}.schema.json` define these inputs.
Only Maestro **2.9.0** command evidence is currently supported. Prerequisites are
macOS, Xcode, an explicitly selected booted iOS Simulator and an installed app.
The engine does not install/reset apps, boot devices, start Metro, supply
credentials or isolate backend calls.

```sh
bun run ui-eval native-pilot doctor --project-root /path/to/app --device <uuid>
bun run ui-eval native-pilot evaluate guest-home --project-root /path/to/app --device <uuid> --format json
```

Steps are limited to tap, visible/hidden assertions and screenshots. Selectors
are Maestro ID/text regular expressions. Expression templates, scripts, text
input and arbitrary driver commands are rejected. Every screenshot must
immediately follow an assertion. Generated flows stop/relaunch the app without
clearing its state; use a dedicated simulator and synthetic data.

The adapter binds device, app, scenario, selectors, command order and checkpoint
identities to evaluated command metadata. Pass requires exit 0, every required
non-optional command completed, and every PNG passing encoded-size/dimension
budgets and CRC-checked decoding. Exit 1 plus a bound failed visibility assertion
with matching Maestro 2.9.0 assertion-mismatch message/debug diagnostics reports
failed interaction. Missing/unknown diagnostics or infrastructure errors during
an assertion remain inconclusive; other driver failures, timeouts, incomplete or invalid
evidence are inconclusive. Source identity is checked before/after capture;
source changes invalidate acceptance.

## Reports and limits

Each run writes `.ui-eval/native-runs/<execution-id>/report.json` and `report.html`.
The result schema is `schemas/native-pilot-result.schema.json`; HTML derives from
that validated record. Both must be written for command success. `plan.json` and
`source.json` retain the inputs corresponding to the report digests, including
working-tree identity. Screenshots have
SHA-256 digests and sit beside the report. Generated flows and raw Maestro output
remain in the run directory. Native evidence does not use the Web CAS store.

Exit 0 means declared checks passed, 1 means a visibility assertion failed, and 2
means prerequisites, infrastructure or evidence were inconclusive. Existing CLI
signal exit semantics remain in effect. Cancellation requests bounded cleanup of
the owned driver; after capture starts it attempts to publish both reports.

Reports explicitly do not certify:

- installed binary or Metro provenance: source identity and installed app
  presence are observations, not a cryptographic build-to-source binding;
- crashes/runtime health, network isolation, accessibility, geometry, typography,
  visual diffs or authoritative design conformance;
- language, clock, orientation, keyboard, permission, safe-area or backend
  determinism: candidate setup owns those inputs;
- Android, Harmony, real-device or device-farm support.

Raw Maestro logs, command metadata and screenshots may contain private data.
They are ignored local artifacts, unencrypted, and do not receive Web evidence
redaction. Use synthetic state, review before sharing and manage retention
externally. Evidence reads are bounded and reject symlinks; total driver disk
output is not quota-managed.

The separate `nativePilot` library namespace exposes the experimental API.
Distribution remains a separately authorized source checkout/build. This pilot
does not complete the broader native-adapter roadmap milestone.
