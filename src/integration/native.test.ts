import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PNG } from "pngjs"
import { canonicalDigest } from "../contracts/canonical-json"
import { evaluateNativePilot } from "../native-pilot/run"
import type { NativePilotProject, NativePilotScenario } from "../native-pilot/config"
import type { runCommand } from "../runtime/command"
import { IncompleteCleanupError } from "../runtime/cleanup"
import { findNativeCommandFile } from "../native-pilot/evidence"
import { nativeIntegrationEvidence } from "./native-evidence"
import { loadIntegrationSuite, type IntegrationSuite } from "./config"
import { runIntegrationSuite, type IntegrationDependencies } from "./run"
import { recordNativeReview } from "../native-pilot/review"
import { relative } from "node:path"

vi.mock("../native-pilot/preflight", async (importOriginal) => ({
  ...await importOriginal<typeof import("../native-pilot/preflight")>(),
  nativeStorage: vi.fn(async () => ({ availableBytes: 2 * 1024 ** 3, minimumBytes: 1024 ** 3 })),
}))

const deviceId = "11111111-1111-1111-1111-111111111111"
const source = { repository: "synthetic", commitSha: "a".repeat(40), dirtyTree: false }
const project: NativePilotProject = {
  apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotProject", projectId: "synthetic-app",
  platform: "ios-simulator", appId: "test.synthetic", maestroVersion: "2.9.0", restartApp: false,
  timeoutMs: 1000, scenarios: { home: "ui-eval/home.json" },
}
const scenario: NativePilotScenario = {
  apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotScenario", scenarioId: "home",
  steps: [{ action: "assert-visible", selector: { id: "synthetic-title" } }, { action: "screenshot", checkpointId: "home" }],
}
const suite: IntegrationSuite = {
  apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: "smoke", projectId: project.projectId,
  adapter: "native-pilot", checks: [], scenarios: [{ id: "home", timeoutMs: 1000 }],
}
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function commandRecords(failed: boolean) {
  const commands = [
    { defineVariablesCommand: { env: { MAESTRO_FILENAME: "flow", MAESTRO_DEVICE_UDID: deviceId, MAESTRO_SHARD_ID: "1", MAESTRO_SHARD_INDEX: "0" }, optional: false } },
    { applyConfigurationCommand: { config: { appId: project.appId, name: "home" }, optional: false } },
    { launchAppCommand: { appId: project.appId, stopApp: false, optional: false } },
    { assertConditionCommand: { condition: { visible: { idRegex: "synthetic-title", optional: false } }, optional: false } },
    { takeScreenshotCommand: { path: "home", optional: false } },
  ]
  if (failed) commands.pop()
  return commands.map((command, index) => ({ command, metadata: {
    evaluatedCommand: command, sequenceNumber: index, depth: 0, status: failed && index === 3 ? "FAILED" : "COMPLETED",
    ...(failed && index === 3 ? { error: {
      message: "Assertion is false: id: synthetic-title is visible",
      debugMessage: "Assertion 'id: synthetic-title is visible' failed. Check the UI hierarchy in debug artifacts",
    } } : {}),
  } }))
}

async function fixture(mode: "passed" | "failed" | "inconclusive" = "passed", withReview = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-integration-"))); roots.push(root)
  await mkdir(join(root, "ui-eval"))
  await writeFile(join(root, "ui-eval/native.json"), JSON.stringify({ ...project, ...(withReview ? {
    reviews: [{ id: "header", scenarioId: "home", checkpointId: "home", criterion: "Header controls remain legible over scrolled content" }],
  } : {}) }))
  await writeFile(join(root, "ui-eval/home.json"), JSON.stringify(scenario))
  let commandPath = ""
  const command: typeof runCommand = async (binary, args) => {
    let stdout = ""
    if (args.includes("--version")) stdout = "2.9.0"
    else if (args.includes("devices")) stdout = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      { udid: deviceId, name: "Synthetic iPhone", state: "Booted", isAvailable: true },
    ] } })
    else if (binary === "maestro") {
      if (mode === "inconclusive") throw new Error("Synthetic unavailable driver")
      const directory = join(args[args.indexOf("--test-output-dir") + 1], "stamp/home")
      await mkdir(join(directory, "takeScreenshot"), { recursive: true })
      commandPath = join(directory, "commands.json")
      await writeFile(commandPath, JSON.stringify(commandRecords(mode === "failed")))
      const png = new PNG({ width: 2, height: 2 }); png.data.fill(255)
      await writeFile(join(directory, "takeScreenshot/home.png"), PNG.sync.write(png))
      return { exitCode: mode === "failed" ? 1 : 0, stdout, stderr: "" }
    }
    return { exitCode: 0, stdout, stderr: "" }
  }
  const output = await evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home" }, {
    platform: "darwin", sourceRevision: async () => source, command,
  })
  const directory = join(root, ".ui-eval/native-runs", output.result.executionId)
  const verify = () => nativeIntegrationEvidence(root, suite, "home", output, canonicalDigest(source), deviceId)
  return { root, output, directory, commandPath, command, verify }
}

