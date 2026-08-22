import { execFile, spawn } from "node:child_process"

import type { ProjectConfig } from "../project/config"

export type DevServerConfig = ProjectConfig["devServer"]

export type DevServerProgressType =
  | "probing"
  | "reused"
  | "starting"
  | "waiting"
  | "ready"
  | "stderr"
  | "stopping"

export interface DevServerProgress {
  type: DevServerProgressType
  message: string
  url: string
  attempt?: number
}

export interface DevServerHandle {
  url: string
  reused: boolean
  stop(): Promise<void>
}

export interface DevServerChildProcess {
  readonly pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stderr?: {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown
  } | null
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface DevServerSpawnOptions {
  cwd: string
  shell: false
  stdio: ["ignore", "ignore", "pipe"]
  windowsHide: true
  detached: boolean
}

export type DevServerSpawn = (
  command: string,
  args: readonly string[],
  options: DevServerSpawnOptions,
) => DevServerChildProcess

export interface DevServerProcessTree {
  isAlive(child: DevServerChildProcess): Promise<boolean>
  signal(
    child: DevServerChildProcess,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<void>
}

export type DevServerFetch = (
  url: string,
  init: { method: "GET"; redirect: "manual"; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface EnsureDevServerOptions {
  projectRoot: string
  /** Cancels startup. An owned process is stopped before ABORTED is reported. */
  signal?: AbortSignal
  onProgress?: (progress: DevServerProgress) => void
  fetchImpl?: DevServerFetch
  spawnImpl?: DevServerSpawn
  processTree?: DevServerProcessTree
  /** Test seam; production uses the fixed bounded shutdown timeout. */
  stopTimeoutMs?: number
}

export type DevServerErrorCode =
  | "INVALID_CONFIG"
  | "ABORTED"
  | "PORT_OCCUPIED"
  | "IDENTITY_MISMATCH"
  | "SPAWN_FAILED"
  | "PROCESS_EXITED"
  | "STARTUP_TIMEOUT"
  | "STOP_FAILED"

export class DevServerError extends Error {
  readonly code: DevServerErrorCode
  readonly url: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stderr?: string

  constructor(options: {
    code: DevServerErrorCode
    message: string
    url: string
    command?: string
    args?: readonly string[]
    exitCode?: number | null
    signal?: NodeJS.Signals | null
    stderr?: string
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = "DevServerError"
    this.code = options.code
    this.url = options.url
    this.command = options.command
    this.args = options.args
    this.exitCode = options.exitCode
    this.signal = options.signal
    this.stderr = options.stderr
  }
}

interface ProcessFailure {
  type: "error" | "exit"
  error?: Error
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

interface ProbeResult {
  reachable: boolean
  healthy: boolean
  status?: number
}

const POLL_INTERVAL_MS = 25
const MAX_PROBE_TIMEOUT_MS = 1_000
const STOP_TIMEOUT_MS = 5_000
const WITHHELD_SERVER_STDERR =
  "Candidate dev server emitted stderr; raw output was withheld."

const defaultFetch: DevServerFetch = async (url, init) => fetch(url, init)
const defaultSpawn: DevServerSpawn = (command, args, options) =>
  spawn(command, [...args], options) as unknown as DevServerChildProcess

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  )
}

function usablePid(child: DevServerChildProcess): number | undefined {
  return Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0
    ? child.pid
    : undefined
}

function processTarget(child: DevServerChildProcess): number | undefined {
  const pid = usablePid(child)
  if (pid === undefined) return undefined
  return process.platform === "win32" ? pid : -pid
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true, timeout: STOP_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
  })
}

const defaultProcessTree: DevServerProcessTree = {
  async isAlive(child) {
    const target = processTarget(child)
    if (target === undefined) {
      return child.exitCode === null && child.signalCode === null
    }
    try {
      process.kill(target, 0)
      return true
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) return false
      if (hasErrorCode(error, "EPERM")) return true
      throw error
    }
  },
  async signal(child, signal) {
    const pid = usablePid(child)
    if (process.platform === "win32" && pid !== undefined) {
      await runTaskkill(pid, signal === "SIGKILL")
      return
    }
    const target = processTarget(child)
    if (target !== undefined) {
      process.kill(target, signal)
      return
    }
    if (!child.kill(signal)) {
      throw new Error(`Could not deliver ${signal} to the owned dev server`)
    }
  },
}

function emitProgress(
  callback: EnsureDevServerOptions["onProgress"],
  progress: DevServerProgress,
): void {
  try {
    callback?.(progress)
  } catch {
    // Diagnostic callbacks must not change process ownership or lifecycle.
  }
}

function validateConfig(config: DevServerConfig, projectRoot: string): void {
  if (
    config.command.length === 0 ||
    config.url.length === 0 ||
    projectRoot.length === 0 ||
    !Number.isInteger(config.startupTimeoutMs) ||
    config.startupTimeoutMs <= 0
  ) {
    throw new DevServerError({
      code: "INVALID_CONFIG",
      message: "Dev server command, URL, project root, and positive timeout are required.",
      url: config.url,
      command: config.command,
      args: config.args,
    })
  }
  if (config.reuseExisting && !config.readiness) {
    throw new DevServerError({
      code: "INVALID_CONFIG",
      message:
        "reuseExisting requires a project-specific readiness path and body marker.",
      url: config.url,
      command: config.command,
      args: config.args,
    })
  }
}

function abortedError(
  config: DevServerConfig,
  signal: AbortSignal,
): DevServerError {
  return new DevServerError({
    code: "ABORTED",
    message: "Dev server startup was interrupted.",
    url: config.url,
    command: config.command,
    args: config.args,
    cause: signal.reason,
  })
}

function throwIfAborted(
  config: DevServerConfig,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) throw abortedError(config, signal)
}

