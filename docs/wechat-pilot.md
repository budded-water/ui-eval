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

Evaluation opens that dedicated project in `fullMode`. In a controlled DevTools
run, switching an initialized window to `liteMode` left the first storage API
call waiting for an automator response; the same scenario completed in
`fullMode`. The editor/debugger may therefore be visible during evaluation.
This does not change the declared project, readiness checks, deadlines, state
restoration or evidence requirements. It is not a guarantee that every DevTools
transport failure is resolved.

Compiled files must stay inside the dedicated runtime. Private DevTools
configuration overrides are rejected. Missing action acknowledgements cannot
pass. If process or state cleanup is incomplete, the runtime lock remains:
inspect owned processes, close the pilot window and regenerate the dedicated
runtime before removing its lock and retrying. Signal cleanup has a bounded
25-second CLI budget, including the 15-second state-restoration budget.

Run from an authorized, pinned engine checkout:

```sh
bun run ui-eval wechat-pilot doctor --project-root /path/to/candidate
bun run ui-eval wechat-pilot probe --project-root /path/to/candidate
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

## Diagnose before accepting

`doctor` checks CLI readiness only. `probe` reads the current page and storage-key
count from an already-open synthetic runtime. It uses the runtime lock and
integrity checks, writes no application storage, and never opens or restarts a
window. Its JSON/text response is transport evidence, not an acceptance report.

Failed calls record bounded diagnostics: phase, tool, failure code, elapsed and
budget milliseconds, exit code. Phases separate readiness, open, state, action,
evidence and cleanup. Raw output, identities, arguments, storage contents and
pending task IDs are excluded. The known automator timeout has its own code.
Diagnostics never change acceptance or authorize an automatic retry.

## Record a visual observation

Before capture, declare `reviews` in `ui-eval/wechat.json`, each with `id`,
`scenarioId`, `checkpointId` and a concrete visual `criterion`. After inspecting
the original PNG, run:

```sh
bun run ui-eval wechat-pilot review --project-root /path/to/candidate \
  --report .ui-eval/wechat-runs/EXECUTION/report.json --review spacing \
  --decision pass --reviewer operator --note 'Inspected the original checkpoint image'
```

The private JSON/HTML pair under `.ui-eval/wechat-reviews/` binds source, original
report, checkpoint PNG and declared criterion. Recording revalidates original
evidence and unchanged source. Failed/inconclusive runs cannot receive a review.
The original human report must exactly render the validated JSON and its image
references; unrelated or modified original HTML is rejected. Available visual
failures remain failures when another applicable run lacks its observation.
The automated result is unchanged. Aliases are self-reported, not authenticated
identity or approval. Review exits are pass 0, fail 1 and inconclusive 2.

## Reconcile a declared scope

Track a `VerificationPlan` under `ui-eval/` before capture. A visual requirement
names its criterion with `visualReview: true` and `visualReviewId`. Write a private
scope containing `apiVersion: uieval.io/wechat-assessment-v1`,
`kind: WechatAssessmentScope`, `verificationPlan`, `reports` and `reviews` paths.
Run `wechat-pilot assess --scope .ui-eval/scope.json --project-root <root>`.
It revalidates original reports, PNGs and review pairs, then writes a verification
record and human report under `.ui-eval/wechat-assessments/`.

Code, UI and release conclusions remain separate. This supplies L4 DevTools
evidence only. Real GPS, system permission prompts, mobile networks, overseas
tile coverage and experience-version selection need separate evidence. Missing
L5 requirements remain pending even when simulator UI passes. Conflicting
observations require an explicit scope choice; no newest-win rule is used.
Assessment uses verification exit codes 0/1/2/3. Captured runtime digests remain
provenance; later review validates original artifacts, not a subsequent build.
