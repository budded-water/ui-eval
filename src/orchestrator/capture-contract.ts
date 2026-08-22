import { canonicalDigest, canonicalJson } from "../contracts/canonical-json"
import type {
  BuildIdentity,
  CaptureBundleSpec,
  CaptureCapability,
  Digest,
  SourceRevision,
  WebResolvedScenarioPlan,
} from "../contracts/model"

export type CaptureContractIssueCode =
  | "value-mismatch"
  | "missing-id"
  | "unexpected-id"
  | "duplicate-id"
  | "invalid-assertion-binding"
  | "assertion-metric-kind-mismatch"
  | "required-flag-mismatch"

export interface CaptureContractIssue {
  path: string
  code: CaptureContractIssueCode
  message: string
}

export class CaptureContractError extends Error {
  readonly code = "CAPTURE_CONTRACT_MISMATCH"
  readonly issues: CaptureContractIssue[]

  constructor(issues: CaptureContractIssue[]) {
    super(
      `Capture does not match the sealed execution contract: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    )
    this.name = "CaptureContractError"
    this.issues = issues
  }
}

export interface CaptureContractContext {
  executionId: string
  runManifestDigest: Digest
  captureKey: Digest
  sourceRevision: SourceRevision
  build: BuildIdentity
}

export interface ExpectedCaptureAdapter {
  id: string
  version: string
  platform: CaptureBundleSpec["adapter"]["platform"]
  capabilities: readonly CaptureCapability[]
  /** Adapter-specific runtime identity, when selected by the orchestrator. */
  browserOrDevice?: string
  /** Driver versions need not equal the adapter semantic version. */
  driverVersion?: string
}

export interface CaptureContractInput {
  capture: CaptureBundleSpec
  plan: WebResolvedScenarioPlan
  context: CaptureContractContext
  expectedAdapter: ExpectedCaptureAdapter
}

interface BindableStep {
  id: string
  action: string
  assertion?: { id: string; kind: BindableAssertionKind }
}

interface BindableCheckpoint {
  id: string
  requiredChannels: CaptureCapability[]
  captureScope: "viewport" | "full-page" | "element"
  assertions?: Array<{ id: string; kind: BindableAssertionKind }>
}

type BindableAssertionKind =
  | "visible"
  | "hidden"
  | "enabled"
  | "text"
  | "url"
  | "no-crash"

type BindableWebPlan = Omit<
  WebResolvedScenarioPlan,
  "target" | "setup" | "steps" | "cleanup" | "checkpoints"
> & {
  target: { platform: "web" }
  setup: BindableStep[]
  steps: BindableStep[]
  cleanup: BindableStep[]
  checkpoints: BindableCheckpoint[]
}

function bindablePlan(plan: WebResolvedScenarioPlan): BindableWebPlan {
  // The runtime schema is a platform union whose TypeBox Static inference leaves
  // a few recursive Web members unknown. The compiler and adapter validate this
  // Web branch before the orchestrator reaches the cross-binding boundary.
  return plan as BindableWebPlan
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function valueIssue(
  issues: CaptureContractIssue[],
  path: string,
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (sameJson(actual, expected)) return
  issues.push({
    path,
    code: "value-mismatch",
    message: `${label} does not match the sealed execution input`,
  })
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

function quoted(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ")
}

function exactCoverageIssues(options: {
  issues: CaptureContractIssue[]
  path: string
  label: string
  expected: readonly string[]
  actual: readonly string[]
}): void {
  const expectedCounts = counts(options.expected)
  const actualCounts = counts(options.actual)
  const missing = [...expectedCounts]
    .filter(([id, count]) => (actualCounts.get(id) ?? 0) < count)
    .flatMap(([id, count]) =>
      Array.from({ length: count - (actualCounts.get(id) ?? 0) }, () => id),
    )
    .sort()
  const unexpected = [...actualCounts]
    .filter(([id]) => !expectedCounts.has(id))
    .flatMap(([id, count]) => Array.from({ length: count }, () => id))
    .sort()
  const duplicates = [...actualCounts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort()

  if (missing.length > 0) {
    options.issues.push({
      path: options.path,
      code: "missing-id",
      message: `${options.label} is missing ${quoted(missing)}`,
    })
  }
  if (unexpected.length > 0) {
    options.issues.push({
      path: options.path,
      code: "unexpected-id",
      message: `${options.label} contains undeclared ${quoted(unexpected)}`,
    })
  }
  if (duplicates.length > 0) {
    options.issues.push({
      path: options.path,
      code: "duplicate-id",
      message: `${options.label} contains duplicate ${quoted(duplicates)}`,
    })
  }
}

function stepIds(plan: BindableWebPlan): string[] {
  return [...plan.setup, ...plan.steps, ...plan.cleanup].map((step) => step.id)
}

function stepAssertionKey(assertionId: string, stepId: string): string {
  return `${assertionId}\0step\0${stepId}`
}

function checkpointAssertionKey(
  assertionId: string,
  checkpointId: string,
): string {
  return `${assertionId}\0checkpoint\0${checkpointId}`
}

function declaredAssertionKeys(plan: BindableWebPlan): string[] {
  const stepAssertions = [...plan.setup, ...plan.steps, ...plan.cleanup].flatMap(
    (step) =>
      step.action === "assert" && step.assertion
        ? [stepAssertionKey(step.assertion.id, step.id)]
        : [],
  )
  const checkpointAssertions = plan.checkpoints.flatMap((checkpoint) =>
    (checkpoint.assertions ?? []).map((assertion) =>
      checkpointAssertionKey(assertion.id, checkpoint.id),
    ),
  )
  return [...stepAssertions, ...checkpointAssertions]
}

function declaredAssertionKinds(
  plan: BindableWebPlan,
): Map<string, BindableAssertionKind> {
  const result = new Map<string, BindableAssertionKind>()
  for (const step of [...plan.setup, ...plan.steps, ...plan.cleanup]) {
    if (step.action !== "assert" || !step.assertion) continue
    result.set(
      stepAssertionKey(step.assertion.id, step.id),
      step.assertion.kind,
    )
  }
  for (const checkpoint of plan.checkpoints) {
    for (const assertion of checkpoint.assertions ?? []) {
      result.set(
        checkpointAssertionKey(assertion.id, checkpoint.id),
        assertion.kind,
      )
    }
  }
  return result
}

function assertionMetricKindIssues(
  input: CaptureContractInput,
  issues: CaptureContractIssue[],
): void {
  const kinds = declaredAssertionKinds(bindablePlan(input.plan))
  input.capture.assertionResults.forEach((result, index) => {
    const key = result.stepId
      ? stepAssertionKey(result.assertionId, result.stepId)
      : result.checkpointId
        ? checkpointAssertionKey(result.assertionId, result.checkpointId)
        : undefined
    const assertionKind = key ? kinds.get(key) : undefined
    if (!assertionKind) return
    const expectedMetricKind =
      assertionKind === "text" || assertionKind === "url"
        ? "string"
        : "boolean"
    for (const field of ["expected", "actual"] as const) {
      const metric = result[field]
      if (!metric || metric.kind === expectedMetricKind) continue
      issues.push({
        path: `/assertionResults/${index}/${field}`,
        code: "assertion-metric-kind-mismatch",
        message: `${assertionKind} assertions require ${expectedMetricKind} metrics`,
      })
    }
  })
}

function capturedAssertionKeys(
  capture: CaptureBundleSpec,
  issues: CaptureContractIssue[],
): string[] {
  return capture.assertionResults.flatMap((result, index) => {
    const hasStep = result.stepId !== undefined
    const hasCheckpoint = result.checkpointId !== undefined
    if (hasStep === hasCheckpoint) {
      issues.push({
        path: `/assertionResults/${index}`,
        code: "invalid-assertion-binding",
        message:
          "assertion result must bind to exactly one declared stepId or checkpointId",
      })
      return []
    }
    return [
      hasStep
        ? stepAssertionKey(result.assertionId, result.stepId!)
        : checkpointAssertionKey(result.assertionId, result.checkpointId!),
    ]
  })
}

function checkpointIssues(
  input: CaptureContractInput,
  issues: CaptureContractIssue[],
): void {
  const plan = bindablePlan(input.plan)
  exactCoverageIssues({
    issues,
    path: "/checkpoints",
    label: "checkpoint coverage",
    expected: plan.checkpoints.map((checkpoint) => checkpoint.id),
    actual: input.capture.checkpoints.map((checkpoint) => checkpoint.checkpointId),
  })

  for (const checkpoint of plan.checkpoints) {
    const capturedIndex = input.capture.checkpoints.findIndex(
      (candidate) => candidate.checkpointId === checkpoint.id,
    )
    if (capturedIndex < 0) continue
    const captured = input.capture.checkpoints[capturedIndex]
    const checkpointPath = `/checkpoints/${capturedIndex}`
    if (checkpoint.captureScope === "viewport") {
      valueIssue(
        issues,
        `${checkpointPath}/renderSpace`,
        "checkpoint renderSpace",
        captured.renderSpace,
        input.plan.device.renderSpace,
      )
    } else if (
      captured.renderSpace.logicalUnit !== "css-px" ||
      captured.renderSpace.logicalWidth <= 0 ||
      captured.renderSpace.logicalHeight <= 0 ||
      captured.renderSpace.deviceScaleFactor !==
        input.plan.device.renderSpace.deviceScaleFactor ||
      captured.renderSpace.screenshotWidthPx !==
        Math.max(
          1,
          Math.round(
            captured.renderSpace.logicalWidth *
              captured.renderSpace.deviceScaleFactor,
          ),
        ) ||
      captured.renderSpace.screenshotHeightPx !==
        Math.max(
          1,
          Math.round(
            captured.renderSpace.logicalHeight *
              captured.renderSpace.deviceScaleFactor,
          ),
        ) ||
      captured.renderSpace.orientation !==
        (captured.renderSpace.logicalWidth >= captured.renderSpace.logicalHeight
          ? "landscape"
          : "portrait") ||
      (checkpoint.captureScope === "full-page" &&
        (captured.renderSpace.logicalWidth <
          input.plan.device.renderSpace.logicalWidth ||
          captured.renderSpace.logicalHeight <
            input.plan.device.renderSpace.logicalHeight))
    ) {
      issues.push({
        path: `${checkpointPath}/renderSpace`,
        code: "value-mismatch",
        message: `${checkpoint.captureScope} checkpoint renderSpace is not self-consistent with the sealed device profile`,
      })
    }
    exactCoverageIssues({
      issues,
      path: `${checkpointPath}/evidence`,
      label: "required channel coverage",
      expected: checkpoint.requiredChannels,
      actual: captured.evidence.map((record) => record.channel),
    })
    captured.evidence.forEach((record, index) => {
      if (
        checkpoint.requiredChannels.includes(record.channel) &&
        !record.required
      ) {
        issues.push({
          path: `${checkpointPath}/evidence/${index}/required`,
          code: "required-flag-mismatch",
          message: `channel ${JSON.stringify(record.channel)} is required by the sealed checkpoint`,
        })
      }
    })
  }
}

function environmentIssues(
  input: CaptureContractInput,
  issues: CaptureContractIssue[],
): void {
  const { environmentDigest, ...environmentBase } = input.capture.environment
  valueIssue(
    issues,
    "/environment/rendererProfile",
    "renderer profile",
    input.capture.environment.rendererProfile,
    input.plan.device.profileId,
  )
  valueIssue(
    issues,
    "/environment/locale",
    "environment locale",
    input.capture.environment.locale,
    input.plan.locale,
  )
  valueIssue(
    issues,
    "/environment/timezone",
    "environment timezone",
    input.capture.environment.timezone,
    input.plan.determinism.timezone,
  )
  if (input.expectedAdapter.browserOrDevice !== undefined) {
    valueIssue(
      issues,
      "/environment/browserOrDevice",
      "browser or device identity",
      input.capture.environment.browserOrDevice,
      input.expectedAdapter.browserOrDevice,
    )
  }
  if (input.expectedAdapter.driverVersion !== undefined) {
    valueIssue(
      issues,
      "/environment/driverVersion",
      "driver version",
      input.capture.environment.driverVersion,
      input.expectedAdapter.driverVersion,
    )
  }
  valueIssue(
    issues,
    "/environment/environmentDigest",
    "environment digest",
    environmentDigest,
    canonicalDigest(environmentBase),
  )
}

/**
 * Cross-binds a structurally valid CaptureBundleSpec to the exact sealed inputs
 * used for this execution. This prevents a stale, partial, or foreign adapter
 * result from being evaluated as if it belonged to the current plan.
 */
export function captureContractIssues(
  input: CaptureContractInput,
): CaptureContractIssue[] {
  const issues: CaptureContractIssue[] = []
  const plan = bindablePlan(input.plan)
  valueIssue(
    issues,
    "/executionId",
    "executionId",
    input.capture.executionId,
    input.context.executionId,
  )
  valueIssue(
    issues,
    "/runManifestDigest",
    "runManifestDigest",
    input.capture.runManifestDigest,
    input.context.runManifestDigest,
  )
  valueIssue(
    issues,
    "/captureKey",
    "captureKey",
    input.capture.captureKey,
    input.context.captureKey,
  )
  valueIssue(
    issues,
    "/scenarioId",
    "scenarioId",
    input.capture.scenarioId,
    input.plan.scenarioId,
  )
  valueIssue(
    issues,
    "/variant",
    "variant",
    input.capture.variant,
    input.plan.variant,
  )
  valueIssue(
    issues,
    "/sourceRevision",
    "sourceRevision",
    input.capture.sourceRevision,
    input.context.sourceRevision,
  )
  valueIssue(
    issues,
    "/build",
    "build",
    input.capture.build,
    input.context.build,
  )
  valueIssue(
    issues,
    "/build/platform",
    "build platform",
    input.capture.build.platform,
    plan.target.platform,
  )

  valueIssue(
    issues,
    "/adapter/id",
    "adapter id",
    input.capture.adapter.id,
    input.expectedAdapter.id,
  )
  valueIssue(
    issues,
    "/adapter/version",
    "adapter version",
    input.capture.adapter.version,
    input.expectedAdapter.version,
  )
  valueIssue(
    issues,
    "/adapter/platform",
    "adapter platform",
    input.capture.adapter.platform,
    input.expectedAdapter.platform,
  )
  valueIssue(
    issues,
    "/adapter/platform",
    "adapter platform",
    input.capture.adapter.platform,
    plan.target.platform,
  )

  exactCoverageIssues({
    issues,
    path: "/capabilities",
    label: "adapter capability coverage",
    expected: input.expectedAdapter.capabilities,
    actual: input.capture.capabilities,
  })
  exactCoverageIssues({
    issues,
    path: "/capabilities",
    label: "plan-required capability coverage",
    expected: input.plan.requiredCapabilities,
    actual: input.capture.capabilities.filter((capability) =>
      input.plan.requiredCapabilities.includes(capability),
    ),
  })
  environmentIssues(input, issues)

  exactCoverageIssues({
    issues,
    path: "/stepResults",
    label: "step result coverage",
    expected: stepIds(plan),
    actual: input.capture.stepResults.map((result) => result.stepId),
  })
  exactCoverageIssues({
    issues,
    path: "/assertionResults",
    label: "assertion result coverage",
    expected: declaredAssertionKeys(plan),
    actual: capturedAssertionKeys(input.capture, issues),
  })
  assertionMetricKindIssues(input, issues)
  checkpointIssues(input, issues)

  return issues
}

export function assertCaptureContract(
  input: CaptureContractInput,
): CaptureBundleSpec {
  const issues = captureContractIssues(input)
  if (issues.length > 0) throw new CaptureContractError(issues)
  return input.capture
}
