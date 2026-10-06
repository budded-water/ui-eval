import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { Type, type Static, type TSchema } from "@sinclair/typebox"
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { canonicalDigest } from "../contracts/canonical-json"
import {
  CaptureCapabilitySchema,
  MatrixValueSchema,
  WebCheckpointSpecSchema,
  WebScenarioStepSchema,
} from "../contracts/schemas"
import type { Digest, PolicySource } from "../contracts/model"
import { WebPolicySourceSchema, expandWebPolicy, type WebPolicySource } from "./policy-profile"
export { WebPolicySourceSchema, type WebPolicySource } from "./policy-profile"

const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9._-]*$"
const projectRelativeReferencePattern = "^(?![A-Za-z][A-Za-z0-9+.-]*:).+$"

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: identifierPattern,
})

const LocalReferenceSchema = Type.String({
  minLength: 1,
  pattern: projectRelativeReferencePattern,
})

export const DeviceProfileSourceSchema = Type.Object(
  {
    viewport: Type.Object(
      {
        width: Type.Integer({ minimum: 1, maximum: 16_384 }),
        height: Type.Integer({ minimum: 1, maximum: 16_384 }),
      },
      { additionalProperties: false },
    ),
    deviceScaleFactor: Type.Number({
      exclusiveMinimum: 0,
      maximum: 8,
    }),
    userAgent: Type.Optional(Type.String({ minLength: 1 })),
    safeArea: Type.Optional(
      Type.Object(
        {
          top: Type.Number({ minimum: 0 }),
          right: Type.Number({ minimum: 0 }),
          bottom: Type.Number({ minimum: 0 }),
          left: Type.Number({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export const FixtureSourceSchema = Type.Object(
  {
    id: IdentifierSchema,
    provider: Type.Union([
      Type.Literal("static"),
      Type.Literal("mock-server"),
      Type.Literal("seed-script"),
      Type.Literal("remote"),
    ]),
    configPath: Type.Optional(LocalReferenceSchema),
    artifactPath: Type.Optional(LocalReferenceSchema),
    mediaType: Type.Optional(Type.String({ minLength: 1 })),
    secretRefs: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
)

export const ProjectConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String({ minLength: 1 })),
    apiVersion: Type.Literal("uieval.io/v1alpha1"),
    kind: Type.Literal("ProjectConfig"),
    projectId: IdentifierSchema,
    artifactRoot: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: projectRelativeReferencePattern,
        default: ".ui-eval",
      }),
    ),
    devServer: Type.Object(
      {
        command: Type.String({ minLength: 1 }),
        args: Type.Array(Type.String()),
        url: Type.String({ minLength: 1, pattern: "^https?://" }),
        reuseExisting: Type.Boolean(),
        readiness: Type.Optional(
          Type.Object(
            {
              path: Type.String({ minLength: 1, pattern: "^/(?!/)" }),
              bodyIncludes: Type.String({ minLength: 1, maxLength: 512 }),
            },
            { additionalProperties: false },
          ),
        ),
        startupTimeoutMs: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    baseUrls: Type.Record(
      IdentifierSchema,
      Type.String({ minLength: 1, pattern: "^https?://" }),
      { minProperties: 1 },
    ),
    deviceProfiles: Type.Record(IdentifierSchema, DeviceProfileSourceSchema, {
      minProperties: 1,
    }),
    defaults: Type.Object(
      {
        locale: Type.String({ minLength: 1 }),
        theme: Type.Union([Type.Literal("light"), Type.Literal("dark")]),
        timezone: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    storageStates: Type.Optional(
      Type.Record(IdentifierSchema, LocalReferenceSchema),
    ),
    fixtureSets: Type.Optional(
      Type.Record(
        IdentifierSchema,
        Type.Array(FixtureSourceSchema, { uniqueItems: true }),
      ),
    ),
    featureFlagSets: Type.Optional(
      Type.Record(
        IdentifierSchema,
        Type.Record(IdentifierSchema, MatrixValueSchema),
      ),
    ),
    supportedCapabilities: Type.Array(CaptureCapabilitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  {
    additionalProperties: false,
    $id: "https://uieval.io/source/project-config",
  },
)

const ScenarioClockSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("fixed"),
      value: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { mode: Type.Literal("real") },
    { additionalProperties: false },
  ),
])

const MatrixDimensionSchema = Type.Array(IdentifierSchema, {
  minItems: 1,
  uniqueItems: true,
})

/**
 * Web authoring schema consumed by the currently implemented CLI pipeline.
 *
 * This is intentionally narrower than the forward-looking multi-platform
 * `ScenarioSourceSchema` in `contracts/schemas`: validating against that
 * contract does not mean a scenario is executable by the current CLI.
 */
export const WebScenarioSourceSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String({ minLength: 1 })),
    apiVersion: Type.Literal("uieval.io/v1alpha1"),
    kind: Type.Literal("ScenarioSource"),
    id: IdentifierSchema,
    revision: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1 }),
    visibility: Type.Union([
      Type.Literal("agent-visible"),
      Type.Literal("holdout"),
    ]),
    tags: Type.Array(IdentifierSchema, { uniqueItems: true }),
    owner: Type.Optional(Type.String({ minLength: 1 })),
    target: Type.Object(
      {
        platform: Type.Literal("web"),
        entrypoint: Type.Object(
          {
            baseUrlRef: IdentifierSchema,
            path: Type.String({ minLength: 1, pattern: "^/(?!/)" }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    auth: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            Type.Union([
              Type.Literal("authenticated"),
              Type.Literal("public-state"),
            ]),
          ),
          role: Type.Optional(Type.String({ minLength: 1 })),
          storageStateRef: IdentifierSchema,
          secretRefs: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    determinism: Type.Object(
      {
        timezone: Type.Optional(Type.String({ minLength: 1 })),
        clock: ScenarioClockSchema,
        randomSeed: Type.Optional(Type.String({ minLength: 1 })),
        networkProfileRef: Type.Optional(IdentifierSchema),
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: Type.Array(CaptureCapabilitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    matrix: Type.Object(
      {
        deviceProfiles: MatrixDimensionSchema,
        locales: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            uniqueItems: true,
          }),
        ),
        themes: Type.Optional(
          Type.Array(
            Type.Union([Type.Literal("light"), Type.Literal("dark")]),
            { minItems: 1, uniqueItems: true },
          ),
        ),
        featureFlagSets: Type.Optional(MatrixDimensionSchema),
        fixtureSets: Type.Optional(MatrixDimensionSchema),
        exclude: Type.Optional(
          Type.Array(Type.Record(IdentifierSchema, MatrixValueSchema)),
        ),
      },
      { additionalProperties: false },
    ),
    fixtures: Type.Optional(Type.Array(FixtureSourceSchema)),
    setup: Type.Optional(Type.Array(WebScenarioStepSchema)),
    steps: Type.Array(WebScenarioStepSchema),
    cleanup: Type.Optional(Type.Array(WebScenarioStepSchema)),
    checkpoints: Type.Array(WebCheckpointSpecSchema, { minItems: 1 }),
  },
  { additionalProperties: false, $id: "https://uieval.io/source/scenario" },
)

/** @deprecated Use WebScenarioSourceSchema for the active CLI authoring format. */
export const ScenarioSourceSchema = WebScenarioSourceSchema

export type DeviceProfileSource = Static<typeof DeviceProfileSourceSchema>
export type FixtureSource = Static<typeof FixtureSourceSchema>
export type ProjectConfig = Static<typeof ProjectConfigSchema>
export type WebScenarioSource = Static<typeof WebScenarioSourceSchema>
/** @deprecated Use WebScenarioSource for the active CLI authoring format. */
export type ScenarioSource = WebScenarioSource
export type { PolicySource } from "../contracts/model"

export interface LoadedDocument<T> {
  readonly value: Readonly<T>
  readonly path: string
  readonly digest: Digest
}

export interface LoadedProjectConfig extends LoadedDocument<ProjectConfig> {
  readonly projectRoot: string
  readonly configDirectory: string
}

export type LoadedScenarioSource = LoadedDocument<ScenarioSource>
export type LoadedPolicySource = LoadedDocument<PolicySource>

export type ProjectConfigErrorCode =
  | "PATH_OUTSIDE_PROJECT"
  | "FILE_NOT_FOUND"
  | "INVALID_JSON"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"

export class ProjectConfigError extends Error {
  readonly code: ProjectConfigErrorCode
  readonly documentPath?: string
  readonly details: readonly string[]

  constructor(options: {
    code: ProjectConfigErrorCode
    message: string
    documentPath?: string
    details?: readonly string[]
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = "ProjectConfigError"
    this.code = options.code
    this.documentPath = options.documentPath
    this.details = options.details ?? []
  }
}

export interface LoadProjectConfigOptions {
  projectRoot: string
  configPath?: string
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: true,
  useDefaults: true,
})
;(addFormats as unknown as (instance: Ajv2020) => Ajv2020)(ajv)

const projectConfigValidator = ajv.compile(ProjectConfigSchema)
const scenarioSourceValidator = ajv.compile(WebScenarioSourceSchema)
const policySourceValidator = ajv.compile(WebPolicySourceSchema)

export function validateWebPolicySource(input: unknown): input is WebPolicySource {
  return policySourceValidator(input) as boolean
}

export function assertWebPolicySource(input: unknown): WebPolicySource {
  if (!validateWebPolicySource(input)) {
    throw new ProjectConfigError({ code: "SCHEMA_INVALID", message: "Invalid web policy authoring document", details: formatValidationErrors(policySourceValidator.errors ?? []) })
  }
  return input
}

/**
 * Structurally validate a project authoring document against the same schema
 * that is exported as `schemas/project.schema.json`.
 *
 * Ajv applies schema defaults, so a successful validation may materialize the
 * default `artifactRoot` on the supplied object. Repository-aware semantic
 * checks remain the responsibility of `loadProjectConfig`.
 */
export function validateProjectConfig(
  input: unknown,
): input is ProjectConfig {
  return projectConfigValidator(input)
}

/**
 * Assert the structural ProjectConfig contract and return the typed value.
 * Repository-aware semantic checks remain the responsibility of the loader.
 */
export function assertProjectConfig(input: unknown): ProjectConfig {
  return assertAuthoringDocument(
    input,
    projectConfigValidator,
    "project config",
  )
}

/**
 * Structurally validate the web-only ScenarioSource format executed by the
 * current CLI and exported as `schemas/scenario-source.schema.json`.
 */
export function validateWebScenarioSource(
  input: unknown,
): input is WebScenarioSource {
  return scenarioSourceValidator(input)
}

/** Assert the web-only ScenarioSource format executed by the current CLI. */
export function assertWebScenarioSource(input: unknown): WebScenarioSource {
  return assertAuthoringDocument(
    input,
    scenarioSourceValidator,
    "web scenario source",
  )
}

function assertAuthoringDocument<T>(
  input: unknown,
  validator: ValidateFunction<T>,
  label: string,
): T {
  if (validator(input)) return input

  const details = formatValidationErrors(validator.errors ?? [])
  throw new ProjectConfigError({
    code: "SCHEMA_INVALID",
    message: `Invalid ${label}: ${details.join("; ")}`,
    details,
  })
}

export async function loadProjectConfig(
  options: LoadProjectConfigOptions,
): Promise<LoadedProjectConfig> {
  const projectRoot = await resolveProjectRoot(options.projectRoot)
  const configPath = await resolveContainedFile({
    projectRoot,
    baseDirectory: projectRoot,
    reference: options.configPath ?? "ui-eval/project.json",
    label: "project config",
  })
  const value = await readValidatedDocument(
    configPath,
    projectConfigValidator,
    "project config",
  )
  await validateProjectSemantics(value, configPath, projectRoot)

  return Object.freeze({
    value: deepFreeze(value),
    path: configPath,
    digest: canonicalDigest(value),
    projectRoot,
    configDirectory: dirname(configPath),
  })
}

export async function loadScenarioSource(
  project: LoadedProjectConfig,
  scenarioReference: string,
): Promise<LoadedScenarioSource> {
  const scenarioPath = await resolveProjectFile(
    project,
    scenarioReference,
    "scenario source",
  )
  const value = await readValidatedDocument(
    scenarioPath,
    scenarioSourceValidator,
    "scenario source",
  )

  return Object.freeze({
    value: deepFreeze(value),
    path: scenarioPath,
    digest: canonicalDigest(value),
  })
}

export async function loadPolicySource(
  project: LoadedProjectConfig,
  policyReference: string,
): Promise<LoadedPolicySource> {
  const policyPath = await resolveProjectFile(
    project,
    policyReference,
    "policy source",
  )
  const authored = await readValidatedDocument<WebPolicySource>(
    policyPath,
    policySourceValidator,
    "policy source",
  )
  const value = expandWebPolicy(authored)
  validatePolicySemantics(value, policyPath)

  return Object.freeze({
    value: deepFreeze(value),
    path: policyPath,
    digest: canonicalDigest(value),
  })
}

/**
 * Resolve an authoring reference relative to ui-eval/project.json while
 * enforcing both lexical and real-path containment within the repository.
 */
export async function resolveProjectFile(
  project: LoadedProjectConfig,
  reference: string,
  label = "project file",
): Promise<string> {
  return resolveContainedFile({
    projectRoot: project.projectRoot,
    baseDirectory: project.configDirectory,
    reference,
    label,
  })
}

async function resolveProjectRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(resolve(projectRoot))
  } catch (error) {
    throw new ProjectConfigError({
      code: "FILE_NOT_FOUND",
      message: `Project root does not exist or cannot be read: ${projectRoot}`,
      documentPath: projectRoot,
      cause: error,
    })
  }
}

async function resolveContainedFile(options: {
  projectRoot: string
  baseDirectory: string
  reference: string
  label: string
}): Promise<string> {
  const candidate = isAbsolute(options.reference)
    ? resolve(options.reference)
    : resolve(options.baseDirectory, options.reference)

  if (!isContainedPath(options.projectRoot, candidate)) {
    throw outsideProjectError(options.label, options.reference, options.projectRoot)
  }

  let resolvedCandidate: string
  try {
    resolvedCandidate = await realpath(candidate)
  } catch (error) {
    throw new ProjectConfigError({
      code: "FILE_NOT_FOUND",
      message: `Could not read ${options.label} "${options.reference}" (resolved to ${candidate}).`,
      documentPath: candidate,
      cause: error,
    })
  }

  if (!isContainedPath(options.projectRoot, resolvedCandidate)) {
    throw outsideProjectError(options.label, options.reference, options.projectRoot)
  }

  return resolvedCandidate
}

function isContainedPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
}

function outsideProjectError(
  label: string,
  reference: string,
  projectRoot: string,
): ProjectConfigError {
  return new ProjectConfigError({
    code: "PATH_OUTSIDE_PROJECT",
    message: `Refusing ${label} "${reference}": it resolves outside project root ${projectRoot}. Use a file contained by the project.`,
  })
}

async function readValidatedDocument<T>(
  path: string,
  validator: ValidateFunction<T>,
  label: string,
): Promise<T> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    throw new ProjectConfigError({
      code: "FILE_NOT_FOUND",
      message: `Could not read ${label} at ${path}.`,
      documentPath: path,
      cause: error,
    })
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ProjectConfigError({
      code: "INVALID_JSON",
      message: `Invalid JSON in ${label} ${path}: ${reason}`,
      documentPath: path,
      cause: error,
    })
  }

  if (!validator(value)) {
    const details = formatValidationErrors(validator.errors ?? [])
    throw new ProjectConfigError({
      code: "SCHEMA_INVALID",
      message: `Invalid ${label} ${path}: ${details.join("; ")}`,
      documentPath: path,
      details,
    })
  }

  return value
}

function formatValidationErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const location = error.instancePath || "/"
    if (error.keyword === "additionalProperties") {
      const property = String(error.params.additionalProperty ?? "unknown")
      return `${location} contains unknown property "${property}"`
    }

    return `${location} ${error.message ?? "is invalid"}`
  })
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  )
}

async function validateArtifactRoot(
  value: ProjectConfig,
  path: string,
  projectRoot: string,
): Promise<void> {
  const configuredRoot = value.artifactRoot ?? ".ui-eval"
  const artifactRoot = resolve(projectRoot, configuredRoot)
  if (isAbsolute(configuredRoot) || !isContainedPath(projectRoot, artifactRoot)) {
    throw semanticError(
      path,
      "artifactRoot must be a project-relative path contained by the project",
    )
  }

  let candidate = artifactRoot
  let isArtifactRoot = true
  while (true) {
    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(candidate)
    } catch (error) {
      if (!hasFileSystemCode(error, "ENOENT")) {
        throw semanticError(
          path,
          "artifactRoot and its ancestors must be safely inspectable",
          error,
        )
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        throw semanticError(
          path,
          "artifactRoot has no existing ancestor inside the project",
          error,
        )
      }
      candidate = parent
      isArtifactRoot = false
      continue
    }

    if (isArtifactRoot && metadata.isSymbolicLink()) {
      throw semanticError(path, "artifactRoot must not be a symbolic link")
    }

    let canonicalCandidate: string
    let canonicalMetadata = metadata
    try {
      canonicalCandidate = await realpath(candidate)
      if (metadata.isSymbolicLink()) canonicalMetadata = await stat(candidate)
    } catch (error) {
      throw semanticError(
        path,
        "artifactRoot and its ancestors must resolve to an existing directory",
        error,
      )
    }
    if (!isContainedPath(projectRoot, canonicalCandidate)) {
      throw semanticError(
        path,
        "artifactRoot resolves through an ancestor outside the project",
      )
    }
    if (!canonicalMetadata.isDirectory()) {
      throw semanticError(
        path,
        "artifactRoot or its nearest existing ancestor is not a directory",
      )
    }
    return
  }
}

