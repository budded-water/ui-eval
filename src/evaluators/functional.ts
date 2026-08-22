import { canonicalDigest } from "../contracts/canonical-json"
import type {
  AssertionResult,
  CaptureBundleSpec,
  ExecutionError,
  Finding,
  StepResult,
} from "../contracts/model"
import type { MetricPrimitive } from "../policy-engine/evaluate-policy"

type ExecutionOutcome = "valid" | "invalid-evidence" | "infra-error"

export interface FunctionalCaptureInput {
  status: CaptureBundleSpec["status"]
  completeness: CaptureBundleSpec["completeness"]
  stepResults: StepResult[]
  assertionResults: AssertionResult[]
  executionErrors?: ExecutionError[]
}

export interface FindingContext {
  scenarioId: string
  executionId: string
  checkpointId: string
  variantKey: string
  contextDigest: `sha256:${string}`
}

export interface FunctionalEvaluationResult {
  executionOutcome: ExecutionOutcome
  metrics: Record<string, MetricPrimitive>
  findings: Finding[]
}

function isInfrastructureOrigin(error: ExecutionError): boolean {
  return ["runner", "driver", "fixture"].includes(error.origin)
}

function hasInfrastructureResult(capture: FunctionalCaptureInput): boolean {
  const infrastructureOrigins = new Set(["runner", "driver", "fixture"])
  return (
    capture.stepResults.some(
      (step) =>
        infrastructureOrigins.has(step.origin) &&
        step.status !== "passed",
    ) ||
    capture.assertionResults.some(
      (assertion) =>
        infrastructureOrigins.has(assertion.origin) &&
        assertion.status !== "passed",
    )
  )
}

function hasInvalidResult(capture: FunctionalCaptureInput): boolean {
  return (
    capture.stepResults.some(
      (step) =>
        step.status === "skipped" ||
        step.status === "not-executed" ||
        (step.status === "passed" && step.origin !== "product"),
    ) ||
    capture.assertionResults.some(
      (assertion) =>
        assertion.status === "not-evaluated" ||
        (assertion.status === "passed" && assertion.origin !== "product"),
    )
  )
}

function hasConclusiveProductFailure(
  capture: FunctionalCaptureInput,
): boolean {
  return (
    capture.stepResults.some(
      (step) => step.origin === "product" && step.status === "failed",
    ) ||
    capture.assertionResults.some(
      (assertion) =>
        assertion.origin === "product" && assertion.status === "failed",
    ) ||
    (capture.executionErrors ?? []).some((error) => error.origin === "product")
  )
}

export function classifyExecutionOutcome(
  capture: FunctionalCaptureInput,
): ExecutionOutcome {
  if (
    (capture.executionErrors ?? []).some(isInfrastructureOrigin) ||
    hasInfrastructureResult(capture)
  ) {
    return "infra-error"
  }
  // A directly observed product failure is sufficient to reject the candidate,
  // even when that failure prevented later screenshots or checkpoints. Missing
  // downstream evidence must not turn a page crash into an infrastructure result.
  if (hasConclusiveProductFailure(capture)) return "valid"
  if (
    capture.status !== "completed" ||
    capture.completeness.missingRequired > 0 ||
    capture.completeness.capturedRequired < capture.completeness.expectedRequired ||
    hasInvalidResult(capture)
  ) {
    return "invalid-evidence"
  }
  return "valid"
}

/**
 * Shared so that every evaluator derives findingId and fingerprint the same
 * way. A second builder would let two evaluators disagree about the identity of
 * the same defect across runs.
 */
