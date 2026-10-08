import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
export const NativePilotResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/native-pilot-v1"),
  kind: Type.Literal("NativePilotResult"),
  experimental: Type.Literal(true),
  projectId: Type.String(),
  scenarioId: Type.String(),
  executionId: Type.String(),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]),
  reason: Type.String(),
  planDigest: digest,
  sourceDigest: digest,
  sourceCommit: Type.String(),
  device: Type.Object({ id: Type.String(), name: Type.String(), runtime: Type.String(), maestroVersion: Type.String() }, { additionalProperties: false }),
  appId: Type.String(),
  provenanceAssurance: Type.Literal("observed-source-and-installed-app-only"),
  assertions: Type.Object({ passed: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  screenshots: Type.Array(Type.Object({
    checkpointId: Type.String(), path: Type.String({ pattern: "^[a-z][a-z0-9-]*\\.png$" }),
    digest, widthPx: Type.Integer({ minimum: 1 }), heightPx: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false })),
  limitations: Type.Array(Type.String()),
}, { additionalProperties: false })
export type NativePilotResult = Static<typeof NativePilotResultSchema>

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

export async function writeNativePilotReport(directory: string, result: NativePilotResult): Promise<void> {
  if (!Value.Check(NativePilotResultSchema, result)) throw new Error("Invalid native pilot result")
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><title>Native UI Eval pilot</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 24px}img{max-width:340px;width:100%;border:1px solid #ddd}figure{display:inline-block;vertical-align:top;margin:16px}code{overflow-wrap:anywhere}</style><h1>${escape(result.scenarioId)}: ${escape(result.status)}</h1><p>Experimental iOS Simulator evidence. ${escape(result.reason)}</p><p>${escape(result.device.name)} · ${escape(result.device.runtime)} · Maestro ${escape(result.device.maestroVersion)}</p><p>Assertions: ${result.assertions.passed} passed, ${result.assertions.failed} failed.</p><p>Source: <code>${escape(result.sourceCommit)}</code>; plan: <code>${escape(result.planDigest)}</code>.</p>${result.screenshots.map((shot) => `<figure><figcaption>${escape(shot.checkpointId)} (${shot.widthPx} × ${shot.heightPx})</figcaption><img src="${escape(shot.path)}" alt="${escape(shot.checkpointId)}"></figure>`).join("")}<h2>Coverage limits</h2><ul>${result.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><p>Machine record: <a href="report.json">report.json</a></p></html>\n`
  await writeFile(resolve(directory, "report.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
  await writeFile(resolve(directory, "report.html"), html, { flag: "wx" })
}
