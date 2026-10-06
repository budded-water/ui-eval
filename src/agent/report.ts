import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import type { AgentRunResult, AgentStatus } from "./model"

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function percent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: value > 0 && value < 0.01 ? 2 : 1,
    maximumFractionDigits: 2,
  }).format(value)
}

function timestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return value
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: "UTC",
  }).format(parsed)
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "accepted": return "Accepted"
    case "blocked": return "Blocked"
    case "plateau": return "Plateau Reached"
    case "exhausted": return "Iteration Budget Exhausted"
  }
}

function scrubProjectRoot(result: AgentRunResult, value: string): string {
  const artifactRoot = resolve(dirname(result.summaryHtmlPath), "..", "..")
  const projectRoot = dirname(artifactRoot)
  return value.replaceAll(projectRoot, "[project-root]")
}

function safeArtifactHref(summaryHtmlPath: string, targetPath: string): string | undefined {
  if (!isAbsolute(summaryHtmlPath) || !isAbsolute(targetPath)) return undefined
  const reportDirectory = dirname(resolve(summaryHtmlPath))
  const artifactRoot = resolve(reportDirectory, "..", "..")
  const target = resolve(targetPath)
  const fromArtifactRoot = relative(artifactRoot, target)
  if (
    fromArtifactRoot === ".." ||
    fromArtifactRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromArtifactRoot)
  ) {
    return undefined
  }
  return relative(reportDirectory, target)
    .split(sep)
    .map((segment) => segment === ".." ? segment : encodeURIComponent(segment))
    .join("/")
}

