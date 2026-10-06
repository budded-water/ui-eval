import { describe, expect, it, vi } from "vitest"
import type { SourceRevision } from "../contracts/model"
import type { ResolvedExecutionProfile } from "../project/execution-profile"
import { executionTarget, verifyRemoteDeployment } from "./remote-target"

const source: SourceRevision = { repository: "synthetic", commitSha: "abc123", dirtyTree: false }
const identity = (revision = "abc123") => ({ schemaVersion: "uieval.deployment/v1alpha1", revision })
function profile(backend = false, timeoutMs = 1000): ResolvedExecutionProfile {
  return { id: "preview", baseUrl: "https://preview.example.invalid/", frontendIdentityUrl: "https://preview.example.invalid/version",
    ...(backend ? { backendIdentityUrl: "https://api.example.invalid/version" } : {}),
    config: { mode: "remote", baseUrlRef: "preview", frontend: { identityPath: "/version" }, readinessTimeoutMs: timeoutMs,
      ...(backend ? { backend: { baseUrlRef: "api", identityPath: "/version", expected: { revision: "api-v2", apiContractVersion: "v2" } } } : {}),
    },
  }
}
function verify(p: ResolvedExecutionProfile, fetchImpl: typeof fetch, waitForReady = false, signal?: AbortSignal) {
  return verifyRemoteDeployment(p, executionTarget(p, source)!, source, { fetchImpl, waitForReady, signal })
}

describe("remote deployment verification", () => {
  it("binds frontend to source and backend to declared versions, retaining checked fields only", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => Response.json(String(url).includes("api.")
      ? { ...identity("api-v2"), apiContractVersion: "v2", dataRevision: "ignored" }
      : { ...identity(), dataRevision: "ignored" }))
    const result = await verify(profile(true), fetchImpl)
    expect(result).toEqual({ status: "verified", frontend: identity(), backend: { ...identity("api-v2"), apiContractVersion: "v2" } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options?.redirect).toBe("manual")
      expect(options?.headers).toEqual({ accept: "application/json" })
    }
  })
  it.each([
    () => Response.json(identity("other")),
    () => Response.json({ schemaVersion: "unknown", revision: "abc123" }),
    () => Response.json({ ...identity(), secret: "withheld" }),
    () => new Response("not json"),
    () => new Response("x".repeat(65 * 1024)),
    () => new Response(null, { status: 302, headers: { location: "https://foreign.example.invalid" } }),
    () => new Response(null, { status: 503 }),
  ])("rejects mismatched, malformed, oversized, redirected and offline evidence without leaking bodies", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response())
    await expect(verify(profile(), fetchImpl)).rejects.toThrow("could not be verified")
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it("rejects backend contract drift even when frontend and backend revisions match", async () => {
    await expect(verify(profile(true), async (url) => Response.json(String(url).includes("api.")
      ? { ...identity("api-v2"), apiContractVersion: "v1" } : identity()))).rejects.toThrow("could not be verified")
  })
  it("waits for the selected revision before capture", async () => {
    let calls = 0
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(identity(++calls === 1 ? "previous" : "abc123")))
    expect((await verify(profile(), fetchImpl, true)).status).toBe("verified")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it("bounds a request that never settles", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}))
    await expect(verify(profile(false, 25), fetchImpl, true)).rejects.toThrow("Remote deployment")
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  it("bounds a response body that never settles", async () => {
    const cancelled = vi.fn()
    await expect(verify(profile(false, 25), async () => new Response(new ReadableStream({ cancel: cancelled })), true)).rejects.toThrow("Remote deployment")
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it("cancels the other request when either identity fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (!String(url).includes("api.")) return Response.json(identity("wrong"))
      return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))
    })
    await expect(verify(profile(true), fetchImpl)).rejects.toThrow("could not be verified")
    expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
  })
  it("rejects a dirty checkout without sending network requests", async () => {
    const p = profile()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(verifyRemoteDeployment(p, executionTarget(p, source)!, { ...source, dirtyTree: true }, { fetchImpl })).rejects.toThrow("clean source checkout")
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("preserves caller cancellation", async () => {
    const controller = new AbortController()
    controller.abort(new Error("caller stopped"))
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(identity()))
    await expect(verify(profile(), fetchImpl, true, controller.signal)).rejects.toThrow("caller stopped")
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
