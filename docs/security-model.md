# Security Model

UI Eval runs a candidate application's command and browser content with the current user's privileges. Its current protections are fail-closed contract, browser-context, filesystem-containment, evidence-classification, and process-ownership controls. They are not an operating-system sandbox.

For GitHub Private Vulnerability Reporting instructions, see [SECURITY.md](../SECURITY.md).

## Assets to protect

- Authenticated browser state and secrets referenced by project inputs.
- Candidate source and source provenance.
- Policies, evaluator configuration, and sealed run identity.
- Screenshots, DOM/style payloads, console/network/crash data, and traces.
- Project isolation inside the local content-addressed store.
- The integrity of capture, gate, finding, and report dispositions.

## Trust boundaries

### Trusted configuration

The following inputs must be reviewed and trusted before execution:

- the authorized UI Eval source and dependencies;
- `ui-eval/project.json`, especially `devServer.command` and `args`;
- selected scenario and policy sources;
- local fixture and storage-state files;
- the local filesystem account and CI runner configuration.

The development-server command is data-driven but still executes a process. UI Eval passes a command and argument array without treating page content as shell instructions; it does not make an untrusted project configuration safe to run.

### Untrusted candidate and capture data

Treat these as hostile data:

- candidate page DOM, accessible names, URLs, and rendered text;
- console messages, network URLs/failure text, exceptions, and crash messages;
- candidate screenshots and trace contents;
- adapter-returned artifact metadata, status, and sensitivity labels;
- the candidate application and any page it attempts to open.

Untrusted data enters retained run output only through typed evidence structures
and channel-specific resource ceilings. That limits what is sealed; it does not
turn the browser or candidate into a resource sandbox. Untrusted values must
never be interpreted as commands or instructions.

### Sealed trusted facts

After validation and digest recomputation, the orchestrator treats these as trusted run facts:

- resolved scenario plan;
- source/build identity;
- selected adapter and intended environment;
- materialized policy and evaluator config digests;
- run manifest, capture/evaluation keys, and validated report bindings.

Trust is earned through validation and cross-binding, not because an object has a familiar TypeScript type.

## Project-root containment

Project, scenario, policy, fixture, storage-state, evaluator-config, and reference-image paths are constrained to the candidate project:

- lexical containment rejects `..` or absolute escapes;
- real-path containment rejects symlink escapes;
- expected regular files/directories are checked for unsafe symlinks and unexpected file types;
- local run and CAS writers perform atomic contained writes;
- identifiers used as path segments are validated.

An `ArtifactRef` contains logical project/store identity and a digest, never an arbitrary local path or HTTP URI. Resolution checks project/store scope, object size, and SHA-256 before returning bytes.

## Candidate-server ownership

UI Eval distinguishes a server process it started from an already responding port:

- `reuseExisting: false` rejects an occupied responding port, even if it looks healthy;
- `reuseExisting: true` requires a project-specific readiness path and body marker;
- UI Eval stops only its owned process tree;
- every matrix variant releases its handle before the next variant starts, and
  a cleanup failure stops the matrix rather than capturing against a process
  whose ownership state is uncertain;
- finalized JSON/HTML reports are published only after every owned candidate
  and fixture process for the variant has stopped successfully;
- cooperative abort sends termination through the owned handle, with bounded escalation;
- raw candidate stderr is not copied into JSON stdout, structured reports, HTML, or progress output.

This prevents accidental evaluation of an unrelated service and avoids leaking arbitrary server diagnostics into run-visible artifacts. It does not protect the host from a malicious trusted configuration; use an OS/container sandbox when that threat matters.

## Loopback mock fixture boundary

The executable `mock-server` fixture provider is deliberately smaller than a
proxy or programmable test server:

- config comes from a project-contained regular JSON file, is sealed into the
  project CAS, size-checked, and validated again before use;
- listeners bind only `127.0.0.1` on an explicitly declared port and never
  reuse an occupied port;
- routes match an exact `GET` or `HEAD` request target and return only fixed,
  bounded JSON or text with non-redirect status codes;
- unmatched methods and paths fail locally; no request is forwarded and no
  script, candidate module, environment variable, secret ref, or secondary
  file is evaluated;
- required routes must be observed before capture can remain completed;
- each variant starts fixtures before its candidate server and attempts to stop
  both, including after partial startup or cancellation.

The candidate server configuration remains trusted executable input. A mock
fixture prevents the declared dependency from reaching a real service only
when the candidate is already configured to use that loopback port. The
provider is not an OS network sandbox, and another local process can reach its
listener while it is active. Use only synthetic responses and add container or
host network policy for authoritative CI.

## Candidate-origin boundary

Every resolved web plan seals one Candidate origin. Browser-context interception and post-action checks cover:

