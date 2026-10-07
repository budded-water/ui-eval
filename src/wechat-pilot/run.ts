import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { canonicalDigest } from "../contracts/canonical-json"
import { hasIncompleteCleanup } from "../runtime/cleanup"
import { collectSourceRevision } from "../orchestrator/identity"
import { containedPath, loadWechatProject, loadWechatScenario } from "./config"
import { record, WechatDriver, WechatDriverError, type CommandRunner } from "./driver"
import { boundedFile, fingerprintRuntime, inspectWechatPng } from "./evidence"
import { writeWechatReport, type WechatPilotResult } from "./report"

export interface WechatOptions { projectRoot: string; driver?: string; signal?: AbortSignal }
export interface WechatDependencies { command?: CommandRunner; source?: typeof collectSourceRevision }
export async function doctorWechatPilot(options: WechatOptions, deps: WechatDependencies = {}): Promise<{ ready: true; projectId: string; runtimeDigest: string }> {
  const project = await loadWechatProject(options.projectRoot)
  const runtimeDigest = await fingerprintRuntime(options.projectRoot, project)
  await new WechatDriver(options.projectRoot, project, options.driver, deps.command, options.signal).ready()
  return { ready: true, projectId: project.projectId, runtimeDigest }
}
class AssertionMismatch extends Error {}

