import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { evaluateNativePilot } from "./run"
import { recordNativeReview } from "./review"
import { summarizeNativeProgress, type NativeProgressScope } from "./progress"
import { nativeIntegrationEvidence } from "../integration/native-evidence"
import { canonicalDigest } from "../contracts/canonical-json"
import { nativeFailureDiagnostic } from "./diagnostics"
import type { NativePilotProject, NativePilotScenario } from "./config"
import type { runCommand } from "../runtime/command"

const deviceId = "11111111-1111-1111-1111-111111111111"
const project: NativePilotProject = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotProject", projectId: "test-app", platform: "ios-simulator", appId: "test.app", maestroVersion: "2.9.0", timeoutMs: 1000, scenarios: { home: "ui-eval/home.json" }, reviews: [{ id: "layout", scenarioId: "home", checkpointId: "opened", criterion: "Panel content is readable" }] }
const scenario: NativePilotScenario = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotScenario", scenarioId: "home", steps: [{ action: "assert-visible", selector: { id: "home" } }, { action: "screenshot", checkpointId: "home" }, { action: "tap", selector: { text: "Safety" } }, { action: "assert-visible", selector: { text: "Opened" } }, { action: "screenshot", checkpointId: "opened" }] }
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const source = async () => ({ repository: "test", commitSha: "abc", dirtyTree: false })
async function fixture(mode: "pass" | "fail" | "missing" | "changed" | "unsafe-spaces" | "unsafe-unicode" = "pass") {
  const root = await mkdtemp(resolve(tmpdir(), "native-progress-")); roots.push(root)
  await mkdir(resolve(root, "ui-eval"))
  await writeFile(resolve(root, "ui-eval/native.json"), JSON.stringify(project))
  await writeFile(resolve(root, "ui-eval/home.json"), JSON.stringify(scenario))
  const png = new PNG({ width: 2, height: 2 }); png.data.fill(255)
  const bytes = PNG.sync.write(png)
  const command: typeof runCommand = async (binary, args) => {
    if (args.includes("--version")) return { exitCode: 0, stdout: "2.9.0", stderr: "" }
    if (args.includes("devices")) return { exitCode: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: deviceId, state: "Booted", isAvailable: true, name: "Test" }] } }), stderr: "" }
    if (binary === "xcrun") return { exitCode: 0, stdout: "", stderr: "" }
    const directory = resolve(args[args.indexOf("--test-output-dir") + 1], "stamp/home")
    await mkdir(resolve(directory, "takeScreenshot"), { recursive: true })
    const commands = [
      { defineVariablesCommand: { env: { MAESTRO_FILENAME: "flow", MAESTRO_DEVICE_UDID: deviceId, MAESTRO_SHARD_ID: "1", MAESTRO_SHARD_INDEX: "0" }, optional: false } },
      { applyConfigurationCommand: { config: { appId: project.appId, name: "home" }, optional: false } },
      { launchAppCommand: { appId: project.appId, stopApp: true, optional: false } },
      { assertConditionCommand: { condition: { visible: { idRegex: "home", optional: false } }, optional: false } },
      { takeScreenshotCommand: { path: "home", optional: false } },
      { tapOnElement: { selector: { textRegex: "Safety", optional: false }, retryIfNoChange: false, waitUntilVisible: false, longPress: false, optional: false } },
      { assertConditionCommand: { condition: { visible: { textRegex: "Opened", optional: false } }, optional: false } },
      { takeScreenshotCommand: { path: "opened", optional: false } },
    ]
    const rows = commands.slice(0, mode === "pass" ? 8 : 7).map((command, index) => ({ command, metadata: { evaluatedCommand: command, sequenceNumber: index, depth: 0, status: mode !== "pass" && index === 6 ? "FAILED" : "COMPLETED", ...(mode !== "pass" && index === 6 ? { error: { message: "Assertion is false: Opened is visible", debugMessage: "Assertion 'Opened is visible' failed. Check the UI hierarchy in debug artifacts" } } : {}) } }))
    await writeFile(resolve(directory, "commands.json"), JSON.stringify(rows))
    await writeFile(resolve(directory, "takeScreenshot/home.png"), bytes)
    await writeFile(resolve(directory, "takeScreenshot/opened.png"), bytes)
    if (mode !== "missing") {
      await mkdir(resolve(directory, "screenshots")); await mkdir(resolve(directory, "screen-hierarchy"))
      if (mode === "changed") png.data[0] = 0
      const label = mode === "unsafe-spaces" ? "Opened state" : mode === "unsafe-unicode" ? "Opened状态" : "Opened"
      await writeFile(resolve(directory, `screenshots/step-007-assertCondition-${label}.png`), PNG.sync.write(png))
      await writeFile(resolve(directory, `screen-hierarchy/step-007-assertCondition-${label}.json`), JSON.stringify({ children: [{ attributes: { accessibilityText: "Safety", bounds: "[10,20][30,60]" } }, { attributes: { accessibilityText: "PRIVATE SYNTHETIC TEXT" } }] }))
    }
    return { exitCode: mode === "pass" ? 0 : 1, stdout: "", stderr: "" }
  }
  const run = await evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home" }, { platform: "darwin", sourceRevision: source, command, storage: async () => ({ availableBytes: 4 * 1024 ** 3, minimumBytes: 1024 ** 3 }) })
  const scope: NativeProgressScope = { apiVersion: "uieval.io/native-progress-v1", kind: "NativeProgressScope", projectId: project.projectId, deviceId, scenarios: ["home"], reports: [{ scenarioId: "home", path: relative(root, run.reportPath) }], reviews: [] }
  const save = () => writeFile(resolve(root, "ui-eval/progress.json"), JSON.stringify(scope))
  await save()
  const summarize = (revision = source) => summarizeNativeProgress({ projectRoot: root, scope: "ui-eval/progress.json" }, revision)
  const observe = async (decision: "pass" | "fail" | "inconclusive" = "pass") => {
    const review = await recordNativeReview({ projectRoot: root, report: relative(root, run.reportPath), review: "layout", decision, reviewer: "owner", note: "Synthetic observation" }, source)
    scope.reviews = [{ reviewId: "layout", path: relative(root, review.reportPath) }]; await save()
    return review
  }
  return { root, run, scope, save, summarize, observe }
}