export function createFinding(options: {
  context: FindingContext
  ruleId: string
  metricKey: string
  evaluatorId: string
  dimension: Finding["dimension"]
  comparison: Finding["comparison"]
  severity: Finding["severity"]
  summary: string
  explanation?: string
  checkpointId?: string
  measurement?: Finding["measurement"]
  evidence?: Finding["evidence"]
}): Finding {
  const fingerprint = canonicalDigest({
    ruleId: options.ruleId,
    ruleSemanticVersion: "1.0.0",
    metricKey: options.metricKey,
    scenarioId: options.context.scenarioId,
    checkpointId: options.checkpointId ?? options.context.checkpointId,
    variantKey: options.context.variantKey,
    contextDigest: options.context.contextDigest,
    dimension: options.dimension,
    comparison: options.comparison,
  })

  return {
    findingId: canonicalDigest({
      fingerprint,
      executionId: options.context.executionId,
    }),
    fingerprint,
    ruleId: options.ruleId,
    ruleSemanticVersion: "1.0.0",
    metricKey: options.metricKey,
    evaluatorId: options.evaluatorId,
    evaluatorVersion: "0.1.0",
    comparison: options.comparison,
    dimension: options.dimension,
    severity: options.severity,
    confidence: 1,
    scenarioId: options.context.scenarioId,
    executionId: options.context.executionId,
    checkpointId: options.checkpointId ?? options.context.checkpointId,
    variantKey: options.context.variantKey,
    contextDigest: options.context.contextDigest,
    ...(options.measurement ? { measurement: options.measurement } : {}),
    summary: options.summary,
    ...(options.explanation ? { explanation: options.explanation } : {}),
    evidence: options.evidence ?? [],
  }
}

export function evaluateFunctionalEvidence(
  capture: FunctionalCaptureInput,
  context: FindingContext,
): FunctionalEvaluationResult {
  const executionOutcome = classifyExecutionOutcome(capture)
  if (executionOutcome !== "valid") {
    return { executionOutcome, metrics: {}, findings: [] }
  }

  const failedSteps = capture.stepResults.filter(
    (step) => step.status === "failed" && step.origin === "product",
  )
  const failedAssertions = capture.assertionResults.filter(
    (assertion) =>
      assertion.status === "failed" && assertion.origin === "product",
  )
  const productErrors = (capture.executionErrors ?? []).filter(
    (error) => error.origin === "product",
  )
  const requiredRatio =
    capture.completeness.expectedRequired === 0
      ? 0
      : capture.completeness.capturedRequired /
        capture.completeness.expectedRequired

  const stepFindings = failedSteps.map((step) =>
    createFinding({
      context,
      ruleId: "interaction.step-failed",
      evaluatorId: "interaction",
      comparison: "runtime-contract",
      metricKey: `step.${step.stepId}`,
      dimension: "interaction",
      severity: "critical",
      summary: `Scenario step failed: ${step.stepId}`,
      explanation: step.errorCode
        ? `The observed product state failed with ${step.errorCode}.`
        : "The observed product state did not satisfy the step.",
      evidence: step.evidence,
    }),
  )

  const assertionFindings = failedAssertions.map((assertion) =>
    createFinding({
      context,
      ruleId: "interaction.assertion-failed",
      evaluatorId: "interaction",
      comparison: "runtime-contract",
      metricKey: `assertion.${assertion.assertionId}`,
      dimension: "interaction",
      severity: "critical",
      checkpointId: assertion.checkpointId,
      summary: `Assertion failed: ${assertion.assertionId}`,
      measurement:
        assertion.expected || assertion.actual
          ? {
              ...(assertion.expected ? { expected: assertion.expected } : {}),
              ...(assertion.actual ? { actual: assertion.actual } : {}),
            }
          : undefined,
      evidence: assertion.evidence,
    }),
  )

  const runtimeFindings = productErrors.map((error) =>
    createFinding({
      context,
      ruleId: "runtime.product-error",
      evaluatorId: "runtime",
      comparison: "runtime-contract",
      metricKey: `runtime.${error.code}`,
      dimension: "runtime",
      severity: "critical",
      summary: `Product runtime error: ${error.code}`,
      explanation: error.message,
      evidence: error.evidence,
    }),
  )

  return {
    executionOutcome,
    metrics: {
      "execution.valid":
        failedSteps.length === 0 &&
        failedAssertions.length === 0 &&
        productErrors.length === 0,
      "execution.failedSteps": failedSteps.length,
      "interaction.failedAssertions": failedAssertions.length,
      "runtime.criticalErrors": productErrors.length,
      "coverage.requiredRatio": requiredRatio,
    },
    findings: [...stepFindings, ...assertionFindings, ...runtimeFindings],
  }
}
