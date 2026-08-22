import { createHash } from "node:crypto"

import { canonicalDigest } from "../contracts/canonical-json"
import type {
  ArtifactRef,
  Digest,
  EvaluationPolicy,
  GeometryEvaluatorConfig,
} from "../contracts/model"
import {
  ContractValidationError,
  validateEvaluationPolicy,
  validateGeometryEvaluatorConfig,
} from "../contracts/validation"

export const PHASE_0A_EVALUATOR_VERSION = "0.1.0" as const
export const PHASE_0A_EVALUATOR_IDS = [
  "execution",
  "interaction",
  "runtime",
  "visual",
  "geometry",
] as const
export const PHASE_0A_REQUIRED_CORE_EVALUATOR_IDS = [
  "execution",
  "interaction",
  "runtime",
] as const

export type Phase0AEvaluatorId = (typeof PHASE_0A_EVALUATOR_IDS)[number]

export interface Phase0AEvaluatorConfigById {
  execution: Readonly<Record<string, never>>
  interaction: Readonly<Record<string, never>>
  runtime: Readonly<{
    sameOrigin5xxIsCritical: true
    consoleErrorIsAdvisory: true
  }>
  visual: Readonly<{ mode: "advisory" }>
  geometry: GeometryEvaluatorConfig
}

export type RunnablePhase0AEvaluator = {
  [Id in Phase0AEvaluatorId]: Readonly<{
    status: "runnable"
    id: Id
    version: typeof PHASE_0A_EVALUATOR_VERSION
    configDigest: Digest
    required: boolean
    config: Phase0AEvaluatorConfigById[Id]
  }>
}[Phase0AEvaluatorId]

export type Phase0AEvaluatorSkipReason =
  | "unsupported-evaluator"
  | "unsupported-version"
  | "config-unavailable"
  | "config-invalid"
  | "reference-unavailable"

export interface SkippedPhase0AEvaluator {
  readonly status: "skipped"
  readonly id: string
  readonly version: string
  readonly configDigest: Digest
  readonly required: false
  readonly reason: Phase0AEvaluatorSkipReason
  readonly detail: string
}

export interface ExecutedEvaluatorProvenance {
  id: Phase0AEvaluatorId
  version: typeof PHASE_0A_EVALUATOR_VERSION
  configDigest: Digest
}

export interface EvaluatorArtifactResolver {
  resolve(ref: ArtifactRef): Promise<Uint8Array>
}

export type EvaluatorRegistryErrorCode =
  | "INVALID_POLICY"
  | "POLICY_DIGEST_MISMATCH"
  | "POLICY_HAS_NO_GATES"
  | "MISSING_REQUIRED_CORE_GATE"
  | "MISSING_REQUIRED_CORE_EVALUATOR"
  | "UNSUPPORTED_POLICY_FEATURE"
  | "UNSUPPORTED_REPEATABILITY"
  | "UNSUPPORTED_EVALUATOR"
  | "UNSUPPORTED_EVALUATOR_VERSION"
  | "CONFIG_REF_UNSUPPORTED"
  | "CONFIG_SCOPE_MISMATCH"
  | "CONFIG_UNAVAILABLE"
  | "CONFIG_INTEGRITY_MISMATCH"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_DIGEST_MISMATCH"
  | "CONFIG_SHAPE_UNSUPPORTED"
  | "REQUIRED_EVALUATOR_UNAVAILABLE"
  | "EVALUATOR_NOT_RUNNABLE"
  | "DUPLICATE_EXECUTION"

export class EvaluatorRegistryError extends Error {
  readonly code: EvaluatorRegistryErrorCode
  readonly evaluatorId?: string
  readonly evaluatorVersion?: string
  readonly required?: boolean

  constructor(options: {
    code: EvaluatorRegistryErrorCode
    message: string
    evaluatorId?: string
    evaluatorVersion?: string
    required?: boolean
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = "EvaluatorRegistryError"
    this.code = options.code
    this.evaluatorId = options.evaluatorId
    this.evaluatorVersion = options.evaluatorVersion
    this.required = options.required
  }
}

export interface LoadPhase0AEvaluatorRegistryOptions {
  artifactResolver: EvaluatorArtifactResolver
  /** Whether a visual reference was supplied for this evaluation. */
  visualReferenceAvailable: boolean
}

type PolicyEvaluator = EvaluationPolicy["spec"]["evaluators"][number]

export class Phase0AEvaluatorRegistry {
  readonly runnable: readonly RunnablePhase0AEvaluator[]
  readonly skipped: readonly SkippedPhase0AEvaluator[]