- initial top-level navigation;
- redirects, with foreign `Location` rejected before following it;
- `goto`, `tap`, and `press` actions that may navigate;
- the first request from a popup or additional page.

A direct external top-level navigation is aborted before dispatch to the destination. The escape is retained as a candidate product failure; the external page is never captured as Candidate evidence.

An asynchronous navigation triggered by keyboard input may be observed during
the following checkpoint rather than during the input step. Either attribution
fails the capture and prevents checkpoint evidence; no external dispatch is
authorized by a passed input step.

The current contract supports exactly one declared browser `Page`. Any additional page fails capture closed:

- a same-origin or otherwise non-external popup is a runner `unsupported-popup-created` error;
- a foreign popup is blocked at its first destination and recorded as `candidate-origin-escaped`.

Capture finalization closes the context to drain late events and rechecks the boundary before serializing, so a late popup cannot turn into a `completed` result.

## Authenticated browser containment

Storage state is supported only after exact Candidate scoping:

- every cookie domain must exactly equal the Candidate hostname;
- leading-dot and foreign cookie domains are rejected;
- every local-storage origin must exactly match Candidate scheme, host, and port.

Storage state defaults to `mode: authenticated`. A scenario may explicitly use
`mode: public-state` for origin-scoped, non-secret preferences such as locale or
market selection. Public state cannot declare secret references and does not
activate authenticated egress denial; its cookie and local-storage origins are
still scoped exactly to the Candidate.

When a plan carries authenticated state:

- service workers are blocked;
- all foreign HTTP(S) requests and WebSockets are denied at the browser-context boundary;
- same-origin responses are preflighted so a foreign redirect target is rejected before following it.

Legitimate third-party dependencies for an authenticated scenario must be provided through a same-origin proxy or deterministic fixture. The current implementation does not provide a third-party allowlist.

This containment covers the controlled Playwright browser context only. It does not isolate DNS, the browser process, the development server, package hooks, or other host processes. Authoritative CI should add container and network policy appropriate to the project.

Chrome is launched with its built-in Local/Private Network Access checks
disabled so an intercepted loopback Candidate can use development transports
such as Next.js HMR. UI Eval's own top-level origin guard, popup rejection, and
authenticated egress routing remain active; the browser flag is not an OS or
network sandbox exception.

## Evidence minimization and redaction

Current evidence controls include:

- per-entry, entry-count, and total-byte budgets for console, network, and crash collections;
- encoded-byte, IHDR-dimension, and pixel-area ceilings for candidate and
  reference PNGs, checked before image decoding; screenshot render space is
  checked before Playwright capture and the returned PNG must match it;
- an encoded-byte ceiling and fixed-descriptor read for Playwright trace files,
  so an oversized or changing file is not sealed;
- explicit captured/dropped/truncated collection statistics;
- identifier, text, accessible-name, and font-family removal in subtrees marked `data-ui-eval-sensitive`, `data-sensitive`, or containing password inputs;
- bounded browser-to-run assertion previews;
- credential-pattern redaction and UTF-8 byte bounds for text values;
- URL metrics reduced to a redacted origin/presence representation rather than userinfo, path, query contents, or fragments;
- a fixed `[REDACTED]` value for sensitive targets;
- kind checking at the capture contract followed by orchestrator re-sanitization before persistence.

The authoritative binary ceilings live in
`src/capture-playwright/binary-evidence.ts`; tests, rather than copied prose
numbers, guard them against drift. Exceeding a required binary-evidence budget
is a runner/infrastructure error and cannot become a pass.

These controls reduce exposure but are not a general data-loss-prevention guarantee. Ordinary private text that does not match a redaction rule may remain in bounded DOM, screenshot, or assertion evidence. Screenshots can reveal information that text redaction cannot identify. Trace recording and browser rendering also consume resources before final artifacts can be validated, so authoritative runners still need external CPU, memory, disk, time, and process quotas.

Checkpoint stabilization applies the declared timeout to font, image,
application-readiness, and stable-frame waits. Font readiness uses the bounded
font-status predicate directly; it does not add a second unbounded
`document.fonts.ready` wait. The same bound is installed as both Playwright's
action and navigation timeout before the first candidate navigation, and on
the response preflight used by the origin guard.

Before normal browser-context shutdown, the adapter gives installed HTTP route
handlers a bounded drain window, then closes the owned context. This prevents
long-lived development-server RSC/HMR requests from blocking finalization while
still allowing an in-flight origin preflight to settle before context closure.
Abort cleanup removes the same routes with close-race errors ignored, then
closes only the owned context and browser.
Context and browser close must both complete successfully within their bounded
waits. Rejection or timeout is incomplete cleanup, withholds final run reports,
and blocks the Agent; successful route teardown alone is not proof of closure.

