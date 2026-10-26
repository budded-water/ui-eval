import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { canonicalDigest } from "../contracts/canonical-json"
import { nativeIntegrationEvidence } from "../integration/native-evidence"
import { IncompleteCleanupError } from "../runtime/cleanup"
import type { runCommand } from "../runtime/command"
import { loadNativePilotScenario, type NativePilotProject, type NativePilotScenario } from "./config"
import { nativeCaptureSegments } from "./flow"
import { summarizeNativeProgress } from "./progress"
import { recordNativeReview } from "./review"
import { evaluateNativePilot, NativePilotInterruptedError } from "./run"

const deviceId = "11111111-1111-1111-1111-111111111111"
const project: NativePilotProject = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotProject", projectId: "sample", platform: "ios-simulator", appId: "test.app", maestroVersion: "2.9.0", timeoutMs: 1000, scenarios: { form: "ui-eval/form.json" },
  reviews: [{ id: "keyboard", scenarioId: "form", checkpointId: "focused", criterion: "Keyboard and synthetic input are visible", screenshotMethod: "simctl" }] }
const scenario: NativePilotScenario = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotScenario", scenarioId: "form", steps: [
  { action: "assert-visible", selector: { id: "sms" } }, { action: "screenshot", checkpointId: "sms", supplementalCapture: "simctl" },
  { action: "assert-visible", selector: { id: "password" } }, { action: "screenshot", checkpointId: "focused", supplementalCapture: "simctl" },
  { action: "assert-hidden", selector: { id: "keyboard" } }, { action: "screenshot", checkpointId: "dismissed" },
] }
const sourceRevision = async () => ({ repository: "test", commitSha: "abc", dirtyTree: false })
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function candidate() {
  const root = await mkdtemp(resolve(tmpdir(), "native-serial-test-")); roots.push(root)
  await mkdir(resolve(root, "ui-eval"))
  await writeFile(resolve(root, "ui-eval/native.json"), JSON.stringify(project))
  await writeFile(resolve(root, "ui-eval/form.json"), JSON.stringify(scenario))
  return root
}
function png(color: number) {
  const image = new PNG({ width: 2, height: 2 }); image.data.fill(color)
  return PNG.sync.write(image)
}
type Mode = "pass" | "capture-exit" | "capture-missing" | "capture-corrupt" | "capture-symlink" | "original-missing" | "wrong-device" | "relaunch" | "product-failure" | "transport" | "timeout" | "abort" | "cleanup" | "budget"
function driver(mode: Mode = "pass", abort = new AbortController()) {
  const calls: Array<{ binary: string; args: readonly string[]; timeoutMs: number }> = []
  let stage = 0, captures = 0, clock = 0
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  const command: typeof runCommand = async (binary, args, options) => {
    let stdout = ""
    if (args.includes("--version")) stdout = "2.9.0\n"
    else if (args.includes("devices")) stdout = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: deviceId, state: "Booted", isAvailable: true, name: "Test" }] } })
    else if (args.includes("test")) {
      calls.push({ binary, args, timeoutMs: options.timeoutMs }); clock += 100
      const index = stage++
      const base = resolve(args[args.indexOf("--test-output-dir") + 1], "stamp/form")
      await mkdir(resolve(base, "takeScreenshot"), { recursive: true })
      const values: unknown[] = [
        { defineVariablesCommand: { env: { MAESTRO_FILENAME: "flow", MAESTRO_DEVICE_UDID: mode === "wrong-device" && index === 1 ? "foreign" : deviceId, MAESTRO_SHARD_ID: "1", MAESTRO_SHARD_INDEX: "0" }, optional: false } },
        { applyConfigurationCommand: { config: { appId: "test.app", name: "form" }, optional: false } },
      ]
      if (index === 0 || mode === "relaunch") values.push({ launchAppCommand: { appId: "test.app", stopApp: true, optional: false } })
      values.push({ assertConditionCommand: { condition: { [index === 2 ? "notVisible" : "visible"]: { idRegex: ["sms", "password", "keyboard"][index], optional: false } }, optional: false } })
      const fails = index === 1 && ["product-failure", "transport"].includes(mode)
      if (!fails) values.push({ takeScreenshotCommand: { path: ["sms", "focused", "dismissed"][index], optional: false } })
      const records = values.map((command, sequenceNumber) => ({ command, metadata: { evaluatedCommand: command, sequenceNumber, depth: 0,
        status: fails && sequenceNumber === values.length - 1 ? "FAILED" : "COMPLETED",
        ...(fails && sequenceNumber === values.length - 1 ? { error: mode === "product-failure" ? { message: "Assertion is false: id: password is visible", debugMessage: "Assertion 'id: password is visible' failed. Check the UI hierarchy in debug artifacts" } : { message: "transport unavailable" } } : {}),
      } }))
      await writeFile(resolve(base, "commands.json"), JSON.stringify(records))
      if (mode !== "original-missing") await writeFile(resolve(base, "takeScreenshot", `${["sms", "focused", "dismissed"][index]}.png`), png(255))
      return { exitCode: fails ? 1 : 0, stdout, stderr: "" }
    } else if (args.includes("screenshot")) {
      calls.push({ binary, args, timeoutMs: options.timeoutMs }); clock += mode === "budget" ? 950 : 100; captures++
      if (mode === "abort") { abort.abort(); throw abort.signal.reason }
      if (mode === "cleanup") throw new IncompleteCleanupError("Synthetic owned process failure")
      const target = args.at(-1)!
      if (mode === "capture-symlink") {
        const other = resolve(options.cwd, "foreign.png"); await writeFile(other, png(128)); await symlink(other, target)
      } else if (mode !== "capture-missing") await writeFile(target, mode === "capture-corrupt" ? "corrupt" : png(128))
      return { exitCode: mode === "capture-exit" ? 148 : mode === "timeout" ? null : 0, stdout, stderr: "" }
    }
    return { exitCode: 0, stdout, stderr: "" }
  }
  return { command, calls, abort, counts: () => ({ stage, captures }) }
}
async function evaluate(root: string, fake: ReturnType<typeof driver>) {
  return evaluateNativePilot({ projectRoot: root, deviceId, scenario: "form", signal: fake.abort.signal }, { platform: "darwin", command: fake.command, sourceRevision, storage: async () => ({ availableBytes: 10 * 1024 ** 3, minimumBytes: 1024 ** 3 }) })
}
async function validate(root: string, run: Awaited<ReturnType<typeof evaluate>>) {
  return nativeIntegrationEvidence(root, { apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: "test", projectId: "sample", adapter: "native-pilot", scenarios: [{ id: "form", timeoutMs: 1000 }], checks: [] }, "form", run, canonicalDigest(await sourceRevision()), deviceId)
}
async function scope(root: string, run: Awaited<ReturnType<typeof evaluate>>, review?: string) {
  await writeFile(resolve(root, "scope.json"), JSON.stringify({ apiVersion: "uieval.io/native-progress-v1", kind: "NativeProgressScope", projectId: "sample", deviceId, scenarios: ["form"], reports: [{ scenarioId: "form", path: relative(root, run.reportPath) }], reviews: review ? [{ reviewId: "keyboard", path: relative(root, review) }] : [] }))
  return summarizeNativeProgress({ projectRoot: root, scope: "scope.json" }, sourceRevision)
}

