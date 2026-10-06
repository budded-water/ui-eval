import { describe, expect, it } from "vitest"

import type { AgentRunResult } from "./run"
import { renderAgentSummaryHtml } from "./report"

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    suiteId: "rentals",
    status: "accepted",
    accepted: true,
    generatedAt: "2026-08-24T00:00:00.000Z",
    summaryPath: "/project/.ui-eval/agent-runs/agent-1/summary.json",
    summaryHtmlPath: "/project/.ui-eval/agent-runs/agent-1/summary.html",
    reason: "all checks, hard gates, and predeclared thresholds passed",
    iterations: [
      {
        iteration: 1,
        score: 1,
        accepted: true,
        changedFiles: ["app/rentals/page.tsx"],
        checks: [
          {
            id: "real-api",
            passed: true,
            onFailure: "block",
            exitCode: 0,
            durationMs: 80,
            output: "HTTP 200",
          },
        ],
        dimensions: [
          { id: "api-data", status: "pass", score: 1, evidence: ["check:real-api"] },
          { id: "visual", status: "pass", score: 1, evidence: ["scenario:list"] },
        ],
        scenarios: [
          {
            id: "list",
            accepted: true,
            score: 1,
            changedPixelRatio: 0.191079,
            maxChangedPixelRatio: 0.2,
            reasons: [],
            reports: [
              {
                variantKey: "desktop",
                rawStatus: "needs-review",
                executionOutcome: "valid",
                reportPath: "/project/.ui-eval/runs/run-1/report.json",
                htmlPath: "/project/.ui-eval/runs/run-1/report.html",
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe("renderAgentSummaryHtml", () => {
  it("renders a single human entry point for dimensions, checks, scenarios, visuals, and history", () => {
    const html = renderAgentSummaryHtml(result())

    expect(html).toContain("Acceptance Dimensions")
    expect(html).toContain("Project &amp; API Checks")
    expect(html).toContain("Interaction &amp; Visual Scenarios")
    expect(html).toContain("Agent Loop")
    expect(html).toContain("19.11%")
    expect(html).toContain("ceiling 20.0%")
    expect(html).toContain("../../runs/run-1/candidate.png")
    expect(html).toContain("../../runs/run-1/reference.png")
    expect(html).toContain("../../runs/run-1/diff.png")
    expect(html).toContain("../../runs/run-1/report.html")
    expect(html).toContain("href=\"summary.json\"")
  })

  it.each([
    ["accepted", "Accepted"],
    ["blocked", "Blocked"],
    ["plateau", "Plateau Reached"],
    ["exhausted", "Iteration Budget Exhausted"],
  ] as const)("makes the %s terminal state explicit", (status, label) => {
    const html = renderAgentSummaryHtml(result({
      status,
      accepted: status === "accepted",
    }))
    expect(html).toContain(label)
  })

  it("escapes report data and refuses links outside the UI Eval artifact root", () => {
    const malicious = result({
      suiteId: "<script>alert(1)</script>",
      reason: "<img src=x onerror=alert(1)>",
    })
    malicious.iterations[0].checks[0].output = "</pre><script>alert(2)</script>"
    malicious.iterations[0].scenarios[0].reports[0].htmlPath = "/private/secret/report.html"
    malicious.iterations[0].scenarios[0].reports[0].reportPath = "/private/secret/report.json"

    const html = renderAgentSummaryHtml(malicious)

    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("/private/secret")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(2)&lt;/script&gt;")
    expect(html).toContain("Open Detailed Report unavailable")
  })

  it("scrubs the candidate root from human-facing command output", () => {
    const input = result()
    input.iterations[0].checks[0].output =
      "RUN /project\n/project/app/rentals/page.tsx passed"

    const html = renderAgentSummaryHtml(input)

    expect(html).not.toContain("/project/app/rentals/page.tsx")
    expect(html).toContain("[project-root]/app/rentals/page.tsx")
  })

  it("uses semantic navigation, headings, tables, image metadata, and visible focus styles", () => {
    const html = renderAgentSummaryHtml(result())

    expect(html).toContain("Skip to Report")
    expect(html).toContain("<main")
    expect(html).toContain("<table>")
    expect(html).toContain("scope=\"col\"")
    expect(html).toContain("width=\"640\" height=\"360\" loading=\"lazy\"")
    expect(html).toContain(":focus-visible")
    expect(html).not.toContain("outline:none")
    expect(html).not.toContain("transition:all")
  })
})
