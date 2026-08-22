import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

import {
  ensureDevServer,
  type DevServerChildProcess,
  type DevServerConfig,
  type DevServerFetch,
  type DevServerProcessTree,
  type DevServerSpawn,
} from "./dev-server"

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = []
  readonly stderr = new EventEmitter()

  constructor(readonly pid?: number) {
    super()
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal)
    queueMicrotask(() => this.exit(null, signal as NodeJS.Signals | null))
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }
}

const config: DevServerConfig = {
  command: "bun",
  args: ["run", "dev"],
  url: "http://127.0.0.1:3000",
  reuseExisting: true,
  readiness: {
    path: "/__ui_eval_health",
    bodyIncludes: "ui-eval-project:test",
  },
  startupTimeoutMs: 100,
}

const response = (
  status: number,
  body = "ui-eval-project:test",
): Awaited<ReturnType<DevServerFetch>> => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
})

const childResult = (child: FakeChild): DevServerChildProcess =>
  child as unknown as DevServerChildProcess

describe("ensureDevServer", () => {
  it("rejects a pre-aborted startup without probing or spawning", async () => {
    const controller = new AbortController()
    controller.abort(new Error("interrupted"))
    const fetchImpl = vi.fn<DevServerFetch>()
    const spawnImpl = vi.fn<DevServerSpawn>()

    await expect(
      ensureDevServer(config, {
        projectRoot: "/workspace/project",
        signal: controller.signal,
        fetchImpl,
        spawnImpl,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it("cancels an in-flight initial probe even when fetch ignores its signal", async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<DevServerFetch>(() => new Promise(() => {}))
    const spawnImpl = vi.fn<DevServerSpawn>()
    const pending = ensureDevServer(config, {
      projectRoot: "/workspace/project",
      signal: controller.signal,
      fetchImpl,
      spawnImpl,
    })

    controller.abort(new Error("interrupted"))

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it("cancels an in-flight readiness body read", async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<DevServerFetch>(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
    }))
    const spawnImpl = vi.fn<DevServerSpawn>()
    const pending = ensureDevServer(config, {
      projectRoot: "/workspace/project",
      signal: controller.signal,
      fetchImpl,
      spawnImpl,
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())

    controller.abort(new Error("interrupted"))

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it("reuses an existing healthy server and never owns or stops it", async () => {
    const fetchImpl = vi.fn<DevServerFetch>(async () => response(200))
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      throw new Error("must not spawn")
    })
    const onProgress = vi.fn()

    const server = await ensureDevServer(config, {
      projectRoot: "/workspace/project",
      fetchImpl,
      spawnImpl,
      onProgress,
    })

    expect(server).toMatchObject({ url: config.url, reused: true })
    expect(spawnImpl).not.toHaveBeenCalled()
    await server.stop()
    await server.stop()
    expect(onProgress.mock.calls.map(([event]) => event.type)).toEqual([
      "probing",
      "reused",
    ])
  })

  it("spawns the exact command without a shell and waits for health", async () => {
    const child = new FakeChild()
    let probe = 0
    const fetchImpl = vi.fn<DevServerFetch>(async () => {
      probe += 1
      if (probe === 1) throw new Error("connection refused")
      return response(probe === 2 ? 503 : 307)
    })
    const spawnImpl = vi.fn<DevServerSpawn>(() => childResult(child))

    const serverPromise = ensureDevServer(config, {
      projectRoot: "/workspace/project",
      fetchImpl,
      spawnImpl,
    })
    const server = await serverPromise

    expect(server).toMatchObject({ url: config.url, reused: false })
    expect(spawnImpl).toHaveBeenCalledExactlyOnceWith(
      "bun",
      ["run", "dev"],
      {
        cwd: "/workspace/project",
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    )
  })

  it("delivers TERM synchronously from abort and keeps later stop idempotent", async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")
    const child = new FakeChild(42_424)
    let alive = true
    const signals: string[] = []
    const processTree: DevServerProcessTree = {
      isAlive: async () => alive,
      signal: (_child, signal) => {
        signals.push(signal)
        alive = false
        return Promise.resolve()
      },
    }
    let probe = 0
    const server = await ensureDevServer(config, {
      projectRoot: "/workspace/project",
      signal: controller.signal,
      fetchImpl: async () => {
        probe += 1
        if (probe === 1) throw new Error("connection refused")
        return response(200)
      },
      spawnImpl: () => childResult(child),
      processTree,
    })

    controller.abort(new Error("SIGINT"))

    // No microtask/await boundary: the owned process group has already
    // received TERM before AbortController.abort() returns.
    expect(signals).toEqual(["SIGTERM"])
    await Promise.all([server.stop(), server.stop()])
    expect(signals).toEqual(["SIGTERM"])
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    )
  })

  it("stops an owned child before reporting cancellation during startup", async () => {
    const controller = new AbortController()
    const child = new FakeChild()
    let probe = 0
    const fetchImpl = vi.fn<DevServerFetch>(() => {
      probe += 1
      if (probe === 1) return Promise.reject(new Error("connection refused"))
      return new Promise(() => {})
    })
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      queueMicrotask(() => controller.abort(new Error("interrupted")))
      return childResult(child)
    })

    await expect(
      ensureDevServer(config, {
        projectRoot: "/workspace/project",
        signal: controller.signal,
        fetchImpl,
        spawnImpl,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
    expect(child.killCalls).toEqual(["SIGTERM"])
  })

  it("never owns or signals a reused server when cancellation happens later", async () => {
    const controller = new AbortController()
    const spawnImpl = vi.fn<DevServerSpawn>()
    const server = await ensureDevServer(config, {
      projectRoot: "/workspace/project",
      signal: controller.signal,
      fetchImpl: async () => response(200),
      spawnImpl,
    })

    controller.abort(new Error("interrupted after reuse"))
    await server.stop()

    expect(server.reused).toBe(true)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it("refuses an occupied port when reuseExisting is false", async () => {
    const fetchImpl = vi.fn<DevServerFetch>(async () => response(200))
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      throw new Error("must not spawn")
    })

    await expect(ensureDevServer(
      { ...config, reuseExisting: false },
      {
        projectRoot: "/workspace/project",
        fetchImpl,
        spawnImpl,
      },
    )).rejects.toMatchObject({ code: "PORT_OCCUPIED" })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it("refuses reuse when the responding server has the wrong identity", async () => {
    const fetchImpl = vi.fn<DevServerFetch>(async () =>
      response(200, "ui-eval-project:someone-else"),
    )
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      throw new Error("must not spawn")
    })

    await expect(
      ensureDevServer(config, {
        projectRoot: "/workspace/project",
        fetchImpl,
        spawnImpl,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it("terminates its child and returns a structured startup timeout", async () => {
    const child = new FakeChild()
    const fetchImpl = vi.fn<DevServerFetch>(async () => {
      throw new Error("connection refused")
    })
    const spawnImpl = vi.fn<DevServerSpawn>(() => childResult(child))

    await expect(
      ensureDevServer(
        { ...config, startupTimeoutMs: 5 },
        {
          projectRoot: "/workspace/project",
          fetchImpl,
          spawnImpl,
        },
      ),
    ).rejects.toMatchObject({
      name: "DevServerError",
      code: "STARTUP_TIMEOUT",
      url: config.url,
      command: config.command,
      args: config.args,
    })
    expect(child.killCalls).toEqual(["SIGTERM"])
  })

  it("surfaces an early child exit instead of waiting for the timeout", async () => {
    const child = new FakeChild()
    let probe = 0
    const fetchImpl = vi.fn<DevServerFetch>(async () => {
      probe += 1
      if (probe === 1) throw new Error("connection refused")
      return new Promise(() => {})
    })
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      queueMicrotask(() => child.exit(17))
      return childResult(child)
    })

    await expect(
      ensureDevServer(config, {
        projectRoot: "/workspace/project",
        fetchImpl,
        spawnImpl,
      }),
    ).rejects.toMatchObject({
      code: "PROCESS_EXITED",
      exitCode: 17,
    })
    expect(child.killCalls).toEqual([])
  })

  it("withholds raw child stderr from progress and structured errors", async () => {
    const child = new FakeChild()
    const sentinel = "server-secret-token-4111111111111111"
    let probe = 0
    const fetchImpl = vi.fn<DevServerFetch>(async () => {
      probe += 1
      if (probe === 1) throw new Error("connection refused")
      return new Promise(() => {})
    })
    const onProgress = vi.fn()
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", sentinel)
        child.exit(17)
      })
      return childResult(child)
    })

    let caught: unknown
    try {
      await ensureDevServer(config, {
        projectRoot: "/workspace/project",
        fetchImpl,
        spawnImpl,
        onProgress,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: "PROCESS_EXITED",
      stderr: expect.stringContaining("withheld"),
    })
    expect(JSON.stringify(caught)).not.toContain(sentinel)
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(sentinel)
  })

  it("preserves an asynchronous spawn error when no process tree was created", async () => {
    const child = new FakeChild()
    let probe = 0
    const fetchImpl = vi.fn<DevServerFetch>(async () => {
      probe += 1
      if (probe === 1) throw new Error("connection refused")
      return new Promise(() => {})
    })
    const spawnImpl = vi.fn<DevServerSpawn>(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")))
      return childResult(child)
    })

    await expect(
      ensureDevServer(config, {
        projectRoot: "/workspace/project",
        fetchImpl,
        spawnImpl,
      }),
    ).rejects.toMatchObject({
      code: "SPAWN_FAILED",
    })
    expect(child.killCalls).toEqual([])
  })

  it("stops a spawned process once even when stop is called repeatedly", async () => {
    const child = new FakeChild()
    let probe = 0
    const fetchImpl = vi.fn<DevServerFetch>(async () => {
      probe += 1
      if (probe === 1) throw new Error("connection refused")
      return response(200)
    })
    const spawnImpl = vi.fn<DevServerSpawn>(() => childResult(child))

    const server = await ensureDevServer(config, {
      projectRoot: "/workspace/project",
      fetchImpl,
      spawnImpl,
    })
    await server.stop()
    await server.stop()

    expect(child.killCalls).toEqual(["SIGTERM"])
  })

  it("escalates from TERM to KILL when the owned process tree stays alive", async () => {
    const child = new FakeChild()
    let alive = true
    const signals: string[] = []
    const processTree: DevServerProcessTree = {
      isAlive: async () => alive,
      signal: async (_child, signal) => {
        signals.push(signal)
        if (signal === "SIGKILL") alive = false
      },
    }
    let probe = 0
    const server = await ensureDevServer(config, {
      projectRoot: "/workspace/project",
      fetchImpl: async () => {
        probe += 1
        if (probe === 1) throw new Error("connection refused")
        return response(200)
      },
      spawnImpl: () => childResult(child),
      processTree,
      stopTimeoutMs: 1,
    })

    await server.stop()

    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  it("rejects stop when the process tree remains alive after KILL", async () => {
    const child = new FakeChild()
    const signals: string[] = []
    const processTree: DevServerProcessTree = {
      isAlive: async () => true,
      signal: async (_child, signal) => {
        signals.push(signal)
      },
    }
    let probe = 0
    const server = await ensureDevServer(config, {
      projectRoot: "/workspace/project",
      fetchImpl: async () => {
        probe += 1
        if (probe === 1) throw new Error("connection refused")
        return response(200)
      },
      spawnImpl: () => childResult(child),
      processTree,
      stopTimeoutMs: 1,
    })

    await expect(server.stop()).rejects.toMatchObject({ code: "STOP_FAILED" })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  it.skipIf(process.platform === "win32")(
    "signals and verifies the detached POSIX process group",
    async () => {
      const child = new FakeChild(424_242)
      let alive = true
      const killSpy = vi.spyOn(process, "kill").mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          expect(pid).toBe(-424_242)
          if (signal === 0) {
            if (alive) return true
            throw Object.assign(new Error("process group is gone"), {
              code: "ESRCH",
            })
          }
          if (signal === "SIGKILL") alive = false
          return true
        }) as typeof process.kill,
      )
      let probe = 0

      try {
        const server = await ensureDevServer(config, {
          projectRoot: "/workspace/project",
          fetchImpl: async () => {
            probe += 1
            if (probe === 1) throw new Error("connection refused")
            return response(200)
          },
          spawnImpl: () => childResult(child),
          stopTimeoutMs: 1,
        })

        await server.stop()

        expect(killSpy).toHaveBeenCalledWith(-424_242, "SIGTERM")
        expect(killSpy).toHaveBeenCalledWith(-424_242, "SIGKILL")
      } finally {
        killSpy.mockRestore()
      }
    },
  )
})
