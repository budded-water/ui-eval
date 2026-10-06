import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { runCommand } from "./command"

describe("owned argv commands", () => {
  it("fails oversized metadata rather than returning a truncated success", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)); setInterval(() => {}, 10)"], {
      cwd: process.cwd(), timeoutMs: 5000, truncateOutput: false, stopTimeoutMs: 100,
    })).rejects.toThrow("metadata exceeded")
  })

  it("bounds retained output without interpreting shell syntax", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(50000)); console.error(process.argv[1])", "$(not-a-shell)"], {
      cwd: process.cwd(), timeoutMs: 5_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toHaveLength(24_000 + "\n[output truncated]".length)
    expect(result.stderr).toContain("$(not-a-shell)")
  })

  it("force-stops a command that ignores graceful termination", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 10)"], {
      cwd: process.cwd(), timeoutMs: 300, stopTimeoutMs: 100,
    })
    expect(result.exitCode).toBeNull()
  })

  it("does not treat a timed-out command's zero exit as success", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 10)"], {
      cwd: process.cwd(), timeoutMs: 300, stopTimeoutMs: 100,
    })
    expect(result.exitCode).toBeNull()
  })

  it("propagates cancellation after cleanup", async () => {
    const controller = new AbortController()
    const operation = runCommand(process.execPath, ["-e", "setInterval(() => {}, 10)"], {
      cwd: process.cwd(), timeoutMs: 5_000, signal: controller.signal, stopTimeoutMs: 100,
    })
    controller.abort(new Error("review cancellation"))
    await expect(operation).rejects.toThrow("review cancellation")
  })

  it("leaves a separately owned process alive during timeout cleanup", async () => {
    const unrelated = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 10)"], {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"],
    })
    try {
      await once(unrelated.stdout!, "data")
      await runCommand(process.execPath, ["-e", "setInterval(() => {}, 10)"], { cwd: process.cwd(), timeoutMs: 300, stopTimeoutMs: 100 })
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.signalCode).toBeNull()
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    } finally {
      const closed = once(unrelated, "close")
      unrelated.kill("SIGKILL")
      await closed
    }
  })
})