export async function evaluateWechatPilot(options: WechatOptions & { scenario: string }, deps: WechatDependencies = {}): Promise<{ result: WechatPilotResult; reportPath: string; htmlPath: string }> {
  const root = options.projectRoot
  const project = await loadWechatProject(root)
  const scenario = await loadWechatScenario(root, project, options.scenario)
  const source = deps.source ?? collectSourceRevision
  const before = await source(root)
  const runtimeDigest = await fingerprintRuntime(root, project)
  const executionId = randomUUID()
  const directory = await containedPath(root, `.ui-eval/wechat-runs/${executionId}`, true)
  const runtime = await containedPath(root, project.runtimeProject)
  const lockPath = resolve(runtime, ".ui-eval-pilot.lock")
  await writeFile(lockPath, executionId, { flag: "wx", mode: 0o600 })
  const driver = new WechatDriver(root, project, options.driver, deps.command, options.signal)
  const projectArgs = ["--project", runtime]
  const sourceDigest = canonicalDigest(before)
  const result: WechatPilotResult = {
    apiVersion: "uieval.io/wechat-pilot-v1", kind: "WechatPilotResult", experimental: true,
    projectId: project.projectId, scenarioId: scenario.id, executionId,
    status: "inconclusive", reason: "Required WeChat evidence is not yet established.",
    planDigest: canonicalDigest({ project, scenario }), sourceDigest, sourceCommit: before.commitSha, runtimeDigest,
    driver: project.driver, steps: scenario.steps.map((step, index) => ({ index, action: step.action, status: "not-run" })),
    assertions: { passed: 0, failed: 0 }, screenshots: [], cleanup: "completed",
    limitations: [
      "This is experimental WeChat DevTools evidence, not phone-WeChat or release acceptance.",
      "Source and compiled-file fingerprints do not prove every byte executed by DevTools.",
      "Geometry, design conformance, accessibility, crash and network gates are not evaluated.",
      "The candidate owns synthetic API/account isolation; payments and phone authorization are outside this pilot.",
    ],
  }
  const backups: Array<{ key: string; present: boolean; value?: unknown }> = []
  const mocked: string[] = []
  let argumentId = 0
  const jsonCall = async (tool: string, args: string[], flag: string, value: unknown, cleanup = false) => {
    const path = resolve(directory, `argument-${argumentId++}.json`)
    await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 })
    try { return await driver.call(tool, [...projectArgs, ...args, flag, path], cleanup) }
    finally { await rm(path, { force: true }) }
  }
  const wx = async (method: string, args: unknown[], cleanup = false) => {
    const response = record(await jsonCall("automation_wx_api", ["--action", "call", "--method", method], "--args-file", args, cleanup))
    if (response.success !== true) throw new WechatDriverError("WeChat state operation was not successful")
    if (method === "getStorageSync" && (!Object.hasOwn(response, "result") || response.result === undefined)) throw new WechatDriverError("Missing original storage value evidence")
    return response.result
  }
  let currentStep = -1
  let unresolvedProcess = false
  try {
    await writeFile(resolve(directory, "plan.json"), JSON.stringify({ project, scenario }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    await writeFile(resolve(directory, "source.json"), JSON.stringify(before, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    await driver.ready()
    await driver.call("open_project_window", [...projectArgs, "--window-mode", "liteMode"])
    if (scenario.storage.length) {
      const info = record(await wx("getStorageInfoSync", []))
      if (!Array.isArray(info.keys) || info.keys.some((key) => typeof key !== "string")) throw new WechatDriverError("Missing WeChat storage-key evidence")
      for (const entry of scenario.storage) {
        const present = info.keys.includes(entry.key)
        const original = present ? await wx("getStorageSync", [entry.key]) : undefined
        backups.push({ key: entry.key, present, value: original })
        if (Object.hasOwn(entry, "value")) await wx("setStorageSync", [entry.key, entry.value])
        else await wx("removeStorageSync", [entry.key])
      }
    }
    for (const mock of scenario.mocks) {
      mocked.push(mock.method)
      await jsonCall("automation_wx_api", ["--action", "mock", "--method", mock.method], "--result-file", mock.result)
    }
    for (const [index, step] of scenario.steps.entries()) {
      currentStep = index
      options.signal?.throwIfAborted()
      if (step.action === "navigate") await driver.call("automation_navigate", [...projectArgs, "--action", "reLaunch", "--url", step.url])
      else if (step.action === "tap" || step.action === "input") {
        await driver.call("automation_element_action", [...projectArgs, "--action", step.action, "--selector", step.selector, "--wait-for-selector", step.selector, ...(step.action === "input" ? ["--value", step.value] : [])])
      } else if (step.action === "assertText") {
        const observed = await driver.call("automation_element_action", [...projectArgs, "--action", "text", "--selector", step.selector, "--wait-for-selector", step.selector])
        if (typeof observed !== "string") throw new WechatDriverError("Missing text assertion evidence")
        if (!observed.includes(step.includes)) throw new AssertionMismatch("Observed text did not match the declared assertion")
        result.assertions.passed++
      } else if (step.action === "assertPage") {
        const deadline = Date.now() + 5000
        while (true) {
          const page = record(record(await driver.call("automation_runtime_info", [...projectArgs, "--action", "currentPage"])).currentPage)
          if (typeof page.path !== "string") throw new WechatDriverError("Missing page assertion evidence")
          if (page.path === step.path) break
          if (Date.now() >= deadline) throw new AssertionMismatch("Observed page did not match the declared assertion")
          await new Promise((done) => setTimeout(done, 200))
        }
        result.assertions.passed++
      } else if (step.action === "screenshot") {
        const path = `${step.checkpointId}.png`
        const expected = resolve(directory, path)
        const shot = record(await driver.call("simulator_screenshot", [...projectArgs, "--path", expected, "--optimize=false"]))
        if (shot.success !== true || shot.path !== expected) throw new WechatDriverError("Screenshot path is not bound to the requested checkpoint")
        const image = inspectWechatPng(await boundedFile(expected))
        if (image.width !== shot.imageWidth || image.height !== shot.imageHeight) throw new WechatDriverError("Screenshot dimensions do not match driver metadata")
        result.screenshots.push({ checkpointId: step.checkpointId, path, digest: image.digest, widthPx: image.width, heightPx: image.height })
      }
      result.steps[index].status = "passed"
    }
    result.status = "passed"
    result.reason = "Every declared interaction assertion and required PNG checkpoint completed."
  } catch (error) {
    unresolvedProcess = hasIncompleteCleanup(error)
    if (error instanceof AssertionMismatch && currentStep >= 0) {
      result.steps[currentStep].status = "failed"
      result.assertions.failed++
      result.status = "failed"
      result.reason = error.message
    } else {
      result.reason = "WeChat driver, state setup or required evidence was unavailable or invalid."
      if (error instanceof WechatDriverError && error.pendingTaskId) result.pendingTaskId = error.pendingTaskId
    }
  } finally {
    let cleanupFailed = false
    for (const method of mocked.reverse()) {
      try { await driver.call("automation_wx_api", [...projectArgs, "--action", "restore", "--method", method], true) }
      catch (error) { cleanupFailed = true; unresolvedProcess ||= hasIncompleteCleanup(error) }
    }
    for (const backup of backups.reverse()) {
      try {
        await wx(backup.present ? "setStorageSync" : "removeStorageSync", backup.present ? [backup.key, backup.value] : [backup.key], true)
      } catch (error) { cleanupFailed = true; unresolvedProcess ||= hasIncompleteCleanup(error) }
    }
    if (cleanupFailed || unresolvedProcess) {
      result.cleanup = "incomplete"
      result.status = "inconclusive"
      result.reason = "WeChat process, mock or storage cleanup did not complete; inspect and reset the dedicated runtime before retrying."
    }
    if (result.cleanup === "completed") await rm(lockPath)
  }
  try {
    if (canonicalDigest(await source(root)) !== sourceDigest || await fingerprintRuntime(root, project) !== runtimeDigest) {
      result.status = "inconclusive"
      result.reason = "Candidate source or compiled runtime changed during capture."
    }
  } catch {
    result.status = "inconclusive"
    result.reason = "Post-capture source/runtime identity could not be established."
  }
  await writeWechatReport(directory, result)
  options.signal?.throwIfAborted()
  return { result, reportPath: resolve(directory, "report.json"), htmlPath: resolve(directory, "report.html") }
}
