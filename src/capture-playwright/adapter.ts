import { arch, platform as operatingSystem } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Locator,
  type Page,
  type Request,
  type Route,
  type Response,
} from "playwright"

import { canonicalDigest } from "../contracts/canonical-json"
import type {
  ArtifactRef,
  AssertionResult,
  AssertionSpec,
  BuildIdentity,
  CaptureBundleSpec,
  CaptureCapability,
  CapturedCheckpoint,
  EvidenceRecord,
  ExecutionEnvironment,
  ExecutionError,
  MetricValue,
  RenderSpace,
  SourceRevision,
  StepResult,
  WebCheckpointSpec,
  WebResolvedScenarioPlan as ContractWebResolvedScenarioPlan,
  WebRuntimeLocator,
  WebScenarioStep,
} from "../contracts/model"
import { validateResolvedScenarioPlan } from "../contracts/validation"
import type { LocalArtifactStore } from "../storage-local/artifact-store"
import {
  assertScreenshotRenderSpaceWithinBudget,
  BinaryEvidenceValidationError,
  inspectPngHeader,
  readBoundedEvidenceFile,
} from "./binary-evidence"
import {
  CaptureOperationError,
  classifyMainDocumentResponse,
  classifyNetworkObservation,
  classifyStepFailure,
  productPageError,
} from "./classification"
import {
  captureDomEvidence,
  consolePayload,
  crashPayload,
  createRuntimeEvidenceCollector,
  MAX_ASSERTION_TEXT_PREVIEW_BYTES,
  networkPayload,
  redactText,
  sanitizeAssertionMetric,
  type CollectedRuntimeEvidence,
  type DomEvidenceSet,
} from "./evidence"
import { webLocator } from "./locator"
import { stabilizePage } from "./stabilize"

export const PLAYWRIGHT_CAPTURE_ADAPTER_ID = "uieval.playwright.chromium"
export const PLAYWRIGHT_CAPTURE_ADAPTER_VERSION = "0.1.0"
export const PLAYWRIGHT_CAPTURE_ABORTED_CODE = "capture-aborted"

const SECURITY_BOUNDARY_FAILURE_CODES = new Set([
  "auth-cross-origin-egress-blocked",
  "candidate-origin-escaped",
  "candidate-response-preflight-failed",
  "unsupported-popup-created",
])

const playwrightDriverVersion = (
  createRequire(import.meta.url)("playwright/package.json") as {
    version: string
  }
).version

export const PLAYWRIGHT_CAPTURE_CAPABILITIES = [
  "screenshot",
  "element-screenshots",
  "dom",
  "computed-styles",
  "layout-metadata",
  "console",
  "network",
  "trace",
  "crash",
] as const satisfies readonly CaptureCapability[]

type ArtifactStorePort = Pick<
  LocalArtifactStore,
  "put" | "putJson" | "resolve"
>

export interface CaptureWebScenarioContext {
  executionId: string
  runManifestDigest: `sha256:${string}`
  captureKey: `sha256:${string}`
  sourceRevision: SourceRevision
  build: BuildIdentity
  artifactStore: ArtifactStorePort
  browserLaunchOptions?: LaunchOptions
  browserChannel?: string
  /** Cancels capture and causes owned Playwright resources to be closed. */
  signal?: AbortSignal
}

type WebAssertion = Omit<AssertionSpec, "target"> & {
  target?: WebRuntimeLocator
}

type ExecutableWebStep =
  | Extract<WebScenarioStep, { action: "goto" | "press" }>
  | (Omit<Extract<WebScenarioStep, { action: "tap" }>, "target"> & {
      target: WebRuntimeLocator
    })
  | (Omit<Extract<WebScenarioStep, { action: "fill" }>, "target"> & {
      target: WebRuntimeLocator
    })
  | (Omit<Extract<WebScenarioStep, { action: "waitFor" }>, "target"> & {
      target?: WebRuntimeLocator
    })
  | (Omit<Extract<WebScenarioStep, { action: "assert" }>, "assertion"> & {
      assertion: WebAssertion
    })
  | Extract<WebScenarioStep, { action: "checkpoint" }>

type ExecutableWebCheckpoint = Omit<
  WebCheckpointSpec,
  "target" | "assertions"
> & {
  target?: WebRuntimeLocator
  assertions?: WebAssertion[]
}

type WebResolvedScenarioPlan = Omit<
  ContractWebResolvedScenarioPlan,
  "target" | "setup" | "steps" | "cleanup" | "checkpoints"
> & {
  target: {
    platform: "web"
    entrypoint: { baseUrl: string; path: string }
  }
  setup: ExecutableWebStep[]
  steps: ExecutableWebStep[]
  cleanup: ExecutableWebStep[]
  checkpoints: ExecutableWebCheckpoint[]
}

interface AssertionExecution {
  result: AssertionResult
  error?: ExecutionError
}

interface CheckpointExecution {
  checkpoint: CapturedCheckpoint
  succeeded: boolean
  origin: StepResult["origin"]
  errorCode?: string
}

interface CaptureState {
  page: Page
  plan: WebResolvedScenarioPlan
  context: CaptureWebScenarioContext
  runtimeEvidence: CollectedRuntimeEvidence
  checkpoints: CapturedCheckpoint[]
  checkpointIds: Set<string>
  assertionResults: AssertionResult[]
  executionErrors: ExecutionError[]
  fontFamilies: Set<string>
  activePhase: ExecutionError["phase"]
  activeStepId?: string
  candidateOrigin: string
  attemptedExternalOrigin?: string
  blockedAuthEgressOrigin?: string
  boundaryFailure?: CaptureOperationError
  unsupportedPopupCreated?: boolean
  mainDocumentStatus?: number
}

function driverVersion(): string {
  return playwrightDriverVersion
}

function environmentFor(
  plan: WebResolvedScenarioPlan,
  browserVersion: string,
  fontFamilies: readonly string[],
  browserChannel?: string,
): ExecutionEnvironment {
  const base = {
    os: operatingSystem(),
    architecture: arch(),
    rendererProfile: plan.device.profileId,
    browserOrDevice: browserChannel
      ? `chromium:${browserChannel}`
      : "chromium:playwright",
    browserOrOsVersion: browserVersion,
    driverVersion: driverVersion(),
    locale: plan.locale,
    timezone: plan.determinism.timezone,
    fontSetDigest: canonicalDigest([...fontFamilies].sort()),
  }
  return {
    ...base,
    environmentDigest: canonicalDigest(base),
  }
}

function requiredChannelCount(plan: WebResolvedScenarioPlan): number {
  return plan.checkpoints.reduce(
    (count, checkpoint) => count + checkpoint.requiredChannels.length,
    0,
  )
}

function missingCheckpoint(
  plan: WebResolvedScenarioPlan,
  checkpoint: ExecutableWebCheckpoint,
  code: string,
  message: string,
): CapturedCheckpoint {
  return {
    checkpointId: checkpoint.id,
    renderSpace: plan.device.renderSpace,
    capturedAt: new Date().toISOString(),
    evidence: checkpoint.requiredChannels.map((channel) => ({
      channel,
      required: true,
      status: "missing",
      error: { code, message },
    })),
  }
}

function declaredAssertions(
  plan: WebResolvedScenarioPlan,
): Array<{ assertion: WebAssertion; stepId?: string; checkpointId?: string }> {
  const steps = [...plan.setup, ...plan.steps, ...plan.cleanup]
    .filter(
      (step): step is Extract<ExecutableWebStep, { action: "assert" }> =>
        step.action === "assert",
    )
    .map((step) => ({ assertion: step.assertion, stepId: step.id }))
  const checkpoints = plan.checkpoints.flatMap((checkpoint) =>
    (checkpoint.assertions ?? []).map((assertion) => ({
      assertion,
      checkpointId: checkpoint.id,
    })),
  )
  return [...steps, ...checkpoints]
}

