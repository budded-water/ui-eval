import { spawn } from "node:child_process"
import { stopOwnedProcess } from "./owned-process"

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd: string
  timeoutMs: number
  input?: string
  signal?: AbortSignal
  truncateOutput?: boolean
  /** Test seam; each production shutdown phase is bounded to one second. */
  stopTimeoutMs?: number
}

const OUTPUT_LIMIT = 24_000
const METADATA_LIMIT = 4 * 1024 * 1024

/** Executes trusted argv, bounds retained output, and cleans only owned processes. */
export async function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let truncatedStdout = false
    let truncatedStderr = false
    let timedOut = false
    let finishing = false
    let failure: unknown
    let stopping: Promise<void> | undefined
    const cleanup = () => stopping ??= child.pid === undefined
      ? Promise.resolve()
      : stopOwnedProcess(child, options.stopTimeoutMs)
    const finish = async (exitCode: number | null) => {
      if (finishing) return
      finishing = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", aborted)
      try {
        await cleanup()
        if (failure) throw failure
        options.signal?.throwIfAborted()
        resolve({
          exitCode: timedOut ? null : exitCode,
          stdout: stdout + (truncatedStdout ? "\n[output truncated]" : ""),
          stderr: stderr + (truncatedStderr ? "\n[output truncated]" : ""),
        })
      } catch (error) {
        reject(error)
      } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
    }
    const stop = () => { void cleanup().then(() => finish(null), (error) => { failure = error; void finish(null) }) }
    const aborted = () => stop()
    const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
    options.signal?.addEventListener("abort", aborted, { once: true })
    const append = (stream: "stdout" | "stderr", chunk: string) => {
      const current = stream === "stdout" ? stdout : stderr
      const limit = options.truncateOutput === false ? METADATA_LIMIT : OUTPUT_LIMIT
      const overflow = current.length + chunk.length > limit
      const retained = current + chunk.slice(0, Math.max(0, limit - current.length))
      if (stream === "stdout") { stdout = retained; truncatedStdout ||= overflow }
      else { stderr = retained; truncatedStderr ||= overflow }
      if (overflow && options.truncateOutput === false && failure === undefined) {
        failure = new Error("Command metadata exceeded its retained output limit")
        stop()
      }
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => append("stdout", chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => append("stderr", chunk))
    child.once("error", (error) => { failure = error; void finish(null) })
    child.once("close", (exitCode) => { void finish(exitCode) })
    child.stdin.on("error", (error) => {
      if ("code" in error && error.code === "EPIPE") return
      failure = error
      stop()
    })
    child.stdin.end(options.input)
    if (options.signal?.aborted) stop()
  })
}
