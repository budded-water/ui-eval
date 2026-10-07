import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nativeReport from "./report"
import { loadNativePilotProject, loadNativePilotScenario, type NativePilotProject, type NativePilotScenario } from "./config"
import { evaluateNativePilot, doctorNativePilot } from "./run"
import { inspectNativeCommands, findNativeCommandFile } from "./evidence"
import { compileNativePilotFlow } from "./flow"
import type { CommandResult } from "../runtime/command"
import type { runCommand } from "../runtime/command"

const deviceId = "11111111-1111-1111-1111-111111111111"
const project: NativePilotProject = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotProject", projectId: "test-app", platform: "ios-simulator", appId: "test.app", maestroVersion: "2.9.0", timeoutMs: 1000, scenarios: { home: "ui-eval/home.json" } }
const scenario: NativePilotScenario = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotScenario", scenarioId: "home", steps: [{ action: "assert-visible", selector: { id: "home-title" } }, { action: "screenshot", checkpointId: "home" }] }
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function candidate() {
  const root = await mkdtemp(resolve(tmpdir(), "native-pilot-test-"))
  roots.push(root)
  await mkdir(resolve(root, "ui-eval"))
  await writeFile(resolve(root, "ui-eval/native.json"), JSON.stringify(project))
  await writeFile(resolve(root, "ui-eval/home.json"), JSON.stringify(scenario))
  return root
}
function commands(status = "COMPLETED") {
  const values = [
    { defineVariablesCommand: { env: { MAESTRO_FILENAME: "flow", MAESTRO_DEVICE_UDID: deviceId, MAESTRO_SHARD_ID: "1", MAESTRO_SHARD_INDEX: "0" }, optional: false } },
    { applyConfigurationCommand: { config: { appId: project.appId, name: "home" }, optional: false } },
    { launchAppCommand: { appId: project.appId, stopApp: true, optional: false } },
    { assertConditionCommand: { condition: { visible: { idRegex: "home-title", optional: false } }, optional: false } },
    { takeScreenshotCommand: { path: "home", optional: false } },
  ]
  return values.map((command, index) => ({ command, metadata: { evaluatedCommand: command, sequenceNumber: index, depth: 0, status: index === 3 ? status : "COMPLETED" } }))
}
const sourceRevision = async () => ({ repository: "test", commitSha: "abc", dirtyTree: false })
const platform = "darwin" as const
function driver(mode: "pass" | "missing-png" | "bad-png" | "failed" | "assertion-transport" | "missing-error" | "unknown-error" | "transport" | "timeout" = "pass"): typeof runCommand {
  return async (binary: string, args: readonly string[]): Promise<CommandResult> => {
    let stdout = ""
    if (args.includes("--version")) stdout = "2.9.0\n"
    else if (args.includes("devices")) stdout = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ udid: deviceId, state: "Booted", isAvailable: true, name: "Test iPhone" }] } })
    else if (binary === "maestro") {
      const directory = resolve(args[args.indexOf("--test-output-dir") + 1], "stamp/home")
      await mkdir(resolve(directory, "takeScreenshot"), { recursive: true })
      const failed = ["failed", "assertion-transport", "missing-error", "unknown-error"].includes(mode)
      const records = commands(failed ? "FAILED" : "COMPLETED")
      if (failed) {
        records.pop()
        const mismatch = { message: "Assertion is false: id: home-title is visible", debugMessage: "Assertion 'id: home-title is visible' failed. Check the UI hierarchy in debug artifacts to verify the element state and properties." }
        const error = mode === "failed" ? mismatch : mode === "assertion-transport" ? { message: "java.io.IOException: Failed to read iOS UI hierarchy" } : mode === "unknown-error" ? { ...mismatch, debugMessage: "Unknown exception" } : undefined
        Object.assign(records[3].metadata, { error })
      }
      await writeFile(resolve(directory, "commands.json"), JSON.stringify(records))
      if (mode !== "missing-png") {
        const png = new PNG({ width: 2, height: 2 })
        png.data.fill(255)
        await writeFile(resolve(directory, "takeScreenshot/home.png"), mode === "bad-png" ? "not a PNG" : PNG.sync.write(png))
      }
      return { exitCode: failed ? 1 : mode === "transport" ? 2 : mode === "timeout" ? null : 0, stdout, stderr: "" }
    }
    return { exitCode: 0, stdout, stderr: "" }
  }
}

