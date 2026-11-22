import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const strict = { additionalProperties: false }
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
const phase = Type.Union((["readiness", "open", "state", "action", "evidence", "cleanup"] as const).map((value) => Type.Literal(value)))
const tool = Type.String({ pattern: "^[a-z_]{1,80}$" })
const duration = Type.Integer({ minimum: 0 })
export const WechatFailureSchema = Type.Object({
  phase, tool,
  code: Type.Union(["command-failed", "automator-timeout", "invalid-envelope", "response-binding", "authorization-pending", "action-unconfirmed", "deadline"].map((value) => Type.Literal(value))),
  elapsedMs: duration, budgetMs: Type.Number({ minimum: 0, maximum: 30000 }),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
}, strict)
const WechatDriverTimingSchema = Type.Object({
  phase, tool, calls: Type.Integer({ minimum: 1 }), failedCalls: Type.Integer({ minimum: 0 }), elapsedMs: duration,
}, strict)
export type WechatDriverTiming = Static<typeof WechatDriverTimingSchema>
export const WechatPilotResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/wechat-pilot-v1"), kind: Type.Literal("WechatPilotResult"), experimental: Type.Literal(true),
  projectId: Type.String(), scenarioId: Type.String(), executionId: Type.String(),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]), reason: Type.String(),
  planDigest: digest, sourceDigest: digest, sourceCommit: Type.String(), runtimeDigest: digest,
  driver: Type.Object({ clientName: Type.String(), skillVersion: Type.String() }, strict),
  steps: Type.Array(Type.Object({ index: Type.Integer({ minimum: 0 }), action: Type.String(), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-run")]), elapsedMs: Type.Optional(duration) }, strict)),
  assertions: Type.Object({ passed: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }) }, strict),
  screenshots: Type.Array(Type.Object({ checkpointId: Type.String(), path: Type.String({ pattern: "^[a-z][a-z0-9-]*\\.png$" }), digest, widthPx: Type.Integer({ minimum: 1 }), heightPx: Type.Integer({ minimum: 1 }) }, strict)),
  pendingTaskId: Type.Optional(Type.String()),
  diagnostics: Type.Optional(Type.Array(WechatFailureSchema, { maxItems: 300 })),
  timings: Type.Optional(Type.Object({
    driver: Type.Array(WechatDriverTimingSchema, { maxItems: 300 }),
    identityBeforeMs: duration, identityAfterMs: duration, totalMs: duration,
  }, strict)),
  cleanup: Type.Union([Type.Literal("completed"), Type.Literal("incomplete")]),
  limitations: Type.Array(Type.String()),
}, strict)
export type WechatPilotResult = Static<typeof WechatPilotResultSchema>
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
export function renderWechatReport(result: WechatPilotResult): string {
  if (!Value.Check(WechatPilotResultSchema, result)) throw new Error("Invalid WeChat pilot result")
  if (result.status === "passed" && (result.cleanup !== "completed" || result.steps.some((step) => step.status !== "passed") || result.assertions.passed < 1 || result.assertions.failed !== 0 || result.screenshots.length < 1)) throw new Error("WeChat pilot pass is missing acceptance evidence")
  const showElapsed = result.steps.some((step) => step.elapsedMs !== undefined)
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><title>WeChat UI Eval pilot</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 24px}img{width:100%;max-width:340px;border:1px solid #ddd}figure{display:inline-block;vertical-align:top;margin:16px}code{overflow-wrap:anywhere}td,th{padding:8px;text-align:left}</style><h1>${escape(result.scenarioId)}: ${escape(result.status)}</h1><p>${escape(result.reason)}</p><p>Experimental WeChat DevTools evidence · assertions: ${result.assertions.passed} passed, ${result.assertions.failed} failed · cleanup: ${escape(result.cleanup)}</p><p>Source: <code>${escape(result.sourceCommit)}</code> · compiled runtime: <code>${escape(result.runtimeDigest)}</code></p><table><tr><th>Step</th><th>Action</th><th>Result</th>${showElapsed ? "<th>Step elapsed (ms)</th>" : ""}</tr>${result.steps.map((step) => `<tr><td>${step.index + 1}</td><td>${escape(step.action)}</td><td>${escape(step.status)}</td>${showElapsed ? `<td>${step.elapsedMs ?? "—"}</td>` : ""}</tr>`).join("")}</table>${result.screenshots.map((shot) => `<figure><figcaption>${escape(shot.checkpointId)} (${shot.widthPx} × ${shot.heightPx})</figcaption><img src="${escape(shot.path)}" alt="${escape(shot.checkpointId)}"></figure>`).join("")}<h2>Coverage limits</h2><ul>${result.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><p>Machine record: <a href="report.json">report.json</a></p></html>\n`
  const diagnostics = result.diagnostics?.length ? `<h2>Sanitized failure stages</h2><ul>${result.diagnostics.map((entry) => `<li>${escape(entry.phase)} / ${escape(entry.tool)} / ${escape(entry.code)} (${entry.elapsedMs} ms; budget ${entry.budgetMs} ms)</li>`).join("")}</ul>` : ""
  const timing = result.timings
  const timings = timing ? `<h2>Driver timing by phase and tool</h2><p>Evaluation: ${timing.totalMs} ms. Identity checks: ${timing.identityBeforeMs} ms before capture, ${timing.identityAfterMs} ms after capture.</p><table><tr><th>Phase</th><th>Tool</th><th>Calls</th><th>Failed calls</th><th>Elapsed (ms)</th></tr>${timing.driver.map((row) => `<tr><td>${escape(row.phase)}</td><td>${escape(row.tool)}</td><td>${row.calls}</td><td>${row.failedCalls}</td><td>${row.elapsedMs}</td></tr>`).join("")}</table>` : ""
  return html + diagnostics + timings
}
export async function writeWechatReport(directory: string, result: WechatPilotResult): Promise<void> {
  const html = renderWechatReport(result)
  await writeFile(resolve(directory, "report.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  await writeFile(resolve(directory, "report.html"), html, { flag: "wx", mode: 0o600 })
}