  private readonly runnableById: ReadonlyMap<
    Phase0AEvaluatorId,
    RunnablePhase0AEvaluator
  >
  private readonly skippedById: ReadonlyMap<string, SkippedPhase0AEvaluator>

  constructor(
    runnable: readonly RunnablePhase0AEvaluator[],
    skipped: readonly SkippedPhase0AEvaluator[],
  ) {
    this.runnable = Object.freeze([...runnable])
    this.skipped = Object.freeze([...skipped])
    this.runnableById = new Map(runnable.map((entry) => [entry.id, entry]))
    this.skippedById = new Map(skipped.map((entry) => [entry.id, entry]))
  }

  get<Id extends Phase0AEvaluatorId>(
    id: Id,
  ): Extract<RunnablePhase0AEvaluator, { id: Id }> | undefined {
    return this.runnableById.get(id) as
      | Extract<RunnablePhase0AEvaluator, { id: Id }>
      | undefined
  }

  /**
   * Builds report provenance from the caller's actual execution ledger. Policy
   * registration alone is never treated as proof that an evaluator ran.
   */
  provenanceFor(
    executedIds: readonly Phase0AEvaluatorId[],
  ): ExecutedEvaluatorProvenance[] {
    const seen = new Set<Phase0AEvaluatorId>()
    return executedIds.map((id) => {
      if (seen.has(id)) {
        throw registryError(
          "DUPLICATE_EXECUTION",
          `Evaluator "${id}" was reported as executed more than once.`,
          { id, version: PHASE_0A_EVALUATOR_VERSION },
        )
      }
      seen.add(id)

      const evaluator = this.runnableById.get(id)
      if (!evaluator) {
        const skipped = this.skippedById.get(id)
        throw registryError(
          "EVALUATOR_NOT_RUNNABLE",
          skipped
            ? `Evaluator "${id}" was skipped (${skipped.reason}) and cannot be reported as executed.`
            : `Evaluator "${id}" is not registered by the sealed policy and cannot be reported as executed.`,
          {
            id,
            version: skipped?.version ?? PHASE_0A_EVALUATOR_VERSION,
            required: skipped?.required,
          },
        )
      }

      return {
        id: evaluator.id,
        version: evaluator.version,
        configDigest: evaluator.configDigest,
      }
    })
  }
}

/**
 * Resolves and validates the complete evaluator configuration trust boundary.
 * Only the exact Phase 0A implementations and configurations below may become
 * runnable. Optional unsupported entries remain visible as skipped entries;
 * required ones fail before capture/evaluation starts.
 */
export async function loadPhase0AEvaluatorRegistry(
  policyInput: EvaluationPolicy,
  options: LoadPhase0AEvaluatorRegistryOptions,
): Promise<Phase0AEvaluatorRegistry> {
  let policy: EvaluationPolicy
  try {
    policy = validateEvaluationPolicy(policyInput)
  } catch (error) {
    const digestMismatch =
      error instanceof ContractValidationError &&
      error.issues.some(
        (issue) =>
          issue.instancePath === "/metadata/specDigest" &&
          issue.keyword === "digestMatch",
      )
    throw new EvaluatorRegistryError({
      code: digestMismatch ? "POLICY_DIGEST_MISMATCH" : "INVALID_POLICY",
      message: digestMismatch
        ? "EvaluationPolicy metadata.specDigest does not match its canonical spec."
        : `Evaluator registry requires a valid sealed EvaluationPolicy: ${errorMessage(error)}`,
      cause: error,
    })
  }

  if (policy.spec.gates.length === 0) {
    throw new EvaluatorRegistryError({
      code: "POLICY_HAS_NO_GATES",
      message:
        "Phase 0A refuses a policy with zero gates because it could produce PASS without evaluating a quality condition.",
    })
  }
  if (policy.spec.repeatability.attempts !== 1) {
    throw new EvaluatorRegistryError({
      code: "UNSUPPORTED_REPEATABILITY",
      message: `Phase 0A supports exactly one evaluation attempt; received ${policy.spec.repeatability.attempts}.`,
    })
  }
  if (
    policy.spec.tolerances.length > 0 ||
    policy.spec.dynamicRegions.length > 0 ||
    policy.spec.evaluators.some((evaluator) => evaluator.weight !== 0)
  ) {
    throw new EvaluatorRegistryError({
      code: "UNSUPPORTED_POLICY_FEATURE",
      message:
        "Phase 0A does not execute tolerances, dynamic regions, or evaluator weighting; these fields must remain empty or zero until their semantics are implemented.",
    })
  }
  assertRequiredCoreDeclarations(policy)
  assertRequiredCoreGates(policy)

  const runnable: RunnablePhase0AEvaluator[] = []
  const skipped: SkippedPhase0AEvaluator[] = []

  for (const evaluator of policy.spec.evaluators) {
    if (!isPhase0AEvaluatorId(evaluator.id)) {
      if (evaluator.required) {
        throw registryError(
          "UNSUPPORTED_EVALUATOR",
          `Required evaluator "${evaluator.id}" is not implemented in Phase 0A.`,
          evaluator,
        )
      }
      skipped.push(
        skippedEvaluator(
          evaluator,
          "unsupported-evaluator",
          `Evaluator "${evaluator.id}" is not implemented in Phase 0A.`,
        ),
      )
      continue
    }

    if (evaluator.version !== PHASE_0A_EVALUATOR_VERSION) {
      if (evaluator.required) {
        throw registryError(
          "UNSUPPORTED_EVALUATOR_VERSION",
          `Required evaluator "${evaluator.id}" uses unsupported version "${evaluator.version}"; Phase 0A supports only "${PHASE_0A_EVALUATOR_VERSION}".`,
          evaluator,
        )
      }
      skipped.push(
        skippedEvaluator(
          evaluator,
          "unsupported-version",
          `Version "${evaluator.version}" is unsupported; Phase 0A supports only "${PHASE_0A_EVALUATOR_VERSION}".`,
        ),
      )
      continue
    }

    let config: Phase0AEvaluatorConfigById[typeof evaluator.id]
    try {
      config = await resolveEvaluatorConfig(
        evaluator,
        evaluator.id,
        policy.metadata.projectId,
        options.artifactResolver,
      )
    } catch (error) {
      if (
        error instanceof EvaluatorRegistryError &&
        evaluator.required &&
        isRequiredCoreEvaluatorId(evaluator.id)
      ) {
        throw registryError(
          "MISSING_REQUIRED_CORE_EVALUATOR",
          `Required Phase 0A core evaluator "${evaluator.id}" failed to become runnable (${error.code}).`,
          evaluator,
          error,
        )
      }
      if (!(error instanceof EvaluatorRegistryError) || evaluator.required) {
        throw error
      }
      skipped.push(
        skippedEvaluator(
          evaluator,
          error.code === "CONFIG_UNAVAILABLE"
            ? "config-unavailable"
            : "config-invalid",
          error.message,
        ),
      )
      continue
    }

    if (evaluator.id === "visual" && !options.visualReferenceAvailable) {
      if (evaluator.required) {
        throw registryError(
          "REQUIRED_EVALUATOR_UNAVAILABLE",
          "Required visual evaluator cannot run because no reference image was supplied.",
          evaluator,
        )
      }
      skipped.push(
        skippedEvaluator(
          evaluator,
          "reference-unavailable",
          "Visual evaluator was not run because no reference image was supplied.",
        ),
      )
      continue
    }

    runnable.push(
      Object.freeze({
        status: "runnable",
        id: evaluator.id,
        version: PHASE_0A_EVALUATOR_VERSION,
        configDigest: evaluator.configDigest,
        required: evaluator.required,
        config,
      }) as RunnablePhase0AEvaluator,
    )
  }

  for (const id of PHASE_0A_REQUIRED_CORE_EVALUATOR_IDS) {
    if (!runnable.some((evaluator) => evaluator.id === id)) {
      throw registryError(
        "MISSING_REQUIRED_CORE_EVALUATOR",
        `Required Phase 0A core evaluator "${id}" did not become runnable.`,
        { id, version: PHASE_0A_EVALUATOR_VERSION, required: true },
      )
    }
  }

  return new Phase0AEvaluatorRegistry(runnable, skipped)
}

function assertRequiredCoreDeclarations(policy: EvaluationPolicy): void {
  for (const id of PHASE_0A_REQUIRED_CORE_EVALUATOR_IDS) {
    const evaluator = policy.spec.evaluators.find((entry) => entry.id === id)
    if (
      !evaluator ||
      !evaluator.required ||
      evaluator.version !== PHASE_0A_EVALUATOR_VERSION
    ) {
      const detail = !evaluator
        ? "is missing"
        : !evaluator.required
          ? "must declare required: true"
          : `uses unsupported version "${evaluator.version}"`
      throw registryError(
        "MISSING_REQUIRED_CORE_EVALUATOR",
        `Phase 0A core evaluator "${id}" ${detail}; execution, interaction, and runtime@${PHASE_0A_EVALUATOR_VERSION} must all be required and runnable.`,
        {
          id,
          version: evaluator?.version ?? PHASE_0A_EVALUATOR_VERSION,
          required: evaluator?.required ?? true,
        },
      )
    }
  }
}

type PolicyGate = EvaluationPolicy["spec"]["gates"][number]

const PHASE_0A_REQUIRED_CORE_GATES = [
  { metric: "execution.valid", value: true },
  { metric: "interaction.failedAssertions", value: 0 },
  { metric: "runtime.criticalErrors", value: 0 },
] as const

function isExactRequiredCoreGate(
  gate: PolicyGate,
  required: (typeof PHASE_0A_REQUIRED_CORE_GATES)[number],
): boolean {
  const expression = gate.expression
  return (
    gate.hard &&
    gate.onUnknown === "fail" &&
    "metric" in expression &&
    expression.metric === required.metric &&
    expression.operator === "eq" &&
    expression.value === required.value
  )
}

function assertRequiredCoreGates(policy: EvaluationPolicy): void {
  for (const required of PHASE_0A_REQUIRED_CORE_GATES) {
    if (
      policy.spec.gates.some((gate) =>
        isExactRequiredCoreGate(gate, required),
      )
    ) {
      continue
    }

    throw new EvaluatorRegistryError({
      code: "MISSING_REQUIRED_CORE_GATE",
      message: `Phase 0A requires an independent hard gate with onUnknown "fail" and expression ${required.metric} eq ${JSON.stringify(required.value)}; compound or alternative gates cannot replace this invariant.`,
    })
  }
}

async function resolveEvaluatorConfig<Id extends Phase0AEvaluatorId>(
  evaluator: PolicyEvaluator,
  id: Id,
  projectId: string,
  resolver: EvaluatorArtifactResolver,
): Promise<Phase0AEvaluatorConfigById[Id]> {
  const { configRef } = evaluator
  if (configRef.projectId !== projectId) {
    throw registryError(
      "CONFIG_SCOPE_MISMATCH",
      `Evaluator "${id}" config belongs to project "${configRef.projectId}", expected "${projectId}".`,
      evaluator,
    )
  }
  if (
    configRef.mediaType.toLowerCase().split(";", 1)[0].trim() !==
      "application/json" ||
    configRef.sensitivity !== "internal"
  ) {
    throw registryError(
      "CONFIG_REF_UNSUPPORTED",
      `Evaluator "${id}" config must be an internal application/json artifact.`,
      evaluator,
    )
  }

  let resolved: unknown
  try {
    resolved = await resolver.resolve(configRef)
  } catch (error) {
    throw registryError(
      "CONFIG_UNAVAILABLE",
      `Evaluator "${id}" config artifact ${configRef.digest} could not be resolved from CAS.`,
      evaluator,
      error,
    )
  }
  if (!(resolved instanceof Uint8Array)) {
    throw registryError(
      "CONFIG_UNAVAILABLE",
      `Evaluator "${id}" config resolver returned a non-byte value.`,
      evaluator,
    )
  }

  const bytes = resolved
  if (bytes.byteLength !== configRef.sizeBytes) {
    throw registryError(
      "CONFIG_INTEGRITY_MISMATCH",
      `Evaluator "${id}" config size does not match its ArtifactRef.`,
      evaluator,
    )
  }
  const byteDigest = sha256(bytes)
  if (byteDigest !== configRef.digest) {
    throw registryError(
      "CONFIG_INTEGRITY_MISMATCH",
      `Evaluator "${id}" config bytes do not match ArtifactRef digest ${configRef.digest}.`,
      evaluator,
    )
  }

  let value: unknown
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw registryError(
      "CONFIG_INVALID_JSON",
      `Evaluator "${id}" config artifact is not valid UTF-8 JSON.`,
      evaluator,
      error,
    )
  }

