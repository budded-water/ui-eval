import { execFile } from "node:child_process"

export interface OwnedProcess {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
}

function target(child: OwnedProcess): number | undefined {
  if (child.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid <= 0) return undefined
  return process.platform === "win32" ? child.pid : -child.pid
}

function code(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected
}

/** Only use with a process spawned in its own group (detached on POSIX). */
export const ownedProcessTree = {
  async isAlive(child: OwnedProcess): Promise<boolean> {
    const pid = target(child)
    if (pid === undefined) return child.exitCode === null && child.signalCode === null
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (code(error, "ESRCH")) return false
      if (code(error, "EPERM")) return true
      throw error
    }
  },
  async signal(child: OwnedProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const pid = target(child)
    if (process.platform === "win32" && pid !== undefined) {
      await new Promise<void>((resolve, reject) => {
        execFile("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
          { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL" },
          (error) => error ? reject(error) : resolve())
      })
    } else if (pid !== undefined) {
      process.kill(pid, signal)
    } else if (!child.kill(signal)) {
      throw new Error(`Could not deliver ${signal} to the owned process`)
    }
  },
}

export async function stopOwnedProcess(child: OwnedProcess, timeoutMs = 1_000): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await ownedProcessTree.isAlive(child))) return
    try {
      await ownedProcessTree.signal(child, signal)
    } catch (error) {
      if (!(await ownedProcessTree.isAlive(child))) return
      if (signal === "SIGKILL") throw error
    }
    const deadline = Date.now() + timeoutMs
    while (await ownedProcessTree.isAlive(child)) {
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
    }
  }
  if (await ownedProcessTree.isAlive(child)) throw new Error("Owned process cleanup did not settle")
}
