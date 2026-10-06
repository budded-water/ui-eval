import {
  canonicalDigest,
  canonicalJson,
  DigestExclusionProfiles,
} from "../contracts/canonical-json"
import type {
  CaptureBundle,
  Digest,
  EvaluationPlan,
  EvaluationPolicy,
  EvaluationReportSpec,
} from "../contracts/model"
import {
  decideRawStatus,
  type EvaluatedGate,
} from "../policy-engine/evaluate-policy"

export type ReportVisualDecision =
  | { status: "none" }
  | { status: "measured"; changedPixels: number }
  | { status: "unknown" }

type EvaluatorProvenance =
  EvaluationReportSpec["provenance"]["evaluators"][number]

export interface ReportContractInput {
  reportSpec: EvaluationReportSpec
  evaluationPlan: EvaluationPlan
  policy: EvaluationPolicy
  captureBundle: CaptureBundle
  evaluatedGates: readonly EvaluatedGate[]
  expectedExecutionOutcome: EvaluationReportSpec["executionOutcome"]
  expectedMetrics?: EvaluationReportSpec["metrics"]
  expectedExecutionTarget?: EvaluationReportSpec["inputs"]["executionTarget"]
  expectedDeploymentVerification?: EvaluationReportSpec["provenance"]["deploymentVerification"]
  visualDecision: ReportVisualDecision
  expectedEvaluatorProvenance: readonly EvaluatorProvenance[]
  /** ResolvedScenarioPlan is intentionally not part of EvaluationPlan in v1alpha1. */
  expectedScenarioDigest: Digest
}

export type ReportContractIssueCode =
  | "value-mismatch"
  | "missing-id"
  | "unexpected-id"
  | "duplicate-id"
  | "invalid-binding"

export interface ReportContractIssue {
  path: string
  code: ReportContractIssueCode
  message: string
}

export class ReportContractError extends Error {
  readonly code = "REPORT_CONTRACT_MISMATCH"
  readonly issues: ReportContractIssue[]

