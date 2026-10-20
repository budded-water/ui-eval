import { afterEach, describe, expect, it, vi } from "vitest"

import {
  canonicalDigest,
  DigestExclusionProfiles,
} from "../contracts/canonical-json"
import type { WebResolvedScenarioPlan } from "../contracts/model"
import { captureWebScenario, closePlaywrightResources } from "./adapter"
import { BINARY_EVIDENCE_LIMITS } from "./binary-evidence"

const digest = canonicalDigest({ adapter: "unit" }) as `sha256:${string}`

function planWithCapability(
  capability: "screenshot" | "performance",
): WebResolvedScenarioPlan {
  const plan: WebResolvedScenarioPlan = {
    scenarioId: "adapter-unit",
    scenarioRevision: 1,
    scenarioDigest: digest,
    planDigest: digest,
    visibility: "agent-visible",
    target: {
      platform: "web",
      entrypoint: { baseUrl: "http://127.0.0.1:3000/", path: "/" },
    },
    variant: {
      variantKey: "desktop",
      values: { deviceProfile: "desktop" },
      contextDigest: digest,
    },
    device: {
      profileId: "desktop",
      renderSpace: {
        logicalWidth: 800,
        logicalHeight: 600,
        logicalUnit: "css-px",
        deviceScaleFactor: 1,
        screenshotWidthPx: 800,
        screenshotHeightPx: 600,
        orientation: "landscape",
      },
    },
    locale: "en-US",
    theme: "light",
    determinism: { timezone: "UTC", clock: { mode: "real" } },
    fixtures: [],
    requiredCapabilities: [capability],
    fixtureDigests: [],
    evidenceRequestDigest: digest,
    captureConfigDigest: digest,
    setup: [],
    steps: [],
    cleanup: [],
    checkpoints: [
      {
        id: "page",
        requiredChannels: [capability],
        captureScope: "viewport",
        stabilize: {
          disableAnimations: true,
          waitForFonts: true,
          stableFrames: 2,
          timeoutMs: 1_000,
        },
      },
    ],
  }
  plan.planDigest = canonicalDigest(plan, {
    exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
  })
  return plan
}

function context(artifactStore: {
  resolve: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  putJson: ReturnType<typeof vi.fn>
}) {
  return {
    executionId: "adapter-unit-run",
    runManifestDigest: digest,
    captureKey: digest,
    sourceRevision: { repository: "local", commitSha: "unit" },
    build: {
      platform: "web" as const,
      artifactDigest: digest,
      buildConfigDigest: digest,
      publicEnvironmentDigest: digest,
    },
    artifactStore: artifactStore as never,
  }
}

