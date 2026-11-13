import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { containedPath, loadWechatProject } from "./config"
import { WechatDriver, record } from "./driver"
import { WechatFailureSchema } from "./report"
import { fingerprintRuntime } from "./evidence"
import { hasIncompleteCleanup } from "../runtime/cleanup"
import type { WechatOptions, WechatDependencies } from "./run"

export const WechatProbeResultSchema = Type.Object({
  kind: Type.Literal("WechatRuntimeProbe"), projectId: Type.String(),
  status: Type.Union([Type.Literal("ready"), Type.Literal("inconclusive")]),
  runtimeDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  phase: Type.Union(["readiness", "action", "state", "evidence"].map((value) => Type.Literal(value))),
  pagePath: Type.Optional(Type.String({ pattern: "^pages/[a-zA-Z0-9/_-]{1,500}$" })),
  storageKeyCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  diagnostics: Type.Array(WechatFailureSchema, { maxItems: 300 }),
  cleanup: Type.Union([Type.Literal("completed"), Type.Literal("incomplete")]),
}, { additionalProperties: false })
export type WechatProbeResult = Static<typeof WechatProbeResultSchema>

/** Read an already-open synthetic runtime; never open/restart a window or write storage. */
export async function probeWechatPilot(options: WechatOptions, deps: WechatDependencies = {}): Promise<WechatProbeResult> {
  const project = await loadWechatProject(options.projectRoot)
  const runtime = await containedPath(options.projectRoot, project.runtimeProject)
  const lock = resolve(runtime, ".ui-eval-pilot.lock")
  const executionId = randomUUID()
  const directory = await containedPath(options.projectRoot, `.ui-eval/wechat-probes/${executionId}`, true)
  const path = resolve(directory, "arguments.json")
  const result: WechatProbeResult = { kind: "WechatRuntimeProbe", projectId: project.projectId, status: "inconclusive",
    runtimeDigest: await fingerprintRuntime(options.projectRoot, project), phase: "readiness", diagnostics: [], cleanup: "completed" }
  await writeFile(lock, executionId, { flag: "wx", mode: 0o600 })
  const driver = new WechatDriver(options.projectRoot, project, options.driver, deps.command, options.signal)
  try {
    await driver.ready()
    result.phase = "action"
    const response = record(await driver.call("automation_runtime_info", ["--project", runtime, "--action", "currentPage"]))
    const page = record(response.currentPage)
    if (typeof page.path !== "string" || !/^pages\/[a-zA-Z0-9/_-]{1,500}$/.test(page.path)) throw new Error("Missing current page evidence")
    await writeFile(path, "[]", { flag: "wx", mode: 0o600 })
    result.phase = "state"
    const info = record(record(await driver.call("automation_wx_api", ["--project", runtime, "--action", "call", "--method", "getStorageInfoSync", "--args-file", path])).result)
    if (!Array.isArray(info.keys) || info.keys.length > 10000 || info.keys.some((key) => typeof key !== "string")) throw new Error("Missing storage-key evidence")
    result.phase = "evidence"
    if (await fingerprintRuntime(options.projectRoot, project) !== result.runtimeDigest) throw new Error("Runtime changed during probe")
    result.pagePath = page.path; result.storageKeyCount = info.keys.length; result.status = "ready"
  } catch (error) {
    if (hasIncompleteCleanup(error)) result.cleanup = "incomplete"
  } finally {
    result.diagnostics = [...driver.diagnostics]
    await rm(path, { force: true })
    if (result.cleanup === "completed") await rm(lock)
  }
  options.signal?.throwIfAborted()
  return result
}