describe("native failure diagnostics", () => {
  it.each(["fail", "changed"] as const)("keeps %s failed and derives only observed comparisons", async (mode) => {
    const { run } = await fixture(mode)
    expect(run.result.status).toBe("failed")
    expect(run.result.screenshots).toEqual([])
    expect(run.result.diagnostic).toMatchObject({ failedStep: 3, precedingInteraction: { step: 2, action: "tap" }, cause: "undetermined", imageComparison: mode === "fail" ? "identical-pixels" : "different-pixels", targetBounds: { x: 10, y: 20, width: 20, height: 40 } })
    const html = await readFile(run.htmlPath, "utf8")
    expect(html).toContain("cause undetermined")
    expect(html).not.toContain("PRIVATE SYNTHETIC TEXT")
    expect(JSON.stringify(run.result)).not.toContain("PRIVATE SYNTHETIC TEXT")
  })
  it("keeps missing diagnostic artifacts unavailable without hiding the assertion failure", async () => {
    const { run } = await fixture("missing")
    expect(run.result.status).toBe("failed")
    expect(run.result.diagnostic).toMatchObject({ imageComparison: "unavailable", cause: "undetermined" })
    expect(run.result.diagnostic?.after).toBeUndefined()
  })
  it.each(["unsafe-spaces", "unsafe-unicode"] as const)("publishes the original failed result when optional PNG/hierarchy paths are %s", async (mode) => {
    const { run } = await fixture(mode)
    expect(run.result.status).toBe("failed")
    expect(run.result.diagnostic?.after).toBeUndefined()
    expect(run.result.diagnostic?.hierarchy).toBeUndefined()
    expect(run.result.diagnostic?.imageComparison).toBe("unavailable")
    expect(JSON.parse(await readFile(run.reportPath, "utf8")).status).toBe("failed")
    expect(await readFile(run.htmlPath, "utf8")).toContain("home: failed")
  })
  it("rejects changed diagnostic artifacts on final evidence revalidation", async () => {
    const { root, run } = await fixture("fail")
    await writeFile(resolve(dirname(run.reportPath), run.result.diagnostic!.after!.path), "corrupt")
    await expect(nativeIntegrationEvidence(root, { apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: "test", projectId: project.projectId, adapter: "native-pilot", checks: [], scenarios: [{ id: "home", timeoutMs: 1000 }] }, "home", run, canonicalDigest(await source()), deviceId)).rejects.toThrow("diagnostic")
  })
  it("does not follow a symlinked diagnostic image or guess regex target coordinates", async () => {
    const { run } = await fixture("fail")
    const directory = dirname(run.reportPath)
    const image = resolve(directory, run.result.diagnostic!.after!.path)
    await rm(image); await symlink(resolve(directory, run.result.diagnostic!.before!.path), image)
    const commandPath = resolve(directory, "driver/stamp/home/commands.json")
    const commands = JSON.parse(await readFile(commandPath, "utf8"))
    const changed = structuredClone(scenario)
    changed.steps[2] = { action: "tap", selector: { text: "Saf.*" } }
    const output = await nativeFailureDiagnostic(directory, commandPath, commands, changed)
    expect(output.diagnostic.after).toBeUndefined()
    expect(output.diagnostic.targetBounds).toBeUndefined()
    expect(output.diagnostic.imageComparison).toBe("unavailable")
  })
  it.each([undefined, 123, "[40,50][60,70]"])("does not claim unique target bounds when another matching node has bounds %j", async (bounds) => {
    const { run } = await fixture("fail")
    const directory = dirname(run.reportPath)
    const path = resolve(directory, run.result.diagnostic!.hierarchy!.path)
    const tree = JSON.parse(await readFile(path, "utf8"))
    tree.children.push({ attributes: { accessibilityText: "Safety", bounds } })
    await writeFile(path, JSON.stringify(tree))
    const commandPath = resolve(directory, "driver/stamp/home/commands.json")
    const commands = JSON.parse(await readFile(commandPath, "utf8"))
    const output = await nativeFailureDiagnostic(directory, commandPath, commands, scenario)
    expect(output.diagnostic.targetBounds).toBeUndefined()
    expect(output.diagnostic.hierarchy).toBeDefined()
    expect(output.diagnostic.cause).toBe("undetermined")
  })
})

