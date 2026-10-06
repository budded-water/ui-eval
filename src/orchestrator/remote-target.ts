import { setTimeout as delay } from "node:timers/promises"
import { DeploymentIdentitySchema } from "../contracts/schemas"
import { assertSchema } from "../contracts/validation"
import type { DeploymentIdentity, DeploymentVerification, ExecutionTarget, SourceRevision } from "../contracts/model"
import type { ResolvedExecutionProfile } from "../project/execution-profile"

export class RemoteDeploymentError extends Error {
  readonly code = "REMOTE_DEPLOYMENT_UNVERIFIED"
}

export function executionTarget(profile: ResolvedExecutionProfile | undefined, source: SourceRevision): ExecutionTarget | undefined {
  if (!profile) return undefined
  const common = { profileId: profile.id, baseUrl: profile.baseUrl }
  if (profile.config.mode === "local") return { ...common, mode: "local" }
  return { ...common, mode: "remote", frontendIdentityUrl: profile.frontendIdentityUrl!,
    frontend: { ...profile.config.frontend.expected, revision: source.commitSha },
    ...(profile.config.backend ? { backend: profile.config.backend.expected, backendIdentityUrl: profile.backendIdentityUrl! } : {}),
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

async function readIdentity(url: string, expected: Omit<DeploymentIdentity, "schemaVersion">, signal: AbortSignal, fetchImpl: typeof fetch): Promise<DeploymentIdentity> {
  signal.throwIfAborted()
  const response = await abortable(fetchImpl(url, { redirect: "manual", signal, headers: { accept: "application/json" } }), signal)
  if (response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    throw new RemoteDeploymentError("Deployment identity endpoint is not ready")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > 64 * 1024) throw new RemoteDeploymentError("Deployment identity exceeded its byte limit")
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const identity = assertSchema(DeploymentIdentitySchema, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  for (const [key, value] of Object.entries(expected)) {
    if (identity[key as keyof DeploymentIdentity] !== value) throw new RemoteDeploymentError("Deployment identity does not match the declared version")
  }
  // Persist only checked fields, never unrelated server-supplied metadata.
  return { schemaVersion: identity.schemaVersion, ...expected }
}

export async function verifyRemoteDeployment(
  profile: ResolvedExecutionProfile,
  target: ExecutionTarget,
  source: SourceRevision,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; waitForReady?: boolean } = {},
): Promise<DeploymentVerification> {
  if (profile.config.mode !== "remote" || target.mode !== "remote") throw new RemoteDeploymentError("Remote execution target is required")
  if (source.dirtyTree) throw new RemoteDeploymentError("Remote evaluation requires a clean source checkout")
  const timeout = AbortSignal.timeout(profile.config.readinessTimeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const fetchImpl = options.fetchImpl ?? fetch
  for (;;) {
    const attempt = new AbortController()
    const attemptSignal = AbortSignal.any([signal, attempt.signal])
    try {
      const [frontend, backend] = await Promise.all([
        readIdentity(profile.frontendIdentityUrl!, target.frontend, attemptSignal, fetchImpl),
        target.backend ? readIdentity(profile.backendIdentityUrl!, target.backend, attemptSignal, fetchImpl) : undefined,
      ])
      return { status: "verified", frontend, ...(backend ? { backend } : {}) }
    } catch {
      attempt.abort()
      options.signal?.throwIfAborted()
      if (timeout.aborted || options.waitForReady === false) throw new RemoteDeploymentError("Remote deployment identity could not be verified")
      try { await delay(250, undefined, { signal }) } catch {
        options.signal?.throwIfAborted()
        throw new RemoteDeploymentError("Remote deployment readiness deadline exceeded")
      }
    } finally { attempt.abort() }
  }
}
