import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import type { Static, TSchema } from "@sinclair/typebox"

import type {
  CaptureBundle,
  DesignContract,
  DomEvidencePayload,
  EvaluationPlan,
  EvaluationPolicy,
  EvaluationReport,
  EvidencePayload,
  Finding,
  GeometryEvaluatorConfig,
  LayoutEvidencePayload,
  MockServerFixtureConfig,
  NetworkEvidencePayload,
  PolicySource,
  ResolvedScenarioPlan,
  ScenarioAuthoring,
  ScenarioManifest,
  SealedRunManifest,
  StylesEvidencePayload,
  ConsoleEvidencePayload,
  ArtifactRef,
} from "./model"
import {
  canonicalDigest,
  canonicalJson,
  DigestExclusionProfiles,
} from "./canonical-json"
import {
  ArtifactRefSchema,
  CaptureBundleSchema,
  DesignContractSchema,
  DomEvidencePayloadSchema,
  EvaluationPlanSchema,
  EvaluationPolicySchema,
  EvaluationReportSchema,
  EvidencePayloadSchema,
  FindingSchema,
  GeometryEvaluatorConfigSchema,
  LayoutEvidencePayloadSchema,
  MOCK_SERVER_FIXTURE_LIMITS,
  MockServerFixtureConfigSchema,
  NetworkEvidencePayloadSchema,
  PolicySourceSchema,
  ResolvedScenarioPlanSchema,
  ScenarioAuthoringSchema,
  ScenarioManifestSchema,
  SealedRunManifestSchema,
  StylesEvidencePayloadSchema,
  ConsoleEvidencePayloadSchema,
} from "./schemas"

export interface ContractValidationIssue {
  instancePath: string
  schemaPath: string
  keyword: string
  message: string
  params: Record<string, unknown>
}

export class ContractValidationError extends Error {
  readonly issues: ContractValidationIssue[]

  constructor(issues: ContractValidationIssue[], message = "Contract validation failed") {
    super(`${message}: ${formatIssues(issues)}`)
    this.name = "ContractValidationError"
    this.issues = issues
  }
}

export type ContractValidationResult<T> =
  | { success: true; value: T }
  | { success: false; issues: ContractValidationIssue[] }

const validatorCache = new WeakMap<TSchema, ValidateFunction>()

function compile(schema: TSchema): ValidateFunction {
  const cached = validatorCache.get(schema)
  if (cached) return cached

  // One Ajv instance per root schema avoids recursive $id collisions while the
  // WeakMap keeps the normal path compiled and cheap.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: true,
    validateFormats: true,
  })
  ;(addFormats as unknown as (instance: Ajv2020) => Ajv2020)(ajv)
  const validator = ajv.compile(schema)
  validatorCache.set(schema, validator)
  return validator
}

function toIssues(errors: ErrorObject[] | null | undefined): ContractValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "invalid value",
    params: error.params as Record<string, unknown>,
  }))
}

function semanticIssue(
  instancePath: string,
  keyword: string,
  message: string,
): ContractValidationIssue {
  return {
    instancePath,
    schemaPath: `#/semantic/${keyword}`,
    keyword,
    message,
    params: {},
  }
}

function digestMatchIssue(
  instancePath: string,
  actual: string,
  expected: string,
  label: string,
): ContractValidationIssue[] {
  return actual === expected
    ? []
    : [
        semanticIssue(
          instancePath,
          "digestMatch",
          `${label} does not match the canonical contract content`,
        ),
      ]
}

function envelopeDigestIssues(envelope: {
  metadata: { specDigest: string }
  spec: unknown
}): ContractValidationIssue[] {
  return digestMatchIssue(
    "/metadata/specDigest",
    envelope.metadata.specDigest,
    canonicalDigest(envelope.spec),
    "metadata.specDigest",
  )
}

function duplicateIdIssues(
  values: readonly string[],
  instancePath: string,
  label: string,
  propertyName = "id",
): ContractValidationIssue[] {
  const seen = new Map<string, number>()
  const issues: ContractValidationIssue[] = []
  values.forEach((value, index) => {
    const firstIndex = seen.get(value)
    if (firstIndex === undefined) {
      seen.set(value, index)
      return
    }
    issues.push(
      semanticIssue(
        `${instancePath}/${index}/${propertyName}`,
        "uniqueId",
        `${label} id '${value}' duplicates index ${firstIndex}`,
      ),
    )
  })
  return issues
}