function abortRejection(
  config: DevServerConfig,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): { promise: Promise<never>; dispose: () => void } {
  if (!signal) {
    return { promise: new Promise<never>(() => {}), dispose: () => {} }
  }

  let listener: (() => void) | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => {
      onAbort()
      reject(abortedError(config, signal))
    }
    if (signal.aborted) listener()
    else signal.addEventListener("abort", listener, { once: true })
  })
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener("abort", listener)
    },
  }
}

async function probeHealth(
  config: DevServerConfig,
  fetchImpl: DevServerFetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  throwIfAborted(config, signal)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const interruption = abortRejection(config, signal, () => controller.abort())

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("health probe timed out"))
    }, Math.max(1, timeoutMs))
  })

  try {
    const response = await Promise.race([
      fetchImpl(
        new URL(config.readiness?.path ?? "/", config.url).toString(),
        {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        },
      ),
      timeout,
      interruption.promise,
    ])
    let bodyMatches = true
    if (config.readiness) {
      try {
        const body = await Promise.race([
          response.text(),
          timeout,
          interruption.promise,
        ])
        bodyMatches = body.includes(
          config.readiness.bodyIncludes,
        )
      } catch (error) {
        if (signal?.aborted) throw abortedError(config, signal)
        if (error instanceof DevServerError && error.code === "ABORTED") {
          throw error
        }
        return { reachable: true, healthy: false, status: response.status }
      }
    }
    return {
      reachable: true,
      healthy:
        (response.ok ||
          (response.status >= 200 && response.status < 500)) &&
        bodyMatches,
      status: response.status,
    }
  } catch (error) {
    if (signal?.aborted) throw abortedError(config, signal)
    if (error instanceof DevServerError && error.code === "ABORTED") throw error
    return { reachable: false, healthy: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    interruption.dispose()
  }
}

async function abortableDelay(
  config: DevServerConfig,
  delayMs: number,
  signal?: AbortSignal,
): Promise<"delay"> {
  throwIfAborted(config, signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  const interruption = abortRejection(config, signal, () => {
    if (timer !== undefined) clearTimeout(timer)
  })
  try {
    return await Promise.race([
      new Promise<"delay">((resolve) => {
        timer = setTimeout(() => resolve("delay"), delayMs)
      }),
      interruption.promise,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    interruption.dispose()
  }
}

function observeFailure(child: DevServerChildProcess): Promise<ProcessFailure> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (failure: ProcessFailure) => {
      if (settled) return
      settled = true
      resolve(failure)
    }

    child.once("error", (error) => settle({ type: "error", error }))
    child.once("exit", (exitCode, signal) =>
      settle({ type: "exit", exitCode, signal }),
    )

    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(() =>
        settle({
          type: "exit",
          exitCode: child.exitCode,
          signal: child.signalCode,
        }),
      )
    }
  })
}

