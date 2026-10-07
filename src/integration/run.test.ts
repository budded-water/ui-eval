import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { initUiEvalProject } from "../cli/init"
import { runCli, CliInterruptedError } from "../cli/main"
import { evaluateScenario, type EvaluateScenarioDependencies } from "../orchestrator/evaluate"
import { canonicalDigest } from "../contracts/canonical-json"
import type { WebCheckpointSpec, WebScenarioStep } from "../contracts/model"
import { PLAYWRIGHT_CAPTURE_ADAPTER_ID, PLAYWRIGHT_CAPTURE_ADAPTER_VERSION, PLAYWRIGHT_CAPTURE_CAPABILITIES } from "../capture-playwright/adapter"
import { IncompleteCleanupError } from "../runtime/cleanup"
import { runIntegrationSuite, type IntegrationDependencies } from "./run"
import { loadIntegrationSuite } from "./config"
import { assertIntegrationResult } from "./model"
import { writeIntegrationArtifacts, renderIntegrationHtml } from "./report"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const source = async () => ({ repository: "synthetic", commitSha: "a".repeat(40), dirtyTree: false })
const capture: NonNullable<EvaluateScenarioDependencies["capture"]> = async (plan, context) => {
  const checkpoint = plan.checkpoints[0] as WebCheckpointSpec
  const evidence = await Promise.all(checkpoint.requiredChannels.map(async (channel) => ({
    channel, required: true, status: "captured" as const,
    artifact: await context.artifactStore.put({ channel }, { mediaType: "application/json", sensitivity: "internal" }),
  })))
  const environment = { os: "test", architecture: "test", rendererProfile: "desktop-chromium", browserOrDevice: "chromium:playwright",
    browserOrOsVersion: "1", driverVersion: "test", locale: plan.locale, timezone: plan.determinism.timezone, fontSetDigest: `sha256:${"a".repeat(64)}` as const }
  return {
    executionId: context.executionId, runManifestDigest: context.runManifestDigest, captureKey: context.captureKey,
    scenarioId: plan.scenarioId, variant: plan.variant, sourceRevision: context.sourceRevision, build: context.build,
    adapter: { id: PLAYWRIGHT_CAPTURE_ADAPTER_ID, version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION, platform: "web" },
    environment: { ...environment, environmentDigest: canonicalDigest(environment) }, capabilities: [...PLAYWRIGHT_CAPTURE_CAPABILITIES],
    status: "completed", completeness: { expectedRequired: evidence.length, capturedRequired: evidence.length, missingRequired: 0 },
    stepResults: ([...plan.setup, ...plan.steps, ...plan.cleanup] as WebScenarioStep[]).map((step) => ({ stepId: step.id, status: "passed", origin: "product" })),
    assertionResults: ((checkpoint.assertions ?? []) as Array<{ id: string }>).map((assertion) => ({ assertionId: assertion.id, checkpointId: checkpoint.id,
      status: "passed", origin: "product", expected: { kind: "boolean", value: true }, actual: { kind: "boolean", value: true } })),
    checkpoints: [{ checkpointId: checkpoint.id, renderSpace: plan.device.renderSpace, capturedAt: "2026-10-07T00:00:00.000Z", evidence }],
  }
}
const evaluate: NonNullable<IntegrationDependencies["evaluate"]> = (options) => evaluateScenario(options, {
  capture, sourceRevision: source, ensureServer: async () => ({ url: "http://127.0.0.1:3000", reused: true, stop: async () => {} }),
})
const dependencies: IntegrationDependencies = { evaluate, source, verifyEngine: async () => {} }