async function validateProjectSemantics(
  value: ProjectConfig,
  path: string,
  projectRoot: string,
): Promise<void> {
  for (const [id, baseUrl] of Object.entries(value.baseUrls)) {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch (error) {
      throw semanticError(path, `baseUrls.${id} is not a valid URL`, error)
    }

    if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:")) {
      throw semanticError(path, `baseUrls.${id} must use http or https`)
    }
    if (parsed.search || parsed.hash) {
      throw semanticError(
        path,
        `baseUrls.${id} must not contain a query string or fragment`,
      )
    }
  }

  validateHttpUrl(value.devServer.url, path, "devServer.url")
  if (value.devServer.reuseExisting && !value.devServer.readiness) {
    throw semanticError(
      path,
      "devServer.reuseExisting requires a project-specific readiness body marker",
    )
  }

  await validateArtifactRoot(value, path, projectRoot)

  assertTimeZone(value.defaults.timezone, path, "defaults.timezone")

  for (const [id, profile] of Object.entries(value.deviceProfiles)) {
    const screenshotWidth = profile.viewport.width * profile.deviceScaleFactor
    const screenshotHeight = profile.viewport.height * profile.deviceScaleFactor
    if (!Number.isInteger(screenshotWidth) || !Number.isInteger(screenshotHeight)) {
      throw semanticError(
        path,
        `deviceProfiles.${id} viewport multiplied by deviceScaleFactor must produce integer screenshot dimensions`,
      )
    }
  }
}

