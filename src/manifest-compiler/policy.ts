import { readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import {
  canonicalJson,
  canonicalSpecDigest,
} from "../contracts/canonical-json"
import type {
  ActorRef,
  ArtifactRef,
  EvaluationPolicy,
  EvaluationPolicySpec,
  PolicySource,
} from "../contracts/model"
import {
  validateArtifactRef,
  validateEvaluationPolicy,
  validatePolicySource,
} from "../contracts/validation"
import type {
  LoadedPolicySource,
  LoadedProjectConfig,
} from "../project/config"
import type { ArtifactMaterializer } from "./compiler"

export type PolicyMaterializationErrorCode =
  | "INVALID_POLICY_SOURCE"
  | "CONFIG_SOURCE_REQUIRED"
  | "PATH_OUTSIDE_PROJECT"
  | "CONFIG_NOT_FOUND"
  | "INVALID_CONFIG_JSON"
  | "ARTIFACT_MATERIALIZATION_FAILED"
  | "INVALID_ARTIFACT_REF"
  | "INVALID_EVALUATION_POLICY"

export class PolicyMaterializationError extends Error {
  readonly code: PolicyMaterializationErrorCode
  readonly policyId?: string
  readonly evaluatorId?: string
  readonly reference?: string

  constructor(options: {
    code: PolicyMaterializationErrorCode
    message: string
    policyId?: string
    evaluatorId?: string
    reference?: string
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = "PolicyMaterializationError"
    this.code = options.code
    this.policyId = options.policyId
    this.evaluatorId = options.evaluatorId
    this.reference = options.reference
  }
}

export interface MaterializePolicyOptions {
  artifactMaterializer: ArtifactMaterializer
  /** Required only when a raw PolicySource uses configPath outside config dir. */
  policyPath?: string
  createdAt?: string
  createdBy?: ActorRef
}

const defaultActor: ActorRef = {
  type: "service",
  id: "ui-eval-local",
}

/**
 * Turns a human-authored PolicySource into the only Policy form evaluators may
 * consume. Inline and path-backed evaluator configs are sealed into CAS first;
 * no local path survives in the returned EvaluationPolicy.
 */
export async function materializePolicy(
  sourceInput: LoadedPolicySource | PolicySource,
  project: LoadedProjectConfig,
  options: MaterializePolicyOptions,
): Promise<EvaluationPolicy> {
  const { source, policyPath } = await normalizeSource(
    sourceInput,
    project,
    options,
  )
  const evaluators = await Promise.all(
    source.evaluators.map(async (evaluator) => {
      const config = await resolveEvaluatorConfig(
        evaluator,
        source.id,
        policyPath,
        project,
      )
      const configRef = await materializeConfig(
        config,
        source.id,
        evaluator.id,
        project,
        options.artifactMaterializer,
      )

      return {
        id: evaluator.id,
        version: evaluator.version,
        configRef,
        configDigest: configRef.digest,
        required: evaluator.required,
        weight: evaluator.weight,
      }
    }),
  )

  const spec: EvaluationPolicySpec = {
    evaluators,
    tolerances: cloneCanonical(source.tolerances) as unknown as EvaluationPolicySpec["tolerances"],
    gates: cloneCanonical(source.gates),
    repeatability: { ...source.repeatability },
    dynamicRegions: cloneCanonical(source.dynamicRegions),
    agentMutation: cloneCanonical(source.agentMutation),
  }
  const policy: EvaluationPolicy = {
    apiVersion: "uieval.io/v1alpha1",
    kind: "EvaluationPolicy",
    metadata: {
      id: source.id,
      projectId: project.value.projectId,
      revision: source.revision,
      createdAt: options.createdAt ?? new Date().toISOString(),
      createdBy: cloneCanonical(options.createdBy ?? defaultActor),
      specDigest: canonicalSpecDigest({ spec }),
    },
    spec,
  }

  try {
    return validateEvaluationPolicy(policy)
  } catch (error) {
    throw policyError(
      "INVALID_EVALUATION_POLICY",
      source.id,
      `Materialized policy violates the sealed contract: ${errorMessage(error)}`,
      undefined,
      undefined,
      error,
    )
  }
}

async function normalizeSource(
  sourceInput: LoadedPolicySource | PolicySource,
  project: LoadedProjectConfig,
  options: MaterializePolicyOptions,
): Promise<{ source: PolicySource; policyPath?: string }> {
  const candidate = isLoadedPolicy(sourceInput) ? sourceInput.value : sourceInput
  let source: PolicySource
  try {
    source = validatePolicySource(candidate)
  } catch (error) {
    const id = isRecord(candidate) && typeof candidate.id === "string"
      ? candidate.id
      : undefined
    throw new PolicyMaterializationError({
      code: "INVALID_POLICY_SOURCE",
      message: `Could not materialize policy${id ? ` "${id}"` : ""}: ${errorMessage(error)}`,
      ...(id ? { policyId: id } : {}),
      cause: error,
    })
  }

  const inputPath = isLoadedPolicy(sourceInput)
    ? sourceInput.path
    : options.policyPath
  if (!inputPath) return { source }

  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(project.configDirectory, inputPath)
  let canonicalPath: string
  try {
    canonicalPath = await realpath(absolutePath)
  } catch (error) {
    throw policyError(
      "CONFIG_NOT_FOUND",
      source.id,
      `Policy source path "${inputPath}" does not exist or cannot be read.`,
      undefined,
      inputPath,
      error,
    )
  }
  assertLexicallyContained(
    project.projectRoot,
    canonicalPath,
    source.id,
    "policy source",
    inputPath,
  )

  return { source, policyPath: canonicalPath }
}

async function resolveEvaluatorConfig(
  evaluator: PolicySource["evaluators"][number],
  policyId: string,
  policyPath: string | undefined,
  project: LoadedProjectConfig,
): Promise<unknown> {
  const hasInline = evaluator.config !== undefined
  const hasPath = evaluator.configPath !== undefined
  if (hasInline === hasPath) {
    throw policyError(
      "CONFIG_SOURCE_REQUIRED",
      policyId,
      `Evaluator "${evaluator.id}" must use exactly one of config or configPath.`,
      evaluator.id,
    )
  }

  if (hasInline) {
    try {
      canonicalJson(evaluator.config)
      return cloneCanonical(evaluator.config)
    } catch (error) {
      throw policyError(
        "INVALID_CONFIG_JSON",
        policyId,
        `Inline config for evaluator "${evaluator.id}" is not canonical JSON data.`,
        evaluator.id,
        undefined,
        error,
      )
    }
  }

  const reference = evaluator.configPath!
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) {
    throw policyError(
      "PATH_OUTSIDE_PROJECT",
      policyId,
      `Evaluator "${evaluator.id}" configPath must be a local project file, not a URI: ${reference}.`,
      evaluator.id,
      reference,
    )
  }
  const baseDirectory = policyPath
    ? dirname(policyPath)
    : project.configDirectory
  const candidate = isAbsolute(reference)
    ? resolve(reference)
    : resolve(baseDirectory, reference)
  assertLexicallyContained(
    project.projectRoot,
    candidate,
    policyId,
    `evaluator "${evaluator.id}" config`,
    reference,
    evaluator.id,
  )

  let configPath: string
  try {
    configPath = await realpath(candidate)
  } catch (error) {
    throw policyError(
      "CONFIG_NOT_FOUND",
      policyId,
      `Evaluator "${evaluator.id}" configPath "${reference}" does not exist or cannot be read.`,
      evaluator.id,
      reference,
      error,
    )
  }
  assertLexicallyContained(
    project.projectRoot,
    configPath,
    policyId,
    `evaluator "${evaluator.id}" config`,
    reference,
    evaluator.id,
  )

  let text: string
  try {
    text = await readFile(configPath, "utf8")
  } catch (error) {
    throw policyError(
      "CONFIG_NOT_FOUND",
      policyId,
      `Evaluator "${evaluator.id}" configPath "${reference}" cannot be read.`,
      evaluator.id,
      reference,
      error,
    )
  }
  try {
    const value: unknown = JSON.parse(text)
    canonicalJson(value)
    return value
  } catch (error) {
    throw policyError(
      "INVALID_CONFIG_JSON",
      policyId,
      `Evaluator "${evaluator.id}" configPath "${reference}" is not valid JSON.`,
      evaluator.id,
      reference,
      error,
    )
  }
}

async function materializeConfig(
  config: unknown,
  policyId: string,
  evaluatorId: string,
  project: LoadedProjectConfig,
  materializer: ArtifactMaterializer,
): Promise<ArtifactRef> {
  let candidate: unknown
  try {
    candidate = await materializer.put(config, {
      mediaType: "application/json",
      sensitivity: "internal",
    })
  } catch (error) {
    throw policyError(
      "ARTIFACT_MATERIALIZATION_FAILED",
      policyId,
      `Failed to materialize config for evaluator "${evaluatorId}": ${errorMessage(error)}`,
      evaluatorId,
      undefined,
      error,
    )
  }

  let configRef: ArtifactRef
  try {
    configRef = validateArtifactRef(candidate)
  } catch (error) {
    throw policyError(
      "INVALID_ARTIFACT_REF",
      policyId,
      `Artifact store returned an invalid config reference for evaluator "${evaluatorId}".`,
      evaluatorId,
      undefined,
      error,
    )
  }
  if (configRef.projectId !== project.value.projectId) {
    throw policyError(
      "INVALID_ARTIFACT_REF",
      policyId,
      `Evaluator "${evaluatorId}" config artifact belongs to project "${configRef.projectId}", expected "${project.value.projectId}".`,
      evaluatorId,
    )
  }
  if (
    configRef.mediaType !== "application/json" ||
    configRef.sensitivity !== "internal"
  ) {
    throw policyError(
      "INVALID_ARTIFACT_REF",
      policyId,
      `Evaluator "${evaluatorId}" config artifact must be internal application/json.`,
      evaluatorId,
    )
  }

  return configRef
}

function assertLexicallyContained(
  projectRoot: string,
  candidate: string,
  policyId: string,
  label: string,
  reference: string,
  evaluatorId?: string,
): void {
  const relation = relative(projectRoot, candidate)
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    return
  }
  throw policyError(
    "PATH_OUTSIDE_PROJECT",
    policyId,
    `Refusing ${label} "${reference}": it resolves outside project root.`,
    evaluatorId,
    reference,
  )
}

function isLoadedPolicy(
  source: LoadedPolicySource | PolicySource,
): source is LoadedPolicySource {
  return "value" in source && "path" in source && "digest" in source
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function policyError(
  code: PolicyMaterializationErrorCode,
  policyId: string,
  message: string,
  evaluatorId?: string,
  reference?: string,
  cause?: unknown,
): PolicyMaterializationError {
  return new PolicyMaterializationError({
    code,
    message: `Could not materialize policy "${policyId}": ${message}`,
    policyId,
    ...(evaluatorId ? { evaluatorId } : {}),
    ...(reference ? { reference } : {}),
    cause,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
