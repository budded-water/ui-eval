import { describe, expect, it } from "vitest"

import {
  PLAYWRIGHT_CAPTURE_ADAPTER_ID,
  PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
  PLAYWRIGHT_CAPTURE_CAPABILITIES,
} from "../capture-playwright/adapter"
import { canonicalDigest } from "../contracts/canonical-json"
import type {
  ArtifactRef,
  CaptureBundleSpec,
  CaptureCapability,
  Digest,
  WebResolvedScenarioPlan,
} from "../contracts/model"
import {
  assertCaptureContract,
  CaptureContractError,
  captureContractIssues,
  type CaptureContractInput,
} from "./capture-contract"

function digest(character: string): Digest {
  return `sha256:${character.repeat(64)}`
}

const renderSpace = {
  logicalWidth: 1440,
  logicalHeight: 900,
  logicalUnit: "css-px" as const,
  deviceScaleFactor: 1,
  screenshotWidthPx: 1440,
  screenshotHeightPx: 900,
  orientation: "landscape" as const,
}

const sourceRevision = {
  repository: "repository",
  commitSha: "abc123",
  dirtyTree: false,
}

const build = {
  platform: "web" as const,
  artifactDigest: digest("1"),
  buildConfigDigest: digest("2"),
  publicEnvironmentDigest: digest("3"),
}

const plan: WebResolvedScenarioPlan = {
  scenarioId: "checkout-desktop",
  scenarioRevision: 1,
  scenarioDigest: digest("4"),
  planDigest: digest("5"),
  visibility: "agent-visible",
  target: {
    platform: "web",
    entrypoint: { baseUrl: "http://127.0.0.1:3000", path: "/checkout" },
  },
  variant: {
    variantKey: "desktop-en-light",
    values: { deviceProfile: "desktop", locale: "en", theme: "light" },
    contextDigest: digest("6"),
  },
  device: { profileId: "desktop", renderSpace },
  locale: "en",
  theme: "light",
  determinism: { timezone: "UTC", clock: { mode: "real" } },
  fixtures: [],
  requiredCapabilities: ["screenshot", "console"],
  fixtureDigests: [],
  evidenceRequestDigest: digest("7"),
  captureConfigDigest: digest("8"),
  setup: [{ id: "open", action: "goto", path: "/checkout" }],
  steps: [
    {
      id: "assert-main",
      action: "assert",
      assertion: {
        id: "main-visible",
        kind: "visible",
        target: { platform: "web", by: "css", value: "main" },
        expected: true,
      },
    },
    { id: "capture-ready", action: "checkpoint", checkpointId: "ready" },
  ],
  cleanup: [
    {
      id: "wait-before-close",
      action: "waitFor",
      target: { platform: "web", by: "css", value: "main" },
      condition: "visible",
    },
  ],
  checkpoints: [
    {
      id: "ready",
      requiredChannels: ["screenshot", "console"],
      captureScope: "viewport",
      stabilize: {
        disableAnimations: true,
        waitForFonts: true,
        stableFrames: 2,
        timeoutMs: 5_000,
      },
      assertions: [{ id: "no-crash", kind: "no-crash", expected: true }],
    },
  ],
}

function artifact(channel: CaptureCapability, character: string): ArtifactRef {
  const value = digest(character)
  return {
    id: value,
    projectId: "project",
    storeId: "local-cas-v1",
    digest: value,
    mediaType: channel === "screenshot" ? "image/png" : "application/json",
    sizeBytes: 1,
    sensitivity: "internal",
  }
}

const context = {
  executionId: "run-1",
  runManifestDigest: digest("9"),
  captureKey: digest("a"),
  sourceRevision,
  build,
}

const expectedAdapter = {
  id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
  version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
  platform: "web" as const,
  capabilities: PLAYWRIGHT_CAPTURE_CAPABILITIES,
  browserOrDevice: "chromium:playwright",
}