describe("native integration evidence", () => {
  it("records human observations separately and binds them to unchanged validated screenshot evidence", async () => {
    const { root, output } = await fixture("passed", true)
    const before = await readFile(output.reportPath, "utf8")
    const review = await recordNativeReview({ projectRoot: root, report: relative(root, output.reportPath), review: "header", decision: "pass", reviewer: "owner", note: "Synthetic header checked at the declared checkpoint" }, async () => source)
    expect(review.result.method).toBe("human-observation")
    expect(review.result.screenshotDigest).toBe(output.result.screenshots[0].digest)
    expect(await readFile(output.reportPath, "utf8")).toBe(before)
    expect(JSON.parse(await readFile(review.reportPath, "utf8"))).toEqual(review.result)
    expect(await readFile(review.htmlPath, "utf8")).toContain("Human observation")
  })
  it.each(["failed", "source", "checkpoint", "undeclared"])("refuses a human review with %s evidence", async (defect) => {
    const { root, output, directory } = await fixture(defect === "failed" ? "failed" : "passed", true)
    if (defect === "checkpoint") await writeFile(join(directory, "home.png"), "corrupt")
    await expect(recordNativeReview({ projectRoot: root, report: relative(root, output.reportPath), review: defect === "undeclared" ? "unknown" : "header", decision: "pass", reviewer: "owner", note: "Synthetic observation" }, async () => defect === "source" ? { ...source, commitSha: "d".repeat(40) } : source)).rejects.toThrow()
  })
  it.each(["passed", "failed", "inconclusive"] as const)("preserves %s evidence without claiming broader native coverage", async (mode) => {
    const { verify } = await fixture(mode)
    const [report] = await verify()
    expect(report.status).toBe({ passed: "pass", failed: "fail", inconclusive: "inconclusive" }[mode])
    expect(report.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(report.capabilities).toContainEqual(expect.objectContaining({ dimension: "Runtime / network / design / real device", status: "unsupported" }))
  })

  it.each(["project", "device", "source", "plan", "assertions", "checkpoint", "app"])("rejects a foreign or contradictory %s", async (defect) => {
    const { output, verify } = await fixture()
    if (defect === "project") output.result.projectId = "foreign-app"
    if (defect === "device") output.result.device.id = "22222222-2222-2222-2222-222222222222"
    if (defect === "source") output.result.sourceDigest = canonicalDigest("foreign")
    if (defect === "plan") output.result.planDigest = canonicalDigest("foreign")
    if (defect === "assertions") output.result.assertions.passed = 2
    if (defect === "checkpoint") output.result.screenshots[0].checkpointId = "foreign"
    if (defect === "app") output.result.appId = "foreign.app"
    await writeFile(output.reportPath, JSON.stringify(output.result))
    await expect(verify()).rejects.toThrow()
  })

  it.each(["json", "html", "plan", "source", "flow", "copied-png", "raw-png", "commands"])("rejects missing or corrupt %s", async (defect) => {
    const { output, directory, commandPath, verify } = await fixture()
    const path = {
      json: output.reportPath, html: output.htmlPath, plan: join(directory, "plan.json"), source: join(directory, "source.json"),
      flow: join(directory, "flow.yaml"), "copied-png": join(directory, "home.png"),
      "raw-png": join(commandPath, "../takeScreenshot/home.png"), commands: commandPath,
    }[defect]!
    if (defect === "html") await rm(path)
    else await writeFile(path, "corrupt")
    await expect(verify()).rejects.toThrow()
  })

  it("rejects escaped or symlinked report and screenshot paths", async () => {
    const { root, output, directory, verify } = await fixture()
    const original = output.htmlPath
    output.htmlPath = join(root, "foreign.html")
    await expect(verify()).rejects.toThrow()
    output.htmlPath = original
    await writeFile(join(root, "replacement.png"), await readFile(join(directory, "home.png")))
    await rm(join(directory, "home.png"))
    await symlink(join(root, "replacement.png"), join(directory, "home.png"))
    await expect(verify()).rejects.toThrow(/symlink/)
  })

  it("fingerprints exact raw evidence so semantically equal later edits cannot retain acceptance", async () => {
    const { directory, commandPath, verify } = await fixture()
    const original = await verify()
    await writeFile(commandPath, JSON.stringify(JSON.parse(await readFile(commandPath, "utf8")), null, 2))
    expect(canonicalDigest(await verify())).not.toBe(canonicalDigest(original))
    const beforeSourceEdit = await verify()
    await writeFile(join(directory, "source.json"), JSON.stringify(source))
    expect(canonicalDigest(await verify())).not.toBe(canonicalDigest(beforeSourceEdit))
  })

  it("rejects raw command semantics that contradict a reported pass or failure", async () => {
    for (const mode of ["passed", "failed"] as const) {
      const { commandPath, verify } = await fixture(mode)
      const commands = commandRecords(mode === "failed")
      commands[2].command.launchAppCommand!.stopApp = true
      await writeFile(commandPath, JSON.stringify(commands))
      await expect(verify()).rejects.toThrow(/launch/)
    }
  })
})

async function integrationFixture(mode: "passed" | "failed" | "inconclusive" = "passed", withSession = false) {
  const fixtureData = await fixture(mode)
  const { root, command } = fixtureData
  const config = structuredClone(suite)
  if (withSession) config.session = { command: "synthetic-session", args: [], startupTimeoutMs: 1000, cleanupTimeoutMs: 1000 }
  await mkdir(join(root, "ui-eval/integrations"))
  await writeFile(join(root, "ui-eval/engine.json"), JSON.stringify({ repository: "https://example.invalid/ui-eval.git", revision: "a".repeat(40) }))
  const save = () => writeFile(join(root, "ui-eval/integrations/smoke.json"), JSON.stringify(config))
  await save()
  const dependencies: IntegrationDependencies = {
    verifyEngine: async () => {}, source: async () => source,
    native: (options) => evaluateNativePilot(options, { platform: "darwin", sourceRevision: async () => source, command }),
  }
  const options = { projectRoot: root, suite: "smoke", deviceId }
  return { ...fixtureData, config, save, dependencies, options }
}

const afterCheck: IntegrationSuite["checks"][number] = {
  id: "session-observations", phase: "after", dimension: "fixture", failureOutcome: "infrastructure",
  command: "synthetic-check", args: [], timeoutMs: 1000,
}

async function recoveryFixture(mode: "passed" | "failed" = "passed") {
  const data = await integrationFixture(mode)
  data.config.recovery = { maxAttempts: 2, context: { command: "synthetic-context", args: [], timeoutMs: 1000 } }
  data.config.scenarios[0].replaySafe = true
  await data.save()
  data.dependencies.command = async () => ({ exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "" })
  return data
}

describe("bounded native recovery", () => {
  it("keeps planned UI acceptance inconclusive when the recovery context changes after a passed capture", async () => {
    const { root, config, save, options, dependencies } = await recoveryFixture()
    config.verificationPlan = "ui-eval/verification.json"; await save()
    await writeFile(join(root, config.verificationPlan), JSON.stringify({
      apiVersion: "uieval.io/verification-v1alpha1", kind: "VerificationPlan", id: "native-change", projectId: project.projectId,
      outcome: "Declared interaction works in unchanged fixture state", plannedAt: "2026-10-22T00:00:00.000Z", planningContext: "Synthetic recovery regression",
      requirements: [{ id: "interaction", category: "ui", rationale: "Changed interaction", expectedOutcome: "Visibility assertion passes",
        level: "L4", environment: { platform: "ios-simulator" }, selector: { kind: "scenario", id: "home" }, visualReview: false }], omissions: [],
    }))
    let calls = 0
    dependencies.command = async () => ({ exitCode: 0, stdout: `sha256:${(calls++ === 0 ? "b" : "c").repeat(64)}`, stderr: "" })
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.stages.find((stage) => stage.id === "home")?.status).toBe("pass")
    expect(result.stages.find((stage) => stage.id === "recovery-context-after")?.status).toBe("inconclusive")
    expect(result.verification?.evidence[0].status).toBe("inconclusive")
    expect(result.verification?.assessment.conclusions.ui).toBe("inconclusive")
    expect(result.exitCode).toBe(2)
  })
  it("revalidates superseded inconclusive attempt evidence after candidate checks", async () => {
    const { options, dependencies, command, config, save, root } = await recoveryFixture()
    config.checks.push(afterCheck); await save()
    let calls = 0
    dependencies.native = (input) => evaluateNativePilot(input, {
      platform: "darwin", sourceRevision: async () => source,
      command: async (binary, args, config) => {
        if (binary === "maestro" && args.includes("test") && calls++ === 0) throw new Error("Synthetic driver unavailable")
        return command(binary, args, config)
      },
    })
    dependencies.command = async (binary, _args, input) => {
      if (binary === "synthetic-context") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "" }
      const context = JSON.parse(input.input!)
      const stage = context.stages.find((stage: { id: string }) => stage.id === "home")
      await writeFile(join(root, stage.attempts[0].reports[0].reportPath), "changed")
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.status).toBe("inconclusive")
    expect(result.stages.find((stage) => stage.id === "evidence-after")?.status).toBe("inconclusive")
  })
  it.each(["recovery-context-before", "recovery-context-after"])("rejects reserved user check ID %s before creating a run", async (id) => {
    const { root, config, save } = await recoveryFixture()
    config.checks.push({ id, phase: "before", dimension: "fixture", failureOutcome: "infrastructure", command: "synthetic-check", args: [], timeoutMs: 1000 })
    await save()
    await expect(loadIntegrationSuite(root, "smoke")).rejects.toThrow(/reserved/)
  })
  it("exhausts the declared budget and does not turn recurring infrastructure failure into pass", async () => {
    const { options, dependencies, command } = await recoveryFixture()
    let calls = 0
    dependencies.native = (input) => evaluateNativePilot(input, {
      platform: "darwin", sourceRevision: async () => source,
      command: async (binary, args, config) => {
        if (binary === "maestro" && args.includes("test")) { calls++; throw new Error("Synthetic unavailable driver") }
        return command(binary, args, config)
      },
    })
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.status).toBe("inconclusive")
    expect(calls).toBe(2)
    expect(result.stages.find((stage) => stage.id === "home")?.attempts?.map((attempt) => attempt.status)).toEqual(["inconclusive", "inconclusive"])
  })
  it("does not retry when the context witness changes after inconclusive evidence", async () => {
    const { options, dependencies, command } = await recoveryFixture()
    let captures = 0, contexts = 0
    dependencies.command = async () => ({ exitCode: 0, stdout: `sha256:${(contexts++ === 0 ? "b" : "c").repeat(64)}`, stderr: "" })
    dependencies.native = (input) => evaluateNativePilot(input, {
      platform: "darwin", sourceRevision: async () => source,
      command: async (binary, args, config) => {
        if (binary === "maestro" && args.includes("test")) { captures++; throw new Error("Synthetic unavailable driver") }
        return command(binary, args, config)
      },
    })
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.status).toBe("inconclusive")
    expect(captures).toBe(1)
  })
  it("never retries an unsettled driver cleanup", async () => {
    const { options, dependencies } = await recoveryFixture()
    const native = vi.fn(async () => { throw new IncompleteCleanupError("Synthetic unsettled driver") })
    const result = await runIntegrationSuite(options, { ...dependencies, native })
    expect(result.status).toBe("inconclusive")
    expect(result.stages.find((stage) => stage.id === "home")?.cleanupSettled).toBe(false)
    expect(native).toHaveBeenCalledTimes(1)
  })
  it("retries only replay-safe inconclusive evidence and retains both immutable attempts", async () => {
    const { options, dependencies, command } = await recoveryFixture()
    let calls = 0
    dependencies.native = async (input) => evaluateNativePilot(input, {
      platform: "darwin", sourceRevision: async () => source,
      command: async (binary, args, config) => {
        if (binary === "maestro" && args.includes("test") && calls++ === 0) throw new Error("Synthetic driver unavailable")
        return command(binary, args, config)
      },
    })
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.status).toBe("pass")
    const stage = result.stages.find((stage) => stage.id === "home")!
    expect(stage.attempts?.map((attempt) => attempt.status)).toEqual(["inconclusive", "pass"])
    expect(stage.attempts?.[0].reports[0].executionId).not.toBe(stage.reports[0].executionId)
    expect(calls).toBe(2)
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("inconclusive")
  })

  it("does not retry a product failure or a scenario without replay authorization", async () => {
    for (const mode of ["failed", "passed"] as const) {
      const { options, dependencies, config, save } = await recoveryFixture(mode)
      config.scenarios[0].replaySafe = false
      await save()
      const native = vi.fn(dependencies.native!)
      await runIntegrationSuite(options, { ...dependencies, native })
      expect(native).toHaveBeenCalledTimes(1)
    }
    const { options, dependencies } = await recoveryFixture("failed")
    const native = vi.fn(dependencies.native!)
    expect((await runIntegrationSuite(options, { ...dependencies, native })).status).toBe("fail")
    expect(native).toHaveBeenCalledTimes(1)
  })

  it("reuses verified native evidence across invocations without rerunning the passed interaction", async () => {
    const { options, dependencies } = await recoveryFixture()
    const first = await runIntegrationSuite(options, dependencies)
    const native = vi.fn(dependencies.native!)
    const resumed = await runIntegrationSuite({ ...options, resume: first.executionId }, { ...dependencies, native })
    expect(resumed.status).toBe("pass")
    expect(resumed.resumedFrom).toBe(first.executionId)
    expect(resumed.stages.find((stage) => stage.id === "home")?.reusedFrom).toBe(first.executionId)
    expect(native).not.toHaveBeenCalled()
  })

  it.each(["source", "state", "evidence", "suite", "cleanup"])("refuses resume after changed %s", async (defect) => {
    const { options, dependencies, root, config, save } = await recoveryFixture()
    const first = await runIntegrationSuite(options, dependencies)
    if (defect === "source") dependencies.source = async () => ({ ...source, commitSha: "c".repeat(40) })
    if (defect === "state") dependencies.command = async () => ({ exitCode: 0, stdout: `sha256:${"c".repeat(64)}`, stderr: "" })
    if (defect === "suite") { config.scenarios[0].timeoutMs++; await save() }
    if (defect === "evidence") await writeFile(join(root, first.stages.find((stage) => stage.id === "home")!.reports[0].htmlPath), "changed")
    if (defect === "cleanup") {
      first.stages.find((stage) => stage.id === "home")!.cleanupSettled = false
      first.stages.find((stage) => stage.id === "home")!.status = "inconclusive"
      first.stages.find((stage) => stage.id === "home")!.attempts = undefined
      first.status = "inconclusive"; first.exitCode = 2
      await writeFile(first.summaryPath, JSON.stringify(first))
    }
    const native = vi.fn(dependencies.native!)
    const result = await runIntegrationSuite({ ...options, resume: first.executionId }, { ...dependencies, native })
    expect(result.status).toBe("inconclusive")
    expect(native).not.toHaveBeenCalled()
  })
})