describe("optional serial Simulator capture", () => {
  it("preserves every step and original image, awaits supplemental capture before continuation, and shares one budget", async () => {
    const root = await candidate(), fake = driver(), run = await evaluate(root, fake)
    expect(run.result.status).toBe("passed")
    expect(run.result.assertions).toEqual({ passed: 3, failed: 0 })
    expect(run.result.screenshots.map((shot) => shot.checkpointId)).toEqual(["sms", "focused", "dismissed"])
    expect(run.result.supplementalScreenshots?.map((shot) => shot.checkpointId)).toEqual(["sms", "focused"])
    expect(run.result.screenshots[1].digest).not.toBe(run.result.supplementalScreenshots![1].digest)
    expect(fake.calls.map((call) => call.binary)).toEqual(["maestro", "xcrun", "maestro", "xcrun", "maestro"])
    expect(fake.calls.map((call) => call.timeoutMs)).toEqual([1000, 900, 800, 700, 600])
    for (const call of fake.calls.filter((call) => call.binary === "xcrun")) expect(call.args.slice(0, 6)).toEqual(["simctl", "io", deviceId, "screenshot", "--type=png", call.args.at(-1)])
    const segments = nativeCaptureSegments(project, scenario)!
    expect(segments[0].flow).toContain("launchApp")
    expect(segments.slice(1).every((part) => !part.flow.includes("launchApp"))).toBe(true)
    expect(segments.map(({ startStep, endStep }) => scenario.steps.slice(startStep, endStep)).flat()).toEqual(scenario.steps)
    expect(JSON.parse(await readFile(run.reportPath, "utf8"))).toEqual(run.result)
    expect(await readFile(run.htmlPath, "utf8")).toContain("Supplemental simctl captures")
    await expect(validate(root, run)).resolves.toHaveLength(1)
    const progress = await scope(root, run)
    expect(progress.result.automatic[0].state).toBe("passed")
    expect(progress.result.human[0].state).toBe("pending")
  })

  it.each(["capture-exit", "capture-missing", "capture-corrupt", "capture-symlink", "original-missing", "timeout", "budget"] as const)("%s stops before continuation and never falls back to the original image", async (mode) => {
    const root = await candidate(), fake = driver(mode), run = await evaluate(root, fake)
    expect(run.result.status).toBe("inconclusive")
    expect(fake.counts().stage).toBe(1)
    expect(run.result.screenshots).toEqual([])
    expect(run.result.supplementalScreenshots).toBeUndefined()
    expect(JSON.parse(await readFile(run.reportPath, "utf8"))).toEqual(run.result)
    expect(await readFile(run.htmlPath, "utf8")).toContain("form: inconclusive")
    expect((await scope(root, run)).result.automatic[0].state).toBe("inconclusive")
    await expect(recordNativeReview({ projectRoot: root, report: relative(root, run.reportPath), review: "keyboard", decision: "pass", reviewer: "test", note: "Synthetic test" }, sourceRevision)).rejects.toThrow("complete original")
  })

  it.each(["wrong-device", "relaunch", "transport"] as const)("rejects %s in a continuation", async (mode) => {
    const root = await candidate(), fake = driver(mode), run = await evaluate(root, fake)
    expect(run.result.status).toBe("inconclusive")
    expect(fake.counts()).toEqual({ stage: 2, captures: 1 })
  })

  it("retains a bound product assertion failure without executing later captures or segments", async () => {
    const root = await candidate(), fake = driver("product-failure"), run = await evaluate(root, fake)
    expect(run.result.status).toBe("failed")
    expect(run.result.assertions).toEqual({ passed: 1, failed: 1 })
    expect(fake.counts()).toEqual({ stage: 2, captures: 1 })
    expect(run.result.screenshots).toEqual([])
    await expect(validate(root, run)).resolves.toHaveLength(1)
  })

  it.each(["abort", "cleanup"] as const)("propagates %s after publishing inconclusive projections", async (mode) => {
    const root = await candidate(), fake = driver(mode)
    await expect(evaluate(root, fake)).rejects.toBeInstanceOf(mode === "abort" ? NativePilotInterruptedError : IncompleteCleanupError)
    expect(fake.counts().stage).toBe(1)
    const { readdir } = await import("node:fs/promises")
    const [id] = await readdir(resolve(root, ".ui-eval/native-runs"))
    expect(JSON.parse(await readFile(resolve(root, ".ui-eval/native-runs", id, "report.json"), "utf8")).status).toBe("inconclusive")
    expect(await readFile(resolve(root, ".ui-eval/native-runs", id, "report.html"), "utf8")).toContain("inconclusive")
  })

  it.each(["missing-supplement", "corrupt-supplement", "copy-original", "symlink-parent", "missing-continuation", "wrong-order", "capture-too-early", "capture-too-late", "wrong-device", "extra-capture", "changed-flow", "changed-command", "changed-primary"] as const)("offline consumers reject %s without device commands", async (mutation) => {
    const root = await candidate(), fake = driver(), run = await evaluate(root, fake), directory = dirname(run.reportPath)
    const executionPath = resolve(directory, "serial-execution.json")
    const execution = JSON.parse(await readFile(executionPath, "utf8"))
    const shotPath = resolve(directory, "supplemental/focused.png")
    if (mutation === "missing-supplement") await rm(shotPath)
    if (mutation === "corrupt-supplement") await writeFile(shotPath, "bad")
    if (mutation === "copy-original") await writeFile(shotPath, await readFile(resolve(directory, "focused.png")))
    if (mutation === "symlink-parent") {
      await rm(resolve(directory, "supplemental"), { recursive: true })
      await symlink(directory, resolve(directory, "supplemental"))
    }
    if (mutation === "missing-continuation") execution.segments.pop()
    if (mutation === "wrong-order") execution.segments[1].startedMs = 0
    if (mutation === "capture-too-early") execution.segments[1].capture.startedMs = 0
    if (mutation === "capture-too-late") execution.segments[1].capture.finishedMs = project.timeoutMs
    if (mutation === "wrong-device") execution.deviceId = "foreign"
    if (mutation === "extra-capture") execution.segments[2].capture = execution.segments[1].capture
    if (mutation === "changed-flow") await writeFile(resolve(directory, "segments/1/flow.yaml"), "launchApp")
    if (mutation === "changed-command") await writeFile(resolve(directory, "segments/1/driver/stamp/form/commands.json"), "[]")
    if (mutation === "changed-primary") await writeFile(resolve(directory, "focused.png"), png(128))
    await writeFile(executionPath, JSON.stringify(execution))
    // Re-sealing a forged transcript cannot bypass semantic validation.
    run.result.serialExecutionDigest = canonicalDigest(execution)
    await writeFile(run.reportPath, JSON.stringify(run.result))
    await expect(validate(root, run)).rejects.toThrow()
    expect((await scope(root, run)).result.automatic[0].state).toBe("invalid")
    expect(fake.counts()).toEqual({ stage: 3, captures: 2 })
  })

  it("binds synthetic human review records to the trusted method, without accepting a substituted method", async () => {
    const root = await candidate(), run = await evaluate(root, driver())
    const review = await recordNativeReview({ projectRoot: root, report: relative(root, run.reportPath), review: "keyboard", decision: "inconclusive", reviewer: "test", note: "Synthetic test observation" }, sourceRevision)
    expect(review.result.screenshotMethod).toBe("simctl")
    expect(review.result.screenshotDigest).toBe(run.result.supplementalScreenshots![1].digest)
    expect(await readFile(review.htmlPath, "utf8")).toContain("Screenshot capture method: simctl")
    expect((await scope(root, run, review.reportPath)).result.human[0].state).toBe("inconclusive")
    for (const screenshotMethod of [undefined, "maestro-take-screenshot"]) {
      await writeFile(review.reportPath, JSON.stringify({ ...review.result, screenshotMethod }))
      expect((await scope(root, run, review.reportPath)).result.human[0].state).toBe("invalid")
    }
  })

  it("requires opt-in in the checkpoint, and leaves non-opted scenarios unsegmented", async () => {
    const root = await candidate()
    const plain = { ...scenario, steps: scenario.steps.map((step) => step.action === "screenshot" ? { action: "screenshot" as const, checkpointId: step.checkpointId } : step) }
    expect(nativeCaptureSegments(project, plain)).toBeUndefined()
    await writeFile(resolve(root, "ui-eval/form.json"), JSON.stringify(plain))
    await expect(loadNativePilotScenario(root, project, "form")).rejects.toThrow("explicitly enabled")
  })

  it("captures a final opted-in checkpoint without adding an empty continuation", async () => {
    const root = await candidate(), fake = driver()
    const finalCapture = { ...scenario, steps: scenario.steps.map((step) => step.action === "screenshot" ? { ...step, supplementalCapture: "simctl" as const } : step) }
    await writeFile(resolve(root, "ui-eval/form.json"), JSON.stringify(finalCapture))
    const run = await evaluate(root, fake)
    expect(run.result.status).toBe("passed")
    expect(fake.counts()).toEqual({ stage: 3, captures: 3 })
    expect(run.result.supplementalScreenshots).toHaveLength(3)
    await expect(validate(root, run)).resolves.toHaveLength(1)
  })
})