function validCapture(): CaptureBundleSpec {
  const environmentBase = {
    os: "test",
    architecture: "test",
    rendererProfile: "desktop",
    browserOrDevice: expectedAdapter.browserOrDevice,
    browserOrOsVersion: "1",
    driverVersion: "1",
    locale: "en",
    timezone: "UTC",
    fontSetDigest: digest("b"),
  }
  return {
    executionId: context.executionId,
    runManifestDigest: context.runManifestDigest,
    captureKey: context.captureKey,
    scenarioId: plan.scenarioId,
    variant: structuredClone(plan.variant),
    sourceRevision: structuredClone(sourceRevision),
    build: structuredClone(build),
    adapter: {
      id: expectedAdapter.id,
      version: expectedAdapter.version,
      platform: expectedAdapter.platform,
    },
    environment: {
      ...environmentBase,
      environmentDigest: canonicalDigest(environmentBase),
    },
    // Deliberately use a different order from the expected adapter declaration.
    capabilities: [...PLAYWRIGHT_CAPTURE_CAPABILITIES].reverse(),
    status: "completed",
    completeness: {
      expectedRequired: 2,
      capturedRequired: 2,
      missingRequired: 0,
    },
    // Result ordering is operational; coverage is keyed by sealed IDs.
    stepResults: [
      { stepId: "capture-ready", status: "passed", origin: "product" },
      { stepId: "open", status: "passed", origin: "product" },
      { stepId: "wait-before-close", status: "passed", origin: "product" },
      { stepId: "assert-main", status: "passed", origin: "product" },
    ],
    assertionResults: [
      {
        assertionId: "no-crash",
        checkpointId: "ready",
        status: "passed",
        origin: "product",
      },
      {
        assertionId: "main-visible",
        stepId: "assert-main",
        status: "passed",
        origin: "product",
      },
    ],
    checkpoints: [
      {
        checkpointId: "ready",
        renderSpace: structuredClone(renderSpace),
        capturedAt: "2026-08-10T00:00:00.000Z",
        evidence: [
          {
            channel: "console",
            required: true,
            status: "captured",
            artifact: artifact("console", "d"),
          },
          {
            channel: "screenshot",
            required: true,
            status: "captured",
            artifact: artifact("screenshot", "e"),
          },
        ],
      },
    ],
  }
}

function input(capture = validCapture()): CaptureContractInput {
  return { capture, plan, context, expectedAdapter }
}

