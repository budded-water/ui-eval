# Security Policy

UI Eval's source repository is public and `UNLICENSED`. It has no package release or published support window. Public GitHub issues are not a security-reporting channel.

## Supported versions

No released version is supported. Security fixes are evaluated against the current development source. Older copies, local snapshots, and generated artifacts have no guaranteed update path.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, public chat, sample project, test fixture, or ordinary log attachment.

Use [GitHub Private Vulnerability Reporting](https://github.com/budded-water/ui-eval/security/advisories/new). If that private form is unavailable, stop testing and contact the repository owner without sending exploit details or sensitive artifacts through a public channel.

Include only the minimum information needed to reproduce and assess the issue:

- affected source snapshot or revision identifier, when available;
- affected command/module and environment;
- impact and required preconditions;
- minimal reproduction steps;
- whether credentials, source, or evidence may have been exposed;
- a proposed mitigation, if known.

Do not send real credentials, production browser state, customer data, or unredacted traces. Use synthetic evidence and redact paths/identifiers that are not required for reproduction.

## In-scope security areas

Examples include:

- path traversal, symlink escape, arbitrary file read/write, or project/store scope bypass;
- CAS corruption, digest confusion, or sensitivity downgrade;
- origin escape, redirect/popup bypass, or authenticated cross-origin egress;
- credential or private evidence leakage through DOM, assertions, console, network, trace, report, HTML, or server stderr;
- arbitrary command execution beyond explicitly trusted project configuration;
- process-ownership or cleanup behavior that terminates unrelated processes;
- contract/report tampering that creates a false pass;
- unsafe parsing or HTML/script injection in generated reports;
- source-provenance credential leakage;
- denial of service that bypasses documented evidence/input bounds.

For architectural boundaries and non-guarantees, read [Security model](docs/security-model.md).

## Out of scope as guarantees

The current implementation is not an OS/network sandbox, encryption system, general DLP product, secure holdout service, or multi-tenant platform. Reports about gaps already described as explicit non-guarantees may still be useful hardening feedback, but they are not evidence of a broken promised boundary unless an implemented control can be bypassed.

Do not test against systems, accounts, or data you are not authorized to use. Do not create persistent availability impact or exfiltrate data to prove a report.

## Response process

No response-time SLA is currently promised. The owner should privately:

1. acknowledge receipt without reproducing sensitive content broadly;
2. determine affected source and data scope;
3. contain credential/artifact exposure if present;
4. reproduce with synthetic data;
5. add a failing regression test;
6. fix the smallest trustworthy boundary;
7. review related contract, storage, report, and documentation surfaces;
8. coordinate disclosure only after affected authorized users can update.

Coordinate any public advisory through the repository's private vulnerability report. Do not claim a fixed release until an approved release artifact exists.