function artifactLink(
  result: AgentRunResult,
  targetPath: string,
  label: string,
  className = "artifact-link",
): string {
  const href = safeArtifactHref(result.summaryHtmlPath, targetPath)
  if (!href) return `<span class="artifact-unavailable">${escapeHtml(label)} unavailable</span>`
  return `<a class="${className}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
}

function summaryMetrics(result: AgentRunResult): string {
  const latest = result.iterations.at(-1)
  const bestScore = result.iterations.reduce(
    (best, iteration) => Math.max(best, iteration.score),
    0,
  )
  const dimensions = latest?.dimensions ?? []
  const passedDimensions = dimensions.filter((dimension) => dimension.status === "pass").length
  const totalScenarios = latest?.scenarios.length ?? 0
  const acceptedScenarios = latest?.scenarios.filter((scenario) => scenario.accepted).length ?? 0
  return `
    <section class="metrics" aria-label="Run summary">
      <article class="metric"><span>Latest Score</span><strong>${percent(latest?.score ?? 0)}</strong></article>
      <article class="metric"><span>Best Score</span><strong>${percent(bestScore)}</strong></article>
      <article class="metric"><span>Dimensions</span><strong>${passedDimensions}/${dimensions.length}</strong></article>
      <article class="metric"><span>Scenarios</span><strong>${acceptedScenarios}/${totalScenarios}</strong></article>
      <article class="metric"><span>Iterations</span><strong>${result.iterations.length}</strong></article>
    </section>`
}

function dimensionsSection(result: AgentRunResult): string {
  const dimensions = result.iterations.at(-1)?.dimensions ?? []
  if (dimensions.length === 0) {
    return `<section class="panel"><h2>Acceptance Dimensions</h2><p class="empty">No dimensions were evaluated.</p></section>`
  }
  return `
    <section class="panel" aria-labelledby="dimensions-heading">
      <div class="section-heading"><h2 id="dimensions-heading">Acceptance Dimensions</h2><span>${dimensions.filter((item) => item.status === "pass").length}/${dimensions.length} passed</span></div>
      <div class="dimension-grid">
        ${dimensions.map((dimension) => `
          <article class="dimension ${escapeHtml(dimension.status)}">
            <div><h3 translate="no">${escapeHtml(dimension.id)}</h3><p>${dimension.evidence.length > 0 ? dimension.evidence.map(escapeHtml).join(" · ") : "Missing evidence"}</p></div>
            <span class="badge ${escapeHtml(dimension.status)}">${escapeHtml(dimension.status)}</span>
          </article>`).join("")}
      </div>
    </section>`
}

function checksSection(result: AgentRunResult): string {
  const checks = result.iterations.at(-1)?.checks ?? []
  if (checks.length === 0) {
    return `<section class="panel"><h2>Project &amp; API Checks</h2><p class="empty">No checks were configured.</p></section>`
  }
  return `
    <section class="panel" aria-labelledby="checks-heading">
      <div class="section-heading"><h2 id="checks-heading">Project &amp; API Checks</h2><span>${checks.filter((item) => item.passed).length}/${checks.length} passed</span></div>
      <div class="table-scroll" tabindex="0">
        <table>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Duration</th><th scope="col">Failure Policy</th><th scope="col">Evidence</th></tr></thead>
          <tbody>${checks.map((check) => `
            <tr>
              <th scope="row" translate="no">${escapeHtml(check.id)}</th>
              <td><span class="badge ${check.passed ? "pass" : "fail"}">${check.passed ? "pass" : "fail"}</span></td>
              <td class="numeric">${escapeHtml(new Intl.NumberFormat("en-US").format(check.durationMs))}&nbsp;ms</td>
              <td translate="no">${escapeHtml(check.onFailure)}</td>
              <td>${check.output ? `<details><summary>View output</summary><pre>${escapeHtml(scrubProjectRoot(result, check.output))}</pre></details>` : "No output"}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
    </section>`
}

function visualEvidence(
  result: AgentRunResult,
  report: AgentRunResult["iterations"][number]["scenarios"][number]["reports"][number],
): string {
  const runDirectory = dirname(report.htmlPath)
  const images = [
    ["Candidate", resolve(runDirectory, "candidate.png")],
    ["Reference", resolve(runDirectory, "reference.png")],
    ["Diff", resolve(runDirectory, "diff.png")],
  ] as const
  return `
    <div class="visual-grid">
      ${images.map(([label, path]) => {
        const href = safeArtifactHref(result.summaryHtmlPath, path)
        return href
          ? `<figure><a href="${escapeHtml(href)}"><img src="${escapeHtml(href)}" width="640" height="360" loading="lazy" alt="${escapeHtml(`${label} capture for ${report.variantKey}`)}"></a><figcaption>${escapeHtml(label)}</figcaption></figure>`
          : ""
      }).join("")}
    </div>`
}

function scenariosSection(result: AgentRunResult): string {
  const scenarios = result.iterations.at(-1)?.scenarios ?? []
  if (scenarios.length === 0) {
    return `<section class="panel"><h2>Interaction &amp; Visual Scenarios</h2><p class="empty">Scenarios were not evaluated.</p></section>`
  }
  return `
    <section class="panel" aria-labelledby="scenarios-heading">
      <div class="section-heading"><h2 id="scenarios-heading">Interaction &amp; Visual Scenarios</h2><span>${scenarios.filter((item) => item.accepted).length}/${scenarios.length} accepted</span></div>
      <div class="scenario-list">
        ${scenarios.map((scenario) => `
          <article class="scenario">
            <div class="scenario-heading">
              <div><h3 translate="no">${escapeHtml(scenario.id)}</h3><p>Score ${percent(scenario.score)}${scenario.changedPixelRatio === undefined ? "" : ` · Changed pixels ${percent(scenario.changedPixelRatio)}${scenario.maxChangedPixelRatio === undefined ? "" : ` / ceiling ${percent(scenario.maxChangedPixelRatio)}`} <span class="raw">(${escapeHtml(scenario.changedPixelRatio)})</span>`}${scenario.reusedFromIteration === undefined ? "" : ` · Evidence reused from iteration ${scenario.reusedFromIteration}`}</p></div>
              <span class="badge ${scenario.accepted ? "pass" : "fail"}">${scenario.accepted ? "accepted" : "failed"}</span>
            </div>
            ${scenario.reasons.length > 0 ? `<ul class="reasons">${scenario.reasons.map((reason) => `<li>${escapeHtml(scrubProjectRoot(result, reason))}</li>`).join("")}</ul>` : `<p class="success-copy">All declared scenario gates passed.</p>`}
            ${scenario.reports.map((report) => `
              <section class="run-evidence" aria-label="${escapeHtml(`${report.variantKey} evidence`)}">
                <div class="run-heading">
                  <div><h4 translate="no">${escapeHtml(report.variantKey)}</h4><p><span class="badge ${report.executionOutcome === "valid" ? "pass" : "fail"}">${escapeHtml(report.executionOutcome)}</span> <span class="badge neutral">${escapeHtml(report.rawStatus)}</span></p></div>
                  <div class="links">${artifactLink(result, report.htmlPath, "Open Detailed Report")} ${artifactLink(result, report.reportPath, "JSON")}</div>
                </div>
                ${scenario.changedPixelRatio === undefined ? "" : visualEvidence(result, report)}
              </section>`).join("")}
          </article>`).join("")}
      </div>
    </section>`
}

function timelineSection(result: AgentRunResult): string {
  return `
    <section class="panel" aria-labelledby="timeline-heading">
      <div class="section-heading"><h2 id="timeline-heading">Agent Loop</h2><span>${result.iterations.length} iteration${result.iterations.length === 1 ? "" : "s"}</span></div>
      <ol class="timeline">
        ${result.iterations.map((iteration) => `
          <li>
            <div class="timeline-marker" aria-hidden="true"></div>
            <div class="timeline-content">
              <div class="timeline-heading"><h3>Iteration ${iteration.iteration}</h3><span class="badge ${iteration.accepted ? "pass" : "fail"}">${iteration.accepted ? "accepted" : "not accepted"}</span></div>
              <p>Acceptance score ${percent(iteration.score)} · Repair progress ${percent(iteration.progressScore ?? iteration.score)} · ${iteration.checks.filter((check) => check.passed).length}/${iteration.checks.length} checks · ${iteration.scenarios.filter((scenario) => scenario.accepted).length}/${iteration.scenarios.length} scenarios</p>
              <p>${iteration.changedFiles.length} changed file${iteration.changedFiles.length === 1 ? "" : "s"}${iteration.repairRequestPath ? ` · ${artifactLink(result, iteration.repairRequestPath, "Repair Request")}` : ""}</p>
              ${iteration.changedFiles.length > 0 ? `<details><summary>View changed files</summary><ul class="files">${iteration.changedFiles.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul></details>` : ""}
            </div>
          </li>`).join("")}
      </ol>
    </section>`
}

export function renderAgentSummaryHtml(result: AgentRunResult): string {
  const label = statusLabel(result.status)
  const statusClass = result.accepted ? "accepted" : "not-accepted"
  const jsonHref = safeArtifactHref(result.summaryHtmlPath, result.summaryPath)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f7f3">
  <title>${escapeHtml(result.suiteId)} · UI Eval Agent Report</title>
  <style>
    :root { color-scheme: light; --ink:#16231c; --muted:#657269; --line:#dce4dd; --surface:#fff; --canvas:#f5f7f3; --green:#087a4f; --green-soft:#e7f5ed; --red:#a02d35; --red-soft:#fcecee; --amber:#835b0c; --amber-soft:#fff5d9; --shadow:0 18px 60px rgba(24,50,35,.08); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; }
    html { background:var(--canvas); scroll-behavior:smooth; }
    body { margin:0; color:var(--ink); background:linear-gradient(180deg,#ecf4ee 0,#f5f7f3 360px); }
    a { color:var(--green); text-underline-offset:3px; touch-action:manipulation; }
    a:hover { color:#045b3b; }
    a:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline:3px solid #66b693; outline-offset:3px; border-radius:4px; }
    .skip-link { position:absolute; left:16px; top:-80px; z-index:10; padding:10px 14px; background:var(--ink); color:#fff; border-radius:8px; }
    .skip-link:focus { top:16px; }
    .shell { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:56px 0 80px; }
    .hero { padding:38px; border:1px solid rgba(8,122,79,.16); border-radius:24px; background:rgba(255,255,255,.92); box-shadow:var(--shadow); }
    .eyebrow { margin:0 0 12px; color:var(--green); font-size:13px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
    h1,h2,h3,h4 { margin:0; line-height:1.15; text-wrap:balance; scroll-margin-top:24px; }
    h1 { max-width:820px; font-size:clamp(34px,6vw,68px); letter-spacing:-.045em; overflow-wrap:anywhere; }
    h2 { font-size:25px; letter-spacing:-.025em; }
    h3 { font-size:18px; overflow-wrap:anywhere; }
    h4 { font-size:15px; }
    p { line-height:1.6; }
    .status-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:22px; }
    .status { display:inline-flex; align-items:center; min-height:38px; padding:8px 14px; border-radius:999px; font-weight:800; }
    .status.accepted { color:var(--green); background:var(--green-soft); }
    .status.not-accepted { color:var(--red); background:var(--red-soft); }
    .reason { max-width:780px; margin:18px 0 0; color:#3f4c44; font-size:17px; overflow-wrap:anywhere; }
    .meta { display:flex; gap:10px 22px; flex-wrap:wrap; margin-top:22px; color:var(--muted); font-size:13px; }
    .metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin:18px 0 34px; }
    .metric { min-width:0; padding:20px; border:1px solid var(--line); border-radius:16px; background:var(--surface); }
    .metric span { display:block; color:var(--muted); font-size:13px; }
    .metric strong { display:block; margin-top:8px; font-size:25px; font-variant-numeric:tabular-nums; }
    .panel { margin-top:18px; padding:28px; border:1px solid var(--line); border-radius:20px; background:var(--surface); box-shadow:0 8px 28px rgba(24,50,35,.04); }
    .section-heading,.scenario-heading,.run-heading,.timeline-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .section-heading>span { color:var(--muted); font-size:13px; white-space:nowrap; }
    .dimension-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:20px; }
    .dimension { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; min-width:0; padding:16px; border:1px solid var(--line); border-radius:14px; }
    .dimension p,.scenario-heading p,.timeline-content p { margin:6px 0 0; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    .badge { display:inline-flex; align-items:center; padding:5px 9px; border-radius:999px; font-size:11px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; white-space:nowrap; }
    .badge.pass { color:var(--green); background:var(--green-soft); }
    .badge.fail,.badge.not-evaluated { color:var(--red); background:var(--red-soft); }
    .badge.neutral { color:#465248; background:#eef1ee; }
    .table-scroll { margin-top:20px; overflow-x:auto; }
    table { width:100%; min-width:760px; border-collapse:collapse; font-size:13px; }
    th,td { padding:14px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    thead th { color:var(--muted); font-size:11px; letter-spacing:.06em; text-transform:uppercase; }
    tbody tr:last-child th,tbody tr:last-child td { border-bottom:0; }
    .numeric { font-variant-numeric:tabular-nums; white-space:nowrap; }
    details { margin-top:4px; }
    summary { color:var(--green); cursor:pointer; font-weight:700; touch-action:manipulation; }
    pre { max-width:640px; max-height:300px; overflow:auto; padding:14px; border-radius:10px; background:#101914; color:#dff3e7; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .scenario-list { display:grid; gap:14px; margin-top:20px; }
    .scenario { padding:20px; border:1px solid var(--line); border-radius:16px; }
    .reasons { margin:14px 0 0; padding:12px 12px 12px 32px; border-radius:10px; color:var(--red); background:var(--red-soft); }
    .success-copy { margin:14px 0 0; color:var(--green); }
    .raw { color:var(--muted); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .run-evidence { margin-top:18px; padding-top:18px; border-top:1px solid var(--line); }
    .run-heading p { margin:8px 0 0; }
    .links { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .artifact-link { display:inline-flex; align-items:center; min-height:36px; padding:7px 11px; border:1px solid #b9d7c7; border-radius:9px; background:#f7fbf8; font-size:12px; font-weight:750; text-decoration:none; }
    .artifact-link:hover { background:var(--green-soft); border-color:#86bea1; }
    .artifact-unavailable { color:var(--muted); font-size:12px; }
    .visual-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:14px; }
    figure { margin:0; min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:12px; background:#f2f4f2; }
    figure a { display:block; }
    figure img { display:block; width:100%; height:auto; aspect-ratio:16/9; object-fit:contain; background:#fff; }
    figcaption { padding:9px 11px; color:var(--muted); font-size:12px; font-weight:700; }
    .timeline { margin:24px 0 0; padding:0; list-style:none; }
    .timeline>li { position:relative; display:grid; grid-template-columns:18px minmax(0,1fr); gap:14px; padding-bottom:24px; }
    .timeline>li:not(:last-child)::before { content:""; position:absolute; left:7px; top:14px; bottom:0; width:2px; background:var(--line); }
    .timeline-marker { width:16px; height:16px; margin-top:2px; border:4px solid var(--green-soft); border-radius:50%; background:var(--green); }
    .files { columns:2; padding-left:20px; }
    code { font-size:12px; overflow-wrap:anywhere; }
    .empty { color:var(--muted); }
    .footer { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-top:24px; color:var(--muted); font-size:12px; }
    @media (max-width:860px) { .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .dimension-grid { grid-template-columns:1fr; } .visual-grid { grid-template-columns:1fr; } }
    @media (max-width:560px) { .shell { width:min(100% - 24px,1180px); padding:24px 0 48px; } .hero,.panel { padding:20px; border-radius:16px; } .metrics { grid-template-columns:1fr 1fr; } .metric { padding:15px; } .metric strong { font-size:21px; } .scenario-heading,.run-heading { align-items:flex-start; flex-direction:column; } .links { justify-content:flex-start; } .files { columns:1; } }
    @media (prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
    @media print { body { background:#fff; } .shell { width:100%; padding:0; } .hero,.panel,.metric { box-shadow:none; break-inside:avoid; } details:not([open])>*:not(summary) { display:block; } a { color:inherit; text-decoration:none; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to Report</a>
  <main class="shell" id="main-content">
    <header class="hero">
      <p class="eyebrow">UI Eval Agent Report</p>
      <h1 translate="no">${escapeHtml(result.suiteId)}</h1>
      <div class="status-row"><span class="status ${statusClass}" role="status">${escapeHtml(label)}</span></div>
      <p class="reason">${escapeHtml(scrubProjectRoot(result, result.reason))}</p>
      <div class="meta"><span>Generated ${escapeHtml(timestamp(result.generatedAt))}</span><span>Canonical record: ${jsonHref ? `<a href="${escapeHtml(jsonHref)}">summary.json</a>` : "unavailable"}</span></div>
    </header>
    ${summaryMetrics(result)}
    ${dimensionsSection(result)}
    ${checksSection(result)}
    ${scenariosSection(result)}
    ${timelineSection(result)}
    <footer class="footer"><span>HTML is a human-readable projection of the canonical Agent JSON.</span><span>Raw visual ratios are diagnostic and only pass through a predeclared suite threshold.</span></footer>
  </main>
</body>
</html>`
}

export async function writeAgentSummaryArtifacts(result: AgentRunResult): Promise<void> {
  const html = renderAgentSummaryHtml(result)
  await mkdir(dirname(result.summaryHtmlPath), { recursive: true })
  // Publish the human deliverable first. If this fails, no accepted JSON terminal
  // record is emitted and the Agent command fails closed.
  await writeFile(result.summaryHtmlPath, html, "utf8")
  await writeFile(result.summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
}
