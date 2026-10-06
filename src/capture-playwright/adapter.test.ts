import { describe, expect, it, vi } from "vitest"

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

describe("captureWebScenario preflight", () => {
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