function validateHttpUrl(value: string, path: string, field: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw semanticError(path, `${field} is not a valid URL`, error)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw semanticError(path, `${field} must use http or https`)
  }
}

function validatePolicySemantics(value: PolicySource, path: string): void {
  assertUniqueIds(
    value.evaluators.map((item) => item.id),
    path,
    "evaluator",
  )
  assertUniqueIds(
    value.tolerances.map((item) => item.id),
    path,
    "tolerance",
  )
  assertUniqueIds(
    value.gates.map((item) => item.id),
    path,
    "gate",
  )

  if (value.repeatability.requiredAgreement > value.repeatability.attempts) {
    throw semanticError(
      path,
      "repeatability.requiredAgreement cannot exceed repeatability.attempts",
    )
  }

  for (const evaluator of value.evaluators) {
    const hasInlineConfig = evaluator.config !== undefined
    const hasPathConfig = evaluator.configPath !== undefined
    if (hasInlineConfig === hasPathConfig) {
      throw semanticError(
        path,
        `evaluator ${evaluator.id} must use exactly one of config or configPath`,
      )
    }
    if (hasInlineConfig) {
      assertCanonicalJsonValue(
        evaluator.config,
        path,
        `evaluator ${evaluator.id} config`,
      )
    }
  }
  for (const tolerance of value.tolerances) {
    assertCanonicalJsonValue(
      tolerance.value,
      path,
      `tolerance ${tolerance.id} value`,
    )
  }
}

function assertCanonicalJsonValue(
  value: unknown,
  path: string,
  field: string,
): void {
  try {
    canonicalDigest(value)
  } catch (error) {
    throw semanticError(path, `${field} must be canonical JSON data`, error)
  }
}

function assertUniqueIds(
  ids: readonly string[],
  path: string,
  label: string,
): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw semanticError(path, `duplicate ${label} id "${id}"`)
    }
    seen.add(id)
  }
}

function assertTimeZone(timezone: string, path: string, field: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format()
  } catch (error) {
    throw semanticError(path, `${field} is not a valid IANA timezone`, error)
  }
}

function semanticError(
  path: string,
  detail: string,
  cause?: unknown,
): ProjectConfigError {
  return new ProjectConfigError({
    code: "SEMANTIC_INVALID",
    message: `Invalid configuration in ${path}: ${detail}.`,
    documentPath: path,
    details: [detail],
    cause,
  })
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }

  return value
}

// Ensures schema declarations stay assignable to Ajv at compile time.
void (ProjectConfigSchema satisfies TSchema)
