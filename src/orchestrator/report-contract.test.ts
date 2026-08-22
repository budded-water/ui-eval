import { describe, expect, it } from "vitest"

import {
  canonicalDigest,
  DigestExclusionProfiles,
} from "../contracts/canonical-json"
import type {
  ArtifactRef,
  CaptureBundle,
  EvaluationPlan,
  EvaluationPolicy,
  EvaluationReportSpec,
  Finding,
} from "../contracts/model"
import {
  evaluatePolicyGates,
  type GatePolicy,
} from "../policy-engine/evaluate-policy"
import {
  assertReportContract,
  reportContractIssues,
  ReportContractError,
  type ReportContractInput,
  type ReportVisualDecision,
} from "./report-contract"

function digest(seed: number): `sha256:${string}` {
  return `sha256:${seed.toString(16).padStart(64, "0")}`
}

function artifact(seed: number): ArtifactRef {
  const value = digest(seed)
  return {
    id: value,
    projectId: "report-contract-test",
    storeId: "local-cas-v1",
    digest: value,
    mediaType: "application/json",
    sizeBytes: 2,
    sensitivity: "internal",
  }
}

function policy(): EvaluationPolicy {
  const evaluatorConfigs = {
    execution: artifact(11),
    interaction: artifact(12),
    runtime: artifact(13),
  }
  const spec: EvaluationPolicy["spec"] = {
    evaluators: Object.entries(evaluatorConfigs).map(([id, configRef]) => ({
      id,
      version: "0.1.0",
      configRef,
      configDigest: configRef.digest,
      required: true,
      weight: 0,
    })),
    tolerances: [],
    gates: [
      {
        id: "execution-valid",
        hard: true,
        expression: {
          metric: "execution.valid",
          operator: "eq",
          value: true,
        },
        onUnknown: "fail",
      },
      {
        id: "interaction-assertions",
        hard: true,
        expression: {
          metric: "interaction.failedAssertions",
          operator: "eq",
          value: 0,
        },
        onUnknown: "fail",
      },
      {
        id: "runtime-critical-errors",
        hard: true,
        expression: {
          metric: "runtime.criticalErrors",
          operator: "eq",
          value: 0,
        },
        onUnknown: "fail",
      },
    ],
    repeatability: { attempts: 1, requiredAgreement: 1 },
    dynamicRegions: [],
    agentMutation: {
      allowedPathGlobs: ["app/**"],
      protectedPathGlobs: ["ui-eval/**"],
    },
  }
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "EvaluationPolicy",
    metadata: {
      id: "phase-0a",
      projectId: "report-contract-test",
      revision: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      createdBy: { type: "service", id: "test" },
      specDigest: canonicalDigest(spec),
    },
    spec,
  }
}

function captureBundle(): CaptureBundle {
  const screenshot = {
    ...artifact(21),
    mediaType: "image/png",
    sizeBytes: 128,
  }
  const spec: CaptureBundle["spec"] = {
    executionId: "run-1",
    runManifestDigest: digest(22),
    captureKey: digest(23),
    scenarioId: "terms-desktop",
    variant: {
      variantKey: "desktop__zh-CN__light",
      values: {
        deviceProfile: "desktop",
        locale: "zh-CN",
        theme: "light",
      },
      contextDigest: digest(24),
    },
    sourceRevision: {
      repository: "github.com/acme/product",
      commitSha: "abc123",
      dirtyTree: false,
    },
    build: {
      platform: "web",
      artifactDigest: digest(25),
      buildConfigDigest: digest(26),
      publicEnvironmentDigest: digest(27),
    },
    adapter: {
      id: "uieval.playwright.chromium",
      version: "0.1.0",
      platform: "web",
    },
    environment: {
      os: "darwin",
      architecture: "arm64",
      rendererProfile: "desktop",
      browserOrDevice: "chromium:playwright",
      browserOrOsVersion: "1",
      driverVersion: "playwright/1",
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      fontSetDigest: digest(28),
      environmentDigest: digest(29),
    },
    capabilities: ["screenshot"],
    status: "completed",
    completeness: {
      expectedRequired: 1,
      capturedRequired: 1,
      missingRequired: 0,
    },
    stepResults: [],
    assertionResults: [],
    checkpoints: [
      {
        checkpointId: "ready",
        renderSpace: {
          logicalWidth: 1280,
          logicalHeight: 720,
          logicalUnit: "css-px",
          deviceScaleFactor: 1,
          screenshotWidthPx: 1280,
          screenshotHeightPx: 720,
          orientation: "landscape",
        },
        capturedAt: "2026-08-10T00:00:00.000Z",
        evidence: [
          {
            channel: "screenshot",
            required: true,
            status: "captured",
            artifact: screenshot,
          },
        ],
      },
    ],
  }
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "CaptureBundle",
    metadata: {
      id: "capture-run-1",
      projectId: "report-contract-test",
      revision: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      createdBy: { type: "service", id: "test" },
      specDigest: canonicalDigest(spec),
    },
    spec,
  }
}