Use synthetic accounts and scrubbed fixtures. Never commit production cookies, tokens, customer data, or real authenticated traces.

## CAS sensitivity and aliases

The adapter's `ArtifactRef.sensitivity` is an input hint, not an authority. The presentation boundary applies an exhaustive minimum by evidence channel:

- console, network, trace, crash, video, device logs, and performance are at least `sensitive`;
- current visual/structural channels are at least `internal`.

Every occurrence of the same digest is scanned and upgraded to its strictest effective classification. The local CAS persists the strongest classification per project/store/digest before sealing new bytes. Later or forged lower labels cannot downgrade it.

The current default namespace is `local-cas-v2`, whose format invariant includes sensitivity metadata. Within that namespace:

- an older object without metadata is treated conservatively as `sensitive`;
- malformed, mismatched, non-regular, or symlinked metadata fails closed;
- earlier store namespaces are not searched or migrated implicitly.

Sensitive artifacts remain CAS-only and do not receive plaintext aliases beside `report.html`. The local CAS is still ordinary local storage: it is not encrypted at rest, and a user or process with filesystem access may read its bytes.

## Contract and report integrity

Security-sensitive status is cross-bound across the pipeline:

- source identity must be readable and internally consistent;
- remote repository provenance has credentials, query, fragment, and unsafe helper payloads removed;
- plan, manifest, capture, evaluation, policy, and report digests are recomputed;
- adapter identity, scenario/variant, source/build, steps, assertions, checkpoints, channels, and environment must match the sealed plan;
- evaluator provenance lists only implementations actually run;
- a local reference binds its content digest, unique checkpoint, and candidate screenshot digest;
- security-boundary, runner, driver, or fixture errors prohibit `completed` capture status;
- evidence verification can lower but never upgrade `failed` or `partial` status.

Missing or corrupt evidence does not become green. A high visual similarity cannot offset an explicit functional failure.

## Signal and cleanup behavior

Agent checks and repair commands share owned-process signaling with the server
runner. POSIX commands start in their own process group; Windows termination
uses the owned process tree. Command timeouts escalate from `SIGTERM` to
`SIGKILL` with bounded waits and cannot accept a late zero exit. Cancellation
propagates after cleanup. Ordinary stdout/stderr is bounded during collection;
Git metadata has a larger finite bound and fails instead of silently truncating.
These commands remain trusted executable input, and this is not a sandbox for
descendants that create another process group.

Planned geometry work remains in coverage when structured evidence is absent
or invalid. Without an observed product defect, an indecisive geometry result
cannot produce an overall pass. Agent evidence reuse rechecks the source
snapshot after checks, and repair requests bind file-content snapshots.
Snapshots include executable mode and symlink targets without following links;
Git path parsing preserves literal filenames, and unreadable files fail the
audit instead of silently disappearing.

The first `SIGINT` or `SIGTERM` aborts browser/server work cooperatively. UI Eval waits only for a bounded cleanup window; a second signal or deadline expiry forces the conventional exit code. Final reports are withheld until cleanup succeeds, although bounded intermediate evidence may remain in the run directory for diagnosis. This bounds CI shutdown but cannot guarantee that a malicious descendant process has not escaped the owned process group. Use stronger process isolation for hostile candidates.

## Explicit non-guarantees

UI Eval currently does not provide:

- an OS, VM, container, or complete network sandbox;
- encryption at rest or centralized access control for local artifacts;
- comprehensive DLP, OCR-based screenshot redaction, or proof that evidence contains no private data;
- a runtime secret provider;
- secure holdout isolation or oracle-leakage controls;
- reviewer roles, baseline/waiver authorization, or an append-only governance service;
- an agent mutation sandbox or enforcement of `agentMutation` policy fields;
- multi-tenant storage;
- a third-party egress allowlist for authenticated capture;
- protection from deliberately malicious project configuration executed with the current user's privileges.

## Deployment responsibilities

For meaningful CI security, the operator should:

- run UI Eval and the candidate in an ephemeral least-privilege environment;
- restrict outbound network access at the container/runner layer;
- use synthetic accounts and short-lived credentials;
- retain `.ui-eval/` only as long as required;
- protect uploaded reports and artifacts according to their sensitivity;
- keep policies and scenarios read-only to any automated code-changing actor;
- review dependency and browser updates before changing the authoritative environment;
- treat non-zero exit codes as non-green rather than retrying until a defect disappears.

## Security change checklist

A change to paths, process lifecycle, browser routing, auth state, evidence payloads, redaction, CAS metadata, capture status, or report binding requires:

1. a focused threat analysis;
2. fail-closed negative tests;
3. real-browser coverage when browser behavior changes;
4. updates to this document and [Current limitations](limitations.md);
5. explicit review of whether old artifacts or contracts need migration.
