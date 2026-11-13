import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { relative, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PNG } from "pngjs"
import { loadWechatProject, loadWechatScenario } from "./config"
import { decodeWechatResponse, type CommandRunner } from "./driver"
import { inspectWechatPng } from "./evidence"
import { doctorWechatPilot, evaluateWechatPilot } from "./run"
import { runWechatPilotCli } from "./cli"
import { collectSourceRevision } from "../orchestrator/identity"
import { IncompleteCleanupError } from "../runtime/cleanup"
import { probeWechatPilot } from "./probe"
import { recordWechatReview, verifyWechatReport, verifyWechatReview } from "./review"
import { assessWechatScope } from "./assess"
import { canonicalDigest } from "../contracts/canonical-json"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const source: typeof collectSourceRevision = async () => ({ repository: "local:test", commitSha: "a".repeat(40), dirtyTree: false })
const project = {
  apiVersion: "uieval.io/wechat-pilot-v1", kind: "WechatPilotProject", projectId: "synthetic-app",
  runtimeProject: ".ui-eval/runtime", appId: "wx0123456789abcdef",
  driver: { clientName: "Codex", skillVersion: "0.3.9" }, timeoutMs: 30000,
  scenarios: { login: "ui-eval/login.json" },
}
const scenario = {
  apiVersion: "uieval.io/wechat-pilot-v1", kind: "WechatPilotScenario", id: "login",
  storage: [{ key: "pilot-market", value: "GIN" }], mocks: [{ method: "getLocation", result: { latitude: 0, longitude: 0 } }],
  steps: [{ action: "navigate", url: "/pages/login/index" }, { action: "assertText", selector: ".title", includes: "Sign in" }, { action: "screenshot", checkpointId: "login" }],
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "ui-eval-wechat-test-")); roots.push(root)
  await mkdir(resolve(root, "ui-eval"))
  await mkdir(resolve(root, ".ui-eval/runtime/miniprogram"), { recursive: true })
  await writeFile(resolve(root, "ui-eval/wechat.json"), JSON.stringify(project))
  await writeFile(resolve(root, "ui-eval/login.json"), JSON.stringify(scenario))
  await writeFile(resolve(root, ".ui-eval/runtime/project.config.json"), JSON.stringify({ appid: project.appId, compileType: "miniprogram", miniprogramRoot: "./miniprogram/" }))
  await writeFile(resolve(root, ".ui-eval/runtime/ui-eval-runtime.json"), JSON.stringify({ synthetic: true, projectId: project.projectId }))
  await writeFile(resolve(root, ".ui-eval/runtime/miniprogram/app.js"), "App({})")
  await writeFile(resolve(root, ".ui-eval/runtime/miniprogram/app.json"), '{"pages":["pages/login/index"]}')
  return root
}
function fakeDriver(options: { text?: unknown; corrupt?: boolean; dimensions?: boolean; restoreFails?: boolean; failedTool?: string; mutate?: string; pending?: boolean } = {}) {
  const calls: string[] = []
  const storage = new Map<string, unknown>([["pilot-market", "FRA"]])
  const command: CommandRunner = async (_binary, args) => {
    const tool = args[2]; calls.push(tool)
    let result: unknown = { success: true }
    if (options.failedTool === tool) return { exitCode: 1, stdout: "", stderr: "untrusted secret" }
    if (tool === "check_wechatide_status") result = options.pending ? { success: true, status: "pending", taskId: "auth-pending" } : { success: true, loginExpired: false, tokenRequired: false, skillVersion: "0.3.9", versionRelation: "equal" }
    if (tool === "automation_element_action" && args.includes("text")) result = Object.hasOwn(options, "text") ? options.text : "Sign in"
    if (tool === "automation_wx_api" && args.includes("--args-file")) {
      const values = JSON.parse(await readFile(args[args.indexOf("--args-file") + 1], "utf8"))
      const method = args[args.indexOf("--method") + 1]
      if (method === "getStorageInfoSync") result = { success: true, result: { keys: [...storage.keys()] } }
      else if (method === "getStorageSync") result = { success: true, result: storage.get(values[0]) }
      else if (method === "setStorageSync") {
        if (options.restoreFails && values[1] === "FRA") return { exitCode: 1, stdout: "", stderr: "failed restoration" }
        storage.set(values[0], values[1])
      } else if (method === "removeStorageSync") storage.delete(values[0])
    }
    if (tool === "simulator_screenshot") {
      const path = args[args.indexOf("--path") + 1]
      await writeFile(path, options.corrupt ? Buffer.from("not a PNG") : PNG.sync.write(new PNG({ width: 2, height: 2 })))
      result = { success: true, path, imageWidth: options.dimensions ? 3 : 2, imageHeight: 2 }
      if (options.mutate) await writeFile(options.mutate, "changed compiled code")
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, tool, clientName: args[1], result }), stderr: "" }
  }
  return { command, calls, storage }
}