describe("native integration execution", () => {
  it("uses the same verification contract for a native consumer with exact simulator scope", async () => {
    const { root, config, save, options, dependencies } = await integrationFixture()
    config.verificationPlan = "ui-eval/verification.json"; await save()
    await writeFile(join(root, config.verificationPlan), JSON.stringify({
      apiVersion: "uieval.io/verification-v1alpha1", kind: "VerificationPlan", id: "native-change", projectId: project.projectId,
      outcome: "Declared interaction works", plannedAt: "2026-10-22T00:00:00.000Z", planningContext: "Synthetic native regression plan",
      requirements: [{ id: "interaction", category: "ui", rationale: "Changed interaction", expectedOutcome: "Visibility assertion passes",
        level: "L4", environment: { platform: "ios-simulator", deviceId, variantKey: "ios-simulator" },
        selector: { kind: "scenario", id: "home" }, visualReview: false }], omissions: [{ scope: "Physical device", reason: "Synthetic driver test only" }],
    }))
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.verification?.assessment.conclusions.ui).toBe("pass")
    expect(result.verification?.evidence[0].environment).toEqual({ platform: "ios-simulator", deviceId, variantKey: "ios-simulator" })
    expect(result.status).toBe("pass")
  })
  it.each(["passed", "failed", "inconclusive"] as const)("aggregates %s native observations into synchronized integration JSON and HTML", async (mode) => {
    const { options, dependencies } = await integrationFixture(mode)
    const result = await runIntegrationSuite(options, dependencies)
    expect(result.exitCode).toBe({ passed: 0, failed: 1, inconclusive: 2 }[mode])
    expect(result.deviceId).toBe(deviceId)
    expect(result.source).toEqual(source)
    expect(JSON.parse(await readFile(result.summaryPath, "utf8"))).toEqual(result)
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("Experimental iOS Simulator")
    expect(result.stages.find((stage) => stage.kind === "scenario")?.reports).toHaveLength(1)
  })

  it.each([undefined, "invalid"])("rejects missing or malformed device %s before native work", async (value) => {
    const { options, dependencies } = await integrationFixture()
    const native = vi.fn(dependencies.native!)
    await expect(runIntegrationSuite({ ...options, deviceId: value }, { ...dependencies, native })).rejects.toThrow(/simulator UUID/)
    expect(native).not.toHaveBeenCalled()
  })

  it.each(["driver", "executionProfile", "browserChannel", "policy", "reference"])("rejects foreign adapter option %s for native suites", async (name) => {
    const { root, config, save } = await integrationFixture()
    if (name === "policy" || name === "reference") config.scenarios[0][name] = "foreign.json"
    else Object.assign(config, { [name]: "foreign" })
    await save()
    await expect(loadIntegrationSuite(root, "smoke")).rejects.toThrow(/options/)
  })

  it("does not let a Web suite accept a native device or session", async () => {
    const { root, config, options, save, dependencies } = await integrationFixture()
    config.adapter = "web"
    await save()
    await expect(runIntegrationSuite(options, dependencies)).rejects.toThrow(/Only native/)
    config.session = { command: "synthetic", args: [], startupTimeoutMs: 1000, cleanupTimeoutMs: 1000 }
    await save()
    await expect(loadIntegrationSuite(root, "smoke")).rejects.toThrow(/Session/)
  })

  it.each(["foreign-device", "malformed-result"])("marks %s as inconclusive without accepting its screenshots", async (defect) => {
    const { options, dependencies } = await integrationFixture()
    const native: NonNullable<IntegrationDependencies["native"]> = async (input) => {
      const output = await dependencies.native!(input)
      if (defect === "foreign-device") output.result.device.id = "22222222-2222-2222-2222-222222222222"
      else output.result.assertions.passed = -1
      await writeFile(output.reportPath, JSON.stringify(output.result))
      return output
    }
    const result = await runIntegrationSuite(options, { ...dependencies, native })
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.kind === "scenario")?.reports).toHaveLength(0)
  })

  it("invalidates native evidence changed by an after check even when command semantics remain identical", async () => {
    const { options, root, config, save, dependencies } = await integrationFixture()
    config.checks = [afterCheck]; await save()
    const command: typeof runCommand = async (_binary, _args, context) => {
      const input = JSON.parse(context.input!)
      const report = input.stages.find((stage: { kind: string }) => stage.kind === "scenario").reports[0]
      const commands = await findNativeCommandFile(join(root, ".ui-eval/native-runs", report.executionId, "driver"))
      await writeFile(commands, JSON.stringify(JSON.parse(await readFile(commands, "utf8")), null, 2))
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    const result = await runIntegrationSuite(options, { ...dependencies, command })
    expect(result.exitCode).toBe(2)
    expect(result.stages.find((stage) => stage.kind === "scenario")?.status).toBe("pass")
    expect(result.stages.find((stage) => stage.id === "evidence-after")?.status).toBe("inconclusive")
  })

  it("never runs after checks after incomplete native cleanup, but still stops its candidate session", async () => {
    const { options, config, save, dependencies } = await integrationFixture("passed", true)
    config.checks = [afterCheck]; await save()
    const stop = vi.fn(async () => {})
    const command = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const result = await runIntegrationSuite(options, {
      ...dependencies, command,
      session: async () => ({ signal: new AbortController().signal, assertAlive: () => {}, stop }),
      native: (input) => evaluateNativePilot(input, {
        platform: "darwin", sourceRevision: async () => source,
        command: async (binary, args) => {
          if (args.includes("test")) throw new IncompleteCleanupError("Synthetic incomplete driver cleanup")
          if (args.includes("--version")) return { exitCode: 0, stdout: "2.9.0", stderr: "" }
          if (args.includes("devices")) return { exitCode: 0, stdout: JSON.stringify({ devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ udid: deviceId, name: "Synthetic iPhone", state: "Booted", isAvailable: true }],
          } }), stderr: "" }
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      }),
    })
    expect(result.exitCode).toBe(2)
    expect(command).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(result.stages.find((stage) => stage.kind === "scenario")?.cleanupSettled).toBe(false)
  })

  it("makes unconfirmed session shutdown inconclusive after otherwise passing native evidence", async () => {
    const { options, dependencies } = await integrationFixture("passed", true)
    const stop = vi.fn(async () => { throw new IncompleteCleanupError("Synthetic App stop could not be confirmed") })
    const result = await runIntegrationSuite(options, { ...dependencies,
      session: async () => ({ signal: new AbortController().signal, assertAlive: () => {}, stop }),
    })
    expect(result.exitCode).toBe(2)
    expect(stop).toHaveBeenCalledOnce()
    expect(result.stages.find((stage) => stage.id === "session-stop")).toMatchObject({ status: "inconclusive", cleanupSettled: false })
  })

  it("aborts the native evaluator on session death and skips after checks while stopping the session", async () => {
    const { options, config, save, dependencies } = await integrationFixture("passed", true)
    config.checks = [afterCheck]; await save()
    const sessionAbort = new AbortController()
    const stop = vi.fn(async () => {})
    const command = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    let receivedCancellation = false
    const result = await runIntegrationSuite(options, { ...dependencies, command,
      session: async () => ({ signal: sessionAbort.signal, assertAlive: () => {}, stop }),
      native: async (input) => {
        sessionAbort.abort(new Error("Synthetic session exited early"))
        receivedCancellation = Boolean(input.signal?.aborted)
        input.signal?.throwIfAborted()
        throw new Error("Native should not continue after session death")
      },
    })
    expect(receivedCancellation).toBe(true)
    expect(result.exitCode).toBe(2)
    expect(command).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  })

  it.each(["native", "after-check"])("still stops its session and publishes interrupted projections on caller cancellation at %s", async (stage) => {
    const { root, options, config, save, dependencies } = await integrationFixture("passed", true)
    config.checks = [afterCheck]; await save()
    const abort = new AbortController()
    const stop = vi.fn(async () => {})
    const interrupted = new Error("Synthetic caller cancelled")
    await expect(runIntegrationSuite({ ...options, signal: abort.signal }, { ...dependencies,
      session: async () => ({ signal: new AbortController().signal, assertAlive: () => {}, stop }),
      native: async (input) => {
        if (stage === "native") { abort.abort(interrupted); input.signal?.throwIfAborted() }
        return dependencies.native!(input)
      },
      command: async () => { abort.abort(interrupted); return { exitCode: 0, stdout: "", stderr: "" } },
    })).rejects.toBe(interrupted)
    expect(stop).toHaveBeenCalledOnce()
    const [directory] = await readdir(join(root, ".ui-eval/integration"))
    const summary = JSON.parse(await readFile(join(root, ".ui-eval/integration", directory, "summary.json"), "utf8"))
    expect(summary).toMatchObject({ status: "interrupted", exitCode: 130 })
    expect(summary.stages.find((entry: { id: string }) => entry.id === "session-stop").status).toBe("pass")
    expect(await readFile(join(root, ".ui-eval/integration", directory, "summary.html"), "utf8")).toContain("smoke: interrupted")
  })
})