  if (canonicalDigest(value) !== evaluator.configDigest) {
    throw registryError(
      "CONFIG_DIGEST_MISMATCH",
      `Evaluator "${id}" config is not canonical JSON matching configDigest ${evaluator.configDigest}.`,
      evaluator,
    )
  }

  return validateSupportedConfig(id, value, evaluator)
}

function validateSupportedConfig<Id extends Phase0AEvaluatorId>(
  id: Id,
  value: unknown,
  evaluator: PolicyEvaluator,
): Phase0AEvaluatorConfigById[Id] {
  if (!isJsonObject(value)) {
    throw registryError(
      "CONFIG_SHAPE_UNSUPPORTED",
      `Evaluator "${id}" config must be a JSON object.`,
      evaluator,
    )
  }

  switch (id) {
    case "execution":
    case "interaction":
      if (Object.keys(value).length !== 0) {
        throw unsupportedShape(evaluator, "an empty object")
      }
      return Object.freeze({}) as Phase0AEvaluatorConfigById[Id]
    case "runtime":
      if (
        !hasExactKeys(value, [
          "consoleErrorIsAdvisory",
          "sameOrigin5xxIsCritical",
        ]) ||
        value.sameOrigin5xxIsCritical !== true ||
        value.consoleErrorIsAdvisory !== true
      ) {
        throw unsupportedShape(
          evaluator,
          "exactly { sameOrigin5xxIsCritical: true, consoleErrorIsAdvisory: true }",
        )
      }
      return Object.freeze({
        sameOrigin5xxIsCritical: true,
        consoleErrorIsAdvisory: true,
      }) as Phase0AEvaluatorConfigById[Id]
    case "visual":
      if (!hasExactKeys(value, ["mode"]) || value.mode !== "advisory") {
        throw unsupportedShape(evaluator, 'exactly { mode: "advisory" }')
      }
      return Object.freeze({ mode: "advisory" }) as Phase0AEvaluatorConfigById[Id]
    case "geometry":
      // Structured rather than exact-shaped: the constraint vocabulary is a
      // contract, so it is validated by the contract validator and cannot drift
      // from the policy schema.
      try {
        return validateGeometryEvaluatorConfig(
          value,
        ) as Phase0AEvaluatorConfigById[Id]
      } catch (error) {
        throw registryError(
          "CONFIG_SHAPE_UNSUPPORTED",
          `Evaluator "geometry" config is not a valid GeometryEvaluatorConfig: ${
            error instanceof Error ? error.message : String(error)
          }`,
          evaluator,
        )
      }
  }
}