/**
 * Capabilities are a forward-facing vocabulary, so a contract can name one this
 * version cannot carry. Each declared capability must be backed by its payload,
 * and each payload must be declared, otherwise a consumer would read a token set
 * that the contract never claimed or trust a capability that carries nothing.
 */
function designContractIssues(
  spec: DesignContract["spec"],
  basePath: string,
): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = []
  const declared = new Set<string>(spec.capabilities)
  const backing: ReadonlyArray<[string, string, boolean]> = [
    ["rendered-image", "targets", spec.targets !== undefined],
    ["tokens", "tokenSet", spec.tokenSet !== undefined],
  ]
  const representable = new Set(backing.map(([capability]) => capability))

  spec.capabilities.forEach((capability, index) => {
    if (representable.has(capability)) return
    issues.push(
      semanticIssue(
        `${basePath}/capabilities/${index}`,
        "designCapabilityUnrepresentable",
        `capability '${capability}' has no payload in this contract version`,
      ),
    )
  })

  for (const [capability, property, present] of backing) {
    if (declared.has(capability) && !present) {
      issues.push(
        semanticIssue(
          `${basePath}/${property}`,
          "designCapabilityUnbacked",
          `capability '${capability}' requires '${property}'`,
        ),
      )
    }
    if (!declared.has(capability) && present) {
      issues.push(
        semanticIssue(
          `${basePath}/${property}`,
          "designPayloadUndeclared",
          `'${property}' requires capability '${capability}'`,
        ),
      )
    }
  }

  const tokenSet = spec.tokenSet
  if (tokenSet) {
    issues.push(
      ...duplicateIdIssues(
        (tokenSet.valueSets ?? []).map((valueSet) => valueSet.id),
        `${basePath}/tokenSet/valueSets`,
        "value set",
      ),
      ...duplicateIdIssues(
        (tokenSet.scales ?? []).map((scale) => scale.id),
        `${basePath}/tokenSet/scales`,
        "scale",
      ),
      ...duplicateIdIssues(
        (tokenSet.ranges ?? []).map((range) => range.id),
        `${basePath}/tokenSet/ranges`,
        "range",
      ),
    )
    ;(tokenSet.ranges ?? []).forEach((range, index) => {
      if (range.min === undefined && range.max === undefined) {
        issues.push(
          semanticIssue(
            `${basePath}/tokenSet/ranges/${index}`,
            "designRangeUnbounded",
            `range '${range.id}' declares neither min nor max`,
          ),
        )
      } else if (
        range.min !== undefined &&
        range.max !== undefined &&
        range.min > range.max
      ) {
        issues.push(
          semanticIssue(
            `${basePath}/tokenSet/ranges/${index}`,
            "designRangeInverted",
            `range '${range.id}' declares min greater than max`,
          ),
        )
      }
    })
  }

  return issues
}

function policyIssues(
  policy: PolicySource | EvaluationPolicy["spec"],
  basePath: string,
): ContractValidationIssue[] {
  const issues = [
    ...duplicateIdIssues(
      policy.evaluators.map((evaluator) => evaluator.id),
      `${basePath}/evaluators`,
      "evaluator",
    ),
    ...duplicateIdIssues(
      policy.gates.map((gate) => gate.id),
      `${basePath}/gates`,
      "gate",
    ),
    ...duplicateIdIssues(
      policy.tolerances.map((tolerance) => tolerance.id),
      `${basePath}/tolerances`,
      "tolerance",
    ),
  ]

  if (policy.repeatability.requiredAgreement > policy.repeatability.attempts) {
    issues.push(
      semanticIssue(
        `${basePath}/repeatability/requiredAgreement`,
        "agreementRange",
        "requiredAgreement cannot exceed attempts",
      ),
    )
  }

  if ((policy as { kind?: unknown }).kind === "PolicySource") {
    const sourcePolicy = policy as PolicySource
    sourcePolicy.evaluators.forEach((evaluator, index) => {
      if (evaluator.config !== undefined && evaluator.configPath !== undefined) {
        issues.push(
          semanticIssue(
            `${basePath}/evaluators/${index}`,
            "exclusiveConfigSource",
            "evaluator must use either config or configPath, not both",
          ),
        )
      }
      if (evaluator.config !== undefined) {
        try {
          canonicalJson(evaluator.config)
        } catch {
          issues.push(
            semanticIssue(
              `${basePath}/evaluators/${index}/config`,
              "jsonValue",
              "evaluator config must be a canonical JSON value",
            ),
          )
        }
      }
    })
    sourcePolicy.tolerances.forEach((tolerance, index) => {
      try {
        canonicalJson(tolerance.value)
      } catch {
        issues.push(
          semanticIssue(
            `${basePath}/tolerances/${index}/value`,
            "jsonValue",
            "tolerance value must be a canonical JSON value",
          ),
        )
      }
    })
  } else {
    const materializedPolicy = policy as EvaluationPolicy["spec"]
    materializedPolicy.evaluators.forEach((evaluator, index) => {
      if (evaluator.configRef.digest !== evaluator.configDigest) {
        issues.push(
          semanticIssue(
            `${basePath}/evaluators/${index}/configDigest`,
            "artifactDigest",
            "configDigest must equal configRef.digest",
          ),
        )
      }
    })
  }
  return issues
}