describe("owned Playwright cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("uses spare cleanup time for a slow browser close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const closing = closePlaywrightResources({
      unrouteAll: async () => {},
      close: async () => {},
    } as never, {
      close: () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
    } as never, 90)
    const result = closing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(90)
    expect(await result).toBeUndefined()
  })

  it("allows browser shutdown to finish an already pending context close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    let finishContext: (() => void) | undefined
    const browser = { close: vi.fn(async () => finishContext!()) }
    const closing = closePlaywrightResources({
      unrouteAll: async () => {},
      close: () => new Promise<void>((resolve) => { finishContext = resolve }),
    } as never, browser as never, 90)
    const result = closing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(90)
    expect(await result).toBeUndefined()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("does not treat browser closure as proof that a pending context close succeeded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const closing = closePlaywrightResources({
      unrouteAll: async () => {},
      close: () => new Promise<void>(() => {}),
    } as never, { close: async () => {} } as never, 90)
    const result = closing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(90)
    expect(await result).toMatchObject({
      code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE",
      message: expect.stringContaining("context: timed-out"),
    })
  })

  it("keeps the total deadline when route and context teardown consume time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const browser = { close: vi.fn(() => delay(45)) }
    const closing = closePlaywrightResources({
      unrouteAll: () => delay(25),
      close: () => delay(25),
    } as never, browser as never, 90)
    const result = closing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(90)
    expect(await result).toMatchObject({
      code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE",
      message: expect.stringContaining("browser: timed-out"),
    })
    expect(performance.now()).toBe(90)
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("rejects late fulfillment when stalled scheduling runs close callbacks before the deadline timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const browser = { close: vi.fn(() => delay(20)) }
    const closing = closePlaywrightResources({
      unrouteAll: async () => {},
      close: () => delay(60),
    } as never, browser as never, 90)
    const result = closing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(45)
    // After an event-loop stall, earlier close timers can run before the
    // deadline timer even though monotonic elapsed time exceeds the budget.
    vi.spyOn(performance, "now").mockReturnValue(145)
    await vi.advanceTimersByTimeAsync(45)
    expect(await result).toMatchObject({
      code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE",
      message: "Owned browser cleanup incomplete (context: timed-out, browser: timed-out)",
    })
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("attempts browser closure after a synchronous context close error", async () => {
    const browser = { close: vi.fn(async () => {}) }
    await expect(closePlaywrightResources({
      unrouteAll: async () => {},
      close: () => { throw new Error("private transport detail") },
    } as never, browser as never, 90)).rejects.toMatchObject({
      code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE",
      message: "Owned browser cleanup incomplete (context: rejected, browser: fulfilled)",
    })
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("rejects browser close failure even when the context closed", async () => {
    await expect(closePlaywrightResources({
      unrouteAll: async () => {},
      close: async () => {},
    } as never, {
      close: async () => { throw new Error("private browser transport detail") },
    } as never, 90)).rejects.toMatchObject({
      code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE",
      message: "Owned browser cleanup incomplete (context: fulfilled, browser: rejected)",
    })
  })

  it("bounds Playwright cleanup when Chrome does not settle", async () => {
    const neverSettles = new Promise<void>(() => undefined)
    const browserContext = {
      unrouteAll: vi.fn(() => neverSettles),
      close: vi.fn(() => neverSettles),
    }
    const browser = { close: vi.fn(() => neverSettles) }
    const startedAt = Date.now()

    await expect(closePlaywrightResources(
      browserContext as never,
      browser as never,
      30,
    )).rejects.toMatchObject({ code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE" })

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(browserContext.unrouteAll).toHaveBeenCalledWith({
      behavior: "ignoreErrors",
    })
    expect(browserContext.close).toHaveBeenCalledOnce()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("attempts browser shutdown but rejects when context close fails", async () => {
    const browser = { close: vi.fn(async () => {}) }
    await expect(closePlaywrightResources({
      unrouteAll: async () => {},
      close: async () => { throw new Error("transport failed") },
    } as never, browser as never, 30)).rejects.toMatchObject({ code: "OWNED_RESOURCE_CLEANUP_INCOMPLETE" })
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("allows bounded route teardown when context and browser close succeed", async () => {
    await expect(closePlaywrightResources({
      unrouteAll: () => new Promise<void>(() => {}),
      close: async () => {},
    } as never, { close: async () => {} } as never, 30)).resolves.toBeUndefined()
  })
})

describe("captureWebScenario preflight", () => {

  it("lets browser close use the unused total cleanup budget", async () => {
    vi.useFakeTimers()
    try {
      const result = closePlaywrightResources({
        unrouteAll: async () => {},
        close: async () => {},
      } as never, {
        close: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
      } as never, 60)
      const assertion = expect(result).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(40)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("identifies rejected context close and timed-out browser close", async () => {
    await expect(closePlaywrightResources({
      unrouteAll: async () => {},
      close: async () => { throw new Error("private transport detail") },
    } as never, {
      close: () => new Promise<void>(() => {}),
    } as never, 30)).rejects.toThrow("context: rejected, browser: timed-out")
  })

  it.each([
    [30, 20, true],
    [40, 30, true],
    [40, 40, false],
  ])("shares a total deadline across overlapping closes %s/%s", async (contextDelay, browserDelay, succeeds) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    try {
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
      const browser = { close: vi.fn(() => delay(browserDelay)) }
      const result = closePlaywrightResources({
        unrouteAll: () => delay(5),
        close: () => delay(contextDelay),
      } as never, browser as never, 60)
      const assertion = succeeds
        ? expect(result).resolves.toBeUndefined()
        : expect(result).rejects.toThrow("context: fulfilled, browser: timed-out")
      await vi.advanceTimersByTimeAsync(60)
      await assertion
      expect(browser.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("attempts browser shutdown after a synchronous context throw", async () => {
    const browser = { close: vi.fn(async () => {}) }
    await expect(closePlaywrightResources({
      unrouteAll: async () => {},
      close: () => { throw new Error("private context error") },
    } as never, browser as never, 30)).rejects.toThrow("context: rejected, browser: fulfilled")
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it("fails closed before browser launch when screenshot dimensions exceed the budget", async () => {
    const plan = planWithCapability("screenshot")
    plan.device.renderSpace.logicalWidth =
      BINARY_EVIDENCE_LIMITS.png.maxWidthPx + 1
    plan.device.renderSpace.screenshotWidthPx =
      BINARY_EVIDENCE_LIMITS.png.maxWidthPx + 1
    plan.planDigest = canonicalDigest(plan, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    })
    const artifactStore = {
      resolve: vi.fn(),
      put: vi.fn(),
      putJson: vi.fn(),
    }

    const bundle = await captureWebScenario(plan, context(artifactStore))

    expect(bundle).toMatchObject({
      status: "failed",
      completeness: { capturedRequired: 0, missingRequired: 1 },
      executionErrors: [
        {
          origin: "runner",
          phase: "prepare",
          code: "screenshot-dimensions-exceeded",
          retryable: false,
        },
      ],
    })
    expect(artifactStore.put).not.toHaveBeenCalled()
  })

  it("returns a recognizable runner abort without starting capture", async () => {
    const artifactStore = {
      resolve: vi.fn(),
      put: vi.fn(),
      putJson: vi.fn(),
    }
    const controller = new AbortController()
    controller.abort()

    const bundle = await captureWebScenario(planWithCapability("screenshot"), {
      ...context(artifactStore),
      signal: controller.signal,
    })

    expect(bundle.status).toBe("failed")
    expect(bundle.executionErrors).toEqual([
      expect.objectContaining({
        origin: "runner",
        phase: "prepare",
        code: "capture-aborted",
        retryable: false,
      }),
    ])
    expect(artifactStore.resolve).not.toHaveBeenCalled()
    expect(artifactStore.put).not.toHaveBeenCalled()
  })

  it("returns failed completeness before browser launch for unsupported channels", async () => {
    const artifactStore = {
      resolve: vi.fn(),
      put: vi.fn(),
      putJson: vi.fn(),
    }

    const bundle = await captureWebScenario(
      planWithCapability("performance"),
      context(artifactStore),
    )

    expect(bundle.status).toBe("failed")
    expect(bundle.completeness).toEqual({
      expectedRequired: 1,
      capturedRequired: 0,
      missingRequired: 1,
    })
    expect(bundle.executionErrors).toEqual([
      expect.objectContaining({
        origin: "runner",
        phase: "prepare",
        code: "unsupported-capability",
      }),
    ])
    expect(artifactStore.resolve).not.toHaveBeenCalled()
    expect(artifactStore.put).not.toHaveBeenCalled()
  })

  it("classifies an invalid auth storage artifact as runner infrastructure", async () => {
    const base = planWithCapability("screenshot")
    const plan = {
      ...base,
      auth: {
        storageState: {
          id: digest,
          projectId: "adapter-unit",
          storeId: "local",
          digest,
          mediaType: "application/json",
          sizeBytes: 8,
          sensitivity: "sensitive" as const,
        },
      },
    } satisfies WebResolvedScenarioPlan
    plan.planDigest = canonicalDigest(plan, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    })
    const artifactStore = {
      resolve: vi.fn().mockResolvedValue(Buffer.from("not-json")),
      put: vi.fn(),
      putJson: vi.fn(),
    }

    const bundle = await captureWebScenario(plan, context(artifactStore))

    expect(bundle.status).toBe("failed")
    expect(bundle.executionErrors).toEqual([
      expect.objectContaining({
        origin: "runner",
        phase: "prepare",
        code: "auth-storage-state-invalid",
      }),
    ])
  })

  it.each([
    {
      cookies: [],
      origins: [{ origin: "https://outside.example", localStorage: [] }],
    },
    {
      cookies: [
        {
          name: "session",
          value: "redacted",
          domain: ".example.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    {
      cookies: [
        {
          name: "session",
          value: "redacted",
          domain: ".127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    {
      cookies: [],
      origins: [
        {
          origin: "http://127.0.0.1:3000/path",
          localStorage: [],
        },
      ],
    },
  ])("rejects auth storage state outside the exact candidate origin", async (storageState) => {
    const base = planWithCapability("screenshot")
    const plan = {
      ...base,
      auth: {
        storageState: {
          id: digest,
          projectId: "adapter-unit",
          storeId: "local",
          digest,
          mediaType: "application/json",
          sizeBytes: 2,
          sensitivity: "sensitive" as const,
        },
      },
    } satisfies WebResolvedScenarioPlan
    plan.planDigest = canonicalDigest(plan, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    })
    const artifactStore = {
      resolve: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(storageState))),
      put: vi.fn(),
      putJson: vi.fn(),
    }

    const bundle = await captureWebScenario(plan, context(artifactStore))

    expect(bundle.status).toBe("failed")
    expect(bundle.executionErrors).toEqual([
      expect.objectContaining({
        origin: "runner",
        phase: "prepare",
        code: "auth-storage-state-origin-mismatch",
        retryable: false,
      }),
    ])
  })

  it("rejects unresolved auth secret references before touching artifacts", async () => {
    const base = planWithCapability("screenshot")
    const plan = {
      ...base,
      auth: {
        storageState: {
          id: digest,
          projectId: "adapter-unit",
          storeId: "local",
          digest,
          mediaType: "application/json",
          sizeBytes: 2,
          sensitivity: "sensitive" as const,
        },
        secretRefs: ["UI_EVAL_SESSION_TOKEN"],
      },
    } satisfies WebResolvedScenarioPlan
    plan.planDigest = canonicalDigest(plan, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    })
    const artifactStore = {
      resolve: vi.fn(),
      put: vi.fn(),
      putJson: vi.fn(),
    }

    const bundle = await captureWebScenario(plan, context(artifactStore))

    expect(bundle.status).toBe("failed")
    expect(bundle.executionErrors).toEqual([
      expect.objectContaining({
        origin: "runner",
        phase: "prepare",
        code: "unsupported-auth-secret-refs",
        retryable: false,
      }),
    ])
    expect(artifactStore.resolve).not.toHaveBeenCalled()
  })
})
