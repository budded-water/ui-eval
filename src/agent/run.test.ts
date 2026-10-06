import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { EvaluateScenarioResult } from "../orchestrator/evaluate"
import { runAgentSuite } from "./run"
import { initUiEvalProject } from "../cli/init"
import { evaluateScenario } from "../orchestrator/evaluate"
import { IncompleteCleanupError } from "../runtime/cleanup"
import type { AgentSuite } from "./config"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function project(options?: { repair?: boolean; reference?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-agent-run-"))
  roots.push(root)
  await mkdir(join(root, "ui-eval", "agents"), { recursive: true })
  await writeFile(
    join(root, "ui-eval", "agents", "rentals.json"),
    JSON.stringify({
      apiVersion: "uieval.io/v1alpha1",
      kind: "AgentSuite",
      id: "rentals",
      revision: 1,
      maxIterations: 3,
      plateau: { maxConsecutiveNoImprovement: 2, minScoreImprovement: 0.01 },
      requiredDimensions: ["maintainability", "visual"],
      mutation: {
        allowedPathPrefixes: ["app", "components"],
        protectedPathPrefixes: ["ui-eval", ".ui-eval"],
        maxChangedFiles: 8,
      },
      scenarios: [
        options?.reference
          ? {
              id: "rentals-list",
              reference: "ui-eval/references/list.png",
              maxChangedPixelRatio: 0.03,
              dimensions: ["visual"],
              timeoutMs: 60_000,
            }
          : { id: "rentals-list", dimensions: ["visual"], timeoutMs: 60_000 },
      ],
      checks: [{ id: "quality", command: "npm", args: ["test"], timeoutMs: 1000, dimension: "maintainability" }],
      ...(options?.repair
        ? { repair: { command: "codex", args: ["exec", "-"], timeoutMs: 1000 } }
        : {}),
    }),
  )
  return root
}

function evaluation(pixelRatio?: number): EvaluateScenarioResult {
  return {
    projectId: "project",
    scenarioId: "rentals-list",
    runs: [
      {
        executionId: "run-1",
        variantKey: "desktop",
        executionOutcome: "valid",
        rawStatus: pixelRatio === undefined ? "pass" : "needs-review",
        reportPath: "/run/report.json",
        htmlPath: "/run/report.html",
        report: {
          spec: {
            metrics: pixelRatio === undefined ? {} : { "visual.changedPixelRatio": pixelRatio },
            gates: [{ gateId: "execution-valid", hard: true, status: "pass", reason: "ok" }],
            findings:
              pixelRatio === undefined || pixelRatio === 0
                ? []
                : [
                    {
                      dimension: "pixel",
                      metricKey: "visual.changedPixelRatio",
                      measurement: { actual: { kind: "ratio", value: pixelRatio } },
                    },
                  ],
          },
        } as EvaluateScenarioResult["runs"][number]["report"],
      },
    ],
  }
}

function inconclusiveEvaluation(): EvaluateScenarioResult {
  const result = evaluation()
  result.runs[0].executionOutcome = "infra-error"
  result.runs[0].rawStatus = "inconclusive"
  return result
}

describe("runAgentSuite", () => {
  async function updateSuite(root: string, update: (suite: AgentSuite) => void) {
    const path = join(root, "ui-eval/agents/rentals.json")
    const suite = JSON.parse(await readFile(path, "utf8"))
    update(suite)
    await writeFile(path, JSON.stringify(suite))
  }
  const scopeDeps = { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    listChangedFiles: async () => [], snapshotFiles: async () => new Map<string, string>() }
  it("preserves the mandatory floor, adds only declared scenarios and publishes selected scope", async () => {
    const projectRoot = await project()
    await updateSuite(projectRoot, (suite) => { suite.optionalScenarios = [{ ...suite.scenarios[0], id: "details" }] })
    const evaluate = vi.fn(async () => evaluation())
    const result = await runAgentSuite({ projectRoot, suite: "rentals", additionalScenarios: ["details", "details"] }, { ...scopeDeps, evaluate })
    expect(result.accepted).toBe(true)
    expect(evaluate.mock.calls).toHaveLength(2)
    expect(result.scope).toEqual({ requiredScenarioIds: ["rentals-list"], selectedScenarioIds: ["rentals-list", "details"] })
    const machine = JSON.parse(await readFile(result.summaryPath, "utf8"))
    expect(machine.scope).toEqual(result.scope)
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("details")
  })
  it("requires every selected optional scenario to pass", async () => {
    const projectRoot = await project()
    await updateSuite(projectRoot, (suite) => { suite.optionalScenarios = [{ ...suite.scenarios[0], id: "details" }] })
    const result = await runAgentSuite({ projectRoot, suite: "rentals", fullScope: true, repair: false }, { ...scopeDeps,
      evaluate: async (options) => options.scenario === "details" ? { ...evaluation(), runs: [{ ...evaluation().runs[0], rawStatus: "fail" }] } : evaluation(),
    })
    expect(result.accepted).toBe(false)
    expect(result.scope?.selectedScenarioIds).toEqual(["rentals-list", "details"])
  })
  it("rejects undeclared suggestions, duplicate scope IDs and profile overrides before execution", async () => {
    const projectRoot = await project()
    const evaluate = vi.fn()
    await expect(runAgentSuite({ projectRoot, suite: "rentals", additionalScenarios: ["unknown"] }, { evaluate })).rejects.toThrow("Undeclared")
    await updateSuite(projectRoot, (suite) => { suite.executionProfile = "preview" })
    await expect(runAgentSuite({ projectRoot, suite: "rentals", executionProfile: "local" }, { evaluate })).rejects.toThrow("Cannot override")
    await updateSuite(projectRoot, (suite) => { suite.optionalScenarios = suite.scenarios })
    await expect(runAgentSuite({ projectRoot, suite: "rentals" }, { evaluate })).rejects.toThrow("unique IDs")
    expect(evaluate).not.toHaveBeenCalled()
  })
  it("disables remote repairs and re-captures accepted scenarios during infrastructure retries", async () => {
    const projectRoot = await project({ repair: true })
    await initUiEvalProject({ projectRoot, route: "/", scenarioId: "rentals-list" })
    await updateSuite(projectRoot, (suite) => {
      suite.executionProfile = "preview"
      suite.scenarios.push({ ...suite.scenarios[0], id: "details" })
    })
    const path = join(projectRoot, "ui-eval/project.json")
    const config = JSON.parse(await readFile(path, "utf8"))
    config.baseUrls.preview = "https://preview.example.invalid"
    config.executionProfiles = { preview: { mode: "remote", baseUrlRef: "preview", frontend: { identityPath: "/version" }, readinessTimeoutMs: 1000 } }
    await writeFile(path, JSON.stringify(config))
    const evaluate = vi.fn(async (options) => options.scenario === "details" ? inconclusiveEvaluation() : evaluation())
    const runCommand = vi.fn(scopeDeps.runCommand)
    await expect(runAgentSuite({ projectRoot, suite: "rentals", repair: true }, { ...scopeDeps, evaluate, runCommand })).rejects.toThrow("does not authorize product repair")
    const result = await runAgentSuite({ projectRoot, suite: "rentals" }, { ...scopeDeps, evaluate, runCommand })
    expect(result.accepted).toBe(false)
    expect(evaluate).toHaveBeenCalledTimes(6)
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(evaluate.mock.calls.every(([options]) => options.executionProfile === "preview")).toBe(true)
    expect(result.iterations.every((iteration) => iteration.scenarios.every((scenario) => scenario.reusedFromIteration === undefined))).toBe(true)
  })
  it.each([false, true])("blocks explicit cleanup failure without repair (aggregate: %s)", async (aggregate) => {
    const root = await project({ repair: true })
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: true }, {
      evaluate: async () => {
        const error = new IncompleteCleanupError("Owned browser cleanup did not settle")
        throw aggregate ? new AggregateError([error, new Error("server cleanup failed")], "Cleanup failed") : error
      },
      runCommand, listChangedFiles: async () => [], snapshotFiles: async () => new Map(),
    })
    expect(result.status).toBe("blocked")
    expect(result.iterations).toHaveLength(1)
    expect(result.iterations[0].scenarios[0].cleanupSettled).toBe(false)
    expect(runCommand).toHaveBeenCalledOnce()
  })

  it("accepts a measured zero pixel ratio without inventing a finding", async () => {
    const root = await project({ reference: true })
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: false }, {
      evaluate: async () => evaluation(0),
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      listChangedFiles: async () => [], snapshotFiles: async () => new Map(),
    })
    expect(result.status).toBe("accepted")
    expect(result.iterations[0].scenarios[0].changedPixelRatio).toBe(0)
  })

  it.each(["pass", "inconclusive"] as const)("rejects a %s variant without its own pixel metric", async (rawStatus) => {
    const root = await project({ reference: true })
    const mixed = evaluation(0.01)
    mixed.runs.push({ ...evaluation().runs[0], variantKey: "mobile", rawStatus })
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: false }, {
      evaluate: async () => mixed,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      listChangedFiles: async () => [], snapshotFiles: async () => new Map(),
    })
    expect(result.accepted).toBe(false)
    expect(result.iterations[0].scenarios[0].reasons.join(" ")).toContain("mobile")
  })

  it.each(["fail", "inconclusive"] as const)("rejects a %s report even with a pixel metric below the ceiling", async (rawStatus) => {
    const root = await project({ reference: true })
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: false }, {
      evaluate: async () => {
        const measured = evaluation(0.01)
        measured.runs[0].rawStatus = rawStatus
        return measured
      },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      listChangedFiles: async () => [], snapshotFiles: async () => new Map(),
    })
    expect(result.accepted).toBe(false)
  })

  it("blocks a real orchestrator cancellation while capture remains pending", async () => {
    const root = await project({ repair: true })
    await initUiEvalProject({ projectRoot: root, route: "/", scenarioId: "rentals-list" })
    const suitePath = join(root, "ui-eval", "agents", "rentals.json")
    const suite = JSON.parse(await readFile(suitePath, "utf8"))
    suite.scenarios[0].timeoutMs = 1_000
    await writeFile(suitePath, JSON.stringify(suite))
    const capture = vi.fn(() => new Promise<never>(() => {}))
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: true }, {
      evaluate: (options) => evaluateScenario(options, {
        capture, captureCleanupTimeoutMs: 10,
        ensureServer: async () => ({ url: "http://127.0.0.1:3000", reused: true, stop: async () => {} }),
        sourceRevision: async () => ({ repository: "test", commitSha: "abc123", dirtyTree: false }),
      }),
      runCommand, listChangedFiles: async () => [], snapshotFiles: async () => new Map(),
      scenarioCleanupTimeoutMs: 100,
    })
    expect(result.status).toBe("blocked")
    expect(result.reason).toContain("cleanup did not settle")
    expect(result.iterations).toHaveLength(1)
    expect(capture).toHaveBeenCalledOnce()
    expect(runCommand).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).accepted).toBe(false)
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("Blocked")
  })

  it("treats an empty evaluation result as missing infrastructure evidence", async () => {
    const root = await project({ repair: true })
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: true }, {
      evaluate: vi.fn(async () => ({ projectId: "project", scenarioId: "rentals-list", runs: [] })),
      runCommand, listChangedFiles: vi.fn(async () => []), snapshotFiles: vi.fn(async () => new Map()),
    })
    expect(result.status).toBe("exhausted")
    expect(result.accepted).toBe(false)
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(result.iterations.every((iteration) => iteration.scenarios[0].accepted === false)).toBe(true)
  })
  it("continues repairing while visual measurements improve before acceptance", async () => {
    const root = await project({ repair: true, reference: true })
    const suitePath = join(root, "ui-eval", "agents", "rentals.json")
    const suite = JSON.parse(await readFile(suitePath, "utf8"))
    suite.maxIterations = 5
    await writeFile(suitePath, JSON.stringify(suite))
    const ratios = [0.2, 0.1, 0.05, 0.02]
    const evaluate = vi.fn(async () => evaluation(ratios.shift()))
    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate,
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
      },
    )
    expect(result.status).toBe("accepted")
    expect(result.iterations.map((iteration) => iteration.score)).toEqual([0.5, 0.5, 0.5, 1])
    expect(result.iterations.map((iteration) => iteration.progressScore)).toEqual([0.9, 0.95, 0.975, 1])
  })

  it("does not reuse prior evidence after checks change source", async () => {
    const root = await project()
    const suitePath = join(root, "ui-eval", "agents", "rentals.json")
    const suite = JSON.parse(await readFile(suitePath, "utf8"))
    suite.scenarios.push({ id: "responsive", dimensions: ["visual"], timeoutMs: 60_000 })
    await writeFile(suitePath, JSON.stringify(suite))
    const evaluate = vi.fn()
      .mockResolvedValueOnce(evaluation())
      .mockRejectedValueOnce(new Error("driver unavailable"))
      .mockResolvedValue(evaluation())
    const snapshots = vi.fn()
      .mockResolvedValueOnce(new Map([["app/page.ts", "before"]]))
      .mockResolvedValueOnce(new Map([["app/page.ts", "before"]]))
      .mockResolvedValue(new Map([["app/page.ts", "after"]]))
    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: false },
      {
        evaluate,
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: snapshots,
      },
    )
    expect(result.status).toBe("accepted")
    expect(evaluate).toHaveBeenCalledTimes(4)
    expect(result.iterations[1].scenarios[0].reusedFromIteration).toBeUndefined()
  })
  it("accepts only after checks and hard gates pass", async () => {
    const root = await project()
    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: false },
      {
        evaluate: vi.fn(async () => evaluation()),
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
        now: () => new Date("2026-08-24T00:00:00.000Z"),
      },
    )

    expect(result.status).toBe("accepted")
    expect(result.summaryHtmlPath).toMatch(/summary\.html$/)
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("UI Eval Agent Report")
    expect(JSON.parse(await readFile(result.summaryPath, "utf8"))).toMatchObject({
      accepted: true,
      summaryHtmlPath: result.summaryHtmlPath,
    })
    expect(result.iterations).toHaveLength(1)
    expect(result.iterations[0].score).toBe(1)
    expect(result.iterations[0].dimensions).toEqual([
      expect.objectContaining({ id: "maintainability", status: "pass" }),
      expect.objectContaining({ id: "visual", status: "pass" }),
    ])
  })

  it("does not convert an over-threshold visual review into a pass", async () => {
    const root = await project({ reference: true })
    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: false },
      {
        evaluate: vi.fn(async () => evaluation(0.1847)),
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.iterations[0].scenarios[0].reasons.join(" ")).toContain("exceeds")
  })

  it("skips browser scenarios and stops when a blocking precondition fails", async () => {
    const root = await project()
    const suitePath = join(root, "ui-eval", "agents", "rentals.json")
    const suite = JSON.parse(await readFile(suitePath, "utf8"))
    suite.checks[0].onFailure = "block"
    await writeFile(suitePath, JSON.stringify(suite))
    const evaluate = vi.fn(async () => evaluation())

    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate,
        runCommand: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "offline" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.reason).toContain("non-repairable checks failed: quality")
    expect(result.iterations[0].scenarios).toEqual([])
    expect(result.iterations[0].dimensions).toEqual([
      expect.objectContaining({ id: "maintainability", status: "fail" }),
      expect.objectContaining({ id: "visual", status: "not-evaluated" }),
    ])
    expect(evaluate).not.toHaveBeenCalled()
  })

  it("stops when a repair adapter changes an out-of-scope path", async () => {
    const root = await project({ repair: true, reference: true })
    const listChangedFiles = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["ui-eval/policies/default.json"])
    const snapshotFiles = vi
      .fn<() => Promise<Map<string, string>>>()
      .mockResolvedValueOnce(new Map([["ui-eval/policies/default.json", "before"]]))
      .mockResolvedValueOnce(new Map([["ui-eval/policies/default.json", "before"]]))
      .mockResolvedValueOnce(new Map([["ui-eval/policies/default.json", "after"]]))
    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate: vi.fn(async () => evaluation(0.2)),
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        listChangedFiles,
        snapshotFiles,
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.reason).toContain("out-of-scope")
  })

  it("exhausts infrastructure retries without invoking repair or product plateau", async () => {
    const root = await project({ repair: true })
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))
    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate: vi.fn(async () => {
          throw new Error("driver stalled")
        }),
        runCommand,
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
      },
    )

    expect(result.status).toBe("exhausted")
    expect(result.reason).toBe("maximum iterations (3) reached")
    expect(result.iterations).toHaveLength(3)
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(result.iterations[0].scenarios[0]).toMatchObject({
      accepted: false,
      reasons: ["evaluation failed: driver stalled"],
    })
  })

  it("never sends a reported infrastructure outcome to product repair", async () => {
    const root = await project({ repair: true })
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))

    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate: vi.fn(async () => inconclusiveEvaluation()),
        runCommand,
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
      },
    )

    expect(result.status).toBe("exhausted")
    expect(result.reason).toBe("maximum iterations (3) reached")
    expect(result.iterations).toHaveLength(3)
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(result.iterations[0].scenarios[0].reports[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
  })

  it("does not send an inconclusive visual comparison with valid execution to product repair", async () => {
    const root = await project({ repair: true, reference: true })
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const result = await runAgentSuite({ projectRoot: root, suite: "rentals", repair: true }, {
      evaluate: async () => {
        const result = evaluation()
        result.runs[0].rawStatus = "inconclusive"
        return result
      },
      runCommand, listChangedFiles: async () => [], snapshotFiles: async () => new Map(),
    })
    expect(result.status).toBe("exhausted")
    expect(result.accepted).toBe(false)
    expect(runCommand).toHaveBeenCalledTimes(3)
  })

  it("blocks when a timed-out evaluator does not settle its owned resources", async () => {
    const root = await project({ repair: true })
    const suitePath = join(root, "ui-eval", "agents", "rentals.json")
    const suite = JSON.parse(await readFile(suitePath, "utf8"))
    suite.scenarios[0].timeoutMs = 1_000
    await writeFile(suitePath, JSON.stringify(suite))
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))

    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate: vi.fn(() => new Promise<never>(() => {})),
        runCommand,
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
        scenarioCleanupTimeoutMs: 1,
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.reason).toBe("evaluator cleanup did not settle: rentals-list")
    expect(result.iterations).toHaveLength(1)
    expect(result.iterations[0].scenarios[0].reasons).toEqual([
      "evaluation deadline exceeded after 1000ms; evaluator cleanup exceeded 1ms",
    ])
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it("reuses accepted immutable scenario evidence across infrastructure-only retries", async () => {
    const root = await project()
    const suitePath = join(root, "ui-eval", "agents", "rentals.json")
    const suite = JSON.parse(await readFile(suitePath, "utf8"))
    suite.scenarios.push({
      id: "rentals-responsive",
      dimensions: ["visual"],
      timeoutMs: 60_000,
    })
    await writeFile(suitePath, JSON.stringify(suite))
    const evaluate = vi
      .fn<(options: { scenario: string }) => Promise<EvaluateScenarioResult>>()
      .mockImplementationOnce(async () => evaluation())
      .mockImplementationOnce(async () => { throw new Error("browser closed") })
      .mockImplementationOnce(async () => evaluation())

    const result = await runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: true },
      {
        evaluate: evaluate as never,
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
      },
    )

    expect(result.status).toBe("accepted")
    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(result.iterations[1].scenarios).toHaveLength(2)
    expect(result.iterations[1].scenarios[0]).toMatchObject({
      id: "rentals-list",
      accepted: true,
      reusedFromIteration: 1,
    })
  })

  it("fails closed when the human-readable terminal report cannot be published", async () => {
    const root = await project()
    const writeSummaryArtifacts = vi.fn(async () => {
      throw new Error("summary HTML write failed")
    })

    await expect(runAgentSuite(
      { projectRoot: root, suite: "rentals", repair: false },
      {
        evaluate: vi.fn(async () => evaluation()),
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        listChangedFiles: vi.fn(async () => []),
        snapshotFiles: vi.fn(async () => new Map()),
        writeSummaryArtifacts,
      },
    )).rejects.toThrow("summary HTML write failed")

    expect(writeSummaryArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted", accepted: true }),
    )
  })
})