function evaluationPlan(
  sealedPolicy: EvaluationPolicy,
  capture: CaptureBundle,
): EvaluationPlan {
  const base: EvaluationPlan = {
    evaluationId: "evaluation-run-1",
    candidate: {
      captureBundleDigest: capture.metadata.specDigest,
      normalizedCandidateEvidenceDigest: digest(31),
    },
    policy: {
      policyDigest: sealedPolicy.metadata.specDigest,
      evaluators: sealedPolicy.spec.evaluators.map(
        ({ id, version, configRef, configDigest, required }) => ({
          id,
          version,
          configRef,
          configDigest,
          required,
        }),
      ),
    },
    evaluationKey: digest(0),
  }
  base.evaluationKey = canonicalDigest(base, {
    exclusions: DigestExclusionProfiles.evaluationPlan,
  })
  return base
}

function refreshEvaluationKey(plan: EvaluationPlan): void {
  plan.evaluationKey = canonicalDigest(plan, {
    exclusions: DigestExclusionProfiles.evaluationPlan,
  })
}

function fixture(): ReportContractInput {
  const sealedPolicy = policy()
  const capture = captureBundle()
  const plan = evaluationPlan(sealedPolicy, capture)
  const evaluatedGates = evaluatePolicyGates(
    sealedPolicy.spec.gates as GatePolicy[],
    {
      "execution.valid": true,
      "interaction.failedAssertions": 0,
      "runtime.criticalErrors": 0,
    },
  )
  const expectedEvaluatorProvenance = sealedPolicy.spec.evaluators.map(
    ({ id, version, configDigest }) => ({ id, version, configDigest }),
  )
  const reportSpec: EvaluationReportSpec = {
    evaluationKey: plan.evaluationKey,
    inputs: {
      candidateCaptureDigest: capture.metadata.specDigest,
      normalizedCandidateEvidenceDigest:
        plan.candidate.normalizedCandidateEvidenceDigest,
      scenarioDigest: digest(32),
      policyDigest: sealedPolicy.metadata.specDigest,
      sourceRevision: capture.spec.sourceRevision,
    },
    executionOutcome: "valid",
    rawStatus: "pass",
    coverage: {
      total: {
        expected: 0,
        evaluated: 0,
        passed: 0,
        failed: 0,
        unsupported: 0,
        invalid: 0,
      },
      byDimension: [],
    },
    gates: evaluatedGates.map(({ gateId, hard, status, reason }) => ({
      gateId,
      hard,
      status,
      reason,
    })),
    findings: [],
    provenance: {
      orchestratorVersion: "0.1.0",
      evaluators: expectedEvaluatorProvenance.map((entry) => ({ ...entry })),
    },
  }
  return {
    reportSpec,
    evaluationPlan: plan,
    policy: sealedPolicy,
    captureBundle: capture,
    evaluatedGates,
    expectedExecutionOutcome: "valid",
    visualDecision: { status: "none" },
    expectedEvaluatorProvenance,
    expectedScenarioDigest: digest(32),
  }
}