type ScenarioLike = ScenarioAuthoring | ScenarioManifest["spec"] | ResolvedScenarioPlan

function scenarioIssues(scenario: ScenarioLike, basePath: string): ContractValidationIssue[] {
  type StepLike = { id: string; action: string; checkpointId?: string }
  type CheckpointLike = {
    id: string
    captureScope: "viewport" | "full-page" | "element"
    target?: unknown
  }
  const scenarioValue = scenario as unknown as {
    setup?: StepLike[]
    steps: StepLike[]
    cleanup?: StepLike[]
    checkpoints: CheckpointLike[]
    determinism: { clock: { mode: "fixed" | "real"; value?: string } }
  }
  const issues: ContractValidationIssue[] = []
  const allSteps = [
    ...(scenarioValue.setup ?? []),
    ...scenarioValue.steps,
    ...(scenarioValue.cleanup ?? []),
  ]
  issues.push(
    ...duplicateIdIssues(
      allSteps.map((step) => step.id),
      `${basePath}/steps`,
      "step",
    ),
  )
  issues.push(
    ...duplicateIdIssues(
      scenarioValue.checkpoints.map((checkpoint) => checkpoint.id),
      `${basePath}/checkpoints`,
      "checkpoint",
    ),
  )

  const checkpointIds = new Set(
    scenarioValue.checkpoints.map((checkpoint) => checkpoint.id),
  )
  allSteps.forEach((step, index) => {
    if (
      step.action === "checkpoint" &&
      step.checkpointId !== undefined &&
      !checkpointIds.has(step.checkpointId)
    ) {
      issues.push(
        semanticIssue(
          `${basePath}/steps/${index}/checkpointId`,
          "reference",
          `checkpoint '${step.checkpointId}' is not declared`,
        ),
      )
    }
  })

  scenarioValue.checkpoints.forEach((checkpoint, index) => {
    if (checkpoint.captureScope === "element" && checkpoint.target === undefined) {
      issues.push(
        semanticIssue(
          `${basePath}/checkpoints/${index}/target`,
          "requiredForScope",
          "element capture requires a target locator",
        ),
      )
    }
  })

  if (
    scenarioValue.determinism.clock.mode === "fixed" &&
    !scenarioValue.determinism.clock.value
  ) {
    issues.push(
      semanticIssue(
        `${basePath}/determinism/clock/value`,
        "requiredForMode",
        "fixed clock mode requires a value",
      ),
    )
  }
  if (
    scenarioValue.determinism.clock.mode === "real" &&
    scenarioValue.determinism.clock.value
  ) {
    issues.push(
      semanticIssue(
        `${basePath}/determinism/clock/value`,
        "forbiddenForMode",
        "real clock mode must not declare a fixed value",
      ),
    )
  }

  return issues
}