describe("native pilot evidence acceptance", () => {
  it("publishes synchronized JSON/HTML only after every assertion and PNG is valid", async () => {
    const root = await candidate()
    const run = await evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home" }, { platform, command: driver(), sourceRevision })
    expect(run.result.status).toBe("passed")
    expect(run.result.assertions).toEqual({ passed: 1, failed: 0 })
    expect(run.result.screenshots[0]).toMatchObject({ checkpointId: "home", widthPx: 2, heightPx: 2 })
    expect(JSON.parse(await readFile(run.reportPath, "utf8"))).toEqual(run.result)
    expect(await readFile(run.htmlPath, "utf8")).toContain("home: passed")
    expect(await readFile(run.htmlPath, "utf8")).toContain("not cryptographically bound")
  })
  it.each(["missing-png", "bad-png", "transport", "timeout"] as const)("never passes %s", async (mode) => {
    const run = await evaluateNativePilot({ projectRoot: await candidate(), deviceId, scenario: "home" }, { platform, command: driver(mode), sourceRevision })
    expect(run.result.status).toBe("inconclusive")
    expect(JSON.parse(await readFile(run.reportPath, "utf8")).status).toBe("inconclusive")
  })
  it("reports a bound failed visibility assertion without fabricating later screenshots", async () => {
    const run = await evaluateNativePilot({ projectRoot: await candidate(), deviceId, scenario: "home" }, { platform, command: driver("failed"), sourceRevision })
    expect(run.result.status).toBe("failed")
    expect(run.result.assertions.failed).toBe(1)
    expect(run.result.screenshots).toEqual([])
  })
  it.each(["assertion-transport", "missing-error", "unknown-error"] as const)("keeps exit 1 with %s evidence inconclusive", async (mode) => {
    const run = await evaluateNativePilot({ projectRoot: await candidate(), deviceId, scenario: "home" }, { platform, command: driver(mode), sourceRevision })
    expect(run.result.status).toBe("inconclusive")
    expect(run.result.assertions.failed).toBe(0)
    expect(JSON.parse(await readFile(run.reportPath, "utf8")).status).toBe("inconclusive")
    expect(await readFile(run.htmlPath, "utf8")).toContain("home: inconclusive")
  })
  it("invalidates successful evidence when source changes during capture", async () => {
    let calls = 0
    const run = await evaluateNativePilot({ projectRoot: await candidate(), deviceId, scenario: "home" }, { platform, command: driver(), sourceRevision: async () => ({ repository: "test", commitSha: String(Math.floor(calls++ / 2)) }) })
    expect(run.result.status).toBe("inconclusive")
    expect(run.result.reason).toContain("source changed")
  })
  it("rejects another device, selector, duplicate command, or missing checkpoint", () => {
    expect(() => inspectNativeCommands(commands(), project, scenario, "wrong")).toThrow(/device/)
    const other = structuredClone(scenario)
    other.steps[0] = { action: "assert-visible", selector: { id: "another-title" } }
    expect(() => inspectNativeCommands(commands(), project, other, deviceId)).toThrow(/selector/)
    const duplicate = commands(); duplicate.push(duplicate[3])
    expect(() => inspectNativeCommands(duplicate, project, scenario, deviceId)).toThrow(/coverage/)
    expect(inspectNativeCommands(commands().slice(0, 4), project, scenario, deviceId).complete).toBe(false)
  })
  it("rejects additional selector semantics and weakened relaunch flags", () => {
    const changedLaunch = commands()
    changedLaunch[2].command.launchAppCommand!.stopApp = false
    expect(() => inspectNativeCommands(changedLaunch, project, scenario, deviceId)).toThrow(/launch/)
    const changedSelector = commands()
    Object.assign(changedSelector[3].command.assertConditionCommand!.condition.visible, { textRegex: "unrequested-title" })
    expect(() => inspectNativeCommands(changedSelector, project, scenario, deviceId)).toThrow(/semantics/)
  })
  it("binds observed Maestro tap defaults and hidden assertions", () => {
    const chain: NativePilotScenario = { ...scenario, steps: [
      { action: "tap", selector: { id: "probe-button" } },
      { action: "assert-visible", selector: { id: "probe-tapped" } },
      { action: "assert-hidden", selector: { id: "probe-title" } },
      { action: "screenshot", checkpointId: "home" },
    ] }
    // These command names/defaults were observed in the real 2.9.0 native probe.
    const authored = [
      { tapOnElement: { selector: { idRegex: "probe-button", optional: false }, retryIfNoChange: false, waitUntilVisible: false, longPress: false, optional: false } },
      { assertConditionCommand: { condition: { visible: { idRegex: "probe-tapped", optional: false } }, optional: false } },
      { assertConditionCommand: { condition: { notVisible: { idRegex: "probe-title", optional: false } }, optional: false } },
      { takeScreenshotCommand: { path: "home", optional: false } },
    ]
    const evidence = [...commands().slice(0, 3), ...authored.map((command, index) => ({ command, metadata: { evaluatedCommand: command, sequenceNumber: index + 3, depth: 0, status: "COMPLETED" } }))]
    expect(inspectNativeCommands(evidence, project, chain, deviceId)).toEqual({ passed: 2, failed: 0, complete: true })
    authored[0].tapOnElement!.longPress = true
    expect(() => inspectNativeCommands(evidence, project, chain, deviceId)).toThrow(/semantics/)
  })
  it("rejects an edit while native inputs are being loaded", async () => {
    const root = await candidate()
    let changed = false
    const command = driver()
    await expect(evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home" }, {
      platform,
      sourceRevision: async () => ({ repository: "test", commitSha: changed ? "after" : "before" }),
      command: async (binary, args, options) => {
        if (args.includes("--version")) {
          changed = true
          await writeFile(resolve(root, "ui-eval/home.json"), JSON.stringify({ ...scenario, steps: [{ action: "assert-visible", selector: { id: "another-title" } }, scenario.steps[1]] }))
        }
        return command(binary, args, options)
      },
    })).rejects.toThrow(/source changed while loading/)
  })
  it("rejects unavailable selected devices and wrong Maestro pins", async () => {
    const root = await candidate()
    await expect(doctorNativePilot({ projectRoot: root, deviceId: "bad" }, { platform, command: driver() })).rejects.toThrow(/UUID/)
    const command = driver()
    await expect(doctorNativePilot({ projectRoot: root, deviceId }, { platform, command: async (binary, args, options) => args.includes("--version") ? { exitCode: 0, stdout: "2.8.0", stderr: "" } : command(binary, args, options) })).rejects.toThrow(/version/)
  })
  it("publishes interrupted JSON/HTML before propagating cancellation", async () => {
    const root = await candidate()
    const abort = new AbortController()
    const command = driver()
    await expect(evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home", signal: abort.signal }, {
      platform, sourceRevision,
      command: async (binary, args, options) => {
        if (args.includes("test")) { abort.abort(); throw new Error("cancelled") }
        return command(binary, args, options)
      },
    })).rejects.toThrow()
    const runs = resolve(root, ".ui-eval/native-runs")
    const directories = await readdir(runs)
    expect(directories).toHaveLength(1)
    const report = JSON.parse(await readFile(resolve(runs, directories[0], "report.json"), "utf8"))
    expect(report.status).toBe("inconclusive")
    expect(report.reason).toContain("interrupted")
    expect(await readFile(resolve(runs, directories[0], "report.html"), "utf8")).toContain("interrupted")
  })
  it.each(["final-source", "report-publication"] as const)("invalidates passed projections when cancelled during %s", async (stage) => {
    const root = await candidate()
    const abort = new AbortController()
    let sourceReads = 0
    if (stage === "report-publication") {
      const publish = nativeReport.writeNativePilotReport
      vi.spyOn(nativeReport, "writeNativePilotReport").mockImplementation(async (directory, result) => {
        await publish(directory, result)
        abort.abort(new Error("late cancellation"))
      })
    }
    await expect(evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home", signal: abort.signal }, {
      platform, command: driver(), sourceRevision: async () => {
        if (++sourceReads === 3 && stage === "final-source") abort.abort(new Error("late cancellation"))
        return sourceRevision()
      },
    })).rejects.toThrow("late cancellation")
    const runs = resolve(root, ".ui-eval/native-runs")
    const directories = await readdir(runs)
    expect(directories).toHaveLength(1)
    const report = JSON.parse(await readFile(resolve(runs, directories[0], "report.json"), "utf8"))
    expect(report.status).toBe("inconclusive")
    expect(report.reason).toContain("interrupted")
    expect(await readFile(resolve(runs, directories[0], "report.html"), "utf8")).toContain("home: inconclusive")
  })
})