function unsupportedShape(
  evaluator: PolicyEvaluator,
  expectation: string,
): EvaluatorRegistryError {
  return registryError(
    "CONFIG_SHAPE_UNSUPPORTED",
    `Evaluator "${evaluator.id}" version "${evaluator.version}" supports ${expectation}; no other config is implemented in Phase 0A.`,
    evaluator,
  )
}

function skippedEvaluator(
  evaluator: PolicyEvaluator,
  reason: Phase0AEvaluatorSkipReason,
  detail: string,
): SkippedPhase0AEvaluator {
  return Object.freeze({
    status: "skipped",
    id: evaluator.id,
    version: evaluator.version,
    configDigest: evaluator.configDigest,
    required: false,
    reason,
    detail,
  })
}

function registryError(
  code: EvaluatorRegistryErrorCode,
  message: string,
  evaluator?: {
    id: string
    version: string
    required?: boolean
  },
  cause?: unknown,
): EvaluatorRegistryError {
  return new EvaluatorRegistryError({
    code,
    message,
    ...(evaluator
      ? {
          evaluatorId: evaluator.id,
          evaluatorVersion: evaluator.version,
          ...(evaluator.required === undefined
            ? {}
            : { required: evaluator.required }),
        }
      : {}),
    ...(cause === undefined ? {} : { cause }),
  })
}

function isPhase0AEvaluatorId(value: string): value is Phase0AEvaluatorId {
  return (PHASE_0A_EVALUATOR_IDS as readonly string[]).includes(value)
}

function isRequiredCoreEvaluatorId(
  value: string,
): value is (typeof PHASE_0A_REQUIRED_CORE_EVALUATOR_IDS)[number] {
  return (PHASE_0A_REQUIRED_CORE_EVALUATOR_IDS as readonly string[]).includes(
    value,
  )
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function sha256(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
