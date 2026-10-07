import { runCommand, type CommandOptions, type CommandResult } from "../runtime/command"
import type { WechatPilotProject } from "./config"

export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>
export class WechatDriverError extends Error {
  constructor(message: string, readonly pendingTaskId?: string) { super(message); this.name = "WechatDriverError" }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WechatDriverError("Invalid WeChat driver evidence")
  return value as Record<string, unknown>
}
/** Only an exact, successful envelope for the requested tool/client is usable. */
export function decodeWechatResponse(stdout: string, exitCode: number | null, tool: string, client: string): unknown {
  if (exitCode !== 0) throw new WechatDriverError("WeChat driver command failed or timed out")
  const payload = record(JSON.parse(stdout))
  if (payload.ok !== true || payload.tool !== tool || payload.clientName !== client) throw new WechatDriverError("WeChat driver response is not bound to the requested command")
  if (!Object.hasOwn(payload, "result")) throw new WechatDriverError("Missing WeChat driver result")
  const result = payload.result
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const metadata = record(result)
    if (metadata.status === "pending") throw new WechatDriverError("WeChat DevTools requires user authorization or confirmation", typeof metadata.taskId === "string" ? metadata.taskId : undefined)
    if (metadata.success === false) throw new WechatDriverError("WeChat driver did not establish success")
  }
  return result
}
export class WechatDriver {
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
    if (remaining <= 0) throw new WechatDriverError("WeChat pilot deadline exceeded")
    const output = await this.command(this.binary, ["-c", this.project.driver.clientName, tool, ...args], {
      cwd: this.root, timeoutMs: Math.min(remaining, 30000), truncateOutput: false,
      ...(cleanup || !this.signal ? {} : { signal: this.signal }),
    })
    const result = decodeWechatResponse(output.stdout, output.exitCode, tool, this.project.driver.clientName)
    if (tool !== "check_wechatide_status" && !(tool === "automation_element_action" && args[args.indexOf("--action") + 1] === "text")) {
      if (record(result).success !== true) throw new WechatDriverError("WeChat driver did not establish action success")
    }
    return result
  }
  async ready(): Promise<void> {
    const status = record(await this.call("check_wechatide_status", ["--skill-version", this.project.driver.skillVersion]))
    if (status.loginExpired !== false || status.tokenRequired !== false || status.skillVersion !== this.project.driver.skillVersion || status.versionRelation !== "equal") throw new WechatDriverError("WeChat DevTools login, token or driver version is not ready")
  }
}