describe("native authoring boundary", () => {
  it("generates data-only commands and requires assertions before checkpoints", async () => {
    const root = await candidate()
    expect(compileNativePilotFlow(project, scenario)).toContain('"assertVisible":{"id":"home-title"}')
    const bad = structuredClone(scenario)
    bad.steps.reverse()
    await writeFile(resolve(root, "ui-eval/home.json"), JSON.stringify(bad))
    await expect(loadNativePilotScenario(root, project, "home")).rejects.toThrow(/immediately follow/)
  })
  it("rejects native scripts/templates and foreign platforms", async () => {
    const root = await candidate()
    await writeFile(resolve(root, "ui-eval/native.json"), JSON.stringify({ ...project, platform: "harmony" }))
    await expect(loadNativePilotProject(root)).rejects.toThrow(/project/)
    await writeFile(resolve(root, "ui-eval/home.json"), JSON.stringify({ ...scenario, steps: [{ action: "assert-visible", selector: { text: "${1 + 1}" } }, scenario.steps[1]] }))
    await expect(loadNativePilotScenario(root, project, "home")).rejects.toThrow(/scenario/)
  })
  it("rejects escaped input and symlinked artifact destinations before driver execution", async () => {
    const root = await candidate()
    await expect(loadNativePilotScenario(root, { ...project, scenarios: { home: "../outside.json" } }, "home")).rejects.toThrow(/escapes/)
    const outside = await mkdtemp(resolve(tmpdir(), "native-pilot-outside-")); roots.push(outside)
    await symlink(outside, resolve(root, ".ui-eval"))
    await expect(evaluateNativePilot({ projectRoot: root, deviceId, scenario: "home" }, { platform, command: driver(), sourceRevision })).rejects.toThrow(/symlinks/)
  })
  it("rejects a symlinked driver output root rather than reading external evidence", async () => {
    const root = await candidate()
    await mkdir(resolve(root, "external"))
    await writeFile(resolve(root, "external/commands.json"), JSON.stringify(commands()))
    await symlink(resolve(root, "external"), resolve(root, "driver"))
    await expect(findNativeCommandFile(resolve(root, "driver"))).rejects.toThrow(/symlink/)
  })
})
