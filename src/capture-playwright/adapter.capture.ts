import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  canonicalDigest,
  DigestExclusionProfiles,
} from "../contracts/canonical-json"
import type {
  CaptureCapability,
  WebResolvedScenarioPlan,
} from "../contracts/model"
import { CaptureBundleSpecSchema } from "../contracts/schemas"
import { assertSchema } from "../contracts/validation"
import { LocalArtifactStore } from "../storage-local/artifact-store"
import { captureWebScenario, closePlaywrightResources } from "./adapter"

const browserInstalled = existsSync(chromium.executablePath())
const browserRequired = process.env.UI_EVAL_REQUIRE_BROWSER === "1"

describe("Playwright Chromium prerequisite", () => {
  it.skipIf(!browserRequired)(
    "has the bundled Chromium executable required by CI",
    () => {
      expect(
        browserInstalled,
        `Bundled Chromium is required when UI_EVAL_REQUIRE_BROWSER=1; expected executable at ${chromium.executablePath()}`,
      ).toBe(true)
    },
  )
})

function minimalPlan(options: {
  baseUrl: string
  path: string
  steps?: WebResolvedScenarioPlan["steps"]
}): WebResolvedScenarioPlan {
  const digest = canonicalDigest({
    baseUrl: options.baseUrl,
    path: options.path,
    ...(options.steps === undefined ? {} : { steps: options.steps }),
  }) as `sha256:${string}`
  const plan: WebResolvedScenarioPlan = {
    scenarioId: "capture-guard",
    scenarioRevision: 1,
    scenarioDigest: digest,
    planDigest: digest,
    visibility: "agent-visible",
    target: {
      platform: "web",
      entrypoint: { baseUrl: options.baseUrl, path: options.path },
    },
    variant: {
      variantKey: "desktop-en-light",
      values: { deviceProfile: "desktop", locale: "en-US", theme: "light" },
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
    requiredCapabilities: ["screenshot"],
    fixtureDigests: [],
    evidenceRequestDigest: digest,
    captureConfigDigest: digest,
    setup: [],
    steps:
      options.steps ??
      [{ id: "capture", action: "checkpoint", checkpointId: "page" }],
    cleanup: [],
    checkpoints: [
      {
        id: "page",
        requiredChannels: ["screenshot"],
        captureScope: "viewport",
        stabilize: {
          disableAnimations: true,
          waitForFonts: true,
          stableFrames: 2,
          timeoutMs: 5_000,
        },
      },
    ],
  }
  plan.planDigest = canonicalDigest(plan, {
    exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
  })
  return plan
}

describe.skipIf(!browserInstalled)("Playwright Chromium capture", () => {
  it("confirms owned context and browser shutdown before reporting cleanup success", async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.setContent("<p>Synthetic lifecycle fixture</p>")
      await closePlaywrightResources(context, browser)
      expect(browser.isConnected()).toBe(false)
      expect(page.isClosed()).toBe(true)
    } finally {
      await browser.close()
    }
  })

  let server: Server | undefined
  let baseUrl: string
  let artifactRoot: string | undefined
  let externalRequests = 0
  let traceFinalizationStarted = false
  let onHangNavigation: (() => void) | undefined

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/external") {
        externalRequests += 1
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end("<!doctype html><main>External destination</main>")
        return
      }

      if (request.url === "/api/fail") {
        response.writeHead(503, { "content-type": "application/json" })
        response.end('{"error":"expected pilot failure"}')
        return
      }

      if (request.url === "/trace-finalization-state") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ ready: traceFinalizationStarted }))
        return
      }

      if (request.url === "/missing") {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" })
        response.end("<!doctype html><main>Not found</main>")
        return
      }

      if (request.url === "/missing-click") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          '<!doctype html><button type="button" onclick="location.href=\'/missing\'">Missing</button>',
        )
        return
      }

      if (request.url === "/redirect-external") {
        response.writeHead(302, {
          location: `http://localhost:${request.socket.localPort}/external`,
        })
        response.end()
        return
      }

      if (request.url === "/external-click") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(`<!doctype html><button type="button" onclick="location.href='http://localhost:${request.socket.localPort}/external'">Leave</button>`)
        return
      }

      if (request.url === "/external-press") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(`<!doctype html><main>Press Enter</main><script>addEventListener('keydown', event => { if (event.key === 'Enter') location.href='http://localhost:${request.socket.localPort}/external' })</script>`)
        return
      }

      if (request.url === "/external-popup") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(`<!doctype html><button type="button" onclick="window.open('http://localhost:${request.socket.localPort}/external', '_blank')">Open external</button>`)
        return
      }

      if (request.url === "/same-origin-popup-500-launcher") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          `<!doctype html><button type="button" onclick="window.open('/same-origin-popup-500', '_blank')">Open popup</button>`,
        )
        return
      }

      if (request.url === "/same-origin-popup-500") {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" })
        response.end("<!doctype html><main>Popup failed</main>")
        return
      }

      if (request.url === "/same-origin-popup-error-launcher") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          `<!doctype html><button type="button" onclick="window.open('/same-origin-popup-error', '_blank')">Open popup</button>`,
        )
        return
      }

      if (request.url === "/same-origin-popup-error") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          '<!doctype html><main>Popup</main><script>throw new Error("popup boom")</script>',
        )
        return
      }

      if (request.url === "/finalization-popup-launcher") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          `<!doctype html><button type="button" onclick="(async () => { while (true) { const state = await fetch('/trace-finalization-state').then(response => response.json()); if (state.ready) { window.open('/same-origin-popup-500', '_blank'); return; } await new Promise(resolve => setTimeout(resolve, 5)); } })()">Open finalization popup</button>`,
        )
        return
      }

      if (request.url === "/external-fetch") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(`<!doctype html><main>Authenticated page</main><script>
          window.__UI_EVAL_READY__ = false
          fetch('http://localhost:${request.socket.localPort}/external', {
            method: 'POST',
            body: localStorage.getItem('session-token')
          }).catch(() => {}).finally(() => { window.__UI_EVAL_READY__ = true })
        </script>`)
        return
      }

      if (request.url?.startsWith("/assertion-secrets")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(`<!doctype html>
          <script>
            const NativeTextEncoder = window.TextEncoder
            window.TextEncoder = class GuardedTextEncoder extends NativeTextEncoder {
              encode(value = '') {
                if (Array.from(String(value)).length > 1) {
                  throw new Error('assertion preview encoded more than one code point')
                }
                return super.encode(value)
              }
            }
          </script>
          <main>
            <p data-ui-id="long-text">token=actual-front-secret ${"界".repeat(250_000)} token=actual-late-secret</p>
            <section data-ui-eval-sensitive>
              <p data-ui-id="private-text">actual-sensitive-secret</p>
            </section>
          </main>`)
        return
      }

      if (request.url === "/hang") {
        onHangNavigation?.()
        return
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html>
        <html>
          <head><title>Capture Pilot</title></head>
          <body>
            <main data-ui-id="pilot">
              <h1 data-ui-id="title">Pilot</h1>
              <label>Name <input data-testid="name" /></label>
              <label>Category <select data-testid="category"><option value="all">All</option><option value="residential">Residential</option></select></label>
              <output data-ui-id="selection">all</output>
              <button type="button">Update</button>
            </main>
            <script>
              window.__UI_EVAL_READY__ = false
              document.querySelector('button').addEventListener('click', () => {
                document.querySelector('[data-ui-id="title"]').textContent = 'Updated'
              })
              document.querySelector('[data-testid="category"]').addEventListener('change', event => {
                document.querySelector('[data-ui-id="selection"]').textContent = event.target.value
              })
              fetch('/api/fail').finally(() => { window.__UI_EVAL_READY__ = true })
            </script>
          </body>
        </html>`)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}/`
    artifactRoot = await mkdtemp(join(tmpdir(), "ui-eval-capture-test-"))
  })

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    if (artifactRoot) {
      await rm(artifactRoot, { recursive: true, force: true })
    }
  })

  async function captureGuardPlan(
    sourcePlan: WebResolvedScenarioPlan,
    signal?: AbortSignal,
    storageState?: { cookies: unknown[]; origins: unknown[] },
    onTracePut?: () => Promise<void> | void,
    storageMode?: "authenticated" | "public-state",
  ) {
    const executionDigest = canonicalDigest({ captureGuard: true }) as `sha256:${string}`
    const artifactStore = new LocalArtifactStore(
      artifactRoot!,
      "capture-pilot",
      "local",
    )
    const plan = structuredClone(sourcePlan)
    if (storageState) {
      const storageStateRef = await artifactStore.putJson(storageState, {
        sensitivity: "sensitive",
      })
      plan.auth = {
        storageState: storageStateRef,
        ...(storageMode ? { mode: storageMode } : {}),
      }
      plan.planDigest = canonicalDigest(plan, {
        exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
      })
    }
    const captureArtifactStore = onTracePut
      ? {
          put: async (...args: Parameters<LocalArtifactStore["put"]>) => {
            const options = args[1]
            const mediaType =
              typeof options === "string" ? options : options?.mediaType
            if (mediaType === "application/zip") await onTracePut()
            return artifactStore.put(...args)
          },
          putJson: artifactStore.putJson.bind(artifactStore),
          resolve: artifactStore.resolve.bind(artifactStore),
        }
      : artifactStore
    return captureWebScenario(plan, {
      executionId: "capture-guard-run",
      runManifestDigest: executionDigest,
      captureKey: executionDigest,
      sourceRevision: { repository: "local", commitSha: "capture-test" },
      build: {
        platform: "web",
        artifactDigest: executionDigest,
        buildConfigDigest: executionDigest,
        publicEnvironmentDigest: executionDigest,
      },
      artifactStore: captureArtifactStore,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  it("captures every Phase 0A required evidence channel", async () => {
    const digest = canonicalDigest({ pilot: true }) as `sha256:${string}`
    const requiredCapabilities = [
      "screenshot",
      "dom",
      "computed-styles",
      "layout-metadata",
      "console",
      "network",
      "trace",
      "crash",
    ] as const
    const plan: WebResolvedScenarioPlan = {
      scenarioId: "capture-pilot",
      scenarioRevision: 1,
      scenarioDigest: digest,
      planDigest: digest,
      visibility: "agent-visible",
      target: {
        platform: "web",
        entrypoint: { baseUrl, path: "/" },
      },
      variant: {
        variantKey: "desktop-en-light",
        values: { deviceProfile: "desktop", locale: "en-US", theme: "light" },
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
      determinism: {
        timezone: "UTC",
        clock: { mode: "fixed", value: "2026-08-10T00:00:00.000Z" },
        randomSeed: "capture-pilot",
      },
      fixtures: [],
      requiredCapabilities: [...requiredCapabilities],
      fixtureDigests: [],
      evidenceRequestDigest: digest,
      captureConfigDigest: digest,
      setup: [
        {
          id: "ready",
          action: "waitFor",
          condition: "app-ready",
          timeoutMs: 5_000,
        },
      ],
      steps: [
        {
          id: "select-category",
          action: "select",
          target: { platform: "web", by: "testId", value: "category" },
          value: "residential",
        },
        {
          id: "selected-category",
          action: "assert",
          assertion: {
            id: "selection-text",
            kind: "text",
            target: { platform: "web", by: "uiId", value: "selection" },
            expected: "residential",
          },
        },
        {
          id: "fill-name",
          action: "fill",
          target: { platform: "web", by: "testId", value: "name" },
          value: "Ada",
        },
        {
          id: "update",
          action: "tap",
          target: { platform: "web", by: "role", value: "button", name: "Update" },
        },
        {
          id: "updated-title",
          action: "assert",
          assertion: {
            id: "title-text",
            kind: "text",
            target: { platform: "web", by: "uiId", value: "title" },
            expected: "Updated",
          },
        },
        { id: "capture", action: "checkpoint", checkpointId: "page" },
      ],
      cleanup: [],
      checkpoints: [
        {
          id: "page",
          requiredChannels: [...requiredCapabilities],
          captureScope: "viewport",
          stabilize: {
            disableAnimations: true,
            waitForFonts: true,
            stableFrames: 2,
            timeoutMs: 5_000,
          },
          assertions: [{ id: "no-crash", kind: "no-crash" }],
        },
      ],
    }
    plan.planDigest = canonicalDigest(plan, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    })
    const artifactStore = new LocalArtifactStore(
      artifactRoot!,
      "capture-pilot",
      "local",
    )

    const bundle = await captureWebScenario(plan, {
      executionId: "capture-pilot-run",
      runManifestDigest: digest,
      captureKey: digest,
      sourceRevision: { repository: "local", commitSha: "capture-test" },
      build: {
        platform: "web",
        artifactDigest: digest,
        buildConfigDigest: digest,
        publicEnvironmentDigest: digest,
      },
      artifactStore,
    })

    expect(() => assertSchema(CaptureBundleSpecSchema, bundle)).not.toThrow()
    expect(
      bundle.status,
      JSON.stringify(
        {
          completeness: bundle.completeness,
          evidence: bundle.checkpoints.flatMap((checkpoint) => checkpoint.evidence),
          errors: bundle.executionErrors,
          steps: bundle.stepResults,
        },
        null,
        2,
      ),
    ).toBe("completed")
    expect(bundle.completeness).toEqual({
      expectedRequired: requiredCapabilities.length,
      capturedRequired: requiredCapabilities.length,
      missingRequired: 0,
    })
    expect(bundle.checkpoints[0].evidence.map((record) => record.channel)).toEqual(
      requiredCapabilities,
    )
    expect(bundle.checkpoints[0].evidence.every((record) => record.artifact)).toBe(
      true,
    )
    expect(bundle.assertionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: "title-text", status: "passed" }),
        expect.objectContaining({ assertionId: "selection-text", status: "passed" }),
        expect.objectContaining({ assertionId: "no-crash", status: "passed" }),
      ]),
    )
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "product",
          code: "same-origin-http-5xx",
        }),
      ]),
    )
  }, 30_000)

  it("seals only redacted and bounded assertion values into the capture bundle", async () => {
    const candidate = new URL(baseUrl)
    const plan = minimalPlan({
      baseUrl,
      path: "/assertion-secrets/magic-actual-secret?code=actual-query-secret&state=actual-state-secret&foo=actual-arbitrary-secret#actual-hash-secret",
      steps: [
        {
          id: "long-text",
          action: "assert",
          assertion: {
            id: "long-text",
            kind: "text",
            target: { platform: "web", by: "uiId", value: "long-text" },
            expected: `token=expected-front-secret ${"界".repeat(2_000)} token=expected-late-secret`,
          },
        },
        {
          id: "private-text",
          action: "assert",
          assertion: {
            id: "private-text",
            kind: "text",
            target: { platform: "web", by: "uiId", value: "private-text" },
            expected: "expected-sensitive-secret",
          },
        },
        {
          id: "url",
          action: "assert",
          assertion: {
            id: "url",
            kind: "url",
            expected: `http://alice:password@${candidate.host}/assertion-secrets/magic-expected-secret?code=expected-query-secret&state=expected-state-secret&foo=expected-arbitrary-secret#expected-hash-secret`,
          },
        },
        { id: "capture", action: "checkpoint", checkpointId: "page" },
      ],
    })
    const bundle = await captureGuardPlan(plan)
    const byId = new Map(
      bundle.assertionResults.map((result) => [result.assertionId, result]),
    )

    const longText = byId.get("long-text")
    expect(longText?.status).toBe("failed")
    expect(longText?.expected).toEqual(
      expect.objectContaining({ kind: "string" }),
    )
    expect(longText?.actual).toEqual(
      expect.objectContaining({ kind: "string" }),
    )
    for (const metric of [longText?.expected, longText?.actual]) {
      if (metric?.kind !== "string") throw new Error("expected string metric")
      expect(metric.value).toContain("…[TRUNCATED]")
      expect(Buffer.byteLength(metric.value, "utf8")).toBeLessThanOrEqual(1_024)
    }
    expect(byId.get("private-text")).toMatchObject({
      status: "failed",
      expected: { kind: "string", value: "[REDACTED]" },
      actual: { kind: "string", value: "[REDACTED]" },
    })
    expect(byId.get("url")).toMatchObject({
      status: "failed",
      expected: {
        kind: "string",
        value: `${candidate.origin}/[REDACTED_PATH]?[REDACTED_QUERY]`,
      },
      actual: {
        kind: "string",
        value: `${candidate.origin}/[REDACTED_PATH]?[REDACTED_QUERY]`,
      },
    })

    const serialized = JSON.stringify(bundle)
    for (const secret of [
      "alice",
      "password",
      "actual-query-secret",
      "expected-query-secret",
      "actual-state-secret",
      "expected-state-secret",
      "actual-arbitrary-secret",
      "expected-arbitrary-secret",
      "magic-actual-secret",
      "magic-expected-secret",
      "actual-hash-secret",
      "expected-hash-secret",
      "actual-front-secret",
      "expected-front-secret",
      "actual-late-secret",
      "expected-late-secret",
      "actual-sensitive-secret",
      "expected-sensitive-secret",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  }, 30_000)

  it("fails a true 404 main document before capturing its error page", async () => {
    const bundle = await captureGuardPlan(
      minimalPlan({ baseUrl, path: "/missing" }),
    )

    expect(bundle.status).toBe("failed")
    expect(bundle.completeness).toEqual({
      expectedRequired: 1,
      capturedRequired: 0,
      missingRequired: 1,
    })
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "product",
          phase: "prepare",
          code: "same-origin-main-document-http-4xx",
        }),
      ]),
    )
    expect(bundle.checkpoints[0].evidence).toEqual([
      expect.objectContaining({
        channel: "screenshot",
        status: "missing",
      }),
    ])
    expect(bundle.checkpoints[0].evidence[0]).not.toHaveProperty("artifact")
  }, 30_000)

  it("treats a tap navigation to a 404 document as terminal", async () => {
    const bundle = await captureGuardPlan(
      minimalPlan({
        baseUrl,
        path: "/missing-click",
        steps: [
          {
            id: "missing",
            action: "tap",
            target: {
              platform: "web",
              by: "role",
              value: "button",
              name: "Missing",
            },
          },
          { id: "capture", action: "checkpoint", checkpointId: "page" },
        ],
      }),
    )

    expect(bundle.status).toBe("failed")
    expect(bundle.completeness.capturedRequired).toBe(0)
    expect(bundle.stepResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "missing",
          status: "failed",
          origin: "product",
          errorCode: "same-origin-main-document-http-4xx",
        }),
        expect.objectContaining({
          stepId: "capture",
          status: "not-executed",
          errorCode: "same-origin-main-document-http-4xx",
        }),
      ]),
    )
  }, 30_000)

  it("blocks an external initial redirect without capturing external evidence", async () => {
    externalRequests = 0
    const bundle = await captureGuardPlan(
      minimalPlan({ baseUrl, path: "/redirect-external" }),
    )

    expect(bundle.status).toBe("failed")
    expect(bundle.completeness.capturedRequired).toBe(0)
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "product",
          code: "candidate-origin-escaped",
          retryable: false,
        }),
      ]),
    )
    expect(
      bundle.checkpoints.flatMap((checkpoint) => checkpoint.evidence),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "captured" })]),
    )
    expect(externalRequests).toBe(0)
  }, 30_000)

  it.each([
    {
      name: "tap",
      path: "/external-click",
      action: {
        id: "leave",
        action: "tap" as const,
        target: {
          platform: "web" as const,
          by: "role" as const,
          value: "button",
          name: "Leave",
        },
      },
    },
    {
      name: "press",
      path: "/external-press",
      action: { id: "leave", action: "press" as const, key: "Enter" },
    },
  ])("blocks external navigation caused by $name before checkpoint evidence", async ({
    path,
    action,
  }) => {
    externalRequests = 0
    const plan = minimalPlan({
      baseUrl,
      path,
      steps: [
        action,
        { id: "capture", action: "checkpoint", checkpointId: "page" },
      ],
    })
    const bundle = await captureGuardPlan(plan)

    expect(bundle.status).toBe("failed")
    expect(bundle.completeness.capturedRequired).toBe(0)
    // Keyboard input can return before its asynchronous navigation request.
    // The boundary must reject the action or the following checkpoint and
    // retain no evidence, regardless of protocol event ordering.
    expect(bundle.stepResults).toContainEqual(expect.objectContaining({
      status: "failed", origin: "product", errorCode: "candidate-origin-escaped",
    }))
    expect(bundle.stepResults.find((step) => step.stepId === "capture")?.status).not.toBe("passed")
    expect(externalRequests).toBe(0)
  }, 30_000)

  it("fails closed when an undeclared popup is created during trace finalization", async () => {
    traceFinalizationStarted = false
    const plan = minimalPlan({
      baseUrl,
      path: "/finalization-popup-launcher",
      steps: [
        {
          id: "schedule-popup",
          action: "tap",
          target: {
            platform: "web",
            by: "role",
            value: "button",
            name: "Open finalization popup",
          },
        },
        { id: "capture", action: "checkpoint", checkpointId: "page" },
      ],
    })
    plan.requiredCapabilities.push("trace")
    const checkpoint = (
      plan as unknown as {
        checkpoints: Array<{ requiredChannels: CaptureCapability[] }>
      }
    ).checkpoints[0]
    checkpoint.requiredChannels.push("trace")
    plan.planDigest = canonicalDigest(plan, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    })

    const bundle = await captureGuardPlan(
      plan,
      undefined,
      undefined,
      async () => {
        traceFinalizationStarted = true
        await new Promise((resolve) => setTimeout(resolve, 250))
      },
    )

    expect(bundle.status).toBe("failed")
    expect(bundle.stepResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "capture", status: "passed" }),
      ]),
    )
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "runner",
          code: "unsupported-popup-created",
          retryable: false,
        }),
      ]),
    )
  }, 30_000)

  it("blocks the first external navigation request of a popup", async () => {
    externalRequests = 0
    const plan = minimalPlan({
      baseUrl,
      path: "/external-popup",
      steps: [
        {
          id: "open-external",
          action: "tap",
          target: {
            platform: "web",
            by: "role",
            value: "button",
            name: "Open external",
          },
        },
        {
          id: "settle",
          action: "waitFor",
          condition: "app-ready",
          timeoutMs: 1_000,
        },
        { id: "capture", action: "checkpoint", checkpointId: "page" },
      ],
    })
    const bundle = await captureGuardPlan(plan)

    expect(bundle.status).toBe("failed")
    expect(bundle.completeness.capturedRequired).toBe(0)
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "product",
          code: "candidate-origin-escaped",
          retryable: false,
        }),
      ]),
    )
    expect(externalRequests).toBe(0)
  }, 30_000)

  it.each([
    "/same-origin-popup-500-launcher",
    "/same-origin-popup-error-launcher",
  ])("fails closed when %s creates an undeclared popup", async (path) => {
    const plan = minimalPlan({
      baseUrl,
      path,
      steps: [
        {
          id: "open-popup",
          action: "tap",
          target: {
            platform: "web",
            by: "role",
            value: "button",
            name: "Open popup",
          },
        },
        { id: "capture", action: "checkpoint", checkpointId: "page" },
      ],
    })
    const bundle = await captureGuardPlan(plan)

    expect(bundle.status).toBe("failed")
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "runner",
          code: "unsupported-popup-created",
          retryable: false,
        }),
      ]),
    )
    expect(bundle.stepResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          origin: "runner",
          errorCode: "unsupported-popup-created",
        }),
      ]),
    )
    // The popup event may reject the click or the following checkpoint.
    // Either timing must block capture with the same non-retryable failure.
    const captureStep = bundle.stepResults.find((step) => step.stepId === "capture")
    expect(captureStep).toMatchObject({
      origin: "runner",
      errorCode: "unsupported-popup-created",
    })
    expect(["failed", "not-executed"]).toContain(captureStep?.status)
  }, 30_000)

  it("blocks authenticated cross-origin fetch before request data can leave", async () => {
    externalRequests = 0
    const candidateOrigin = new URL(baseUrl).origin
    const bundle = await captureGuardPlan(
      minimalPlan({
        baseUrl,
        path: "/external-fetch",
        steps: [
          {
            id: "ready",
            action: "waitFor",
            condition: "app-ready",
            timeoutMs: 5_000,
          },
          { id: "capture", action: "checkpoint", checkpointId: "page" },
        ],
      }),
      undefined,
      {
        cookies: [
          {
            name: "market_country",
            value: "CHN",
            domain: new URL(baseUrl).hostname,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [
          {
            origin: candidateOrigin,
            localStorage: [
              { name: "session-token", value: "must-not-leave" },
            ],
          },
        ],
      },
    )

    expect(
      bundle.status,
      JSON.stringify(
        {
          errors: bundle.executionErrors,
          steps: bundle.stepResults,
          externalRequests,
        },
        null,
        2,
      ),
    ).toBe("failed")
    expect(bundle.executionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "runner",
          code: "auth-cross-origin-egress-blocked",
          retryable: false,
        }),
      ]),
    )
    expect(externalRequests).toBe(0)
  }, 30_000)

  it("allows explicitly public origin-scoped state to load public dependencies", async () => {
    externalRequests = 0
    const bundle = await captureGuardPlan(
      minimalPlan({
        baseUrl,
        path: "/external-fetch",
        steps: [
          {
            id: "ready",
            action: "waitFor",
            condition: "app-ready",
            timeoutMs: 5_000,
          },
          { id: "capture", action: "checkpoint", checkpointId: "page" },
        ],
      }),
      undefined,
      {
        cookies: [
          {
            name: "market_country",
            value: "CHN",
            domain: new URL(baseUrl).hostname,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      undefined,
      "public-state",
    )

    expect(bundle.status).toBe("completed")
    expect(externalRequests).toBe(1)
    expect(bundle.executionErrors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "auth-cross-origin-egress-blocked" }),
      ]),
    )
  }, 30_000)

  it("aborts a live navigation and returns only after owned browser resources close", async () => {
    const controller = new AbortController()
    let startedAt: number | undefined
    // Abort a confirmed in-flight request, not a machine-dependent browser
    // startup phase. The five-second budget measures cancellation cleanup.
    onHangNavigation = () => {
      startedAt = Date.now()
      controller.abort()
    }
    try {
      const bundle = await captureGuardPlan(
        minimalPlan({ baseUrl, path: "/hang" }),
        controller.signal,
      )

      expect(startedAt).toBeDefined()
      expect(Date.now() - startedAt!).toBeLessThan(5_000)
      expect(bundle.status).toBe("failed")
      expect(bundle.completeness.capturedRequired).toBe(0)
      expect(bundle.executionErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: "runner",
            code: "capture-aborted",
            retryable: false,
          }),
        ]),
      )
    } finally {
      onHangNavigation = undefined
      controller.abort()
    }
  }, 30_000)
})