function failedBundle(
  plan: WebResolvedScenarioPlan,
  context: CaptureWebScenarioContext,
  error: ExecutionError,
): CaptureBundleSpec {
  const allSteps = [...plan.setup, ...plan.steps, ...plan.cleanup]
  const expectedRequired = requiredChannelCount(plan)
  return {
    executionId: context.executionId,
    runManifestDigest: context.runManifestDigest,
    captureKey: context.captureKey,
    scenarioId: plan.scenarioId,
    variant: plan.variant,
    sourceRevision: context.sourceRevision,
    build: context.build,
    adapter: {
      id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
      version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
      platform: "web",
    },
    environment: environmentFor(
      plan,
      "unavailable",
      [],
      context.browserChannel,
    ),
    capabilities: [...PLAYWRIGHT_CAPTURE_CAPABILITIES],
    status: "failed",
    completeness: {
      expectedRequired,
      capturedRequired: 0,
      missingRequired: expectedRequired,
    },
    stepResults: allSteps.map((step) => ({
      stepId: step.id,
      status: "not-executed",
      origin: error.origin === "fixture" ? "fixture" : error.origin === "driver" ? "driver" : "runner",
      errorCode: error.code,
    })),
    assertionResults: declaredAssertions(plan).map(
      ({ assertion, stepId, checkpointId }) => ({
        assertionId: assertion.id,
        ...(stepId === undefined ? {} : { stepId }),
        ...(checkpointId === undefined ? {} : { checkpointId }),
        status: "not-evaluated",
        origin:
          error.origin === "fixture"
            ? "fixture"
            : error.origin === "driver"
              ? "driver"
              : "runner",
      }),
    ),
    checkpoints: plan.checkpoints.map((checkpoint) =>
      missingCheckpoint(plan, checkpoint, error.code, error.message),
    ),
    executionErrors: [error],
  }
}

function validatePlan(
  plan: WebResolvedScenarioPlan,
  context: CaptureWebScenarioContext,
): void {
  validateResolvedScenarioPlan(plan)
  if (plan.target.platform !== "web") {
    throw new CaptureOperationError("Playwright adapter requires a web plan", {
      origin: "runner",
      code: "unsupported-platform",
      retryable: false,
    })
  }
  if (context.build.platform !== "web") {
    throw new CaptureOperationError("Playwright adapter requires a web build", {
      origin: "runner",
      code: "build-platform-mismatch",
      retryable: false,
    })
  }
  if ((plan.auth?.secretRefs?.length ?? 0) > 0) {
    throw new CaptureOperationError(
      "Phase 0A cannot resolve or inject auth.secretRefs",
      {
        origin: "runner",
        code: "unsupported-auth-secret-refs",
        retryable: false,
      },
    )
  }

  const renderSpace = plan.device.renderSpace
  if (
    renderSpace.logicalUnit !== "css-px" ||
    !Number.isInteger(renderSpace.logicalWidth) ||
    !Number.isInteger(renderSpace.logicalHeight) ||
    renderSpace.screenshotWidthPx !==
      Math.round(renderSpace.logicalWidth * renderSpace.deviceScaleFactor) ||
    renderSpace.screenshotHeightPx !==
      Math.round(renderSpace.logicalHeight * renderSpace.deviceScaleFactor)
  ) {
    throw new CaptureOperationError("Web renderSpace is internally inconsistent", {
      origin: "runner",
      code: "invalid-render-space",
      retryable: false,
    })
  }

  const needsScreenshot = plan.checkpoints.some((checkpoint) =>
    checkpoint.requiredChannels.some(
      (channel) =>
        channel === "screenshot" || channel === "element-screenshots",
    ),
  )
  if (needsScreenshot) {
    assertScreenshotRenderSpaceWithinBudget(renderSpace)
  }

  const supported = new Set<CaptureCapability>(PLAYWRIGHT_CAPTURE_CAPABILITIES)
  const unsupported = new Set(
    [
      ...plan.requiredCapabilities,
      ...plan.checkpoints.flatMap((checkpoint) => checkpoint.requiredChannels),
    ].filter((capability) => !supported.has(capability)),
  )
  if (unsupported.size > 0) {
    throw new CaptureOperationError(
      `Playwright adapter does not support: ${[...unsupported].join(", ")}`,
      {
        origin: "runner",
        code: "unsupported-capability",
        retryable: false,
      },
    )
  }

  const declared = new Set(plan.requiredCapabilities)
  const undeclared = plan.checkpoints
    .flatMap((checkpoint) => checkpoint.requiredChannels)
    .filter((channel) => !declared.has(channel))
  if (undeclared.length > 0) {
    throw new CaptureOperationError(
      `Checkpoint requires undeclared capabilities: ${[...new Set(undeclared)].join(", ")}`,
      {
        origin: "runner",
        code: "undeclared-checkpoint-capability",
        retryable: false,
      },
    )
  }
}

function executionError(
  error: unknown,
  phase: ExecutionError["phase"],
  operation: Parameters<typeof classifyStepFailure>[1],
  stepId?: string,
): ExecutionError {
  const classification = classifyStepFailure(error, operation)
  return {
    origin: classification.origin,
    phase,
    code: classification.code,
    message: redactText(error instanceof Error ? error.message : String(error)),
    retryable: classification.retryable,
    ...(stepId === undefined ? {} : { stepId }),
  }
}

function captureAbortedError(
  phase: ExecutionError["phase"] = "prepare",
  stepId?: string,
): ExecutionError {
  return {
    origin: "runner",
    phase,
    code: PLAYWRIGHT_CAPTURE_ABORTED_CODE,
    message: "Capture was aborted",
    retryable: false,
    ...(stepId === undefined ? {} : { stepId }),
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw new CaptureOperationError("Capture was aborted", {
    origin: "runner",
    code: PLAYWRIGHT_CAPTURE_ABORTED_CODE,
    retryable: false,
  })
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined
  } catch {
    return undefined
  }
}

function isTopLevelNavigationRequest(request: Request): boolean {
  if (!request.isNavigationRequest()) return false
  try {
    return request.frame().parentFrame() === null
  } catch {
    // Playwright intentionally has no Frame yet for the first navigation of a
    // popup. Context routing is the only interception point for that request,
    // so treat an unavailable frame as top-level and fail closed.
    return true
  }
}

const UNSUPPORTED_POPUP_MESSAGE =
  "Phase 0A cannot prove complete evidence for multi-page or popup scenarios"

function unsupportedPopupFailure(): CaptureOperationError {
  return new CaptureOperationError(UNSUPPORTED_POPUP_MESSAGE, {
    origin: "runner",
    code: "unsupported-popup-created",
    retryable: false,
  })
}

function recordAttemptedExternalOrigin(
  state: CaptureState,
  origin: string,
): void {
  state.attemptedExternalOrigin = origin
  // A popup may be observed before its first routed request. Once the routed
  // destination proves an external escape, retain the more precise product
  // classification instead of also turning the run into infrastructure error.
  state.executionErrors = state.executionErrors.filter(
    (error) => error.code !== "unsupported-popup-created",
  )
}

function candidateOriginError(
  state: CaptureState,
): CaptureOperationError | undefined {
  if (state.boundaryFailure) return state.boundaryFailure
  if (state.blockedAuthEgressOrigin) {
    return new CaptureOperationError(
      `Authenticated capture blocked cross-origin egress to ${state.blockedAuthEgressOrigin}`,
      {
        origin: "runner",
        code: "auth-cross-origin-egress-blocked",
        retryable: false,
      },
    )
  }
  const actualOrigin =
    state.attemptedExternalOrigin ?? safeOrigin(state.page.url()) ?? "non-http(s)"
  if (actualOrigin === state.candidateOrigin) {
    if (!state.unsupportedPopupCreated) return undefined
    return unsupportedPopupFailure()
  }
  return new CaptureOperationError(
    `Candidate top-level navigation escaped ${state.candidateOrigin} to ${actualOrigin}`,
    {
      origin: "product",
      code: "candidate-origin-escaped",
      retryable: false,
    },
  )
}

function planOperationTimeout(plan: WebResolvedScenarioPlan): number {
  return Math.max(
    ...plan.checkpoints.map(
      (checkpoint) => checkpoint.stabilize.timeoutMs,
    ),
  )
}