  constructor(issues: ReportContractIssue[]) {
    super(
      `EvaluationReport does not match its sealed evaluation inputs: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    )
    this.name = "ReportContractError"
    this.issues = issues
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return canonicalJson(left) === canonicalJson(right)
}

function valueIssue(
  issues: ReportContractIssue[],
  path: string,
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (sameJson(actual, expected)) return
  issues.push({
    path,
    code: "value-mismatch",
    message: `${label} does not match the sealed evaluation input`,
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

function duplicateIdIssues(
  issues: ReportContractIssue[],
  path: string,
  label: string,
  ids: readonly string[],
): void {
  const duplicates = [...counts(ids)]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort()
  if (duplicates.length === 0) return
  issues.push({
    path,
    code: "duplicate-id",
    message: `${label} contains duplicate ${quoted(duplicates)}`,
  })
}

function exactIdCoverageIssues(options: {
  issues: ReportContractIssue[]
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
  duplicateIdIssues(
    options.issues,
    options.path,
    options.label,
    options.actual,
  )
}

function inputBindingIssues(
  input: ReportContractInput,
  issues: ReportContractIssue[],
): void {
  const { reportSpec, evaluationPlan, policy, captureBundle } = input
  valueIssue(
    issues,
    "/captureBundle/metadata/specDigest",
    "capture bundle spec digest",
    captureBundle.metadata.specDigest,
    canonicalDigest(captureBundle.spec),
  )
  valueIssue(
    issues,
    "/policy/metadata/specDigest",
    "policy spec digest",
    policy.metadata.specDigest,
    canonicalDigest(policy.spec),
  )
  valueIssue(
    issues,
    "/evaluationPlan/evaluationKey",
    "evaluation plan key",
    evaluationPlan.evaluationKey,
    canonicalDigest(evaluationPlan, {
      exclusions: DigestExclusionProfiles.evaluationPlan,
    }),
  )

  valueIssue(
    issues,
    "/evaluationKey",
    "report evaluation key",
    reportSpec.evaluationKey,
    evaluationPlan.evaluationKey,
  )
  valueIssue(
    issues,
    "/evaluationPlan/candidate/captureBundleDigest",
    "planned capture bundle digest",
    evaluationPlan.candidate.captureBundleDigest,
    captureBundle.metadata.specDigest,
  )
  valueIssue(
    issues,
    "/inputs/candidateCaptureDigest",
    "candidate capture digest",
    reportSpec.inputs.candidateCaptureDigest,
    evaluationPlan.candidate.captureBundleDigest,
  )
  valueIssue(
    issues,
    "/inputs/normalizedCandidateEvidenceDigest",
    "normalized candidate evidence digest",
    reportSpec.inputs.normalizedCandidateEvidenceDigest,
    evaluationPlan.candidate.normalizedCandidateEvidenceDigest,
  )
  valueIssue(
    issues,
    "/evaluationPlan/policy/policyDigest",
    "planned policy digest",
    evaluationPlan.policy.policyDigest,
    policy.metadata.specDigest,
  )
  valueIssue(
    issues,
    "/inputs/policyDigest",
    "report policy digest",
    reportSpec.inputs.policyDigest,
    evaluationPlan.policy.policyDigest,
  )
  valueIssue(
    issues,
    "/inputs/scenarioDigest",
    "scenario digest",
    reportSpec.inputs.scenarioDigest,
    input.expectedScenarioDigest,
  )
  valueIssue(
    issues,
    "/inputs/sourceRevision",
    "source revision",
    reportSpec.inputs.sourceRevision,
    captureBundle.spec.sourceRevision,
  )
  valueIssue(
    issues,
    "/inputs/designContractDigest",
    "design contract digest",
    reportSpec.inputs.designContractDigest,
    evaluationPlan.design?.contractDigest,
  )
  valueIssue(
    issues,
    "/inputs/localReferenceDigest",
    "local reference digest",
    reportSpec.inputs.localReferenceDigest,
    evaluationPlan.localReference?.inputDigest,
  )
  if (evaluationPlan.localReference) {
    const reference = evaluationPlan.localReference
    const checkpoint = captureBundle.spec.checkpoints.find(
      (candidate) => candidate.checkpointId === reference.checkpointId,
    )
    if (!checkpoint) {
      issues.push({
        path: "/evaluationPlan/localReference/checkpointId",
        code: "invalid-binding",
        message: "local reference checkpoint is absent from candidate capture",
      })
    } else {
      const screenshot = checkpoint.evidence.find(
        (record) =>
          record.channel === "screenshot" &&
          record.status === "captured",
      )?.artifact
      valueIssue(
        issues,
        "/evaluationPlan/localReference/candidateArtifactDigest",
        "local reference candidate screenshot digest",
        reference.candidateArtifactDigest,
        screenshot?.digest,
      )
    }
  }

  const baselineDigests = evaluationPlan.baseline?.captureDigests
  if (baselineDigests && baselineDigests.length !== 1) {
    issues.push({
      path: "/evaluationPlan/baseline/captureDigests",
      code: "invalid-binding",
      message:
        "a singular report baselineCaptureDigest cannot exactly bind multiple planned baselines",
    })
  } else {
    valueIssue(
      issues,
      "/inputs/baselineCaptureDigest",
      "baseline capture digest",
      reportSpec.inputs.baselineCaptureDigest,
      baselineDigests?.[0],
    )
  }

  const expectedEvaluators = policy.spec.evaluators.map(
    ({ id, version, configRef, configDigest, required }) => ({
      id,
      version,
      configRef,
      configDigest,
      required,
    }),
  )
  exactIdCoverageIssues({
    issues,
    path: "/evaluationPlan/policy/evaluators",
    label: "planned policy evaluator coverage",
    expected: expectedEvaluators.map(({ id }) => id),
    actual: evaluationPlan.policy.evaluators.map(({ id }) => id),
  })
  duplicateIdIssues(
    issues,
    "/policy/spec/evaluators",
    "materialized policy evaluator coverage",
    expectedEvaluators.map(({ id }) => id),
  )
  for (const expected of expectedEvaluators) {
    const index = evaluationPlan.policy.evaluators.findIndex(
      ({ id }) => id === expected.id,
    )
    if (index < 0) continue
    valueIssue(
      issues,
      `/evaluationPlan/policy/evaluators/${index}`,
      `evaluator ${JSON.stringify(expected.id)}`,
      evaluationPlan.policy.evaluators[index],
      expected,
    )
  }
}

function gateBindingIssues(
  input: ReportContractInput,
  issues: ReportContractIssue[],
): void {
  const policyGates = input.policy.spec.gates
  const evaluated = input.evaluatedGates
  const reported = input.reportSpec.gates
  duplicateIdIssues(
    issues,
    "/policy/spec/gates",
    "policy gate coverage",
    policyGates.map(({ id }) => id),
  )
  exactIdCoverageIssues({
    issues,
    path: "/evaluatedGates",
    label: "evaluated gate coverage",
    expected: policyGates.map(({ id }) => id),
    actual: evaluated.map(({ gateId }) => gateId),
  })
  exactIdCoverageIssues({
    issues,
    path: "/gates",
    label: "reported gate coverage",
    expected: evaluated.map(({ gateId }) => gateId),
    actual: reported.map(({ gateId }) => gateId),
  })

  for (const gate of evaluated) {
    const policyGate = policyGates.find(({ id }) => id === gate.gateId)
    const evaluatedIndex = evaluated.indexOf(gate)
    if (policyGate) {
      valueIssue(
        issues,
        `/evaluatedGates/${evaluatedIndex}/hard`,
        "evaluated gate hardness",
        gate.hard,
        policyGate.hard,
      )
      valueIssue(
        issues,
        `/evaluatedGates/${evaluatedIndex}/unknownDisposition`,
        "evaluated unknown disposition",
        gate.unknownDisposition,
        gate.status === "unknown" ? policyGate.onUnknown : undefined,
      )
    }

    const reportIndex = reported.findIndex(
      ({ gateId }) => gateId === gate.gateId,
    )
    if (reportIndex < 0) continue
    const reportGate = reported[reportIndex]
    valueIssue(
      issues,
      `/gates/${reportIndex}/hard`,
      "reported gate hardness",
      reportGate.hard,
      gate.hard,
    )
    valueIssue(
      issues,
      `/gates/${reportIndex}/status`,
      "reported gate status",
      reportGate.status,
      gate.status,
    )
    valueIssue(
      issues,
      `/gates/${reportIndex}/reason`,
      "reported gate reason",
      reportGate.reason,
      gate.reason,
    )
  }

  const findingFingerprints = new Set(
    input.reportSpec.findings.map(({ fingerprint }) => fingerprint),
  )
  reported.forEach((gate, gateIndex) => {
    const foreign = (gate.relatedFindingFingerprints ?? []).filter(
      (fingerprint) => !findingFingerprints.has(fingerprint),
    )
    if (foreign.length === 0) return
    issues.push({
      path: `/gates/${gateIndex}/relatedFindingFingerprints`,
      code: "invalid-binding",
      message: `gate references absent finding fingerprints ${quoted(foreign)}`,
    })
  })
}

function expectedRawStatus(
  input: ReportContractInput,
  issues: ReportContractIssue[],
): EvaluationReportSpec["rawStatus"] {
  const policyStatus = decideRawStatus(
    input.expectedExecutionOutcome,
    input.evaluatedGates,
  )
  const hasReference = input.evaluationPlan.localReference !== undefined
  const visualRequested = input.visualDecision.status !== "none"
  if (hasReference !== visualRequested) {
    issues.push({
      path: "/visualDecision/status",
      code: "invalid-binding",
      message: hasReference
        ? "a planned local reference requires a measured or unknown visual decision"
        : "a visual decision requires a localReference sealed in EvaluationPlan",
    })
  }

  if (input.visualDecision.status === "measured") {
    const { changedPixels } = input.visualDecision
    if (!Number.isSafeInteger(changedPixels) || changedPixels < 0) {
      issues.push({
        path: "/visualDecision/changedPixels",
        code: "invalid-binding",
        message: "changedPixels must be a non-negative safe integer",
      })
    }
  }

  if (
    input.expectedExecutionOutcome !== "valid" ||
    policyStatus === "fail"
  ) {
    return policyStatus
  }
  if (input.visualDecision.status === "none") return policyStatus
  if (input.visualDecision.status === "unknown") return "inconclusive"
  if (
    input.visualDecision.changedPixels > 0 &&
    policyStatus === "pass"
  ) {
    return "needs-review"
  }
  return policyStatus
}

function findingBindingIssues(
  input: ReportContractInput,
  issues: ReportContractIssue[],
): void {
  const { captureBundle, reportSpec } = input
  const checkpointIds = new Set(
    captureBundle.spec.checkpoints.map(({ checkpointId }) => checkpointId),
  )
  const evaluatorById = new Map(
    input.expectedEvaluatorProvenance.map((entry) => [entry.id, entry]),
  )

  reportSpec.findings.forEach((finding, index) => {
    const path = `/findings/${index}`
    valueIssue(
      issues,
      `${path}/executionId`,
      "finding executionId",
      finding.executionId,
      captureBundle.spec.executionId,
    )
    valueIssue(
      issues,
      `${path}/scenarioId`,
      "finding scenarioId",
      finding.scenarioId,
      captureBundle.spec.scenarioId,
    )
    valueIssue(
      issues,
      `${path}/variantKey`,
      "finding variantKey",
      finding.variantKey,
      captureBundle.spec.variant.variantKey,
    )
    valueIssue(
      issues,
      `${path}/contextDigest`,
      "finding contextDigest",
      finding.contextDigest,
      captureBundle.spec.variant.contextDigest,
    )
    if (!checkpointIds.has(finding.checkpointId)) {
      issues.push({
        path: `${path}/checkpointId`,
        code: "invalid-binding",
        message: "finding checkpointId is absent from the candidate capture",
      })
    }

    const evaluator = evaluatorById.get(finding.evaluatorId)
    if (!evaluator || evaluator.version !== finding.evaluatorVersion) {
      issues.push({
        path: `${path}/evaluatorId`,
        code: "invalid-binding",
        message:
          "finding evaluator identity is absent from expected executed provenance",
      })
    }
  })

  if (
    reportSpec.rawStatus === "pass" &&
    reportSpec.findings.some(({ severity }) =>
      ["blocker", "critical"].includes(severity),
    )
  ) {
    issues.push({
      path: "/rawStatus",
      code: "invalid-binding",
      message: "PASS cannot coexist with a blocker or critical finding",
    })
  }
}

function provenanceBindingIssues(
  input: ReportContractInput,
  issues: ReportContractIssue[],
): void {
  const expected = input.expectedEvaluatorProvenance
  const reported = input.reportSpec.provenance.evaluators
  duplicateIdIssues(
    issues,
    "/expectedEvaluatorProvenance",
    "expected evaluator provenance",
    expected.map(({ id }) => id),
  )
  exactIdCoverageIssues({
    issues,
    path: "/provenance/evaluators",
    label: "reported evaluator provenance",
    expected: expected.map(({ id }) => id),
    actual: reported.map(({ id }) => id),
  })

  for (const evaluator of expected) {
    const planIndex = input.evaluationPlan.policy.evaluators.findIndex(
      ({ id }) => id === evaluator.id,
    )
    if (planIndex < 0) {
      issues.push({
        path: "/expectedEvaluatorProvenance",
        code: "unexpected-id",
        message: `executed evaluator ${JSON.stringify(evaluator.id)} was not sealed in EvaluationPlan`,
      })
    } else {
      const planned = input.evaluationPlan.policy.evaluators[planIndex]
      valueIssue(
        issues,
        `/expectedEvaluatorProvenance/${expected.indexOf(evaluator)}/version`,
        "executed evaluator version",
        evaluator.version,
        planned.version,
      )
      valueIssue(
        issues,
        `/expectedEvaluatorProvenance/${expected.indexOf(evaluator)}/configDigest`,
        "executed evaluator config digest",
        evaluator.configDigest,
        planned.configDigest,
      )
    }

    const reportIndex = reported.findIndex(({ id }) => id === evaluator.id)
    if (reportIndex < 0) continue
    valueIssue(
      issues,
      `/provenance/evaluators/${reportIndex}`,
      `reported evaluator ${JSON.stringify(evaluator.id)}`,
      reported[reportIndex],
      evaluator,
    )
  }
}

export function reportContractIssues(
  input: ReportContractInput,
): ReportContractIssue[] {
  const issues: ReportContractIssue[] = []
  inputBindingIssues(input, issues)
  gateBindingIssues(input, issues)
  valueIssue(
    issues,
    "/executionOutcome",
    "report execution outcome",
    input.reportSpec.executionOutcome,
    input.expectedExecutionOutcome,
  )
  valueIssue(
    issues,
    "/rawStatus",
    "report raw status",
    input.reportSpec.rawStatus,
    expectedRawStatus(input, issues),
  )
  provenanceBindingIssues(input, issues)
  findingBindingIssues(input, issues)
  valueIssue(issues, "/inputs/executionTarget", "execution target", input.reportSpec.inputs.executionTarget, input.expectedExecutionTarget)
  valueIssue(issues, "/provenance/deploymentVerification", "deployment verification", input.reportSpec.provenance.deploymentVerification, input.expectedDeploymentVerification)
  valueIssue(issues, "/metrics", "report metrics", input.reportSpec.metrics, input.expectedMetrics)
  return issues
}

export function assertReportContract(
  input: ReportContractInput,
): EvaluationReportSpec {
  const issues = reportContractIssues(input)
  if (issues.length > 0) throw new ReportContractError(issues)
  return input.reportSpec
}