async function project(twoScenarios = false) {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-integration-test-"))
  roots.push(root)
  for (const id of twoScenarios ? ["home", "details"] : ["home"]) {
    await initUiEvalProject({ projectRoot: root, route: "/", scenarioId: id })
    const path = join(root, `ui-eval/scenarios/${id}.json`)
    const scenario = JSON.parse(await readFile(path, "utf8"))
    scenario.requiredCapabilities = ["console", "network", "crash"]
    scenario.checkpoints[0].requiredChannels = [...scenario.requiredCapabilities]
    scenario.matrix.locales = ["en", "zh-CN"]
    await writeFile(path, JSON.stringify(scenario))
  }
  const config = JSON.parse(await readFile(join(root, "ui-eval/project.json"), "utf8"))
  await mkdir(join(root, "ui-eval/integrations"))
  await writeFile(join(root, "ui-eval/engine.json"), JSON.stringify({ repository: "https://example.invalid/ui-eval.git", revision: "a".repeat(40) }))
  await writeFile(join(root, "ui-eval/integrations/smoke.json"), JSON.stringify({
    apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: "smoke", projectId: config.projectId, adapter: "web",
    prepare: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1000 }, checks: [],
    scenarios: (twoScenarios ? ["home", "details"] : ["home"]).map((id) => ({ id, timeoutMs: 10000 })),
  }))
  return realpath(root)
}
async function update(root: string, fn: (value: ReturnType<typeof JSON.parse>) => void) {
  const path = join(root, "ui-eval/integrations/smoke.json")
  const suite = JSON.parse(await readFile(path, "utf8")); fn(suite); await writeFile(path, JSON.stringify(suite))
}