function sealLocalReference(
  input: ReportContractInput,
  visualDecision: ReportVisualDecision,
): void {
  const referenceDigest = digest(41)
  input.evaluationPlan.localReference = {
    inputDigest: referenceDigest,
    trust: "local-unprotected",
    checkpointId: input.captureBundle.spec.checkpoints[0].checkpointId,
    candidateArtifactDigest:
      input.captureBundle.spec.checkpoints[0].evidence[0].artifact!.digest,
  }
  refreshEvaluationKey(input.evaluationPlan)
  input.reportSpec.evaluationKey = input.evaluationPlan.evaluationKey
  input.reportSpec.inputs.localReferenceDigest = referenceDigest
  input.visualDecision = visualDecision
}

function finding(input: ReportContractInput): Finding {
  return {
    findingId: digest(51),
    fingerprint: digest(52),
    ruleId: "runtime.observation",
    ruleSemanticVersion: "1.0.0",
    metricKey: "runtime.observation",
    evaluatorId: "runtime",
    evaluatorVersion: "0.1.0",
    comparison: "runtime-contract",
    dimension: "runtime",
    severity: "info",
    confidence: 1,
    scenarioId: input.captureBundle.spec.scenarioId,
    executionId: input.captureBundle.spec.executionId,
    checkpointId: input.captureBundle.spec.checkpoints[0].checkpointId,
    variantKey: input.captureBundle.spec.variant.variantKey,
    contextDigest: input.captureBundle.spec.variant.contextDigest,
    summary: "Runtime observation",
    evidence: [],
  }
}