async function candidateRouteResponse(
  route: Route,
  state: CaptureState,
  topLevel: boolean,
): Promise<void> {
  const request = route.request()
  const response = await route
    .fetch({
      maxRedirects: 0,
      timeout: planOperationTimeout(state.plan),
    })
    .catch(() => undefined)
  if (!response) {
    state.boundaryFailure = new CaptureOperationError(
      "Candidate response preflight could not be completed",
      {
        origin: "runner",
        code: "candidate-response-preflight-failed",
        retryable: true,
      },
    )
    await route.abort()
    return
  }

  const location = response.headers().location
  if (response.status() >= 300 && response.status() < 400 && location) {
    const redirectedOrigin =
      safeOrigin(new URL(location, request.url()).toString()) ?? "non-http(s)"
    if (redirectedOrigin !== state.candidateOrigin) {
      if (topLevel) recordAttemptedExternalOrigin(state, redirectedOrigin)
      else state.blockedAuthEgressOrigin = redirectedOrigin
      await response.dispose()
      await route.abort()
      return
    }
  }

  try {
    await route.fulfill({ response })
  } finally {
    await response.dispose().catch(() => undefined)
  }
}

function assertCandidateOrigin(state: CaptureState): void {
  const failure = candidateOriginError(state)
  if (failure) throw failure
}

function stateExecutionError(
  error: unknown,
  state: CaptureState,
  phase: ExecutionError["phase"],
  operation: Parameters<typeof classifyStepFailure>[1],
  stepId?: string,
): ExecutionError {
  if (state.context.signal?.aborted) return captureAbortedError(phase, stepId)
  const originFailure = candidateOriginError(state)
  return executionError(originFailure ?? error, phase, operation, stepId)
}

function recordUnsupportedPopup(state: CaptureState): void {
  state.unsupportedPopupCreated = true
  if (
    state.attemptedExternalOrigin ||
    state.executionErrors.some(
      (error) => error.code === "unsupported-popup-created",
    )
  ) {
    return
  }
  state.executionErrors.push(
    stateExecutionError(
      unsupportedPopupFailure(),
      state,
      state.activePhase,
      "driver",
      state.activeStepId,
    ),
  )
}

function recordTerminalBoundaryFailure(state: CaptureState): void {
  const failure = candidateOriginError(state)
  if (!failure) return
  const terminal = executionError(
    failure,
    state.activePhase,
    "driver",
    state.activeStepId,
  )
  if (
    state.executionErrors.some(
      (error) => error.origin === terminal.origin && error.code === terminal.code,
    )
  ) {
    return
  }
  state.executionErrors.push(terminal)
}

function assertMainDocumentResponse(
  response: Response | null,
  phase: ExecutionError["phase"],
  stepId?: string,
): void {
  if (!response) return
  const failure = classifyMainDocumentResponse(response.status(), phase, stepId)
  if (!failure) return
  throw new CaptureOperationError(failure.message, {
    origin: "product",
    code: failure.code,
    retryable: false,
  })
}

function assertCurrentMainDocument(
  state: CaptureState,
  phase: ExecutionError["phase"],
  stepId?: string,
): void {
  if (state.mainDocumentStatus === undefined) return
  const failure = classifyMainDocumentResponse(
    state.mainDocumentStatus,
    phase,
    stepId,
  )
  if (!failure) return
  throw new CaptureOperationError(failure.message, {
    origin: "product",
    code: failure.code,
    retryable: false,
  })
}

function resultOrigin(
  origin: ExecutionError["origin"],
): StepResult["origin"] {
  return origin === "external-service" ? "runner" : origin
}

function assertionFailure(
  assertion: WebAssertion,
  origin: AssertionResult["origin"],
  status: AssertionResult["status"],
  options: {
    stepId?: string
    checkpointId?: string
    expected?: MetricValue
    actual?: MetricValue
  },
): AssertionResult {
  return {
    assertionId: assertion.id,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    ...(options.checkpointId === undefined
      ? {}
      : { checkpointId: options.checkpointId }),
    status,
    origin,
    ...(options.expected === undefined
      ? {}
      : { expected: options.expected }),
    ...(options.actual === undefined ? {} : { actual: options.actual }),
  }
}

async function evaluateAssertion(
  page: Page,
  assertion: WebAssertion,
  runtimeEvidence: CollectedRuntimeEvidence,
  baseUrl: string,
  options: { stepId?: string; checkpointId?: string },
): Promise<AssertionExecution> {
  try {
    if (
      ["visible", "hidden", "enabled", "text"].includes(assertion.kind) &&
      assertion.target === undefined
    ) {
      throw new CaptureOperationError("Assertion requires a target locator", {
        origin: "runner",
        code: "assertion-target-missing",
        retryable: false,
      })
    }

    let expected: string | number | boolean
    let actual: string | number | boolean
    let sensitiveTarget = false
    let actualSourceTruncated = false
    let rawValuesMatch: boolean | undefined

    switch (assertion.kind) {
      case "visible":
        expected = true
        actual = await webLocator(page, assertion.target!).isVisible()
        break
      case "hidden":
        expected = true
        actual = !(await webLocator(page, assertion.target!).isVisible())
        break
      case "enabled":
        expected = true
        actual = await webLocator(page, assertion.target!).isEnabled()
        break
      case "text": {
        if (typeof assertion.expected !== "string") {
          throw new CaptureOperationError("Text assertion requires a string expected value", {
            origin: "runner",
            code: "assertion-expected-missing",
            retryable: false,
          })
        }
        expected = assertion.expected
        const locator = webLocator(page, assertion.target!)
        const observation = await locator.evaluate(
          (element, input) => {
            const sensitive = Boolean(
              element.closest(
                '[data-ui-eval-sensitive], [data-sensitive], input[type="password"]',
              ),
            )
            const encoder = new TextEncoder()
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            )
            let started = false
            let matchIndex = 0
            let mismatch = false
            let pendingWhitespace = false
            let pendingMatchIndex = 0
            let pendingMismatch = false
            let preview = ""
            let previewBytes = 0
            let previewOverflow = false
            let pendingPreview = ""
            let pendingPreviewBytes = 0
            let pendingPreviewOverflow = false
            let node = walker.nextNode()

            while (node) {
              for (const character of node.nodeValue ?? "") {
                const whitespace = character.trim().length === 0
                if (!started && whitespace) continue
                if (!started) started = true

                if (whitespace && !pendingWhitespace) {
                  pendingWhitespace = true
                  pendingMatchIndex = matchIndex
                  pendingMismatch = mismatch
                  pendingPreview = preview
                  pendingPreviewBytes = previewBytes
                  pendingPreviewOverflow = previewOverflow
                } else if (!whitespace) {
                  pendingWhitespace = false
                }

                if (
                  input.expected.slice(
                    matchIndex,
                    matchIndex + character.length,
                  ) !== character
                ) {
                  mismatch = true
                }
                matchIndex += character.length

                if (!sensitive) {
                  const characterBytes = encoder.encode(character).byteLength
                  if (
                    !previewOverflow &&
                    previewBytes + characterBytes <= input.maxPreviewBytes
                  ) {
                    preview += character
                    previewBytes += characterBytes
                  } else {
                    previewOverflow = true
                  }
                }
              }
              node = walker.nextNode()
            }

            // Element.textContent.trim() semantics without constructing or
            // UTF-8 encoding the complete hostile value. Whitespace becomes
            // committed only when a later non-whitespace character exists.
            if (pendingWhitespace) {
              matchIndex = pendingMatchIndex
              mismatch = pendingMismatch
              preview = pendingPreview
              previewBytes = pendingPreviewBytes
              previewOverflow = pendingPreviewOverflow
            }
            return {
              matches: !mismatch && matchIndex === input.expected.length,
              sensitive,
              preview,
              truncated: previewOverflow,
            }
          },
          {
            expected,
            maxPreviewBytes: MAX_ASSERTION_TEXT_PREVIEW_BYTES,
          },
        )
        sensitiveTarget = observation.sensitive
        actualSourceTruncated = observation.truncated
        rawValuesMatch = observation.matches
        actual = observation.preview
        break
      }
      case "url": {
        if (typeof assertion.expected !== "string") {
          throw new CaptureOperationError("URL assertion requires a string expected value", {
            origin: "runner",
            code: "assertion-expected-missing",
            retryable: false,
          })
        }
        expected = new URL(assertion.expected, baseUrl).toString()
        actual = page.url()
        break
      }
      case "no-crash":
        expected = true
        actual = runtimeEvidence.crashEntries.length === 0
        break
    }

    return {
      result: assertionFailure(
        assertion,
        "product",
        (rawValuesMatch ?? actual === expected) ? "passed" : "failed",
        {
          ...options,
          expected: sanitizeAssertionMetric(assertion.kind, expected, {
            sensitiveTarget,
          }),
          actual: sanitizeAssertionMetric(assertion.kind, actual, {
            sensitiveTarget,
            sourceTruncated: actualSourceTruncated,
          }),
        },
      ),
    }
  } catch (error) {
    const failure = executionError(
      error,
      options.checkpointId ? "checkpoint" : "action",
      "assertion",
      options.stepId,
    )
    return {
      result: assertionFailure(
        assertion,
        resultOrigin(failure.origin),
        failure.origin === "product" ? "failed" : "not-evaluated",
        options,
      ),
      error: failure,
    }
  }
}