describe("integration runner", () => {
  it("prepares once across scenarios and variants and publishes one complete acceptance pair", async () => {
    const root = await project(true)
    const command = vi.fn(async () => ({ exitCode: 0, stdout: "sensitive command output", stderr: "hidden" }))
    const verifyEngine = vi.fn(async () => {})
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies, command, verifyEngine })
    expect(result.exitCode).toBe(0)
    expect(command).toHaveBeenCalledOnce()
    expect(verifyEngine).toHaveBeenCalledTimes(2)
    expect(result.stages.filter((stage) => stage.kind === "scenario").map((stage) => stage.reports.length)).toEqual([2, 2])
    expect(result.stages.every((stage) => stage.durationMs >= 0 && stage.status === "pass")).toBe(true)
    const json = await readFile(result.summaryPath, "utf8")
    expect(JSON.parse(json)).toEqual(result)
    expect(json).not.toContain("sensitive command output")
    const html = await readFile(result.summaryHtmlPath, "utf8")
    expect(html).toContain("smoke: pass")
    expect(html).toContain("Geometry / typography constraints: unsupported")
    expect(html).not.toContain("sensitive command output")
    assertIntegrationResult(result)
  })

  it("lets an after check reject passing browser reports without rewriting their truth", async () => {
    const root = await project()
    await update(root, (suite) => { suite.checks = [{ id: "api-contract", command: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 1000,
      phase: "after", dimension: "api-data", failureOutcome: "candidate" }] })
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, dependencies)
    expect(result).toMatchObject({ status: "fail", exitCode: 1 })
    expect(result.stages.find((stage) => stage.id === "api-contract")?.status).toBe("fail")
    const report = result.stages.find((stage) => stage.kind === "scenario")!.reports[0]
    expect(JSON.parse(await readFile(join(root, report.reportPath), "utf8")).spec.rawStatus).toBe("pass")
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("api-contract")
  })

  it("records check infrastructure failure as inconclusive rather than product repair", async () => {
    const root = await project()
    await update(root, (suite) => { suite.checks = [{ id: "backend-ready", command: "missing-command-synthetic", args: [], timeoutMs: 1000,
      phase: "before", dimension: "api-data", failureOutcome: "infrastructure" }] })
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, dependencies)
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.kind === "scenario")?.status).toBe("not-run")
  })

  it.each(["empty", "foreign", "missing-variant", "missing-html", "contradiction", "corrupt-json"])("rejects %s evidence", async (defect) => {
    const root = await project()
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies, evaluate: async (options) => {
      const output = await evaluate(options)
      if (defect === "empty") output.runs = []
      if (defect === "foreign") output.projectId = "another-project"
      if (defect === "missing-variant") output.runs.pop()
      if (defect === "missing-html") await rm(output.runs[0].htmlPath)
      if (defect === "contradiction") output.runs[0].rawStatus = "fail"
      if (defect === "corrupt-json") await writeFile(output.runs[0].reportPath, "{}")
      return output
    } })
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.kind === "scenario")?.status).toBe("inconclusive")
  })

  it("refuses a pin mismatch before executing project commands", async () => {
    const root = await project(); const command = vi.fn()
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies, command, verifyEngine: async () => { throw new Error("wrong pin") } })
    expect(result.exitCode).toBe(2); expect(command).not.toHaveBeenCalled()
  })

  it.each(["capture-missing", "capture-corrupt", "artifact-missing", "artifact-corrupt", "manifest", "plan", "policy"])("rejects damaged underlying evidence after checks (%s)", async (defect) => {
    const root = await project()
    await update(root, (suite) => { suite.checks = [{ id: "after", command: "check", args: [], timeoutMs: 1000,
      phase: "after", dimension: "contract", failureOutcome: "candidate" }] })
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies,
      command: async (_command, _args, options) => {
        const context = JSON.parse(options.input!)
        const report = context.stages.find((stage: { kind: string }) => stage.kind === "scenario")?.reports[0]
        if (report) {
          const directory = dirname(join(root, report.reportPath))
          const capturePath = join(directory, "capture.json")
          if (defect === "capture-missing") await rm(capturePath)
          if (defect === "capture-corrupt") await writeFile(capturePath, "{}")
          if (defect === "artifact-missing") await rm(join(root, ".ui-eval/artifacts"), { recursive: true })
          if (defect === "artifact-corrupt") {
            const capture = JSON.parse(await readFile(capturePath, "utf8"))
            const ref = capture.spec.checkpoints[0].evidence[0].artifact
            const hex = ref.digest.slice(7)
            await writeFile(join(root, ".ui-eval/artifacts/projects", ref.projectId, "stores", ref.storeId, "sha256", hex.slice(0, 2), hex), "changed bytes")
          }
          const files: Record<string, string> = { manifest: "run-manifest.json", plan: "evaluation-plan.json", policy: "policy.json" }
          if (files[defect]) await writeFile(join(directory, files[defect]), "{}")
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.id === "evidence-after")?.status).toBe("inconclusive")
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).status).toBe("inconclusive")
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("smoke: inconclusive")
  })

  it("waits for deadline cleanup before after checks and refuses the adapter's late success", async () => {
    const root = await project()
    await update(root, (suite) => { suite.scenarios[0].timeoutMs = 1000; suite.checks = [{ id: "after", command: "check", args: [], timeoutMs: 1000,
      phase: "after", dimension: "contract", failureOutcome: "candidate" }] })
    let cleaned = false
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies, cleanupTimeoutMs: 500,
      evaluate: async (options) => {
        expect(options.signal).toBeDefined()
        await new Promise<void>((done) => options.signal!.addEventListener("abort", () => setTimeout(() => { cleaned = true; done() }, 5), { once: true }))
        return { projectId: "unused", scenarioId: "home", runs: [] }
      },
      command: async (_command, _args, options) => {
        const context = JSON.parse(options.input!)
        if (context.stages.some((stage: { kind: string; status: string }) => stage.kind === "scenario" && stage.status === "inconclusive")) expect(cleaned).toBe(true)
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(cleaned).toBe(true)
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.id === "home")).toMatchObject({ status: "inconclusive", cleanupSettled: true })
  })

  it.each(["json", "html"])("revalidates original %s evidence after external checks", async (artifact) => {
    const root = await project()
    await update(root, (suite) => { suite.checks = [{ id: "after", command: "check", args: [], timeoutMs: 1000,
      phase: "after", dimension: "contract", failureOutcome: "candidate" }] })
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies,
      command: async (_command, _args, options) => {
        const context = JSON.parse(options.input!)
        const report = context.stages.find((stage: { kind: string }) => stage.kind === "scenario")?.reports[0]
        if (report) await writeFile(join(root, artifact === "json" ? report.reportPath : report.htmlPath), artifact === "json" ? "{}" : "Changed HTML")
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.id === "evidence-after")?.status).toBe("inconclusive")
  })

  it("rejects candidate or engine drift at the end", async () => {
    const root = await project()
    let call = 0
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies,
      source: async () => ({ ...await source(), commitSha: ++call === 1 ? "a".repeat(40) : "b".repeat(40) }),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.id === "source-after")?.status).toBe("inconclusive")
    let verifies = 0
    const drift = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies,
      verifyEngine: async () => { if (++verifies === 2) throw new Error("engine changed") },
    })
    expect(drift.exitCode).toBe(2)
  })

  it("blocks subsequent scenarios and checks while adapter cleanup is incomplete", async () => {
    const root = await project(true)
    await update(root, (suite) => { suite.checks = [{ id: "after", command: "test", args: [], timeoutMs: 1000,
      phase: "after", dimension: "api-data", failureOutcome: "candidate" }] })
    const invoke = vi.fn(async () => { throw new IncompleteCleanupError("owned process still live") })
    const command = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { ...dependencies, evaluate: invoke, command })
    expect(result.exitCode).toBe(2); expect(invoke).toHaveBeenCalledOnce(); expect(command).toHaveBeenCalledOnce()
    expect(result.stages.find((stage) => stage.id === "home")?.cleanupSettled).toBe(false)
    expect(result.stages.find((stage) => stage.id === "after")?.status).toBe("not-run")
  })

  it("publishes interrupted summaries and preserves conventional signal exit codes", async () => {
    const root = await project(); const controller = new AbortController()
    await expect(runIntegrationSuite({ projectRoot: root, suite: "smoke", signal: controller.signal }, { ...dependencies,
      evaluate: async () => { controller.abort(new CliInterruptedError("SIGTERM")); throw controller.signal.reason },
      publish: async (result, projectRoot) => {
        expect(result).toMatchObject({ exitCode: 143, status: "interrupted" })
        await writeIntegrationArtifacts(result, projectRoot)
        expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("interrupted")
      },
    })).rejects.toThrow("SIGTERM")
  })

  it("rejects missing human-report publication and keeps JSON stdout singular", async () => {
    const root = await project(); const stdout: string[] = []; const stderr: string[] = []
    const code = await runCli(["integrate", "smoke", "--format", "json"], { cwd: root, stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v) }, {
      integrate: (options) => runIntegrationSuite(options, { ...dependencies, publish: async () => { throw new Error("publication failed") } }),
    })
    expect(code).toBe(2); expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]).error.message).toBe("publication failed")
    expect(stderr.length).toBeGreaterThan(0)
  })

  it("escapes HTML and rejects report links outside the project", async () => {
    const root = await project(); const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, dependencies)
    result.stages[0].reason = '<script>alert("x")</script>'
    expect(renderIntegrationHtml(result, root)).not.toContain('<script>alert')
    result.stages.find((stage) => stage.kind === "scenario")!.reports[0].htmlPath = "../../outside.html"
    expect(() => renderIntegrationHtml(result, root)).toThrow("escapes")
    result.exitCode = 0; result.stages[0].status = "inconclusive"
    expect(() => assertIntegrationResult(result)).toThrow("contradicts")
  })

  it("refuses symlinked authoring and unsupported native or adapter options", async () => {
    const root = await project()
    const suitePath = join(root, "ui-eval/integrations/smoke.json")
    await writeFile(join(root, "suite-copy.json"), await readFile(suitePath)); await rm(suitePath); await symlink(join(root, "suite-copy.json"), suitePath)
    await expect(loadIntegrationSuite(root, "smoke")).rejects.toThrow("symlink")
    await rm(suitePath); await writeFile(suitePath, await readFile(join(root, "suite-copy.json")))
    await update(root, (suite) => { suite.adapter = "native-pilot" })
    await expect(loadIntegrationSuite(root, "smoke")).rejects.toThrow("Invalid")
    await update(root, (suite) => { suite.adapter = "web"; suite.driver = "unrelated-driver" })
    await expect(loadIntegrationSuite(root, "smoke")).rejects.toThrow("not supported")
  })
})