describe("assertCaptureContract", () => {
  it("accepts an exact, order-independent binding and returns the capture", () => {
    const capture = validCapture()

    expect(assertCaptureContract(input(capture))).toBe(capture)
    expect(captureContractIssues(input(capture))).toEqual([])
  })

  it("rejects a stale or foreign execution identity", () => {
    const capture = validCapture()
    capture.executionId = "old-run"
    capture.runManifestDigest = digest("f")
    capture.captureKey = digest("0")
    capture.scenarioId = "other-scenario"
    capture.variant.variantKey = "mobile"
    capture.sourceRevision.commitSha = "old-commit"
    capture.build.artifactDigest = digest("f")

    const issues = captureContractIssues(input(capture))
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "/executionId",
        "/runManifestDigest",
        "/captureKey",
        "/scenarioId",
        "/variant",
        "/sourceRevision",
        "/build",
      ]),
    )
    let thrown: unknown
    try {
      assertCaptureContract(input(capture))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CaptureContractError)
    expect(thrown).toMatchObject({
      code: "CAPTURE_CONTRACT_MISMATCH",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "/executionId" }),
      ]),
    })
  })

  it("requires the explicitly selected adapter identity and capabilities", () => {
    const capture = validCapture()
    capture.adapter.id = "foreign.capture"
    capture.adapter.version = "9.9.9"
    capture.adapter.platform = "ios"
    capture.capabilities = ["screenshot", "dom", "performance", "performance"]

    const issues = captureContractIssues(input(capture))
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/adapter/id", code: "value-mismatch" }),
        expect.objectContaining({
          path: "/adapter/version",
          code: "value-mismatch",
        }),
        expect.objectContaining({
          path: "/adapter/platform",
          code: "value-mismatch",
        }),
        expect.objectContaining({ path: "/capabilities", code: "missing-id" }),
        expect.objectContaining({
          path: "/capabilities",
          code: "unexpected-id",
        }),
        expect.objectContaining({ path: "/capabilities", code: "duplicate-id" }),
      ]),
    )
  })

  it("binds the runtime environment to the plan and its own digest", () => {
    const capture = validCapture()
    capture.environment.rendererProfile = "mobile"
    capture.environment.locale = "fr"
    capture.environment.timezone = "Europe/Paris"
    capture.environment.browserOrDevice = "chromium:chrome"

    const issues = captureContractIssues(input(capture))
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/environment/rendererProfile",
          code: "value-mismatch",
        }),
        expect.objectContaining({
          path: "/environment/locale",
          code: "value-mismatch",
        }),
        expect.objectContaining({
          path: "/environment/timezone",
          code: "value-mismatch",
        }),
        expect.objectContaining({
          path: "/environment/browserOrDevice",
          code: "value-mismatch",
        }),
        expect.objectContaining({
          path: "/environment/environmentDigest",
          code: "value-mismatch",
        }),
      ]),
    )
  })

  it("rejects missing, extra, and duplicate step or assertion results", () => {
    const capture = validCapture()
    capture.stepResults = [
      capture.stepResults[0],
      capture.stepResults[1],
      capture.stepResults[1],
      { stepId: "foreign-step", status: "passed", origin: "product" },
    ]
    capture.assertionResults = [
      capture.assertionResults[0],
      capture.assertionResults[0],
      {
        assertionId: "foreign-assertion",
        status: "passed",
        origin: "product",
      },
    ]

    const issues = captureContractIssues(input(capture))
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/stepResults", code: "missing-id" }),
        expect.objectContaining({ path: "/stepResults", code: "unexpected-id" }),
        expect.objectContaining({ path: "/stepResults", code: "duplicate-id" }),
        expect.objectContaining({
          path: "/assertionResults/2",
          code: "invalid-assertion-binding",
        }),
        expect.objectContaining({
          path: "/assertionResults",
          code: "missing-id",
        }),
        expect.objectContaining({
          path: "/assertionResults",
          code: "duplicate-id",
        }),
      ]),
    )
  })

  it("binds assertion metric kinds to the declared assertion semantics", () => {
    const capture = validCapture()
    const visible = capture.assertionResults.find(
      (result) => result.assertionId === "main-visible",
    )!
    visible.expected = { kind: "color", value: "token=must-not-escape" }
    visible.actual = { kind: "number", value: 1, unit: "secret-unit" }

    expect(captureContractIssues(input(capture))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/\/expected$/),
          code: "assertion-metric-kind-mismatch",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/\/actual$/),
          code: "assertion-metric-kind-mismatch",
        }),
      ]),
    )
    expect(() => assertCaptureContract(input(capture))).toThrow(
      CaptureContractError,
    )
  })

  it("binds checkpoint IDs, render space, required flags, and channel coverage", () => {
    const capture = validCapture()
    const ready = capture.checkpoints[0]
    ready.renderSpace.logicalWidth = 1280
    ready.evidence = [
      {
        channel: "screenshot",
        required: false,
        status: "captured",
        artifact: artifact("screenshot", "e"),
      },
      {
        channel: "network",
        required: false,
        status: "captured",
        artifact: artifact("network", "f"),
      },
      {
        channel: "network",
        required: false,
        status: "captured",
        artifact: artifact("network", "f"),
      },
    ]
    capture.checkpoints.push(structuredClone(ready))
    capture.checkpoints.push({ ...structuredClone(ready), checkpointId: "foreign" })

    const issues = captureContractIssues(input(capture))
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/checkpoints", code: "duplicate-id" }),
        expect.objectContaining({ path: "/checkpoints", code: "unexpected-id" }),
        expect.objectContaining({
          path: "/checkpoints/0/renderSpace",
          code: "value-mismatch",
        }),
        expect.objectContaining({
          path: "/checkpoints/0/evidence",
          code: "missing-id",
        }),
        expect.objectContaining({
          path: "/checkpoints/0/evidence",
          code: "unexpected-id",
        }),
        expect.objectContaining({
          path: "/checkpoints/0/evidence",
          code: "duplicate-id",
        }),
        expect.objectContaining({
          path: "/checkpoints/0/evidence/0/required",
          code: "required-flag-mismatch",
        }),
      ]),
    )
  })

  it("accepts a self-consistent full-page render space derived at runtime", () => {
    const fullPagePlan = structuredClone(plan) as WebResolvedScenarioPlan & {
      checkpoints: Array<{
        captureScope: "viewport" | "full-page" | "element"
      }>
    }
    fullPagePlan.checkpoints[0].captureScope = "full-page"
    const capture = validCapture()
    capture.checkpoints[0].renderSpace = {
      ...renderSpace,
      logicalHeight: 2400,
      screenshotHeightPx: 2400,
      orientation: "portrait",
    }

    expect(
      captureContractIssues({
        ...input(capture),
        plan: fullPagePlan,
      }),
    ).toEqual([])
  })

  it("rejects a missing checkpoint even when a foreign checkpoint is present", () => {
    const capture = validCapture()
    capture.checkpoints[0].checkpointId = "foreign"

    expect(captureContractIssues(input(capture))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/checkpoints", code: "missing-id" }),
        expect.objectContaining({
          path: "/checkpoints",
          code: "unexpected-id",
        }),
      ]),
    )
  })
})
