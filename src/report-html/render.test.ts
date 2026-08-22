import { describe, expect, it } from "vitest"

import { renderEvaluationReportHtml } from "./render"

describe("renderEvaluationReportHtml", () => {
  it("renders outcome, capability truthfulness, gates, findings, and reproduction", () => {
    const html = renderEvaluationReportHtml({
      title: "Terms desktop",
      projectId: "example-project",
      scenarioId: "terms-desktop",
      executionId: "run-1",
      generatedAt: "2026-08-10T00:00:00.000Z",
      executionOutcome: "valid",
      rawStatus: "fail",
      reproductionCommand: "ui-eval evaluate terms-desktop",
      provenance: [
        { label: "Policy", value: "sha256:policy" },
        { label: "Evaluator", value: "execution@0.1.0" },
      ],
      capabilities: [
        { dimension: "interaction", status: "measured" },
        {
          dimension: "typography",
          status: "unsupported",
          detail: "structured design styles unavailable",
        },
      ],
      gates: [
        {
          gateId: "interaction",
          hard: true,
          status: "fail",
          reason: "1 assertion failed",
        },
      ],
      findings: [
        {
          fingerprint: "sha256:finding",
          severity: "critical",
          dimension: "content",
          summary: "Heading differs",
        },
      ],
      assertions: [],
      runtimeEntries: [],
    })

    expect(html).toContain("Candidate failed")
    expect(html).toContain("structured design styles unavailable")
    expect(html).toContain("Heading differs")
    expect(html).toContain("ui-eval evaluate terms-desktop")
    expect(html).toContain("sha256:policy")
    expect(html).toContain("execution@0.1.0")
    expect(html).not.toContain("Overall score")
  })

  it("escapes untrusted evidence and only permits safe local report links", () => {
    const html = renderEvaluationReportHtml({
      title: "<script>alert(1)</script>",
      projectId: "project",
      scenarioId: "scenario",
      executionId: "run",
      generatedAt: "2026-08-10T00:00:00.000Z",
      executionOutcome: "valid",
      rawStatus: "needs-review",
      reproductionCommand: "evaluate <scenario>",
      provenance: [{ label: "source", value: "<unsafe>" }],
      capabilities: [],
      gates: [],
      findings: [
        {
          fingerprint: "finding",
          severity: "major",
          dimension: "runtime",
          summary: '<img src=x onerror="alert(1)">',
          evidence: [
            { label: "candidate", href: "report-assets/candidate.png" },
            { label: "unsafe", href: "javascript:alert(1)" },
          ],
        },
      ],
      assertions: [
        {
          assertionId: '<assertion onmouseover="alert(1)">',
          status: "failed",
          expected: '<script>alert("expected")</script>',
          actual: '<img src=x onerror="alert(\'actual\')">',
        },
      ],
      runtimeEntries: [],
    })

    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("<img src=x")
    expect(html).not.toContain("<assertion onmouseover")
    expect(html).not.toContain("javascript:")
    expect(html).toContain("&lt;script&gt;alert")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert")
    expect(html).toContain("report-assets/candidate.png")
  })
})