async function checkpointRenderSpace(
  page: Page,
  plan: WebResolvedScenarioPlan,
  checkpoint: ExecutableWebCheckpoint,
  target?: Locator,
): Promise<RenderSpace> {
  if (checkpoint.captureScope === "viewport") return plan.device.renderSpace

  let width: number
  let height: number
  if (checkpoint.captureScope === "element") {
    const box = await target?.boundingBox()
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new CaptureOperationError("Checkpoint target has no visible box", {
        origin: "product",
        code: "checkpoint-target-not-visible",
        retryable: false,
      })
    }
    width = box.width
    height = box.height
  } else {
    const dimensions = await page.evaluate(() => ({
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
        window.innerWidth,
      ),
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
        window.innerHeight,
      ),
    }))
    width = dimensions.width
    height = dimensions.height
  }

  const deviceScaleFactor = plan.device.renderSpace.deviceScaleFactor
  return {
    logicalWidth: width,
    logicalHeight: height,
    logicalUnit: "css-px",
    deviceScaleFactor,
    screenshotWidthPx: Math.max(1, Math.round(width * deviceScaleFactor)),
    screenshotHeightPx: Math.max(1, Math.round(height * deviceScaleFactor)),
    orientation: width >= height ? "landscape" : "portrait",
  }
}

async function storeBytes(
  store: ArtifactStorePort,
  bytes: Uint8Array,
  mediaType: string,
  sensitivity: "public" | "internal" | "sensitive" = "internal",
): Promise<ArtifactRef> {
  try {
    return (await store.put(bytes, { mediaType, sensitivity })) as ArtifactRef
  } catch (error) {
    throw new CaptureOperationError("Failed to seal captured artifact", {
      origin: "runner",
      code: "artifact-write-failed",
      retryable: true,
    }, { cause: error })
  }
}

async function storeJson(
  store: ArtifactStorePort,
  value: unknown,
  sensitivity: "public" | "internal" | "sensitive" = "internal",
): Promise<ArtifactRef> {
  try {
    return (await store.putJson(value, {
      mediaType: "application/json",
      sensitivity,
      redaction: { applied: true, policyId: "uieval.capture-default" },
    })) as ArtifactRef
  } catch (error) {
    throw new CaptureOperationError("Failed to seal captured JSON evidence", {
      origin: "runner",
      code: "artifact-write-failed",
      retryable: true,
    }, { cause: error })
  }
}

async function screenshotBytes(
  page: Page,
  checkpoint: ExecutableWebCheckpoint,
  target?: Locator,
): Promise<Buffer> {
  if (checkpoint.captureScope === "element") {
    if (!target) {
      throw new CaptureOperationError("Element screenshot requires a target", {
        origin: "runner",
        code: "checkpoint-target-missing",
        retryable: false,
      })
    }
    return target.screenshot({
      animations: "disabled",
      caret: "hide",
      timeout: checkpoint.stabilize.timeoutMs,
    })
  }
  return page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: checkpoint.captureScope === "full-page",
    timeout: checkpoint.stabilize.timeoutMs,
  })
}

function capturedRecord(
  channel: CaptureCapability,
  artifact: ArtifactRef,
  coordinateSpace?: RenderSpace,
): EvidenceRecord {
  return {
    channel,
    required: true,
    status: "captured",
    artifact,
    ...(coordinateSpace === undefined ? {} : { coordinateSpace }),
  }
}

function missingRecord(
  channel: CaptureCapability,
  code: string,
  message: string,
): EvidenceRecord {
  return {
    channel,
    required: true,
    status: "missing",
    error: { code, message: redactText(message) },
  }
}

async function captureChannel(
  channel: CaptureCapability,
  checkpoint: ExecutableWebCheckpoint,
  renderSpace: RenderSpace,
  target: Locator | undefined,
  state: CaptureState,
  domEvidence: () => Promise<DomEvidenceSet>,
): Promise<EvidenceRecord> {
  throwIfAborted(state.context.signal)
  assertCandidateOrigin(state)
  assertCurrentMainDocument(
    state,
    "checkpoint",
    state.activeStepId,
  )
  switch (channel) {
    case "screenshot":
    case "element-screenshots": {
      assertScreenshotRenderSpaceWithinBudget(renderSpace)
      const bytes = await screenshotBytes(state.page, checkpoint, target)
      const header = inspectPngHeader(bytes, "screenshot")
      if (
        header.width !== renderSpace.screenshotWidthPx ||
        header.height !== renderSpace.screenshotHeightPx
      ) {
        throw new BinaryEvidenceValidationError(
          `screenshot PNG dimensions ${header.width}x${header.height} do not match render space ${renderSpace.screenshotWidthPx}x${renderSpace.screenshotHeightPx}`,
          "screenshot-render-space-mismatch",
        )
      }
      return capturedRecord(
        channel,
        await storeBytes(state.context.artifactStore, bytes, "image/png"),
        renderSpace,
      )
    }
    case "dom": {
      const evidence = await domEvidence()
      return capturedRecord(
        channel,
        await storeJson(state.context.artifactStore, evidence.dom),
        renderSpace,
      )
    }
    case "layout-metadata": {
      const evidence = await domEvidence()
      return capturedRecord(
        channel,
        await storeJson(state.context.artifactStore, evidence.layout),
        renderSpace,
      )
    }
    case "computed-styles": {
      const evidence = await domEvidence()
      return capturedRecord(
        channel,
        await storeJson(state.context.artifactStore, evidence.styles),
      )
    }
    case "console":
      return capturedRecord(
        channel,
        await storeJson(
          state.context.artifactStore,
          consolePayload(state.runtimeEvidence),
          "sensitive",
        ),
      )
    case "network":
      return capturedRecord(
        channel,
        await storeJson(
          state.context.artifactStore,
          networkPayload(state.runtimeEvidence),
          "sensitive",
        ),
      )
    case "crash":
      return capturedRecord(
        channel,
        await storeJson(
          state.context.artifactStore,
          crashPayload(state.runtimeEvidence),
          "sensitive",
        ),
      )
    case "trace":
      return missingRecord(
        channel,
        "trace-pending",
        "Trace is sealed after scenario cleanup",
      )
    default:
      return missingRecord(
        channel,
        "unsupported-capability",
        `Playwright adapter cannot capture ${channel}`,
      )
  }
}