describe("assertReportContract", () => {
  it("accepts an exact binding independent of gate and provenance order", () => {
    const input = fixture()
    input.reportSpec.gates.reverse()
    input.reportSpec.provenance.evaluators.reverse()

    expect(assertReportContract(input)).toBe(input.reportSpec)
  })

  it("binds report inputs and verifies every upstream digest", () => {
    const input = fixture()
    input.reportSpec.evaluationKey = digest(61)
    input.reportSpec.inputs.candidateCaptureDigest = digest(62)
    input.reportSpec.inputs.normalizedCandidateEvidenceDigest = digest(63)
    input.reportSpec.inputs.policyDigest = digest(64)
    input.reportSpec.inputs.scenarioDigest = digest(65)
    input.reportSpec.inputs.sourceRevision = {
      ...input.reportSpec.inputs.sourceRevision,
      commitSha: "foreign",
    }
    input.captureBundle.spec.build.artifactDigest = digest(66)
    input.policy.spec.agentMutation.maxChangedFiles = 99
    input.evaluationPlan.candidate.normalizedCandidateEvidenceDigest = digest(67)

    expect(reportContractIssues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/evaluationKey" }),
        expect.objectContaining({ path: "/inputs/candidateCaptureDigest" }),
        expect.objectContaining({
          path: "/inputs/normalizedCandidateEvidenceDigest",
        }),
        expect.objectContaining({ path: "/inputs/policyDigest" }),
        expect.objectContaining({ path: "/inputs/scenarioDigest" }),
        expect.objectContaining({ path: "/inputs/sourceRevision" }),
        expect.objectContaining({
          path: "/captureBundle/metadata/specDigest",
        }),
        expect.objectContaining({ path: "/policy/metadata/specDigest" }),
        expect.objectContaining({
          path: "/evaluationPlan/evaluationKey",
        }),
      ]),
    )
  })

  it("exactly binds optional design, baseline, and local-reference inputs", () => {
    const input = fixture()
    input.reportSpec.inputs.designContractDigest = digest(71)
    input.reportSpec.inputs.baselineCaptureDigest = digest(72)
    input.reportSpec.inputs.localReferenceDigest = digest(73)

    expect(reportContractIssues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/inputs/designContractDigest" }),
        expect.objectContaining({ path: "/inputs/baselineCaptureDigest" }),
        expect.objectContaining({ path: "/inputs/localReferenceDigest" }),
      ]),
    )

    const multiBaseline = fixture()
    multiBaseline.evaluationPlan.baseline = {
      captureDigests: [digest(74), digest(75)],
      environmentCompatibilityDigest: digest(76),
    }
    refreshEvaluationKey(multiBaseline.evaluationPlan)
    multiBaseline.reportSpec.evaluationKey =
      multiBaseline.evaluationPlan.evaluationKey
    expect(reportContractIssues(multiBaseline)).toContainEqual(
      expect.objectContaining({
        path: "/evaluationPlan/baseline/captureDigests",
        code: "invalid-binding",
      }),
    )
  })

  it("binds a local reference to its exact captured checkpoint artifact", () => {
    const wrongCheckpoint = fixture()
    sealLocalReference(wrongCheckpoint, {
      status: "measured",
      changedPixels: 0,
    })
    wrongCheckpoint.evaluationPlan.localReference!.checkpointId = "foreign"
    refreshEvaluationKey(wrongCheckpoint.evaluationPlan)
    wrongCheckpoint.reportSpec.evaluationKey =
      wrongCheckpoint.evaluationPlan.evaluationKey

    expect(reportContractIssues(wrongCheckpoint)).toContainEqual(
      expect.objectContaining({
        path: "/evaluationPlan/localReference/checkpointId",
        code: "invalid-binding",
      }),
    )

    const wrongArtifact = fixture()
    sealLocalReference(wrongArtifact, {
      status: "measured",
      changedPixels: 0,
    })
    wrongArtifact.evaluationPlan.localReference!.candidateArtifactDigest =
      digest(99)
    refreshEvaluationKey(wrongArtifact.evaluationPlan)
    wrongArtifact.reportSpec.evaluationKey =
      wrongArtifact.evaluationPlan.evaluationKey

    expect(reportContractIssues(wrongArtifact)).toContainEqual(
      expect.objectContaining({
        path: "/evaluationPlan/localReference/candidateArtifactDigest",
        code: "value-mismatch",
      }),
    )
  })

  it("requires exact policy, evaluated, and reported gate coverage", () => {
    const input = fixture()
    input.evaluatedGates = input.evaluatedGates.slice(0, 2)
    input.reportSpec.gates[0] = {
      ...input.reportSpec.gates[0],
      hard: false,
      status: "fail",
      reason: "fabricated",
    }
    input.reportSpec.gates.push({
      gateId: "foreign",
      hard: true,
      status: "pass",
      reason: "fabricated",
    })

    expect(reportContractIssues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/evaluatedGates", code: "missing-id" }),
        expect.objectContaining({ path: "/gates", code: "unexpected-id" }),
        expect.objectContaining({ path: "/gates/0/hard" }),
        expect.objectContaining({ path: "/gates/0/status" }),
        expect.objectContaining({ path: "/gates/0/reason" }),
      ]),
    )
  })

  it("binds unknown disposition to the selected policy", () => {
    const input = fixture()
    input.evaluatedGates = input.evaluatedGates.map((gate, index) =>
      index === 0 ? { ...gate, unknownDisposition: "review" } : gate,
    )

    expect(reportContractIssues(input)).toContainEqual(
      expect.objectContaining({
        path: "/evaluatedGates/0/unknownDisposition",
        code: "value-mismatch",
      }),
    )
  })

  it("recomputes raw status with the exact visual decision semantics", () => {
    const unchanged = fixture()
    sealLocalReference(unchanged, { status: "measured", changedPixels: 0 })
    expect(reportContractIssues(unchanged)).toEqual([])

    const changed = fixture()
    sealLocalReference(changed, { status: "measured", changedPixels: 1 })
    changed.reportSpec.rawStatus = "needs-review"
    expect(reportContractIssues(changed)).toEqual([])

    const unknown = fixture()
    sealLocalReference(unknown, { status: "unknown" })
    unknown.reportSpec.rawStatus = "inconclusive"
    expect(reportContractIssues(unknown)).toEqual([])

    const falseGreen = fixture()
    sealLocalReference(falseGreen, { status: "measured", changedPixels: 1 })
    expect(reportContractIssues(falseGreen)).toContainEqual(
      expect.objectContaining({ path: "/rawStatus", code: "value-mismatch" }),
    )
  })

  it("gives invalid or infrastructure execution evidence precedence", () => {
    const input = fixture()
    input.expectedExecutionOutcome = "infra-error"
    input.reportSpec.executionOutcome = "infra-error"

    expect(reportContractIssues(input)).toContainEqual(
      expect.objectContaining({ path: "/rawStatus", code: "value-mismatch" }),
    )
    input.reportSpec.rawStatus = "inconclusive"
    expect(reportContractIssues(input)).toEqual([])
  })

  it("rejects visual decisions that are not sealed by EvaluationPlan", () => {
    const unexpectedVisual = fixture()
    unexpectedVisual.visualDecision = { status: "unknown" }
    unexpectedVisual.reportSpec.rawStatus = "inconclusive"
    expect(reportContractIssues(unexpectedVisual)).toContainEqual(
      expect.objectContaining({
        path: "/visualDecision/status",
        code: "invalid-binding",
      }),
    )

    const missingDecision = fixture()
    sealLocalReference(missingDecision, { status: "none" })
    expect(reportContractIssues(missingDecision)).toContainEqual(
      expect.objectContaining({
        path: "/visualDecision/status",
        code: "invalid-binding",
      }),
    )
  })

  it("binds findings to the candidate context and executed evaluator", () => {
    const exact = fixture()
    exact.reportSpec.findings = [finding(exact)]
    expect(reportContractIssues(exact)).toEqual([])

    const input = fixture()
    const foreign = finding(input)
    foreign.executionId = "foreign-run"
    foreign.scenarioId = "foreign-scenario"
    foreign.variantKey = "foreign-variant"
    foreign.contextDigest = digest(81)
    foreign.checkpointId = "foreign-checkpoint"
    foreign.evaluatorId = "foreign-evaluator"
    input.reportSpec.findings = [foreign]

    expect(reportContractIssues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/findings/0/executionId" }),
        expect.objectContaining({ path: "/findings/0/scenarioId" }),
        expect.objectContaining({ path: "/findings/0/variantKey" }),
        expect.objectContaining({ path: "/findings/0/contextDigest" }),
        expect.objectContaining({ path: "/findings/0/checkpointId" }),
        expect.objectContaining({ path: "/findings/0/evaluatorId" }),
      ]),
    )
  })

  it("never validates PASS alongside a blocker or critical finding", () => {
    const input = fixture()
    input.reportSpec.findings = [
      { ...finding(input), severity: "critical" },
    ]

    expect(reportContractIssues(input)).toContainEqual(
      expect.objectContaining({
        path: "/rawStatus",
        code: "invalid-binding",
      }),
    )
  })

  it("exactly binds evaluator provenance to the sealed plan", () => {
    const input = fixture()
    input.reportSpec.provenance.evaluators.pop()
    input.reportSpec.provenance.evaluators[0] = {
      ...input.reportSpec.provenance.evaluators[0],
      version: "9.9.9",
    }
    input.expectedEvaluatorProvenance = [
      ...input.expectedEvaluatorProvenance,
      { id: "foreign", version: "0.1.0", configDigest: digest(91) },
    ]

    expect(reportContractIssues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/provenance/evaluators",
          code: "missing-id",
        }),
        expect.objectContaining({ path: "/provenance/evaluators/0" }),
        expect.objectContaining({
          path: "/expectedEvaluatorProvenance",
          code: "unexpected-id",
        }),
      ]),
    )
  })

  it("throws a structured boundary error", () => {
    const input = fixture()
    input.reportSpec.rawStatus = "fail"

    expect(() => assertReportContract(input)).toThrowError(
      expect.objectContaining({
        code: "REPORT_CONTRACT_MISMATCH",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "/rawStatus" }),
        ]),
      }),
    )
    expect(
      (() => {
        try {
          assertReportContract(input)
        } catch (error) {
          return error
        }
      })(),
    ).toBeInstanceOf(ReportContractError)
  })
})
