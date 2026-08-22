export type ReportStatus = "pass" | "fail" | "needs-review" | "inconclusive"

export interface EvaluationReportView {
  title: string
  projectId: string
  scenarioId: string
  executionId: string
  generatedAt: string
  executionOutcome: "valid" | "invalid-evidence" | "infra-error"
  rawStatus: ReportStatus
  reproductionCommand: string
  provenance: Array<{
    label: string
    value: string
  }>
  capabilities: Array<{
    dimension: string
    status: "measured" | "unsupported" | "unknown" | "not-applicable"
    detail?: string
  }>
  gates: Array<{
    gateId: string
    hard: boolean
    status: "pass" | "fail" | "unknown"
    reason: string
  }>
  findings: Array<{
    fingerprint: string
    severity: "blocker" | "critical" | "major" | "minor" | "info"
    dimension: string
    summary: string
    explanation?: string
    evidence?: Array<{ label: string; href: string }>
  }>
  assertions: Array<{
    assertionId: string
    status: "passed" | "failed" | "not-evaluated"
    expected?: string
    actual?: string
  }>
  runtimeEntries: Array<{
    level: string
    message: string
  }>
  visual?: {
    status: "measured" | "unknown"
    changedPixelRatio?: number
    reason?: string
    candidateHref?: string
    referenceHref?: string
    diffHref?: string
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function safeLocalHref(value: string | undefined): string | null {
  if (!value || value.startsWith("/") || value.includes("\\")) return null
  if (value.split("/").some((part) => part === "..")) return null
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return null
  return value
}

function outcomeCopy(view: EvaluationReportView): string {
  if (view.executionOutcome === "infra-error") return "Infrastructure error"
  if (view.executionOutcome === "invalid-evidence") return "Evidence inconclusive"
  if (view.rawStatus === "pass") return "Candidate passed"
  if (view.rawStatus === "fail") return "Candidate failed"
  if (view.rawStatus === "needs-review") return "Human review required"
  return "Evaluation inconclusive"
}

function evidenceLinks(
  evidence: Array<{ label: string; href: string }> | undefined,
): string {
  const links = (evidence ?? [])
    .map(({ label, href }) => {
      const safeHref = safeLocalHref(href)
      return safeHref
        ? `<a href="${escapeHtml(safeHref)}">${escapeHtml(label)}</a>`
        : ""
    })
    .filter(Boolean)

  return links.length > 0 ? `<p class="evidence">${links.join(" · ")}</p>` : ""
}

export function renderEvaluationReportHtml(view: EvaluationReportView): string {
  const capabilityRows = view.capabilities
    .map(
      (capability) => `<tr>
        <td>${escapeHtml(capability.dimension)}</td>
        <td><span class="pill ${escapeHtml(capability.status)}">${escapeHtml(capability.status)}</span></td>
        <td>${escapeHtml(capability.detail ?? "")}</td>
      </tr>`,
    )
    .join("")

  const gateRows = view.gates
    .map(
      (gate) => `<tr>
        <td><code>${escapeHtml(gate.gateId)}</code></td>
        <td>${gate.hard ? "hard" : "soft"}</td>
        <td><span class="pill ${escapeHtml(gate.status)}">${escapeHtml(gate.status)}</span></td>
        <td>${escapeHtml(gate.reason)}</td>
      </tr>`,
    )
    .join("")

  const findings = view.findings
    .map(
      (finding) => `<article class="finding ${escapeHtml(finding.severity)}">
        <div class="finding-head">
          <span class="pill ${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <span>${escapeHtml(finding.dimension)}</span>
        </div>
        <h3>${escapeHtml(finding.summary)}</h3>
        ${finding.explanation ? `<p>${escapeHtml(finding.explanation)}</p>` : ""}
        <code class="fingerprint">${escapeHtml(finding.fingerprint)}</code>
        ${evidenceLinks(finding.evidence)}
      </article>`,
    )
    .join("")

  const assertions = view.assertions
    .map(
      (assertion) => `<tr>
        <td><code>${escapeHtml(assertion.assertionId)}</code></td>
        <td><span class="pill ${escapeHtml(assertion.status)}">${escapeHtml(assertion.status)}</span></td>
        <td>${escapeHtml(assertion.expected ?? "")}</td>
        <td>${escapeHtml(assertion.actual ?? "")}</td>
      </tr>`,
    )
    .join("")

  const runtimeEntries = view.runtimeEntries
    .map(
      (entry) => `<li><strong>${escapeHtml(entry.level)}</strong> ${escapeHtml(entry.message)}</li>`,
    )
    .join("")

  const provenanceRows = view.provenance
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.label)}</td>
        <td><code>${escapeHtml(entry.value)}</code></td>
      </tr>`,
    )
    .join("")

  const visualLinks = view.visual
    ? [
        ["Candidate", view.visual.candidateHref],
        ["Reference", view.visual.referenceHref],
        ["Diff", view.visual.diffHref],
      ]
        .map(([label, href]) => {
          const safeHref = safeLocalHref(href)
          return safeHref
            ? `<a class="visual-card" href="${escapeHtml(safeHref)}"><span>${label}</span><img src="${escapeHtml(safeHref)}" alt="${label} evidence"></a>`
            : ""
        })
        .filter(Boolean)
        .join("")
    : ""

  const visual = view.visual
    ? `<section>
        <h2>Visual evidence</h2>
        <p>${
          view.visual.status === "measured"
            ? `Changed pixel ratio: <strong>${escapeHtml(((view.visual.changedPixelRatio ?? 0) * 100).toFixed(4))}%</strong>. Phase 0A treats this as advisory evidence, not a calibrated quality score.`
            : `Unavailable: ${escapeHtml(view.visual.reason ?? "unknown")}`
        }</p>
        <div class="visual-grid">${visualLinks}</div>
      </section>`
    : ""

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(view.title)} · UI Eval</title>
  <style>
    :root { --bg:#f4f7f6; --surface:#fff; --text:#15211b; --muted:#607068; --line:#d9e4de; --brand:#2e8b57; --bad:#b42318; --warn:#9a6700; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    main { width:min(1120px,calc(100% - 32px)); margin:32px auto 72px; }
    header,section { background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:24px; margin:16px 0; }
    h1,h2,h3,p { margin-top:0; } h1 { font-size:clamp(28px,5vw,44px); line-height:1.08; } h2 { font-size:21px; }
    .summary { display:grid; grid-template-columns:1fr auto; gap:20px; align-items:start; }
    .meta { color:var(--muted); } .outcome { font-size:18px; font-weight:750; }
    table { width:100%; border-collapse:collapse; } th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em; overflow-wrap:anywhere; }
    .command { display:block; padding:14px; border-radius:10px; background:#122018; color:#e8fff1; }
    .pill { display:inline-block; border-radius:999px; padding:2px 8px; background:#edf3f0; font-size:12px; font-weight:700; }
    .fail,.failed,.blocker,.critical { color:var(--bad); } .unknown,.unsupported,.needs-review { color:var(--warn); }
    .finding { border-left:4px solid var(--line); padding:16px; margin:12px 0; background:color-mix(in srgb,var(--surface) 94%,var(--bg)); }
    .finding.blocker,.finding.critical { border-left-color:var(--bad); } .finding-head { display:flex; gap:8px; color:var(--muted); }
    .fingerprint { color:var(--muted); } .evidence a,a { color:var(--brand); }
    .visual-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .visual-card { display:grid; gap:8px; } .visual-card img { width:100%; border:1px solid var(--line); border-radius:10px; }
    @media (max-width:760px) { .summary,.visual-grid { grid-template-columns:1fr; } section,header { padding:18px; overflow-x:auto; } }
    @media (prefers-color-scheme:dark) { :root { --bg:#0f1512; --surface:#171f1b; --text:#edf7f1; --muted:#a8b8af; --line:#33433a; } .command { background:#09100c; } }
    @media print { body { background:#fff; } main { width:100%; margin:0; } header,section { break-inside:avoid; box-shadow:none; } }
  </style>
</head>
<body>
<main>
  <header class="summary">
    <div>
      <p class="meta">UI Conformance · ${escapeHtml(view.projectId)} · ${escapeHtml(view.scenarioId)}</p>
      <h1>${escapeHtml(view.title)}</h1>
      <p class="outcome">${escapeHtml(outcomeCopy(view))}</p>
      <p class="meta">Execution: ${escapeHtml(view.executionOutcome)} · Raw status: ${escapeHtml(view.rawStatus)}</p>
    </div>
    <div class="meta">${escapeHtml(view.generatedAt)}<br><code>${escapeHtml(view.executionId)}</code></div>
  </header>

  <section><h2>Reproduce</h2><code class="command">${escapeHtml(view.reproductionCommand)}</code></section>

  <section><h2>Provenance</h2><table><thead><tr><th>Input</th><th>Identity</th></tr></thead><tbody>${provenanceRows}</tbody></table></section>

  <section><h2>Actual evaluation capabilities</h2><table><thead><tr><th>Dimension</th><th>Status</th><th>Detail</th></tr></thead><tbody>${capabilityRows}</tbody></table></section>

  <section><h2>Policy gates</h2><table><thead><tr><th>Gate</th><th>Type</th><th>Status</th><th>Reason</th></tr></thead><tbody>${gateRows}</tbody></table></section>

  <section><h2>Findings</h2>${findings || "<p>No findings.</p>"}</section>

  ${visual}

  <section><h2>Assertions</h2><table><thead><tr><th>Assertion</th><th>Status</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${assertions}</tbody></table></section>

  <section><h2>Runtime evidence</h2><ul>${runtimeEntries}</ul></section>
</main>
</body>
</html>`
}