function createOwnedStop(
  child: DevServerChildProcess,
  url: string,
  onProgress: EnsureDevServerOptions["onProgress"],
  processTree: DevServerProcessTree,
  timeoutMs: number,
): {
  stop: () => Promise<void>
  stopFromAbort: () => Promise<void>
} {
  let stopPromise: Promise<void> | undefined
  let terminationPromise: Promise<void> | undefined
  let stoppingEmitted = false

  const requestTermination = (): void => {
    if (terminationPromise) return
    if (!stoppingEmitted) {
      stoppingEmitted = true
      emitProgress(onProgress, {
        type: "stopping",
        message: "Stopping the dev server started by this evaluation.",
        url,
      })
    }

    // Do not put an await (including an isAlive probe) before this call. The
    // AbortSignal listener uses this path so the process-group SIGTERM is sent
    // in the same synchronous stack as SIGINT/SIGTERM, before a package-runner
    // wrapper has a chance to terminate this Node process.
    try {
      terminationPromise = Promise.resolve(
        processTree.signal(child, "SIGTERM"),
      )
    } catch (error) {
      terminationPromise = Promise.reject(error)
    }
    // Cancellation invokes stop without awaiting it. Attach a rejection
    // observer synchronously; callers still receive the original promise.
    void terminationPromise.catch(() => undefined)
  }

  const beginStop = (eagerTermination: boolean): Promise<void> => {
    if (eagerTermination) requestTermination()
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      const isAlive = async (): Promise<boolean> => {
        try {
          return await processTree.isAlive(child)
        } catch (error) {
          throw new DevServerError({
            code: "STOP_FAILED",
            message: "Could not verify whether the owned dev server stopped.",
            url,
            cause: error,
          })
        }
      }
      const waitUntilStopped = async (): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs
        while (await isAlive()) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) return false
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
          )
        }
        return true
      }

      if (!(await isAlive())) return
      requestTermination()

      let terminationError: unknown
      try {
        await terminationPromise
      } catch (error) {
        terminationError = error
      }
      if (terminationError === undefined && (await waitUntilStopped())) return
      if (terminationError !== undefined && !(await isAlive())) return

      let killError: unknown
      try {
        await processTree.signal(child, "SIGKILL")
      } catch (error) {
        killError = error
      }
      if (killError === undefined && (await waitUntilStopped())) return
      if (killError !== undefined && !(await isAlive())) return

      throw new DevServerError({
        code: "STOP_FAILED",
        message: "Owned dev server remained alive after SIGTERM and SIGKILL.",
        url,
        cause: killError ?? terminationError,
      })
    })()
    return stopPromise
  }

  return {
    stop: () => beginStop(false),
    stopFromAbort: () => beginStop(true),
  }
}

function processFailureError(
  failure: ProcessFailure,
  config: DevServerConfig,
  stderrObserved: boolean,
): DevServerError {
  if (failure.type === "error") {
    return new DevServerError({
      code: "SPAWN_FAILED",
      message: `Dev server process failed before ${config.url} became healthy.`,
      url: config.url,
      command: config.command,
      args: config.args,
      ...(stderrObserved ? { stderr: WITHHELD_SERVER_STDERR } : {}),
      cause: failure.error,
    })
  }

  return new DevServerError({
    code: "PROCESS_EXITED",
    message: `Dev server exited before ${config.url} became healthy.`,
    url: config.url,
    command: config.command,
    args: config.args,
    exitCode: failure.exitCode,
    signal: failure.signal,
    ...(stderrObserved ? { stderr: WITHHELD_SERVER_STDERR } : {}),
  })
}

/**
 * Reuse a healthy configured server when allowed, otherwise start and own one.
 * The returned stop() never signals a server that this function did not spawn.
 */