function captureBundleIssues(bundle: CaptureBundle): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = []
  const requiredEvidence = bundle.spec.checkpoints.flatMap((checkpoint) =>
    checkpoint.evidence.filter((record) => record.required),
  )
  const capturedRequired = requiredEvidence.filter(
    (record) => record.status === "captured" && record.artifact !== undefined,
  ).length
  const missingRequired = requiredEvidence.length - capturedRequired
  const expected = bundle.spec.completeness

  if (
    expected.expectedRequired !== requiredEvidence.length ||
    expected.capturedRequired !== capturedRequired ||
    expected.missingRequired !== missingRequired
  ) {
    issues.push(
      semanticIssue(
        "/spec/completeness",
        "evidenceCompleteness",
        "completeness counts do not match required EvidenceRecord values",
      ),
    )
  }

  bundle.spec.checkpoints.forEach((checkpoint, checkpointIndex) => {
    checkpoint.evidence.forEach((record, evidenceIndex) => {
      if (record.status === "captured" && !record.artifact) {
        issues.push(
          semanticIssue(
            `/spec/checkpoints/${checkpointIndex}/evidence/${evidenceIndex}/artifact`,
            "capturedArtifact",
            "captured evidence requires an artifact",
          ),
        )
      }
    })
  })

  if (bundle.spec.status === "completed" && missingRequired !== 0) {
    issues.push(
      semanticIssue(
        "/spec/status",
        "completedEvidence",
        "completed capture requires every required channel to be captured",
      ),
    )
  }
  if (
    bundle.spec.status === "completed" &&
    bundle.spec.executionErrors?.some(
      (error) =>
        ["runner", "driver", "fixture"].includes(error.origin) ||
        [
          "auth-cross-origin-egress-blocked",
          "candidate-origin-escaped",
          "candidate-response-preflight-failed",
        ].includes(error.code),
    )
  ) {
    issues.push(
      semanticIssue(
        "/spec/status",
        "completedInvalidError",
        "completed capture cannot contain infrastructure or security-boundary errors",
      ),
    )
  }
  return issues
}

function evidenceCollectionIssues(
  payload: ConsoleEvidencePayload | NetworkEvidencePayload,
): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = []
  if (payload.collection.capturedCount !== payload.entries.length) {
    issues.push(
      semanticIssue(
        "/collection/capturedCount",
        "evidenceCollectionCount",
        "capturedCount must equal the number of persisted entries",
      ),
    )
  }
  if (payload.collection.truncatedCount > payload.collection.capturedCount) {
    issues.push(
      semanticIssue(
        "/collection/truncatedCount",
        "evidenceCollectionCount",
        "truncatedCount cannot exceed capturedCount",
      ),
    )
  }
  const limited =
    payload.collection.droppedCount > 0 ||
    payload.collection.truncatedCount > 0
  if (limited !== (payload.collection.limitReason !== undefined)) {
    issues.push(
      semanticIssue(
        "/collection/limitReason",
        "evidenceCollectionLimit",
        limited
          ? "limited evidence must declare limitReason"
          : "limitReason must be absent when no evidence was dropped or truncated",
      ),
    )
  }
  return issues
}

