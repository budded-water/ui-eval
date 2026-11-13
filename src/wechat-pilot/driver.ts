import { runCommand, type CommandOptions, type CommandResult } from "../runtime/command"
import type { WechatPilotProject } from "./config"
import { hasIncompleteCleanup } from "../runtime/cleanup"

export type WechatFailureCode = "command-failed" | "automator-timeout" | "invalid-envelope" | "response-binding" | "authorization-pending" | "action-unconfirmed" | "deadline"
export interface WechatFailure {
  phase: "readiness" | "open" | "state" | "action" | "evidence" | "cleanup"
  tool: string; code: WechatFailureCode; elapsedMs: number; budgetMs: number; exitCode: number | null
}

export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>
export class WechatDriverError extends Error {
  constructor(message: string, readonly pendingTaskId?: string, readonly failureCode: WechatFailureCode = "invalid-envelope") { super(message); this.name = "WechatDriverError" }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WechatDriverError("Invalid WeChat driver evidence")
  return value as Record<string, unknown>
}
/** Only an exact, successful envelope for the requested tool/client is usable. */
export function decodeWechatResponse(stdout: string, exitCode: number | null, tool: string, client: string): unknown {
  let payload: Record<string, unknown>
  try { payload = record(JSON.parse(stdout)) } catch { throw new WechatDriverError("Invalid WeChat driver envelope", undefined, exitCode === 0 ? "invalid-envelope" : "command-failed") }
  if (payload.tool !== tool || payload.clientName !== client) throw new WechatDriverError("WeChat driver response is not bound to the requested command", undefined, "response-binding")
  if (exitCode !== 0 || payload.ok !== true) {
    const code = payload.ok === false && payload.message === "timeout waiting for automator response" ? "automator-timeout" : "command-failed"
    throw new WechatDriverError("WeChat driver command failed or timed out", undefined, code)
  }
  if (!Object.hasOwn(payload, "result")) throw new WechatDriverError("Missing WeChat driver result")
  const result = payload.result
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const metadata = record(result)
    if (metadata.status === "pending") throw new WechatDriverError("WeChat DevTools requires user authorization or confirmation", typeof metadata.taskId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(metadata.taskId) ? metadata.taskId : undefined, "authorization-pending")
    if (metadata.success === false) throw new WechatDriverError("WeChat driver did not establish success")
  }
  return result
}
export class WechatDriver {
  readonly diagnostics: WechatFailure[] = []
  private readonly deadline: number
  private cleanupDeadline?: number
  constructor(
    readonly root: string,
    readonly project: WechatPilotProject,
    readonly binary = "wechatide",
    private readonly command: CommandRunner = runCommand,
    private readonly signal?: AbortSignal,
  ) { this.deadline = Date.now() + project.timeoutMs }
  async call(tool: string, args: readonly string[] = [], cleanup = false): Promise<unknown> {
    if (cleanup) this.cleanupDeadline ??= Date.now() + 15000
    const remaining = (cleanup ? this.cleanupDeadline! : this.deadline) - Date.now()
    if (!/^[a-z_]{1,80}$/.test(tool)) throw new WechatDriverError("Invalid WeChat tool name")
    const phase = cleanup ? "cleanup" : tool === "check_wechatide_status" ? "readiness" : tool === "open_project_window" ? "open" : tool === "automation_wx_api" ? "state" : tool === "simulator_screenshot" ? "evidence" : "action"
    const start = performance.now(), budgetMs = Math.max(0, Math.min(remaining, 30000))
    let exitCode: number | null = null
    try {
      if (remaining <= 0) throw new WechatDriverError("WeChat pilot deadline exceeded", undefined, "deadline")
      const output = await this.command(this.binary, ["-c", this.project.driver.clientName, tool, ...args], {
        cwd: this.root, timeoutMs: budgetMs, truncateOutput: false,
        ...(cleanup || !this.signal ? {} : { signal: this.signal }),
      })
      exitCode = output.exitCode
      const result = decodeWechatResponse(output.stdout, exitCode, tool, this.project.driver.clientName)
      if (tool !== "check_wechatide_status" && !(tool === "automation_element_action" && args[args.indexOf("--action") + 1] === "text")) {
        if (record(result).success !== true) throw new WechatDriverError("WeChat driver did not establish action success", undefined, "action-unconfirmed")
      }
      return result
    } catch (error) {
      this.diagnostics.push({ phase, tool, code: error instanceof WechatDriverError ? error.failureCode : "command-failed", elapsedMs: Math.max(0, Math.round(performance.now() - start)), budgetMs, exitCode })
      if (error instanceof WechatDriverError || hasIncompleteCleanup(error) || this.signal?.aborted) throw error
      throw new WechatDriverError("WeChat command unavailable", undefined, "command-failed")
    }
  }
  async ready(): Promise<void> {
    const status = record(await this.call("check_wechatide_status", ["--skill-version", this.project.driver.skillVersion]))
    if (status.loginExpired !== false || status.tokenRequired !== false || status.skillVersion !== this.project.driver.skillVersion || status.versionRelation !== "equal") throw new WechatDriverError("WeChat DevTools login, token or driver version is not ready")
  }
}