export async function ensureDevServer(
  config: DevServerConfig,
  options: EnsureDevServerOptions,
): Promise<DevServerHandle> {
  validateConfig(config, options.projectRoot)
  throwIfAborted(config, options.signal)
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const processTree = options.processTree ?? defaultProcessTree
  const stopTimeoutMs = Math.max(1, options.stopTimeoutMs ?? STOP_TIMEOUT_MS)

  emitProgress(options.onProgress, {
    type: "probing",
    message: `Checking ${config.url}.`,
    url: config.url,
  })
  const initialProbe = await probeHealth(
    config,
    fetchImpl,
    Math.min(MAX_PROBE_TIMEOUT_MS, config.startupTimeoutMs),
    options.signal,
  )
  throwIfAborted(config, options.signal)
  if (initialProbe.healthy && config.reuseExisting) {
    emitProgress(options.onProgress, {
      type: "reused",
      message: `Reusing the healthy server at ${config.url}.`,
      url: config.url,
    })
    return {
      url: config.url,
      reused: true,
      stop: async () => {},
    }
  }
  if (initialProbe.reachable) {
    throw new DevServerError({
      code: config.reuseExisting ? "IDENTITY_MISMATCH" : "PORT_OCCUPIED",
      message: config.reuseExisting
        ? `A server is responding at ${config.url}, but it did not prove the configured project identity.`
        : `A server is already responding at ${config.url}; refusing to capture an unowned candidate.`,
      url: config.url,
      command: config.command,
      args: config.args,
    })
  }

  emitProgress(options.onProgress, {
    type: "starting",
    message: `Starting the configured dev server for ${config.url}.`,
    url: config.url,
  })

  let child: DevServerChildProcess
  try {
    throwIfAborted(config, options.signal)
    child = spawnImpl(config.command, config.args, {
      cwd: options.projectRoot,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
  } catch (error) {
    if (options.signal?.aborted) throw abortedError(config, options.signal)
    throw new DevServerError({
      code: "SPAWN_FAILED",
      message: `Could not start dev server command ${config.command}.`,
      url: config.url,
      command: config.command,
      args: config.args,
      cause: error,
    })
  }

  const ownedStop = createOwnedStop(
    child,
    config.url,
    options.onProgress,
    processTree,
    stopTimeoutMs,
  )
  const failure = observeFailure(child)
  let abortListenerInstalled = false
  const removeAbortListener = (): void => {
    if (!abortListenerInstalled || !options.signal) return
    abortListenerInstalled = false
    options.signal.removeEventListener("abort", stopOnAbort)
  }
  const observeStop = (pending: Promise<void>): Promise<void> => {
    // Both branches resolve the observer promise, so a fire-and-forget abort
    // cannot create an unhandled rejection. The original promise is preserved
    // for ensureDevServer/evaluate callers that need the cleanup failure.
    void pending.then(removeAbortListener, removeAbortListener)
    return pending
  }
  const stop = (): Promise<void> => observeStop(ownedStop.stop())
  const stopOnAbort = (): void => {
    void observeStop(ownedStop.stopFromAbort())
  }
  if (options.signal) {
    abortListenerInstalled = true
    options.signal.addEventListener("abort", stopOnAbort, { once: true })
    if (options.signal.aborted) stopOnAbort()
  }
  child.once("exit", removeAbortListener)
  child.once("error", removeAbortListener)

  let stderrObserved = false
  child.stderr?.on("data", () => {
    stderrObserved = true
    emitProgress(options.onProgress, {
      type: "stderr",
      message: WITHHELD_SERVER_STDERR,
      url: config.url,
    })
  })

  const deadline = Date.now() + config.startupTimeoutMs
  let attempt = 0

  try {
    throwIfAborted(config, options.signal)
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        await stop()
        throw new DevServerError({
          code: "STARTUP_TIMEOUT",
          message: `Dev server did not become healthy within ${config.startupTimeoutMs}ms.`,
          url: config.url,
          command: config.command,
          args: config.args,
          ...(stderrObserved ? { stderr: WITHHELD_SERVER_STDERR } : {}),
        })
      }

      attempt += 1
      emitProgress(options.onProgress, {
        type: "waiting",
        message: `Waiting for ${config.url} to become healthy.`,
        url: config.url,
        attempt,
      })
      const result = await Promise.race([
        probeHealth(
          config,
          fetchImpl,
          Math.min(MAX_PROBE_TIMEOUT_MS, remaining),
          options.signal,
        ).then((probe) => ({ type: "probe" as const, probe })),
        failure.then((processFailure) => ({
          type: "failure" as const,
          processFailure,
        })),
      ])

      if (result.type === "failure") {
        // A spawn error without a PID means no process tree was created. Treating
        // the still-null ChildProcess state as alive would mask SPAWN_FAILED with
        // an unrelated cleanup error.
        if (
          result.processFailure.type === "exit" ||
          usablePid(child) !== undefined
        ) {
          await stop()
        }
        throw processFailureError(
          result.processFailure,
          config,
          stderrObserved,
        )
      }
      if (result.probe.healthy) {
        throwIfAborted(config, options.signal)
        emitProgress(options.onProgress, {
          type: "ready",
          message: `Dev server is ready at ${config.url}.`,
          url: config.url,
          attempt,
        })
        return { url: config.url, reused: false, stop }
      }

      const delayMs = Math.min(POLL_INTERVAL_MS, deadline - Date.now())
      if (delayMs <= 0) continue
      const waitResult = await Promise.race([
        abortableDelay(config, delayMs, options.signal),
        failure.then(() => "failure" as const),
      ])
      if (waitResult === "failure") {
        const processFailure = await failure
        await stop()
        throw processFailureError(processFailure, config, stderrObserved)
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      await stop()
      throw abortedError(config, options.signal)
    }
    throw error
  }
}
