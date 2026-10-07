# WeChat DevTools pilot

This experimental adapter runs declared UI interactions and captures raw PNGs
in WeChat DevTools through its installed official `wechatide` CLI. It is a
separate `wechat-pilot` command and result contract, not the Web `evaluate`
pipeline or a real-device release gate.

Candidate repositories own `ui-eval/wechat.json`, referenced scenarios, a
synthetic API fixture and a dedicated compiled runtime project. The engine
does not build the candidate, install DevTools, log in, approve authorization,
submit payments or publish a mini program. No new driver dependency is needed.

The CLI must be authorized for the configured client, logged in and compatible
with the declared skill version. Pending authorization and unavailable evidence
are inconclusive, never passes. Commands use bounded argv subprocesses and
operate only on the declared runtime project.

Compiled files must stay inside the dedicated runtime. Private DevTools
configuration overrides are rejected. Missing action acknowledgements cannot
pass. If process or state cleanup is incomplete, the runtime lock remains:
inspect owned processes, close the pilot window and regenerate the dedicated
runtime before removing its lock and retrying. Signal cleanup has a bounded
25-second CLI budget, including the 15-second state-restoration budget.

Run from an authorized, pinned engine checkout:

```sh
bun run ui-eval wechat-pilot doctor --project-root /path/to/candidate
bun run ui-eval wechat-pilot evaluate login-controls --project-root /path/to/candidate
```

Use `--driver /absolute/path/to/wechatide` when the bundled CLI is not on PATH.
`--format json` emits one machine payload. Evaluation publishes validated
`report.json` and `report.html` with declared assertions and PNG screenshots in
`.ui-eval/wechat-runs/`. Generated output is private local evidence, ignored by
Git. The candidate integration owns backend and account isolation.

The first pilot supports navigation, tap, input, explicit text/page assertions
and screenshots. It does not certify Web DOM/CSSOM geometry, crash/network
coverage, accessibility, design conformance, backend compatibility, payment,
phone-number authorization or actual mobile-WeChat rendering. Source and
compiled runtime digests are recorded and checked around capture; they do not
prove that DevTools executed exactly those bytes throughout the run.

Schema sources, generated schemas and this document describe the same pilot.
Scenario JSON is canonical for acceptance scope; the report records actual
coverage, including missing steps. Runtime project configuration and candidate
build output are a second source of state: the integration must regenerate
them from the reviewed candidate inputs before running evaluation.