async function captureCheckpoint(
  checkpoint: ExecutableWebCheckpoint,
  state: CaptureState,
): Promise<CheckpointExecution> {
  throwIfAborted(state.context.signal)
  assertCandidateOrigin(state)
  assertCurrentMainDocument(state, "checkpoint", state.activeStepId)
  if (state.checkpointIds.has(checkpoint.id)) {
    const duplicate = missingCheckpoint(
      state.plan,
      checkpoint,
      "duplicate-checkpoint",
      "Checkpoint was executed more than once",
    )
    return {
      checkpoint:
        state.checkpoints.find(
          (captured) => captured.checkpointId === checkpoint.id,
        ) ?? duplicate,
      succeeded: false,
      origin: "runner",
      errorCode: "duplicate-checkpoint",
    }
  }
  state.checkpointIds.add(checkpoint.id)

  const target = checkpoint.target
    ? webLocator(state.page, checkpoint.target)
    : undefined

  if (target) {
    try {
      await target.waitFor({
        state: "visible",
        timeout: checkpoint.stabilize.timeoutMs,
      })
    } catch (error) {
      throwIfAborted(state.context.signal)
      const failure = executionError(
        error,
        "checkpoint",
        "locator",
        state.activeStepId,
      )
      state.executionErrors.push(failure)
      for (const assertion of checkpoint.assertions ?? []) {
        state.assertionResults.push(
          assertionFailure(
            assertion,
            resultOrigin(failure.origin),
            failure.origin === "product" ? "failed" : "not-evaluated",
            { checkpointId: checkpoint.id },
          ),
        )
      }
      return {
        checkpoint: missingCheckpoint(
          state.plan,
          checkpoint,
          failure.code,
          failure.message,
        ),
        succeeded: false,
        origin: resultOrigin(failure.origin),
        errorCode: failure.code,
      }
    }
  }

  try {
    await stabilizePage(state.page, checkpoint, target)
  } catch (error) {
    throwIfAborted(state.context.signal)
    const failure = executionError(
      error,
      "checkpoint",
      "stabilization",
      state.activeStepId,
    )
    state.executionErrors.push(failure)
    for (const assertion of checkpoint.assertions ?? []) {
      state.assertionResults.push(
        assertionFailure(assertion, resultOrigin(failure.origin), "not-evaluated", {
          checkpointId: checkpoint.id,
        }),
      )
    }
    return {
      checkpoint: missingCheckpoint(
        state.plan,
        checkpoint,
        failure.code,
        failure.message,
      ),
      succeeded: false,
      origin: resultOrigin(failure.origin),
      errorCode: failure.code,
    }
  }

  throwIfAborted(state.context.signal)
  assertCandidateOrigin(state)
  assertCurrentMainDocument(state, "checkpoint", state.activeStepId)

  const renderSpace = await checkpointRenderSpace(
    state.page,
    state.plan,
    checkpoint,
    target,
  )
  let domPromise: Promise<DomEvidenceSet> | undefined
  const domEvidence = () => {
    domPromise ??= captureDomEvidence(state.page, renderSpace).then((evidence) => {
      evidence.fontFamilies.forEach((family) => state.fontFamilies.add(family))
      return evidence
    })
    return domPromise
  }

  for (const assertion of checkpoint.assertions ?? []) {
    throwIfAborted(state.context.signal)
    assertCandidateOrigin(state)
    assertCurrentMainDocument(state, "checkpoint", state.activeStepId)
    const execution = await evaluateAssertion(
      state.page,
      assertion,
      state.runtimeEvidence,
      state.plan.target.entrypoint.baseUrl,
      { checkpointId: checkpoint.id },
    )
    throwIfAborted(state.context.signal)
    assertCandidateOrigin(state)
    assertCurrentMainDocument(state, "checkpoint", state.activeStepId)
    state.assertionResults.push(execution.result)
    if (execution.error) state.executionErrors.push(execution.error)
  }

  const evidence: EvidenceRecord[] = []
  let firstFailure: ExecutionError | undefined
  for (const channel of checkpoint.requiredChannels) {
    try {
      evidence.push(
        await captureChannel(
          channel,
          checkpoint,
          renderSpace,
          target,
          state,
          domEvidence,
        ),
      )
    } catch (error) {
      throwIfAborted(state.context.signal)
      assertCandidateOrigin(state)
      const failure = executionError(
        error,
        "checkpoint",
        "driver",
        state.activeStepId,
      )
      firstFailure ??= failure
      state.executionErrors.push(failure)
      evidence.push(missingRecord(channel, failure.code, failure.message))
    }
  }

  throwIfAborted(state.context.signal)
  assertCandidateOrigin(state)
  assertCurrentMainDocument(state, "checkpoint", state.activeStepId)

  const checkpointResult = {
    checkpointId: checkpoint.id,
    renderSpace,
    capturedAt: new Date().toISOString(),
    evidence,
  } satisfies CapturedCheckpoint
  state.checkpoints.push(checkpointResult)
  return {
    checkpoint: checkpointResult,
    succeeded: evidence.every(
      (record) => record.status === "captured" || record.channel === "trace",
    ),
    origin:
      firstFailure?.origin === undefined
        ? "product"
        : resultOrigin(firstFailure.origin),
    ...(firstFailure === undefined ? {} : { errorCode: firstFailure.code }),
  }
}

async function waitForStep(
  page: Page,
  step: Extract<ExecutableWebStep, { action: "waitFor" }>,
): Promise<void> {
  const timeout = step.timeoutMs ?? 5_000
  if (step.condition === "app-ready") {
    if (step.target) {
      await webLocator(page, step.target).waitFor({ state: "visible", timeout })
    }
    await page.waitForFunction(
      async () => {
        const candidateWindow = window as typeof window & {
          __UI_EVAL_READY__?:
            | boolean
            | Promise<boolean>
            | (() => boolean | Promise<boolean>)
        }
        const hook = candidateWindow.__UI_EVAL_READY__
        if (hook === undefined) return document.readyState === "complete"
        return Boolean(await (typeof hook === "function" ? hook() : hook))
      },
      undefined,
      { timeout },
    )
    return
  }

  if (!step.target) {
    throw new CaptureOperationError("waitFor condition requires a target", {
      origin: "runner",
      code: "wait-target-missing",
      retryable: false,
    })
  }
  const target = webLocator(page, step.target)
  if (step.condition === "visible" || step.condition === "hidden") {
    await target.waitFor({ state: step.condition, timeout })
    return
  }

  await target.waitFor({ state: "visible", timeout })
  if (!(await target.isEnabled())) {
    throw new CaptureOperationError("Target did not become enabled", {
      origin: "product",
      code: "target-not-enabled",
      retryable: false,
    })
  }
}

function stepOperation(
  step: ExecutableWebStep,
): Parameters<typeof classifyStepFailure>[1] {
  if (step.action === "goto") return "navigation"
  if (["tap", "fill", "waitFor"].includes(step.action)) return "locator"
  if (step.action === "assert") return "assertion"
  return "driver"
}

async function executeStep(
  step: ExecutableWebStep,
  phase: ExecutionError["phase"],
  state: CaptureState,
): Promise<StepResult> {
  state.activePhase = phase
  state.activeStepId = step.id

  try {
    throwIfAborted(state.context.signal)
    assertCandidateOrigin(state)
    assertCurrentMainDocument(state, phase, step.id)
    switch (step.action) {
      case "goto": {
        const response = await state.page.goto(
          new URL(step.path, state.plan.target.entrypoint.baseUrl).toString(),
          { waitUntil: "domcontentloaded" },
        )
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertMainDocumentResponse(response, phase, step.id)
        assertCurrentMainDocument(state, phase, step.id)
        break
      }
      case "tap":
        await webLocator(state.page, step.target).click()
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertCurrentMainDocument(state, phase, step.id)
        break
      case "fill":
        await webLocator(state.page, step.target).fill(step.value)
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertCurrentMainDocument(state, phase, step.id)
        break
      case "press":
        await state.page.keyboard.press(step.key)
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertCurrentMainDocument(state, phase, step.id)
        break
      case "waitFor":
        await waitForStep(state.page, step)
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertCurrentMainDocument(state, phase, step.id)
        break
      case "assert": {
        const execution = await evaluateAssertion(
          state.page,
          step.assertion,
          state.runtimeEvidence,
          state.plan.target.entrypoint.baseUrl,
          { stepId: step.id },
        )
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertCurrentMainDocument(state, phase, step.id)
        state.assertionResults.push(execution.result)
        if (execution.error) state.executionErrors.push(execution.error)
        return {
          stepId: step.id,
          status:
            execution.result.status === "passed"
              ? "passed"
              : execution.result.status === "failed"
                ? "failed"
                : "not-executed",
          origin: execution.result.origin,
          ...(execution.error === undefined
            ? {}
            : { errorCode: execution.error.code }),
        }
      }
      case "checkpoint": {
        const checkpoint = state.plan.checkpoints.find(
          (candidate) => candidate.id === step.checkpointId,
        )
        if (!checkpoint) {
          throw new CaptureOperationError(
            `Checkpoint ${step.checkpointId} is not declared`,
            {
              origin: "runner",
              code: "checkpoint-not-declared",
              retryable: false,
            },
          )
        }
        const captured = await captureCheckpoint(checkpoint, state)
        throwIfAborted(state.context.signal)
        assertCandidateOrigin(state)
        assertCurrentMainDocument(state, phase, step.id)
        if (!state.checkpoints.includes(captured.checkpoint)) {
          state.checkpoints.push(captured.checkpoint)
        }
        return {
          stepId: step.id,
          status: captured.succeeded ? "passed" : "failed",
          origin: captured.origin,
          ...(captured.errorCode === undefined
            ? {}
            : { errorCode: captured.errorCode }),
        }
      }
    }

    return { stepId: step.id, status: "passed", origin: "product" }
  } catch (error) {
    const failure = stateExecutionError(
      error,
      state,
      phase,
      stepOperation(step),
      step.id,
    )
    state.executionErrors.push(failure)
    return {
      stepId: step.id,
      status: "failed",
      origin: resultOrigin(failure.origin),
      errorCode: failure.code,
    }
  } finally {
    state.activeStepId = undefined
  }
}

