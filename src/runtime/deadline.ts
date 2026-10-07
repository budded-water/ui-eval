import { hasIncompleteCleanup, IncompleteCleanupError } from "./cleanup"

/** A deadline never authorizes continuation while an adapter still owns resources. */
export async function withOwnedDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal?: AbortSignal, cleanupMs = 15_000): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const interrupt = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", interrupt, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Integration scenario deadline exceeded")), timeoutMs)
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(controller.signal.reason)
  controller.signal.addEventListener("abort", onAbort, { once: true })
  const execution = Promise.resolve().then(() => operation(controller.signal))
  try {
    return await Promise.race([execution, aborted])
  } catch (error) {
    if (!controller.signal.aborted) throw error
    let settled = false
    let cleanupFailed = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      execution.then(() => { settled = true }, (failure: unknown) => { settled = true; cleanupFailed = hasIncompleteCleanup(failure) }),
      new Promise<void>((done) => { cleanupTimer = setTimeout(done, cleanupMs) }),
    ])
    if (cleanupTimer) clearTimeout(cleanupTimer)
    if (!settled || cleanupFailed) throw new IncompleteCleanupError("Integration adapter cleanup did not settle")
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", interrupt)
    controller.signal.removeEventListener("abort", onAbort)
  }
}