function semanticIssues(schema: TSchema, value: unknown): ContractValidationIssue[] {
  if (schema === MockServerFixtureConfigSchema) {
    const config = value as MockServerFixtureConfig
    const issues = duplicateIdIssues(
      config.routes.map((route) => route.id),
      "/routes",
      "mock route",
    )
    const matches = new Map<string, number>()
    config.routes.forEach((route, index) => {
      const key = `${route.method} ${route.path}`
      const firstIndex = matches.get(key)
      if (firstIndex === undefined) matches.set(key, index)
      else {
        issues.push(
          semanticIssue(
            `/routes/${index}/path`,
            "uniqueMockRoute",
            `mock route '${key}' duplicates index ${firstIndex}`,
          ),
        )
      }
      if (
        Buffer.byteLength(route.response.body, "utf8") >
        MOCK_SERVER_FIXTURE_LIMITS.maxBodyBytes
      ) {
        issues.push(
          semanticIssue(
            `/routes/${index}/response/body`,
            "maxUtf8Bytes",
            "mock response body exceeds the UTF-8 byte limit",
          ),
        )
      }
      if (
        route.response.contentType === "application/json"
      ) {
        try {
          JSON.parse(route.response.body)
        } catch {
          issues.push(
            semanticIssue(
              `/routes/${index}/response/body`,
              "validJsonBody",
              "application/json mock response body must contain valid JSON",
            ),
          )
        }
      }
    })
    return issues
  }
  if (schema === PolicySourceSchema) {
    return policyIssues(value as PolicySource, "")
  }
  if (schema === EvaluationPolicySchema) {
    const policy = value as EvaluationPolicy
    return [
      ...policyIssues(policy.spec, "/spec"),
      ...envelopeDigestIssues(policy),
    ]
  }
  if (schema === ScenarioAuthoringSchema) {
    return scenarioIssues(value as ScenarioAuthoring, "")
  }
  if (schema === ScenarioManifestSchema) {
    const manifest = value as ScenarioManifest
    return [
      ...scenarioIssues(manifest.spec, "/spec"),
      ...envelopeDigestIssues(manifest),
    ]
  }
  if (schema === ResolvedScenarioPlanSchema) {
    const plan = value as ResolvedScenarioPlan
    return [
      ...scenarioIssues(plan, ""),
      ...digestMatchIssue(
        "/planDigest",
        plan.planDigest,
        canonicalDigest(plan, {
          exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
        }),
        "planDigest",
      ),
    ]
  }
  if (schema === DesignContractSchema) {
    const contract = value as DesignContract
    return [
      ...designContractIssues(contract.spec, "/spec"),
      ...envelopeDigestIssues(contract),
    ]
  }
  if (schema === SealedRunManifestSchema) {
    const manifest = value as SealedRunManifest
    return digestMatchIssue(
      "/captureKey",
      manifest.captureKey,
      canonicalDigest(manifest, {
        exclusions: DigestExclusionProfiles.sealedRunManifest,
      }),
      "captureKey",
    )
  }
  if (schema === CaptureBundleSchema) {
    const bundle = value as CaptureBundle
    return [
      ...captureBundleIssues(bundle),
      ...envelopeDigestIssues(bundle),
    ]
  }
  if (
    schema === ConsoleEvidencePayloadSchema ||
    schema === NetworkEvidencePayloadSchema
  ) {
    return evidenceCollectionIssues(
      value as ConsoleEvidencePayload | NetworkEvidencePayload,
    )
  }
  if (schema === EvidencePayloadSchema) {
    const payload = value as EvidencePayload
    if (
      payload.schemaVersion === "uieval.console/v1alpha1" ||
      payload.schemaVersion === "uieval.network/v1alpha1"
    ) {
      return evidenceCollectionIssues(payload)
    }
  }
  if (schema === EvaluationPlanSchema) {
    const plan = value as EvaluationPlan
    return [
      ...plan.policy.evaluators.flatMap((evaluator, index) =>
        evaluator.configRef.digest === evaluator.configDigest
          ? []
          : [
              semanticIssue(
                `/policy/evaluators/${index}/configDigest`,
                "artifactDigest",
                "configDigest must equal configRef.digest",
              ),
            ],
      ),
      ...digestMatchIssue(
        "/evaluationKey",
        plan.evaluationKey,
        canonicalDigest(plan, {
          exclusions: DigestExclusionProfiles.evaluationPlan,
        }),
        "evaluationKey",
      ),
    ]
  }
  if (schema === EvaluationReportSchema) {
    const report = value as EvaluationReport
    const issues = duplicateIdIssues(
      report.spec.gates.map((gate) => gate.gateId),
      "/spec/gates",
      "gate result",
      "gateId",
    )
    const pixelRatio = report.spec.metrics?.["visual.changedPixelRatio"]
    if (pixelRatio !== undefined &&
      (typeof pixelRatio !== "number" || !Number.isFinite(pixelRatio) || pixelRatio < 0 || pixelRatio > 1)) {
      issues.push(semanticIssue(
        "/spec/metrics/visual.changedPixelRatio", "invalidPixelRatio",
        "visual.changedPixelRatio must be a finite ratio between zero and one",
      ))
    }
    if (report.spec.executionOutcome !== "valid" && report.spec.scores !== undefined) {
      issues.push(
        semanticIssue(
          "/spec/scores",
          "invalidEvidenceScore",
          "invalid or infrastructure evidence must not produce quality scores",
        ),
      )
    }
    if (
      report.spec.executionOutcome !== "valid" &&
      report.spec.rawStatus !== "inconclusive"
    ) {
      issues.push(
        semanticIssue(
          "/spec/rawStatus",
          "invalidEvidenceDisposition",
          "invalid or infrastructure evidence must have inconclusive raw status",
        ),
      )
    }
    if (
      report.spec.rawStatus === "pass" &&
      report.spec.gates.some((gate) => gate.status !== "pass")
    ) {
      issues.push(
        semanticIssue(
          "/spec/rawStatus",
          "gateDispositionMismatch",
          "a passing report cannot contain failed or unknown policy gates",
        ),
      )
    }
    if (
      report.spec.rawStatus === "pass" &&
      report.spec.findings.some((finding) =>
        ["blocker", "critical"].includes(finding.severity),
      )
    ) {
      issues.push(
        semanticIssue(
          "/spec/rawStatus",
          "criticalFindingDispositionMismatch",
          "a passing report cannot contain blocker or critical findings",
        ),
      )
    }
    issues.push(...envelopeDigestIssues(report))
    return issues
  }
  return []
}

