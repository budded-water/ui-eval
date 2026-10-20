import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { Value } from "@sinclair/typebox/value"
import { IncompleteCleanupError } from "../runtime/cleanup"
import { stopOwnedProcess } from "../runtime/owned-process"
import {
  IntegrationSessionSchema, IntegrationSessionStartSchema, IntegrationSessionReadySchema, IntegrationSessionStoppedSchema,
  type IntegrationSession, type IntegrationSessionContext, type IntegrationSessionStart, type IntegrationSessionStop,
} from "./session-protocol"

const PROTOCOL_LIMIT = 16 * 1024
const STDERR_LIMIT = 64 * 1024

export interface IntegrationSessionHandle {
  /** Aborts on unexpected session failure; normal stop does not abort it. */
  readonly signal: AbortSignal
  assertAlive(): void
  /** Idempotent; cleanup receives a fresh budget even when the caller aborted. */
  stop(): Promise<void>
}

/** Owns the protocol child and its process group, without retaining candidate output. */
export async function startIntegrationSession(
  config: IntegrationSession,
  context: IntegrationSessionContext,
  options: { cwd: string; signal?: AbortSignal },
): Promise<IntegrationSessionHandle> {
  options.signal?.throwIfAborted()
  const start: IntegrationSessionStart = {
    ...context, apiVersion: "uieval.io/integration-session-v1", kind: "start", sessionId: randomUUID(),
  }
  if (!Value.Check(IntegrationSessionSchema, config) || !Value.Check(IntegrationSessionStartSchema, start)) {
    throw new Error("Invalid integration session configuration or context")
  }
  const child = spawn(config.command, [...config.args], {
    cwd: options.cwd, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  })
  const controller = new AbortController()
  const decoder = new StringDecoder("utf8")
  let buffer = ""
  let outputBytes = 0
  let errorBytes = 0
  let ready = false
  let stopped: "pass" | "inconclusive" | undefined
  let stopping = false
  let closed = false
  let exitCode: number | null = null
  let failure: Error | undefined
  let stopPromise: Promise<void> | undefined
  let readyResolve: () => void = () => {}
  let readyReject: (error: Error) => void = () => {}
  let closeResolve: () => void = () => {}
  const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closure = new Promise<void>((resolve) => { closeResolve = resolve })
  // Startup and automatic cleanup may settle before their public awaiters run.
  void readiness.catch(() => {})

  const fail = (message: string) => {
    failure ??= new Error(message)
    controller.abort(failure)
    readyReject(failure)
    void stop().catch(() => {})
  }
  const waitUntil = async (operation: Promise<void>, deadline: number): Promise<boolean> => {
    void operation.catch(() => {})
    if (Date.now() >= deadline) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now())) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }
  const runStop = async () => {
    stopping = true
    clearTimeout(startupTimer)
    const deadline = Date.now() + config.cleanupTimeoutMs
    const forceBudget = Math.min(2000, Math.max(1, Math.floor(config.cleanupTimeoutMs / 2)))
    let protocolCompleted = false
    let processCleanup = false
    try {
      if (child.pid === undefined) {
        if (failure) throw failure
        throw new Error("Integration session could not start")
      }
      if (!closed && !child.stdin.destroyed) {
        const message: IntegrationSessionStop = { apiVersion: start.apiVersion, kind: "stop", sessionId: start.sessionId }
        child.stdin.end(`${JSON.stringify(message)}\n`)
      }
      // The protocol acknowledgement covers external resources (for example App
      // state); process termination alone cannot establish their restoration.
      protocolCompleted = closed || await waitUntil(closure, deadline - forceBudget)
      const cleanup = stopOwnedProcess(child, Math.max(1, Math.min(1000, Math.floor((deadline - Date.now()) / 2))))
      processCleanup = await waitUntil(cleanup, deadline)
      if (!processCleanup || !protocolCompleted || stopped !== "pass" || exitCode !== 0) {
        throw new IncompleteCleanupError("Integration session cleanup was not confirmed")
      }
      if (failure) throw failure
    } catch (error) {
      if (child.pid !== undefined && (!processCleanup || !protocolCompleted || stopped !== "pass" || exitCode !== 0)) {
        throw new IncompleteCleanupError("Integration session cleanup was not confirmed")
      }
      throw error
    } finally {
      options.signal?.removeEventListener("abort", aborted)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
  function stop(): Promise<void> {
    stopPromise ??= runStop()
    // Automatic shutdown never creates an unhandled rejection. The returned
    // promise remains rejected so the suite must account for cleanup failure.
    void stopPromise.catch(() => {})
    return stopPromise
  }
  const aborted = () => fail("Integration session was interrupted")
  const startupTimer = setTimeout(() => fail("Integration session readiness deadline exceeded"), config.startupTimeoutMs)

  const onLine = (line: string) => {
    let value: unknown
    try { value = JSON.parse(line) } catch { fail("Integration session returned invalid protocol data"); return }
    if (Value.Check(IntegrationSessionReadySchema, value) && value.sessionId === start.sessionId && !ready && !stopped) {
      ready = true
      clearTimeout(startupTimer)
      if (!stopping) readyResolve()
    } else if (Value.Check(IntegrationSessionStoppedSchema, value) && value.sessionId === start.sessionId && stopping && !stopped) {
      stopped = value.status
    } else fail("Integration session returned invalid or out-of-order protocol data")
  }
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (outputBytes > PROTOCOL_LIMIT) { fail("Integration session exceeded its protocol output limit"); return }
    buffer += decoder.write(chunk)
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      onLine(line)
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    errorBytes += chunk.byteLength
    if (errorBytes > STDERR_LIMIT) fail("Integration session exceeded its diagnostic output limit")
  })
  child.stdin.on("error", () => fail("Integration session input channel failed"))
  child.once("error", () => fail("Integration session process failed to start"))
  child.once("exit", () => {
    if (!stopping) fail("Integration session exited before cleanup was requested")
  })
  child.once("close", (code) => {
    closed = true
    exitCode = code
    buffer += decoder.end()
    if (buffer.length) fail("Integration session returned an incomplete protocol line")
    if (!stopping) fail("Integration session exited before cleanup was requested")
    closeResolve()
  })
  options.signal?.addEventListener("abort", aborted, { once: true })
  child.stdin.write(`${JSON.stringify(start)}\n`)
  if (options.signal?.aborted) aborted()
  try {
    await readiness
    if (failure) throw failure
    return {
      signal: controller.signal,
      assertAlive() {
        if (failure) throw failure
        if (!ready || stopping || closed || child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Integration session is not active")
        }
      },
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