describe("WeChat pilot acceptance", () => {
  async function visualFixture() {
    const root = await fixture()
    await writeFile(resolve(root, "ui-eval/wechat.json"), JSON.stringify({ ...project, reviews: [{ id: "spacing", scenarioId: "login", checkpointId: "login", criterion: "Controls remain visibly separated" }] }))
    const output = await evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command: fakeDriver().command, source })
    const report = relative(root, output.reportPath)
    const review = await recordWechatReview({ projectRoot: root, report, review: "spacing", decision: "pass", reviewer: "operator", note: "Inspected the original checkpoint image" }, source)
    const plan = { apiVersion: "uieval.io/verification-v1alpha1", kind: "VerificationPlan", id: "visual", projectId: project.projectId, outcome: "Controls are usable", plannedAt: "2026-10-22T00:00:00.000Z", planningContext: "Declared before capture",
      requirements: [{ id: "spacing", category: "ui", rationale: "Reported spacing regression", expectedOutcome: "Controls remain separated", level: "L4", environment: { platform: "wechat-devtools" }, selector: { kind: "scenario", id: "login" }, visualReview: true, visualReviewId: "spacing" }], omissions: [] }
    await writeFile(resolve(root, "ui-eval/verification.json"), JSON.stringify(plan))
    const scope = { apiVersion: "uieval.io/wechat-assessment-v1", kind: "WechatAssessmentScope", verificationPlan: "ui-eval/verification.json", reports: [report], reviews: [relative(root, review.reportPath)] }
    await writeFile(resolve(root, ".ui-eval/scope.json"), JSON.stringify(scope))
    return { root, output, review, plan, scope }
  }
  it("records a screenshot-bound observation and reconciles only the declared simulator scope", async () => {
    const { root, scope, plan } = await visualFixture()
    const run = () => assessWechatScope({ projectRoot: root, scope: ".ui-eval/scope.json" }, source, async () => "ui-eval/verification.json\n")
    expect((await run()).record.assessment.conclusions).toEqual({ code: "not-assessed", ui: "pass", release: "not-assessed" })
    await writeFile(resolve(root, "ui-eval/verification.json"), JSON.stringify({ ...plan, requirements: [...plan.requirements, { id: "phone", category: "release", rationale: "Actual permissions", expectedOutcome: "Real GPS works", level: "L5", environment: { platform: "physical-device" }, selector: { kind: "external", id: "gps" }, visualReview: false }] }))
    expect((await run()).record.assessment).toMatchObject({ exitCode: 2, conclusions: { ui: "pass", release: "not-run" } })
    await writeFile(resolve(root, ".ui-eval/scope.json"), JSON.stringify({ ...scope, reviews: [] }))
    expect((await run()).record.assessment.conclusions.ui).toBe("needs-review")
  })
  it("rejects stale or altered visual evidence, untracked plans and conflicting observations", async () => {
    const { root, output, review, scope } = await visualFixture()
    await expect(assessWechatScope({ projectRoot: root, scope: ".ui-eval/scope.json" }, source, async () => "")).rejects.toThrow("tracked")
    await expect(recordWechatReview({ projectRoot: root, report: scope.reports[0], review: "undeclared", decision: "pass", reviewer: "operator", note: "Observed" }, source)).rejects.toThrow("declared")
    await expect(recordWechatReview({ projectRoot: root, report: scope.reports[0], review: "spacing", decision: "pass", reviewer: "operator", note: "Observed" }, async () => ({ repository: "local:test", commitSha: "b".repeat(40), dirtyTree: false }))).rejects.toThrow()
    const other = await recordWechatReview({ projectRoot: root, report: scope.reports[0], review: "spacing", decision: "fail", reviewer: "operator", note: "Conflicting later observation" }, source)
    await writeFile(resolve(root, ".ui-eval/scope.json"), JSON.stringify({ ...scope, reviews: [...scope.reviews, relative(root, other.reportPath)] }))
    await expect(assessWechatScope({ projectRoot: root, scope: ".ui-eval/scope.json" }, source, async () => "ui-eval/verification.json")).rejects.toThrow("Conflicting")
    const html = await readFile(output.htmlPath, "utf8")
    await writeFile(output.htmlPath, '<html><img src="different.png"></html>')
    await expect(recordWechatReview({ projectRoot: root, report: scope.reports[0], review: "spacing", decision: "pass", reviewer: "operator", note: "Observed" }, source)).rejects.toThrow("Original WeChat JSON/HTML pair")
    await expect(assessWechatScope({ projectRoot: root, scope: ".ui-eval/scope.json" }, source, async () => "ui-eval/verification.json")).rejects.toThrow("Original WeChat JSON/HTML pair")
    await writeFile(output.htmlPath, html)
    await writeFile(review.htmlPath, "altered derived report")
    await expect(verifyWechatReview(root, scope.reviews[0], output.result)).rejects.toThrow("pair")
    await writeFile(resolve(output.reportPath, "..", output.result.screenshots[0].path), "altered image")
    await expect(verifyWechatReport(root, scope.reports[0], canonicalDigest(await source(root)))).rejects.toThrow()
  })
  it("records only sanitized phase diagnostics for an automator timeout", async () => {
    const driver = fakeDriver()
    const command: CommandRunner = async (bin, args, options) => args[2] === "automation_wx_api" ? {
      exitCode: 1, stderr: "PRIVATE_STDERR_SENTINEL", stdout: JSON.stringify({ ok: false, tool: args[2], clientName: "Codex", message: "timeout waiting for automator response", private: "PRIVATE_PAYLOAD_SENTINEL" }),
    } : driver.command(bin, args, options)
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command, source })
    expect(output.result.status).toBe("inconclusive")
    expect(output.result.diagnostics?.[0]).toMatchObject({ phase: "state", tool: "automation_wx_api", code: "automator-timeout", exitCode: 1 })
    expect(JSON.stringify(output.result)).not.toContain("PRIVATE_")
    expect(await readFile(output.htmlPath, "utf8")).toContain("automator-timeout")
  })
  it("probes an existing synthetic runtime without opening windows or writing storage", async () => {
    const root = await fixture(), driver = fakeDriver()
    const command: CommandRunner = async (bin, args, options) => args[2] === "automation_runtime_info" ? {
      exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, tool: args[2], clientName: "Codex", result: { success: true, currentPage: { path: "pages/login/index", query: "PRIVATE_QUERY" } } }),
    } : driver.command(bin, args, options)
    const result = await probeWechatPilot({ projectRoot: root }, { command, source })
    expect(result.status).toBe("ready"); expect(result.storageKeyCount).toBe(1)
    expect(driver.calls).not.toContain("open_project_window")
    expect(JSON.stringify(result)).not.toContain("pilot-market")
    expect(JSON.stringify(result)).not.toContain("PRIVATE_")
    expect(driver.storage.get("pilot-market")).toBe("FRA")
    await expect(readFile(resolve(root, project.runtimeProject, ".ui-eval-pilot.lock"))).rejects.toThrow()
  })
  it("keeps the full-window automator available before changing and restoring synthetic storage", async () => {
    const root = await fixture(); const driver = fakeDriver()
    let fullWindow = false
    const command: CommandRunner = async (binary, args, options) => {
      if (args[2] === "open_project_window") fullWindow = args[args.indexOf("--window-mode") + 1] === "fullMode"
      if (args[2] === "automation_wx_api" && !fullWindow) return { exitCode: 1, stdout: "", stderr: "automator unavailable after lite-window switch" }
      return driver.command(binary, args, options)
    }
    const output = await evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command, source })
    expect(output.result.status).toBe("passed")
    expect(output.result.cleanup).toBe("completed")
    expect(driver.storage.get("pilot-market")).toBe("FRA")
  })
  it("runs the declared scope, validates PNGs, restores state and synchronizes JSON/HTML", async () => {
    const root = await fixture(); const driver = fakeDriver()
    const output = await evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command: driver.command, source })
    expect(output.result.status).toBe("passed")
    expect(output.result.assertions).toEqual({ passed: 1, failed: 0 })
    expect(output.result.screenshots).toHaveLength(1)
    expect(output.result.steps.every((step) => step.status === "passed")).toBe(true)
    expect(driver.storage.get("pilot-market")).toBe("FRA")
    expect(JSON.parse(await readFile(output.reportPath, "utf8"))).toEqual(output.result)
    expect(await readFile(output.htmlPath, "utf8")).toContain("login: passed")
  })
  it("classifies an observed assertion mismatch as a product failure with missing later evidence", async () => {
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command: fakeDriver({ text: "Wrong page" }).command, source })
    expect(output.result.status).toBe("failed")
    expect(output.result.assertions.failed).toBe(1)
    expect(output.result.steps.map((step) => step.status)).toEqual(["passed", "failed", "not-run"])
    expect(output.result.screenshots).toEqual([])
  })
  it.each([{ text: null }, { corrupt: true }, { dimensions: true }, { failedTool: "simulator_screenshot" }, { restoreFails: true }])("fails closed for invalid or unavailable evidence: %j", async (failure) => {
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command: fakeDriver(failure).command, source })
    expect(output.result.status).toBe("inconclusive")
    expect(output.result.assertions.failed).toBe(0)
    expect(await readFile(output.htmlPath, "utf8")).not.toContain("untrusted secret")
  })
  it("preserves pending authorization and does not perform dependent operations", async () => {
    const driver = fakeDriver({ pending: true })
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command: driver.command, source })
    expect(output.result.status).toBe("inconclusive")
    expect(output.result.pendingTaskId).toBe("auth-pending")
    expect(driver.calls).toEqual(["check_wechatide_status"])
  })
  it("invalidates a run when compiled bytes change even though assertions passed", async () => {
    const root = await fixture()
    const output = await evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command: fakeDriver({ mutate: resolve(root, ".ui-eval/runtime/miniprogram/app.js") }).command, source })
    expect(output.result.status).toBe("inconclusive")
    expect(output.result.reason).toContain("changed during capture")
  })
  it("invalidates accepted screenshots when candidate source changes during capture", async () => {
    let snapshots = 0
    const changedSource: typeof collectSourceRevision = async (root) => ({ ...await source(root), commitSha: (++snapshots === 1 ? "a" : "b").repeat(40) })
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command: fakeDriver().command, source: changedSource })
    expect(output.result.status).toBe("inconclusive")
    expect(output.result.reason).toContain("changed during capture")
  })
  it("records interruption and restores state without executing later steps", async () => {
    const root = await fixture(); const driver = fakeDriver(); const controller = new AbortController()
    const command: CommandRunner = async (binary, args, options) => {
      const output = await driver.command(binary, args, options)
      if (args[2] === "automation_element_action") controller.abort(new Error("cancelled"))
      return output
    }
    await expect(evaluateWechatPilot({ projectRoot: root, scenario: "login", signal: controller.signal }, { command, source })).rejects.toThrow("cancelled")
    expect(driver.storage.get("pilot-market")).toBe("FRA")
    expect(driver.calls).not.toContain("simulator_screenshot")
  })
  it("prevents concurrent runs against the same compiled runtime", async () => {
    const root = await fixture()
    await writeFile(resolve(root, ".ui-eval/runtime/.ui-eval-pilot.lock"), "other-run")
    await expect(evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command: fakeDriver().command, source })).rejects.toMatchObject({ code: "EEXIST" })
  })
  it("produces exactly one JSON CLI payload with report paths", async () => {
    const root = await fixture(); const stdout: string[] = []
    const code = await runWechatPilotCli(["evaluate", "login", "--format", "json"], { cwd: root, stdout: (value) => stdout.push(value) }, undefined, { command: fakeDriver().command, source })
    expect(code).toBe(0); expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ result: { status: "passed" }, htmlPath: expect.stringContaining("report.html") })
  })
})
describe("WeChat pilot trust boundaries", () => {
  it("rejects compiled roots outside the dedicated runtime and private overrides", async () => {
    const root = await fixture()
    await mkdir(resolve(root, "dist"))
    await writeFile(resolve(root, ".ui-eval/runtime/project.config.json"), JSON.stringify({ appid: project.appId, compileType: "miniprogram", miniprogramRoot: "../../dist" }))
    await expect(loadWechatProject(root)).rejects.toThrow("below")
    await writeFile(resolve(root, ".ui-eval/runtime/project.config.json"), JSON.stringify({ appid: project.appId, compileType: "miniprogram", miniprogramRoot: "miniprogram" }))
    await writeFile(resolve(root, ".ui-eval/runtime/project.private.config.json"), "{}")
    await expect(loadWechatProject(root)).rejects.toThrow("private")
  })
  it.each(["automation_navigate", "automation_wx_api"])("rejects missing action evidence for %s", async (tool) => {
    const driver = fakeDriver()
    const command: CommandRunner = async (binary, args, options) => args[2] === tool
      ? { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, tool, clientName: "Codex", result: null }) }
      : driver.command(binary, args, options)
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command, source })
    expect(output.result.status).toBe("inconclusive")
  })
  it("quarantines the runtime when owned process cleanup cannot be established", async () => {
    const root = await fixture(); const driver = fakeDriver()
    const command: CommandRunner = async (binary, args, options) => {
      if (args[2] === "automation_navigate") throw new IncompleteCleanupError("unresolved process")
      return driver.command(binary, args, options)
    }
    const output = await evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command, source })
    expect(output.result).toMatchObject({ status: "inconclusive", cleanup: "incomplete" })
    expect(await readFile(resolve(root, ".ui-eval/runtime/.ui-eval-pilot.lock"), "utf8")).toBe(output.result.executionId)
  })
  it("requires explicit restore acknowledgement and retains the runtime lock on missing evidence", async () => {
    const root = await fixture(); const driver = fakeDriver()
    const command: CommandRunner = async (binary, args, options) => args[2] === "automation_wx_api" && args.includes("restore")
      ? { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, tool: args[2], clientName: "Codex", result: {} }) }
      : driver.command(binary, args, options)
    const output = await evaluateWechatPilot({ projectRoot: root, scenario: "login" }, { command, source })
    expect(output.result).toMatchObject({ status: "inconclusive", cleanup: "incomplete" })
    expect(driver.storage.get("pilot-market")).toBe("FRA")
    expect(await readFile(resolve(root, ".ui-eval/runtime/.ui-eval-pilot.lock"), "utf8")).toBe(output.result.executionId)
  })
  it("does not overwrite existing storage when its backup value is missing", async () => {
    const driver = fakeDriver()
    const command: CommandRunner = async (binary, args, options) => args[2] === "automation_wx_api" && args.includes("getStorageSync")
      ? { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, tool: args[2], clientName: "Codex", result: { success: true } }) }
      : driver.command(binary, args, options)
    const output = await evaluateWechatPilot({ projectRoot: await fixture(), scenario: "login" }, { command, source })
    expect(output.result.status).toBe("inconclusive")
    expect(driver.storage.get("pilot-market")).toBe("FRA")
    expect(driver.calls).not.toContain("automation_navigate")
  })
  it("rejects wrong-tool, wrong-client, malformed and timed-out envelopes", () => {
    for (const envelope of [{ ok: true, tool: "wrong", clientName: "Codex", result: "Sign in" }, { ok: true, tool: "text", clientName: "Other", result: "Sign in" }, { ok: false, tool: "text", clientName: "Codex", result: "Sign in" }]) {
      expect(() => decodeWechatResponse(JSON.stringify(envelope), 0, "text", "Codex")).toThrow()
    }
    expect(() => decodeWechatResponse("not JSON", 0, "text", "Codex")).toThrow()
    expect(() => decodeWechatResponse("{}", null, "text", "Codex")).toThrow()
  })
  it("rejects corrupted PNG CRCs", () => {
    const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }))
    bytes[29] ^= 1
    expect(() => inspectWechatPng(bytes)).toThrow()
  })
  it("refuses non-synthetic projects and runtime symlink escapes before driver execution", async () => {
    const root = await fixture()
    await writeFile(resolve(root, ".ui-eval/runtime/ui-eval-runtime.json"), JSON.stringify({ synthetic: false, projectId: project.projectId }))
    await expect(doctorWechatPilot({ projectRoot: root }, { command: fakeDriver().command })).rejects.toThrow("synthetic")
    await rm(resolve(root, ".ui-eval/runtime"), { recursive: true })
    await symlink(tmpdir(), resolve(root, ".ui-eval/runtime"))
    await expect(loadWechatProject(root)).rejects.toThrow("symlink")
  })
  it("refuses traversal, arbitrary code and unbound screenshot scenarios", async () => {
    const root = await fixture(); const loaded = await loadWechatProject(root)
    for (const invalid of [{ ...scenario, steps: [{ action: "evaluate", script: "arbitrary code" }] }, { ...scenario, steps: [{ action: "screenshot", checkpointId: "alone" }, ...scenario.steps] }]) {
      await writeFile(resolve(root, "ui-eval/login.json"), JSON.stringify(invalid))
      await expect(loadWechatScenario(root, loaded, "login")).rejects.toThrow()
    }
    await expect(loadWechatScenario(root, { ...loaded, scenarios: { login: "../outside.json" } }, "login")).rejects.toThrow("below")
  })
})
