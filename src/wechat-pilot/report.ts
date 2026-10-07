import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const strict = { additionalProperties: false }
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
export const WechatPilotResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/wechat-pilot-v1"), kind: Type.Literal("WechatPilotResult"), experimental: Type.Literal(true),
  projectId: Type.String(), scenarioId: Type.String(), executionId: Type.String(),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]), reason: Type.String(),
  planDigest: digest, sourceDigest: digest, sourceCommit: Type.String(), runtimeDigest: digest,
  driver: Type.Object({ clientName: Type.String(), skillVersion: Type.String() }, strict),
  steps: Type.Array(Type.Object({ index: Type.Integer({ minimum: 0 }), action: Type.String(), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-run")]) }, strict)),
  assertions: Type.Object({ passed: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }) }, strict),
  screenshots: Type.Array(Type.Object({ checkpointId: Type.String(), path: Type.String({ pattern: "^[a-z][a-z0-9-]*\\.png$" }), digest, widthPx: Type.Integer({ minimum: 1 }), heightPx: Type.Integer({ minimum: 1 }) }, strict)),
  pendingTaskId: Type.Optional(Type.String()),
  cleanup: Type.Union([Type.Literal("completed"), Type.Literal("incomplete")]),
  limitations: Type.Array(Type.String()),
}, strict)
export type WechatPilotResult = Static<typeof WechatPilotResultSchema>
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
export async function writeWechatReport(directory: string, result: WechatPilotResult): Promise<void> {
  if (!Value.Check(WechatPilotResultSchema, result)) throw new Error("Invalid WeChat pilot result")
  if (result.status === "passed" && (result.cleanup !== "completed" || result.steps.some((step) => step.status !== "passed") || result.assertions.passed < 1 || result.assertions.failed !== 0 || result.screenshots.length < 1)) throw new Error("WeChat pilot pass is missing acceptance evidence")
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><title>WeChat UI Eval pilot</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 24px}img{width:100%;max-width:340px;border:1px solid #ddd}figure{display:inline-block;vertical-align:top;margin:16px}code{overflow-wrap:anywhere}td,th{padding:8px;text-align:left}</style><h1>${escape(result.scenarioId)}: ${escape(result.status)}</h1><p>${escape(result.reason)}</p><p>Experimental WeChat DevTools evidence · assertions: ${result.assertions.passed} passed, ${result.assertions.failed} failed · cleanup: ${escape(result.cleanup)}</p><p>Source: <code>${escape(result.sourceCommit)}</code> · compiled runtime: <code>${escape(result.runtimeDigest)}</code></p><table><tr><th>Step</th><th>Action</th><th>Result</th></tr>${result.steps.map((step) => `<tr><td>${step.index + 1}</td><td>${escape(step.action)}</td><td>${escape(step.status)}</td></tr>`).join("")}</table>${result.screenshots.map((shot) => `<figure><figcaption>${escape(shot.checkpointId)} (${shot.widthPx} × ${shot.heightPx})</figcaption><img src="${escape(shot.path)}" alt="${escape(shot.checkpointId)}"></figure>`).join("")}<h2>Coverage limits</h2><ul>${result.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><p>Machine record: <a href="report.json">report.json</a></p></html>\n`
  await writeFile(resolve(directory, "report.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  await writeFile(resolve(directory, "report.html"), html, { flag: "wx", mode: 0o600 })
}
