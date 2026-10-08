import { describe, expect, it, vi } from "vitest"

import type { EvaluateScenarioResult } from "../orchestrator/evaluate"
import {
  runCli,
  runCliProcess,
  type CliIo,
  type CliSignal,
  type CliSignalRuntime,
} from "./main"

function output() {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIo = {
    cwd: "/project",
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  }
  return { io, stdout, stderr }
}

function result(
  executionOutcome: "valid" | "invalid-evidence" | "infra-error",
  rawStatus: "pass" | "fail" | "needs-review" | "inconclusive",
): EvaluateScenarioResult {
  return {
    projectId: "project",
    scenarioId: "terms-desktop",
    runs: [
      {
        executionId: "run-1",
        variantKey: "desktop",
        executionOutcome,
        rawStatus,
        reportPath: "/project/.ui-eval/runs/run-1/report.json",
        htmlPath: "/project/.ui-eval/runs/run-1/report.html",
        report: {} as EvaluateScenarioResult["runs"][number]["report"],
      },
    ],
  }
}

function fakeSignalRuntime() {
  const listeners = new Map<CliSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ])
  const forcedExitCodes: number[] = []
  const scheduled: Array<{
    callback: () => void
    timeoutMs: number
    cancelled: boolean
  }> = []
  const runtime: CliSignalRuntime = {
    addSignalListener: (signal, listener) => listeners.get(signal)!.add(listener),
    removeSignalListener: (signal, listener) =>
      listeners.get(signal)!.delete(listener),
    forceExit: (code) => {
      forcedExitCodes.push(code)
    },
    schedule: (callback, timeoutMs) => {
      const task = { callback, timeoutMs, cancelled: false }
      scheduled.push(task)
      return () => {
        task.cancelled = true
      }
    },
  }
  return {
    runtime,
    forcedExitCodes,
    scheduled,
    emit(signal: CliSignal) {
      for (const listener of [...listeners.get(signal)!]) listener()
    },
    listenerCount(signal: CliSignal) {
      return listeners.get(signal)!.size
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe("runCli", () => {
  it.each(["native-pilot", "wechat-pilot"] as const)("routes %s to its own argument validator", async (command) => {
    const stream = output()
    const args = [command, "unsupported", "--format", "json"]
    if (command === "native-pilot") args.push("--device", "test-device")
    expect(await runCli(args, stream.io)).toBe(2)
    expect(JSON.parse(stream.stdout.join(""))).toMatchObject({
      error: { message: expect.stringContaining(`Usage: ${command}`) },
    })
    expect(stream.stderr).toEqual([])
  })

  it("forwards an execution profile to evaluation without changing stdout or exit semantics", async () => {
    const stream = output()
    const evaluate = vi.fn(async () => result("infra-error", "inconclusive"))
    expect(await runCli(["evaluate", "terms-desktop", "--execution-profile", "preview", "--format", "json"], stream.io, { evaluate })).toBe(2)
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ executionProfile: "preview" }))
    expect(JSON.parse(stream.stdout.join(""))).toEqual(result("infra-error", "inconclusive"))
  })
  it("forwards profile, additional scope and full-scope fallback to the Agent", async () => {
    const stream = output()
    const agent = vi.fn(async () => { throw new Error("sentinel") })
    await runCli(["agent", "smoke", "--execution-profile", "local", "--additional-scenario", "details", "--additional-scenario", "mobile", "--full-scope"], stream.io, { agent })
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ executionProfile: "local", additionalScenarios: ["details", "mobile"], fullScope: true }))
  })
  it("forwards profiles to doctor", async () => {
    const stream = output()
    const doctor = vi.fn(async () => ({ ok: true, checks: [] }))
    expect(await runCli(["doctor", "--execution-profile", "preview"], stream.io, { doctor })).toBe(0)
    expect(doctor).toHaveBeenCalledWith(expect.objectContaining({ executionProfile: "preview" }))
  })
  it("documents the installed ui-eval binary without a package-manager wrapper", async () => {
    const stream = output()

    expect(await runCli(["--help"], stream.io)).toBe(0)
    expect(stream.stdout.join("")).toContain("ui-eval evaluate <scenario>")
    expect(stream.stdout.join("")).not.toContain("bun run")
  })

  it("requires an explicit --yes before init mutates project files", async () => {
    const stream = output()
    const init = vi.fn(async () => ({
      created: [],
      updated: [],
      skipped: [],
    }))

    const rejected = await runCli(
      ["init", "--route", "/terms", "--scenario", "terms-desktop"],
      stream.io,
      { init },
    )
    expect(rejected).toBe(2)
    expect(init).not.toHaveBeenCalled()
    expect(stream.stderr.join("")).toContain("--yes")

    const accepted = await runCli(
      [
        "init",
        "--route",
        "/terms",
        "--scenario",
        "terms-desktop",
        "--yes",
      ],
      output().io,
      { init },
    )
    expect(accepted).toBe(0)
    expect(init).toHaveBeenCalledOnce()
  })

  it("keeps JSON stdout clean while progress goes to stderr", async () => {
    const stream = output()
    const evaluate = vi.fn(async (options) => {
      options.onProgress?.("capturing")
      return result("valid", "pass")
    })

    const code = await runCli(
      ["evaluate", "terms-desktop", "--format", "json"],
      stream.io,
      { evaluate },
    )

    expect(code).toBe(0)
    expect(() => JSON.parse(stream.stdout.join(""))).not.toThrow()
    expect(stream.stdout.join("")).not.toContain("capturing")
    expect(stream.stderr.join("")).toContain("capturing")
  })

  it("runs an agent suite with repair opt-in and keeps JSON stdout machine-readable", async () => {
    const stream = output()
    const agent = vi.fn(async (options) => {
      options.onProgress?.("iteration 1")
      return {
        suiteId: "rentals",
        status: "accepted" as const,
        accepted: true,
        iterations: [],
        summaryPath: "/project/.ui-eval/agent-runs/run/summary.json",
        summaryHtmlPath: "/project/.ui-eval/agent-runs/run/summary.html",
        generatedAt: "2026-08-24T00:00:00.000Z",
        reason: "all gates passed",
      }
    })

    const code = await runCli(
      ["agent", "rentals", "--repair", "--format", "json"],
      stream.io,
      { agent },
    )

    expect(code).toBe(0)
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/project",
        suite: "rentals",
        repair: true,
      }),
    )
    expect(JSON.parse(stream.stdout.join(""))).toMatchObject({
      suiteId: "rentals",
      accepted: true,
      summaryHtmlPath: "/project/.ui-eval/agent-runs/run/summary.html",
    })
    expect(stream.stderr.join("")).toContain("iteration 1")
  })

  it.each([
    ["valid", "fail", 1],
    ["infra-error", "inconclusive", 2],
    ["valid", "needs-review", 3],
  ] as const)("maps %s/%s to exit %s", async (executionOutcome, rawStatus, exit) => {
    const stream = output()
    const code = await runCli(["evaluate", "terms-desktop"], stream.io, {
      evaluate: async () => result(executionOutcome, rawStatus),
    })
    expect(code).toBe(exit)
  })

  it("returns a JSON error envelope for agent callers", async () => {
    const stream = output()
    const code = await runCli(
      ["evaluate", "--format", "json"],
      stream.io,
    )

    expect(code).toBe(2)
    expect(JSON.parse(stream.stdout.join(""))).toMatchObject({
      error: { message: expect.stringContaining("scenario") },
    })
    expect(stream.stderr).toEqual([])
  })

  it("maps a failed doctor result to exit 2 without contaminating JSON", async () => {
    const stream = output()
    const code = await runCli(["doctor", "--format", "json"], stream.io, {
      doctor: async () => ({
        ok: false,
        checks: [
          {
            id: "dev-server",
            status: "fail",
            message: "port occupied",
          },
        ],
      }),
    })

    expect(code).toBe(2)
    expect(JSON.parse(stream.stdout.join(""))).toMatchObject({ ok: false })
    expect(stream.stderr).toEqual([])
  })

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "cooperatively handles %s, passes its signal, and keeps JSON stdout valid",
    async (signalName, expectedCode) => {
      const stream = output()
      const signals = fakeSignalRuntime()
      let receivedSignal: AbortSignal | undefined
      const evaluate = vi.fn(async (options) => {
        receivedSignal = (options as typeof options & { signal: AbortSignal }).signal
        await new Promise<void>((resolve) => {
          receivedSignal!.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
        if (signalName === "SIGTERM") {
          throw Object.assign(new Error("dev server startup aborted"), {
            code: "ABORTED",
          })
        }
        return result("valid", "pass")
      })

      const pending = runCliProcess(
        ["evaluate", "terms-desktop", "--format", "json"],
        stream.io,
        { evaluate },
        { cleanupTimeoutMs: 77, runtime: signals.runtime },
      )
      await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())

      signals.emit(signalName)
      const code = await pending

      expect(code).toBe(expectedCode)
      expect(receivedSignal?.aborted).toBe(true)
      expect(signals.scheduled).toEqual([
        expect.objectContaining({ timeoutMs: 77, cancelled: true }),
      ])
      expect(signals.forcedExitCodes).toEqual([])
      expect(signals.listenerCount("SIGINT")).toBe(0)
      expect(signals.listenerCount("SIGTERM")).toBe(0)
      expect(JSON.parse(stream.stdout.join(""))).toMatchObject({
        error: { code: "INTERRUPTED", signal: signalName },
      })
      expect(stream.stderr.join("")).toContain(signalName)
    },
  )

  it("forces the first signal exit code when a second signal arrives", async () => {
    const stream = output()
    const signals = fakeSignalRuntime()
    const completion = deferred<EvaluateScenarioResult>()
    const evaluate = vi.fn(() => completion.promise)
    const pending = runCliProcess(
      ["evaluate", "terms-desktop"],
      stream.io,
      { evaluate },
      { runtime: signals.runtime },
    )
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())

    signals.emit("SIGINT")
    signals.emit("SIGTERM")

    expect(signals.forcedExitCodes).toEqual([130])
    completion.resolve(result("valid", "pass"))
    await expect(pending).resolves.toBe(130)
  })

  it("forces exit when the bounded cleanup deadline expires", async () => {
    const stream = output()
    const signals = fakeSignalRuntime()
    const completion = deferred<EvaluateScenarioResult>()
    const pending = runCliProcess(
      ["evaluate", "terms-desktop"],
      stream.io,
      { evaluate: () => completion.promise },
      { cleanupTimeoutMs: 25, runtime: signals.runtime },
    )
    await vi.waitFor(() => expect(signals.listenerCount("SIGINT")).toBe(1))

    signals.emit("SIGTERM")
    expect(signals.scheduled[0]?.timeoutMs).toBe(25)
    signals.scheduled[0]?.callback()
    expect(signals.forcedExitCodes).toEqual([143])

    completion.resolve(result("valid", "pass"))
    await expect(pending).resolves.toBe(143)
  })
})