async function executeSequence(
  steps: readonly ExecutableWebStep[],
  phase: ExecutionError["phase"],
  state: CaptureState,
  blockedBy?: StepResult,
): Promise<{ results: StepResult[]; blocker?: StepResult }> {
  const results: StepResult[] = []
  let blocker = blockedBy

  for (const step of steps) {
    if (blocker) {
      results.push({
        stepId: step.id,
        status: "not-executed",
        origin: blocker.origin,
        errorCode: blocker.errorCode ?? "blocked-by-prior-step",
      })
      continue
    }

    const result = await executeStep(step, phase, state)
    results.push(result)
    if (
      result.status === "failed" &&
      (result.origin !== "product" ||
        result.errorCode === "candidate-origin-escaped" ||
        result.errorCode === "same-origin-main-document-http-4xx" ||
        result.errorCode === "same-origin-main-document-http-5xx")
    ) {
      blocker = result
    }
  }

  return { results, ...(blocker === undefined ? {} : { blocker }) }
}

async function resolveStorageState(
  plan: WebResolvedScenarioPlan,
  store: ArtifactStorePort,
): Promise<BrowserContextOptions["storageState"]> {
  if (!plan.auth) return undefined
  let bytes: Buffer
  try {
    bytes = await store.resolve(
      plan.auth.storageState as Parameters<ArtifactStorePort["resolve"]>[0],
    )
  } catch (error) {
    throw new CaptureOperationError("Auth storage state could not be resolved", {
      origin: "runner",
      code: "auth-storage-state-unavailable",
      retryable: false,
    }, { cause: error })
  }

  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown
    if (!parsed || typeof parsed !== "object") throw new TypeError("expected object")
    assertStorageStateScope(parsed, plan.target.entrypoint.baseUrl)
    return parsed as Exclude<BrowserContextOptions["storageState"], string | undefined>
  } catch (error) {
    if (error instanceof CaptureOperationError) throw error
    throw new CaptureOperationError("Auth storage state is not valid JSON", {
      origin: "runner",
      code: "auth-storage-state-invalid",
      retryable: false,
    }, { cause: error })
  }
}

function assertStorageStateScope(state: object, baseUrl: string): void {
  const candidate = new URL(baseUrl)
  const candidateHostname = candidate.hostname.toLowerCase()
  const candidateOrigin = candidate.origin
  const candidateState = state as {
    cookies?: unknown
    origins?: unknown
  }

  if (
    !Array.isArray(candidateState.cookies) ||
    !Array.isArray(candidateState.origins)
  ) {
    throw new TypeError("storage state requires cookies and origins arrays")
  }

  const hasForeignCookie = candidateState.cookies.some((value) => {
    if (!value || typeof value !== "object") return true
    const domain = (value as { domain?: unknown }).domain
    return (
      typeof domain !== "string" ||
      domain.startsWith(".") ||
      domain.toLowerCase() !== candidateHostname
    )
  })
  const hasForeignOrigin = candidateState.origins.some((value) => {
    if (!value || typeof value !== "object") return true
    const origin = (value as { origin?: unknown }).origin
    if (typeof origin !== "string") return true
    try {
      return origin !== candidateOrigin || new URL(origin).origin !== candidateOrigin
    } catch {
      return true
    }
  })

  if (hasForeignCookie || hasForeignOrigin) {
    throw new CaptureOperationError(
      "Auth storage state contains cookies or local storage outside the candidate origin",
      {
        origin: "runner",
        code: "auth-storage-state-origin-mismatch",
        retryable: false,
      },
    )
  }
}

async function verifyFixtureArtifacts(
  plan: WebResolvedScenarioPlan,
  store: ArtifactStorePort,
): Promise<void> {
  for (const fixture of plan.fixtures) {
    if (!fixture.artifact) continue
    try {
      await store.resolve(
        fixture.artifact as Parameters<ArtifactStorePort["resolve"]>[0],
      )
    } catch (error) {
      throw new CaptureOperationError(
        `Fixture ${fixture.id} artifact could not be resolved`,
        {
          origin: "fixture",
          code: "fixture-artifact-unavailable",
          retryable: false,
        },
        { cause: error },
      )
    }
  }
}

async function installRandomSeed(
  browserContext: BrowserContext,
  seed: string | undefined,
): Promise<void> {
  if (!seed) return
  await browserContext.addInitScript((seedValue: string) => {
    let state = 2166136261
    for (const character of seedValue) {
      state ^= character.codePointAt(0) ?? 0
      state = Math.imul(state, 16777619)
    }
    Math.random = () => {
      state += 0x6d2b79f5
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
  }, seed)
}

async function installClock(
  page: Page,
  plan: WebResolvedScenarioPlan,
): Promise<void> {
  if (plan.determinism.clock.mode !== "fixed") return
  await page.clock.install({
    time: new Date(plan.determinism.clock.value!),
  })
}

function addRuntimeProductErrors(state: CaptureState): void {
  const fingerprints = new Set(
    state.executionErrors.map(
      (error) => `${error.origin}:${error.code}:${error.message}`,
    ),
  )
  for (const entry of state.runtimeEvidence.networkEntries) {
    const error = classifyNetworkObservation(
      {
        sameOrigin: entry.sameOrigin,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.failureText === undefined
          ? {}
          : { failureText: entry.failureText }),
      },
      "action",
    )
    if (!error) continue
    const fingerprint = `${error.origin}:${error.code}:${error.message}`
    if (!fingerprints.has(fingerprint)) {
      fingerprints.add(fingerprint)
      state.executionErrors.push(error)
    }
  }
  for (const entry of state.runtimeEvidence.crashEntries) {
    const error =
      entry.type === "page-error"
        ? productPageError(entry.message, "action")
        : ({
            origin: "product",
            phase: "action",
            code: "candidate-page-crash",
            message: entry.message,
            retryable: false,
          } satisfies ExecutionError)
    const fingerprint = `${error.origin}:${error.code}:${error.message}`
    if (!fingerprints.has(fingerprint)) {
      fingerprints.add(fingerprint)
      state.executionErrors.push(error)
    }
  }
}

function traceRequested(plan: WebResolvedScenarioPlan): boolean {
  return plan.checkpoints.some((checkpoint) =>
    checkpoint.requiredChannels.includes("trace"),
  )
}

