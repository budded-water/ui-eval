import { dirname, relative, resolve, sep } from "node:path"
import { atomicWriteFile, ensureContainedDirectory, assertPathContained, assertSafeSegment } from "../storage-local/filesystem"
import { assertIntegrationResult, type IntegrationResult } from "./model"

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

export function renderIntegrationHtml(result: IntegrationResult, projectRoot: string): string {
  const link = (path: string, label: string) => {
    assertPathContained(projectRoot, resolve(projectRoot, path))
    const href = relative(dirname(result.summaryHtmlPath), resolve(projectRoot, path)).split(sep)
      .map((part) => part === ".." ? part : encodeURIComponent(part)).join("/")
    return `<a href="${escape(href)}">${escape(label)}</a>`
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>UI Eval integration</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #ccc;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}.table{overflow:auto}li{margin:8px 0}</style><h1>${escape(result.suiteId)}: ${escape(result.status)}</h1><p>Project: ${escape(result.projectId)} · Adapter: ${escape(result.adapter)} · Exit: ${result.exitCode} · Duration: ${Math.round(result.durationMs)} ms</p><p>Engine: <code>${escape(result.engine.revision)}</code> · Profile: ${escape(result.executionProfile ?? "default")} · Browser: ${escape(result.browserChannel ?? "adapter default")}</p><div class="table"><table><thead><tr><th>Stage</th><th>Result</th><th>Duration</th><th>Evidence and coverage</th></tr></thead><tbody>${result.stages.map((stage) => `<tr><td>${escape(stage.kind)}: ${escape(stage.id)}${stage.dimension ? `<br>${escape(stage.dimension)}` : ""}</td><td>${escape(stage.status)}<br>${escape(stage.reason)}</td><td>${Math.round(stage.durationMs)} ms</td><td>${stage.reports.map((report) => `${escape(report.variantKey)}: ${escape(report.status)} ${link(report.htmlPath, "HTML")} · ${link(report.reportPath, "JSON")}<ul>${report.capabilities.map((capability) => `<li>${escape(capability.dimension)}: ${escape(capability.status)} — ${escape(capability.detail)}</li>`).join("")}</ul>`).join("")}</td></tr>`).join("")}</tbody></table></div><h2>Acceptance limits</h2><ul>${result.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><p>${link(relative(projectRoot, result.summaryPath), "Canonical integration JSON")}</p></html>\n`
}

/** Publish the human view first; only a complete pair is a completed integration. */
export async function writeIntegrationArtifacts(result: IntegrationResult, projectRoot: string): Promise<void> {
  assertIntegrationResult(result)
  assertSafeSegment(result.executionId, "integration executionId")
  if (result.summaryPath !== resolve(projectRoot, ".ui-eval/integration", result.executionId, "summary.json")) throw new Error("Integration summary must belong to its generated execution directory")
  await ensureContainedDirectory(projectRoot, dirname(result.summaryPath))
  if (result.summaryHtmlPath !== resolve(dirname(result.summaryPath), "summary.html") ||
    result.summaryPath !== resolve(dirname(result.summaryPath), "summary.json")) throw new Error("Invalid integration report paths")
  const html = renderIntegrationHtml(result, projectRoot)
  await atomicWriteFile(result.summaryHtmlPath, Buffer.from(html))
  await atomicWriteFile(result.summaryPath, Buffer.from(`${JSON.stringify(result, null, 2)}\n`))
}