describe("explicit native acceptance progress", () => {
  it("retains an unusable visual observation as inconclusive without rewriting automatic evidence", async () => {
    const f = await fixture()
    const original = await readFile(f.run.reportPath, "utf8")
    const review = await f.observe("inconclusive")
    expect(review.result.decision).toBe("inconclusive")
    expect(JSON.parse(await readFile(review.reportPath, "utf8"))).toEqual(review.result)
    expect(await readFile(review.htmlPath, "utf8")).toContain("layout: inconclusive")
    const progress = await f.summarize()
    expect(progress.result.status).toBe("pending")
    expect(progress.result.automatic[0].state).toBe("passed")
    expect(progress.result.human[0].state).toBe("inconclusive")
    expect(progress.result.human[0].nextAction).toContain("usable")
    expect(JSON.parse(await readFile(progress.reportPath, "utf8"))).toEqual(progress.result)
    expect(await readFile(progress.htmlPath, "utf8")).toContain("inconclusive")
    expect(await readFile(f.run.reportPath, "utf8")).toBe(original)
    await writeFile(review.reportPath, JSON.stringify({ ...review.result, screenshotDigest: `sha256:${"0".repeat(64)}` }))
    expect((await f.summarize()).result.status).toBe("blocked")
  })
  it("cannot use an inconclusive observation to waive an automatic failure or corrupt PNG", async () => {
    const failed = await fixture("fail")
    await expect(failed.observe("inconclusive")).rejects.toThrow("cannot waive")
    const passed = await fixture()
    await writeFile(resolve(dirname(passed.run.reportPath), "opened.png"), "corrupt")
    await expect(passed.observe("inconclusive")).rejects.toThrow()
  })
  it("keeps legacy capture method unspecified and rejects an unsupported claimed method", async () => {
    const f = await fixture()
    expect(f.run.result.screenshotMethod).toBe("maestro-take-screenshot")
    expect(await readFile(f.run.htmlPath, "utf8")).toContain("maestro-take-screenshot")
    const legacy = { ...f.run.result }; delete legacy.screenshotMethod
    await writeFile(f.run.reportPath, JSON.stringify(legacy))
    const review = await f.observe()
    expect(await readFile(review.htmlPath, "utf8")).toContain("capture method: unspecified")
    expect((await f.summarize()).result.status).toBe("complete")
    const legacyReview = { ...review.result }; delete legacyReview.screenshotMethod
    await writeFile(review.reportPath, JSON.stringify(legacyReview))
    expect((await f.summarize()).result.status).toBe("complete")
    await writeFile(f.run.reportPath, JSON.stringify({ ...legacy, screenshotMethod: "simctl" }))
    expect((await f.summarize()).result.automatic[0].state).toBe("invalid")
  })
  it("requires human evidence after a passed automatic run and publishes matching projections", async () => {
    const f = await fixture()
    const pending = await f.summarize()
    expect(pending.result.status).toBe("pending")
    expect(pending.result.automatic[0].state).toBe("passed")
    expect(pending.result.human[0].state).toBe("pending")
    await f.observe()
    const complete = await f.summarize()
    expect(complete.result.status).toBe("complete")
    expect(JSON.parse(await readFile(complete.reportPath, "utf8"))).toEqual(complete.result)
    expect(await readFile(complete.htmlPath, "utf8")).toContain("Native acceptance: complete")
  })
  it("does not discover or silently substitute an unselected passing run", async () => {
    const f = await fixture(); f.scope.reports = []; await f.save()
    expect((await f.summarize()).result.automatic[0].state).toBe("pending")
  })
  it("blocks a selected automatic or human failure", async () => {
    const failed = await fixture("fail")
    expect((await failed.summarize()).result.status).toBe("blocked")
    const passed = await fixture(); await passed.observe("fail")
    const output = await passed.summarize()
    expect(output.result.status).toBe("blocked")
    expect(output.result.human[0].state).toBe("failed")
  })
  it("marks old-source captures and observations stale instead of passed", async () => {
    const f = await fixture(); await f.observe()
    const output = await f.summarize(async () => ({ ...await source(), commitSha: "new" }))
    expect(output.result.status).toBe("pending")
    expect(output.result.automatic[0].state).toBe("stale")
    expect(output.result.human[0].state).toBe("stale")
  })
  it("rejects a human observation for a different selected capture", async () => {
    const f = await fixture(); const review = await f.observe()
    await writeFile(review.reportPath, JSON.stringify({ ...review.result, reportDigest: `sha256:${"0".repeat(64)}` }))
    expect((await f.summarize()).result.human[0].state).toBe("invalid")
  })
  it("never counts corrupt PNGs, missing human HTML or symlinked inputs as complete", async () => {
    const f = await fixture(); const observation = await f.observe()
    await rm(observation.htmlPath)
    expect((await f.summarize()).result.status).toBe("blocked")
    await writeFile(resolve(dirname(f.run.reportPath), "home.png"), "corrupt")
    expect((await f.summarize()).result.automatic[0].state).toBe("invalid")
    const alias = resolve(f.root, "alias.json"); await symlink(f.run.reportPath, alias)
    f.scope.reports[0].path = "alias.json"; await f.save()
    expect((await f.summarize()).result.automatic[0].state).toBe("invalid")
  })
  it("rejects duplicate selections and changed declared criteria", async () => {
    const f = await fixture(); f.scope.reports.push(f.scope.reports[0]); await f.save()
    await expect(f.summarize()).rejects.toThrow("unique")
    f.scope.reports.pop(); await f.observe()
    await writeFile(resolve(f.root, "ui-eval/native.json"), JSON.stringify({ ...project, reviews: [{ ...project.reviews![0], criterion: "Changed criterion" }] }))
    expect((await f.summarize()).result.human[0].state).toBe("invalid")
  })
  it("refuses source drift during projection instead of publishing completion", async () => {
    const f = await fixture(); let calls = 0
    await expect(f.summarize(async () => ({ ...await source(), commitSha: ++calls === 1 ? "abc" : "new" }))).rejects.toThrow("inputs changed")
  })
  it("rejects cancellation before inspecting or publishing a scope", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort()
    await expect(summarizeNativeProgress({ projectRoot: f.root, scope: "ui-eval/progress.json", signal: controller.signal }, source)).rejects.toThrow()
  })
})