async function finalizeTrace(
  browserContext: BrowserContext,
  state: CaptureState,
  temporaryRoot: string | undefined,
  tracingStarted: boolean,
): Promise<void> {
  if (!traceRequested(state.plan)) return

  let artifact: ArtifactRef | undefined
  let failure: ExecutionError | undefined
  if (!tracingStarted || !temporaryRoot) {
    failure = {
      origin: "driver",
      phase: "checkpoint",
      code: "trace-unavailable",
      message: "Playwright tracing did not start",
      retryable: true,
    }
  } else {
    const tracePath = join(temporaryRoot, "capture-trace.zip")
    try {
      await browserContext.tracing.stop({ path: tracePath })
      artifact = await storeBytes(
        state.context.artifactStore,
        await readBoundedEvidenceFile(tracePath, "trace"),
        "application/zip",
        "sensitive",
      )
    } catch (error) {
      failure = executionError(error, "checkpoint", "driver")
      failure = {
        ...failure,
        code:
          failure.code === "driver-operation-failed"
            ? "trace-capture-failed"
            : failure.code,
      }
    }
  }

  if (failure) state.executionErrors.push(failure)
  for (const checkpoint of state.checkpoints) {
    checkpoint.evidence = checkpoint.evidence.map((record) => {
      if (record.channel !== "trace") return record
      return artifact
        ? capturedRecord("trace", artifact)
        : missingRecord(
            "trace",
            failure?.code ?? "trace-unavailable",
            failure?.message ?? "Trace is unavailable",
          )
    })
  }
}

function addUnvisitedCheckpoints(state: CaptureState): void {
  for (const checkpoint of state.plan.checkpoints) {
    if (state.checkpointIds.has(checkpoint.id)) continue
    state.checkpoints.push(
      missingCheckpoint(
        state.plan,
        checkpoint,
        "checkpoint-not-executed",
        "No scenario step executed this checkpoint",
      ),
    )
  }
}

function completeAssertionResults(
  state: CaptureState,
  stepResults: readonly StepResult[],
): void {
  const key = (value: {
    assertionId: string
    stepId?: string
    checkpointId?: string
  }) => `${value.assertionId}\0${value.stepId ?? ""}\0${value.checkpointId ?? ""}`
  const existing = new Set(state.assertionResults.map(key))
  const byStep = new Map(stepResults.map((result) => [result.stepId, result]))

  for (const declared of declaredAssertions(state.plan)) {
    const resultKey = key({
      assertionId: declared.assertion.id,
      ...(declared.stepId === undefined ? {} : { stepId: declared.stepId }),
      ...(declared.checkpointId === undefined
        ? {}
        : { checkpointId: declared.checkpointId }),
    })
    if (existing.has(resultKey)) continue
    const stepResult = declared.stepId
      ? byStep.get(declared.stepId)
      : undefined
    state.assertionResults.push({
      assertionId: declared.assertion.id,
      ...(declared.stepId === undefined ? {} : { stepId: declared.stepId }),
      ...(declared.checkpointId === undefined
        ? {}
        : { checkpointId: declared.checkpointId }),
      status: "not-evaluated",
      origin: stepResult?.origin ?? "runner",
    })
  }
}

function assembleBundle(
  state: CaptureState,
  stepResults: StepResult[],
  browserVersion: string,
): CaptureBundleSpec {
  // This is the final synchronous serialization boundary. Re-read the state so
  // a popup/external-navigation event observed during evidence finalization can
  // never be upgraded to a completed capture.
  recordTerminalBoundaryFailure(state)
  addUnvisitedCheckpoints(state)
  completeAssertionResults(state, stepResults)

  const requiredEvidence = state.checkpoints.flatMap((checkpoint) =>
    checkpoint.evidence.filter((record) => record.required),
  )
  const capturedRequired = requiredEvidence.filter(
    (record) => record.status === "captured" && record.artifact !== undefined,
  ).length
  const missingRequired = requiredEvidence.length - capturedRequired
  const aborted = state.executionErrors.some(
    (error) => error.code === PLAYWRIGHT_CAPTURE_ABORTED_CODE,
  )
  const infrastructureInvalid = state.executionErrors.some((error) =>
    ["runner", "driver", "fixture"].includes(error.origin),
  )
  const securityBoundaryFailed = state.executionErrors.some((error) =>
    SECURITY_BOUNDARY_FAILURE_CODES.has(error.code),
  )
  const captureInvalid = aborted || infrastructureInvalid

  return {
    executionId: state.context.executionId,
    runManifestDigest: state.context.runManifestDigest,
    captureKey: state.context.captureKey,
    scenarioId: state.plan.scenarioId,
    variant: state.plan.variant,
    sourceRevision: state.context.sourceRevision,
    build: state.context.build,
    adapter: {
      id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
      version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
      platform: "web",
    },
    environment: environmentFor(
      state.plan,
      browserVersion,
      [...state.fontFamilies],
      state.context.browserChannel,
    ),
    capabilities: [...PLAYWRIGHT_CAPTURE_CAPABILITIES],
    status:
      securityBoundaryFailed
        ? "failed"
        : captureInvalid
        ? capturedRequired === 0
          ? "failed"
          : "partial"
        : missingRequired === 0
        ? "completed"
        : capturedRequired === 0
          ? "failed"
          : "partial",
    completeness: {
      expectedRequired: requiredEvidence.length,
      capturedRequired,
      missingRequired,
    },
    stepResults,
    assertionResults: state.assertionResults,
    checkpoints: state.checkpoints,
    ...(state.executionErrors.length === 0
      ? {}
      : { executionErrors: state.executionErrors }),
  }
}

function preflightFailure(
  error: unknown,
  code = "invalid-capture-plan",
): ExecutionError {
  if (error instanceof CaptureOperationError) {
    return {
      origin: error.classification.origin,
      phase: "prepare",
      code: error.classification.code,
      message: redactText(error.message),
      retryable: error.classification.retryable,
    }
  }
  return {
    origin: "runner",
    phase: "prepare",
    code,
    message: redactText(error instanceof Error ? error.message : String(error)),
    retryable: false,
  }
}