export function validateSchema<T extends TSchema>(
  schema: T,
  input: unknown,
): ContractValidationResult<Static<T>> {
  const validator = compile(schema)
  if (!validator(input)) {
    return { success: false, issues: toIssues(validator.errors) }
  }
  const issues = semanticIssues(schema, input)
  if (issues.length > 0) return { success: false, issues }
  return { success: true, value: input as Static<T> }
}

export function assertSchema<T extends TSchema>(schema: T, input: unknown): Static<T> {
  const result = validateSchema(schema, input)
  if (!result.success) throw new ContractValidationError(result.issues)
  return result.value
}

export function isSchema<T extends TSchema>(schema: T, input: unknown): input is Static<T> {
  return validateSchema(schema, input).success
}

export const validateArtifactRef = (input: unknown): ArtifactRef =>
  assertSchema(ArtifactRefSchema, input)
export const validateDesignContract = (input: unknown): DesignContract =>
  assertSchema(DesignContractSchema, input)
export const validateGeometryEvaluatorConfig = (
  input: unknown,
): GeometryEvaluatorConfig => assertSchema(GeometryEvaluatorConfigSchema, input)
export const validateMockServerFixtureConfig = (
  input: unknown,
): MockServerFixtureConfig => assertSchema(MockServerFixtureConfigSchema, input)
export const validateScenarioAuthoring = (input: unknown): ScenarioAuthoring =>
  assertSchema(ScenarioAuthoringSchema, input)
export const validateScenarioSource = validateScenarioAuthoring
export const validateScenarioManifest = (input: unknown): ScenarioManifest =>
  assertSchema(ScenarioManifestSchema, input)
export const validateResolvedScenarioPlan = (input: unknown): ResolvedScenarioPlan =>
  assertSchema(ResolvedScenarioPlanSchema, input)
export const validateSealedRunManifest = (input: unknown): SealedRunManifest =>
  assertSchema(SealedRunManifestSchema, input)
export const validateCaptureBundle = (input: unknown): CaptureBundle =>
  assertSchema(CaptureBundleSchema, input)
export const validateEvaluationPlan = (input: unknown): EvaluationPlan =>
  assertSchema(EvaluationPlanSchema, input)
export const validatePolicySource = (input: unknown): PolicySource =>
  assertSchema(PolicySourceSchema, input)
export const validateEvaluationPolicy = (input: unknown): EvaluationPolicy =>
  assertSchema(EvaluationPolicySchema, input)
export const validateFinding = (input: unknown): Finding =>
  assertSchema(FindingSchema, input)
export const validateEvaluationReport = (input: unknown): EvaluationReport =>
  assertSchema(EvaluationReportSchema, input)
export const validateEvidencePayload = (input: unknown): EvidencePayload =>
  assertSchema(EvidencePayloadSchema, input)
export const validateDomEvidencePayload = (input: unknown): DomEvidencePayload =>
  assertSchema(DomEvidencePayloadSchema, input)
export const validateLayoutEvidencePayload = (
  input: unknown,
): LayoutEvidencePayload => assertSchema(LayoutEvidencePayloadSchema, input)
export const validateStylesEvidencePayload = (
  input: unknown,
): StylesEvidencePayload => assertSchema(StylesEvidencePayloadSchema, input)
export const validateConsoleEvidencePayload = (
  input: unknown,
): ConsoleEvidencePayload => assertSchema(ConsoleEvidencePayloadSchema, input)
export const validateNetworkEvidencePayload = (
  input: unknown,
): NetworkEvidencePayload => assertSchema(NetworkEvidencePayloadSchema, input)

export function formatIssues(issues: readonly ContractValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
    .join("; ")
}