export async function captureWebScenario(
  sourcePlan: ContractWebResolvedScenarioPlan,
  context: CaptureWebScenarioContext,
): Promise<CaptureBundleSpec> {
  const plan = sourcePlan as unknown as WebResolvedScenarioPlan
  try {
    throwIfAborted(context.signal)
    validatePlan(plan, context)
  } catch (error) {
    return failedBundle(plan, context, preflightFailure(error))
  }

  let storageState: BrowserContextOptions["storageState"]
  try {
    storageState = await resolveStorageState(plan, context.artifactStore)
    throwIfAborted(context.signal)
    await verifyFixtureArtifacts(plan, context.artifactStore)
    throwIfAborted(context.signal)
  } catch (error) {
    return failedBundle(plan, context, preflightFailure(error))
  }

  let browser: Browser | undefined
  let browserContext: BrowserContext | undefined
  let temporaryRoot: string | undefined
  let state: CaptureState | undefined
  let tracingStarted = false
  let stepResults: StepResult[] = []
  const pendingBrowserClosures: Promise<void>[] = []
  const closeOwnedBrowserResources = (): Promise<void> => {
    const ownedContext = browserContext
    const ownedBrowser = browser
    browserContext = undefined
    browser = undefined
    const closing = (async () => {
      // Remove route handlers before closing the context so in-flight origin
      // preflights cannot surface close-race errors. Playwright does not
      // guarantee that concurrent context.close/browser.close calls are
      // race-free, so serialize them and share the resulting work with the
      // finalizer.
      await ownedContext
        ?.unrouteAll({ behavior: "ignoreErrors" })
        .catch(() => undefined)
      await ownedContext?.close().catch(() => undefined)
      await ownedBrowser?.close().catch(() => undefined)
    })()
    pendingBrowserClosures.push(closing)
    return closing
  }
  const closeOnAbort = () => {
    void closeOwnedBrowserResources()
  }
  context.signal?.addEventListener("abort", closeOnAbort, { once: true })

  try {
    try {
      throwIfAborted(context.signal)
      browser = await chromium.launch({
        headless: true,
        ...context.browserLaunchOptions,
      })
      throwIfAborted(context.signal)
    } catch (error) {
      const failure = context.signal?.aborted
        ? captureAbortedError("prepare")
        : {
            origin: "driver" as const,
            phase: "prepare" as const,
            code: "browser-launch-failed",
            message: redactText(
              error instanceof Error ? error.message : String(error),
            ),
            retryable: true,
          }
      return failedBundle(
        plan,
        context,
        failure,
      )
    }

    const renderSpace = plan.device.renderSpace
    try {
      browserContext = await browser.newContext({
        viewport: {
          width: renderSpace.logicalWidth,
          height: renderSpace.logicalHeight,
        },
        screen: {
          width: renderSpace.logicalWidth,
          height: renderSpace.logicalHeight,
        },
        deviceScaleFactor: renderSpace.deviceScaleFactor,
        locale: plan.locale,
        timezoneId: plan.determinism.timezone,
        colorScheme: plan.theme,
        reducedMotion: "reduce",
        serviceWorkers: "block",
        baseURL: plan.target.entrypoint.baseUrl,
        acceptDownloads: false,
        ...(plan.device.userAgent === undefined
          ? {}
          : { userAgent: plan.device.userAgent }),
        ...(storageState === undefined ? {} : { storageState }),
      })
      await installRandomSeed(browserContext, plan.determinism.randomSeed)
      throwIfAborted(context.signal)
    } catch (error) {
      const failure = context.signal?.aborted
        ? captureAbortedError("prepare")
        : {
            origin: "driver" as const,
            phase: "prepare" as const,
            code: "browser-context-failed",
            message: redactText(
              error instanceof Error ? error.message : String(error),
            ),
            retryable: true,
          }
      return failedBundle(
        plan,
        context,
        failure,
      )
    }

    const page = await browserContext.newPage()
    await installClock(page, plan)
    throwIfAborted(context.signal)
    const operationTimeout = planOperationTimeout(plan)
    page.setDefaultTimeout(operationTimeout)
    page.setDefaultNavigationTimeout(operationTimeout)

    const candidateOrigin = new URL(plan.target.entrypoint.baseUrl).origin
    const runtimeEvidence = createRuntimeEvidenceCollector(page, candidateOrigin)
    state = {
      page,
      plan,
      context,
      runtimeEvidence,
      checkpoints: [],
      checkpointIds: new Set(),
      assertionResults: [],
      executionErrors: [],
      fontFamilies: new Set(),
      activePhase: "prepare",
      candidateOrigin,
    }

    // Phase 0A models exactly one Page. Context routing protects a popup's
    // first request, but runtime errors and checkpoints are intentionally bound
    // to the declared candidate Page. Fail closed until multi-page scenarios
    // have an explicit contract and shared evidence model.
    browserContext.on("page", (openedPage) => {
      if (openedPage === page) return
      recordUnsupportedPopup(state!)
    })

    // Context-level routing is required for the first request of popup pages;
    // page.route() cannot intercept that request. Service workers are blocked
    // above so top-level origin enforcement cannot be bypassed by a worker.
    await browserContext.route("**/*", async (route) => {
      const request = route.request()
      const topLevel = isTopLevelNavigationRequest(request)
      const requestedOrigin = safeOrigin(request.url()) ?? "non-http(s)"
      if (topLevel) {
        if (requestedOrigin !== candidateOrigin) {
          recordAttemptedExternalOrigin(state!, requestedOrigin)
          await route.abort()
          return
        }
        await candidateRouteResponse(route, state!, true)
        return
      }
      if (plan.auth) {
        if (requestedOrigin !== candidateOrigin) {
          state!.blockedAuthEgressOrigin = requestedOrigin
          await route.abort()
          return
        }
        await candidateRouteResponse(route, state!, false)
        return
      }
      await route.continue()
    })
    await browserContext.routeWebSocket("**/*", async (webSocket) => {
      if (!plan.auth) {
        webSocket.connectToServer()
        return
      }
      const url = new URL(webSocket.url())
      if (url.protocol === "ws:") url.protocol = "http:"
      if (url.protocol === "wss:") url.protocol = "https:"
      const requestedOrigin = safeOrigin(url.toString()) ?? "non-http(s)"
      if (requestedOrigin !== candidateOrigin) {
        state!.blockedAuthEgressOrigin = requestedOrigin
        await webSocket.close({
          code: 1008,
          reason: "UI Eval blocks authenticated cross-origin egress",
        })
        return
      }
      webSocket.connectToServer()
    })
    page.on("response", (response) => {
      const request = response.request()
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        state!.mainDocumentStatus = response.status()
      }
    })

    if (traceRequested(plan)) {
      try {
        throwIfAborted(context.signal)
        temporaryRoot = await mkdtemp(join(tmpdir(), "ui-eval-trace-"))
        await browserContext.tracing.start({
          screenshots: true,
          snapshots: false,
          sources: false,
        })
        tracingStarted = true
      } catch (error) {
        throwIfAborted(context.signal)
        state.executionErrors.push({
          origin: "driver",
          phase: "prepare",
          code: "trace-start-failed",
          message: redactText(error instanceof Error ? error.message : String(error)),
          retryable: true,
        })
      }
    }

    let initialFailure: StepResult | undefined
    try {
      throwIfAborted(context.signal)
      const response = await page.goto(
        new URL(
          plan.target.entrypoint.path,
          plan.target.entrypoint.baseUrl,
        ).toString(),
        { waitUntil: "domcontentloaded" },
      )
      throwIfAborted(context.signal)
      assertCandidateOrigin(state)
      assertMainDocumentResponse(response, "prepare")
    } catch (error) {
      const failure = stateExecutionError(
        error,
        state,
        "prepare",
        "navigation",
      )
      state.executionErrors.push(failure)
      initialFailure = {
        stepId: "__entrypoint__",
        status: "failed",
        origin: resultOrigin(failure.origin),
        errorCode: failure.code,
      }
    }

    const setup = await executeSequence(
      plan.setup,
      "setup",
      state,
      initialFailure,
    )
    const actions = await executeSequence(
      plan.steps,
      "action",
      state,
      setup.blocker,
    )
    const cleanup = await executeSequence(plan.cleanup, "cleanup", state)
    stepResults = [...setup.results, ...actions.results, ...cleanup.results]

    try {
      throwIfAborted(context.signal)
      assertCandidateOrigin(state)
      const fonts = await page.evaluate(() =>
        document.fonts
          ? Array.from(document.fonts)
              .map((font) => font.family)
              .filter(Boolean)
          : [],
      )
      fonts.forEach((family) => state?.fontFamilies.add(family))
    } catch {
      // A product crash may make the page unavailable; crash evidence already
      // records that fact and font identity falls back to the captured DOM set.
    }
    throwIfAborted(context.signal)
    assertCandidateOrigin(state)

    addRuntimeProductErrors(state)
    await finalizeTrace(
      browserContext,
      state,
      temporaryRoot,
      tracingStarted,
    )
    tracingStarted = false
    // Close the context before serializing the contract. This drains Page
    // events and ends candidate timers, eliminating a finalization window in
    // which an undeclared popup could be created after the last boundary check.
    await browserContext.unrouteAll({ behavior: "wait" })
    await browserContext.close()
    browserContext = undefined
    throwIfAborted(context.signal)
    return assembleBundle(state, stepResults, browser.version())
  } catch (error) {
    if (!state) {
      return failedBundle(
        plan,
        context,
        context.signal?.aborted
          ? captureAbortedError("prepare")
          : preflightFailure(error, "capture-prepare-failed"),
      )
    }

    const terminalFailure = stateExecutionError(
      error,
      state,
      state.activePhase,
      "driver",
      state.activeStepId,
    )
    if (
      !SECURITY_BOUNDARY_FAILURE_CODES.has(terminalFailure.code) ||
      !state.executionErrors.some(
        (existing) => existing.code === terminalFailure.code,
      )
    ) {
      state.executionErrors.push(terminalFailure)
    }
    const executed = new Set(stepResults.map((result) => result.stepId))
    for (const step of [...plan.setup, ...plan.steps, ...plan.cleanup]) {
      if (executed.has(step.id)) continue
      stepResults.push({
        stepId: step.id,
        status: "not-executed",
        origin: resultOrigin(terminalFailure.origin),
        errorCode: terminalFailure.code,
      })
    }
    if (browserContext && tracingStarted && !context.signal?.aborted) {
      await finalizeTrace(
        browserContext,
        state,
        temporaryRoot,
        tracingStarted,
      )
    }
    return assembleBundle(state, stepResults, browser?.version() ?? "unavailable")
  } finally {
    context.signal?.removeEventListener("abort", closeOnAbort)
    await closeOwnedBrowserResources()
    await Promise.all(pendingBrowserClosures)
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(
        () => undefined,
      )
    }
  }
}
