import { readFile, stat } from "node:fs/promises"
import { basename } from "node:path"
import {
  DigestExclusionProfiles,
  canonicalDigest,
} from "../contracts/canonical-json"
import type {
  ArtifactRef,
  CaptureCapability,
  Digest,
  MatrixValue,
  ResolvedFixture,
  WebResolvedScenarioPlan,
} from "../contracts/model"
import {
  validateArtifactRef,
  validateMockServerFixtureConfig,
  validateResolvedScenarioPlan,
} from "../contracts/validation"
import { MOCK_SERVER_FIXTURE_LIMITS } from "../contracts/schemas"
import {
  ProjectConfigError,
  resolveProjectFile,
  type FixtureSource,
  type LoadedProjectConfig,
  type LoadedScenarioSource,
  type ScenarioSource,
} from "../project/config"

export interface ArtifactMaterializer {
  put(
    value: unknown,
    options: {
      mediaType: string
      sensitivity: "public" | "internal" | "sensitive"
    },
  ): Promise<ArtifactRef>
}

export interface CompileScenarioOptions {
  /** The concrete adapter capabilities, if narrower than project defaults. */
  availableCapabilities?: readonly CaptureCapability[]
  artifactMaterializer?: ArtifactMaterializer
}

export type ScenarioCompileErrorCode =
  | "UNKNOWN_BASE_URL"
  | "UNKNOWN_DEVICE_PROFILE"
  | "UNKNOWN_STORAGE_STATE"
  | "UNKNOWN_FIXTURE_SET"
  | "UNKNOWN_FEATURE_FLAG_SET"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_FEATURE_FLAGS"
  | "UNSUPPORTED_AUTH_SECRET_REFS"
  | "UNSUPPORTED_FIXTURES"
  | "UNSUPPORTED_NETWORK_PROFILE"
  | "INVALID_EXCLUDE"
  | "EMPTY_MATRIX"
  | "DUPLICATE_STEP_ID"
  | "DUPLICATE_CHECKPOINT_ID"
  | "DANGLING_CHECKPOINT"
  | "PLATFORM_MISMATCH"
  | "INVALID_TIMEZONE"
  | "INVALID_LOCALE"
  | "INVALID_FIXTURE_SOURCE"
  | "INVALID_REFERENCED_JSON"
  | "ARTIFACT_MATERIALIZER_REQUIRED"
  | "ARTIFACT_MATERIALIZATION_FAILED"
  | "INVALID_ARTIFACT_REF"
  | "PATH_OUTSIDE_PROJECT"
  | "FILE_NOT_FOUND"
  | "INVALID_RESOLVED_PLAN"

export class ScenarioCompileError extends Error {
  readonly code: ScenarioCompileErrorCode
  readonly scenarioId?: string
  readonly reference?: string
  readonly details: readonly string[]

  constructor(options: {
    code: ScenarioCompileErrorCode
    message: string
    scenarioId?: string
    reference?: string
    details?: readonly string[]
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = "ScenarioCompileError"
    this.code = options.code
    this.scenarioId = options.scenarioId
    this.reference = options.reference
    this.details = options.details ?? []
  }
}

type MatrixDimensionName =
  | "deviceProfile"
  | "locale"
  | "theme"
  | "featureFlagSet"
  | "fixtureSet"

interface MatrixDimension {
  name: MatrixDimensionName
  values: readonly MatrixValue[]
}

interface CompilationContext {
  project: LoadedProjectConfig
  source: Readonly<ScenarioSource>
  sourceDigest: Digest
  options: CompileScenarioOptions
  baseUrl: string
  requiredCapabilities: CaptureCapability[]
  auth?: WebResolvedScenarioPlan["auth"]
  fixtureCache: Map<string, Promise<ResolvedFixture>>
}

/**
 * Compile a human-authored ScenarioSource into immutable execution plans.
 * Every supported file-backed input is materialized before this function
 * returns; declared inputs the Phase 0A adapter cannot execute fail closed.
 */
export async function compileScenario(
  sourceInput: LoadedScenarioSource | ScenarioSource,
  project: LoadedProjectConfig,
  options: CompileScenarioOptions = {},
): Promise<readonly WebResolvedScenarioPlan[]> {
  const source = isLoadedScenario(sourceInput)
    ? sourceInput.value
    : sourceInput
  const sourceDigest = isLoadedScenario(sourceInput)
    ? sourceInput.digest
    : canonicalDigest(sourceInput)

  assertPhase0ASupportedScenarioInputs(source, project)
  const baseUrl = resolveBaseUrl(source, project)
  validateScenarioSemantics(source, baseUrl)
  validateMatrixReferences(source, project)

  const requiredCapabilities = resolveCapabilities(source, project, options)
  const auth = await resolveAuth(source, project, options)
  const context: CompilationContext = {
    project,
    source,
    sourceDigest,
    options,
    baseUrl,
    requiredCapabilities,
    ...(auth ? { auth } : {}),
    fixtureCache: new Map(),
  }

  const variants = expandMatrix(source, project)
  if (variants.length === 0) {
    throw compileError(
      "EMPTY_MATRIX",
      source.id,
      "Matrix expansion produced no executable variants after exclusions.",
    )
  }

  const plans: WebResolvedScenarioPlan[] = []
  for (const values of variants) {
    plans.push(await compileVariant(context, values))
  }

  return deepFreeze(plans)
}

export function expandMatrix(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
): ReadonlyArray<Readonly<Record<string, MatrixValue>>> {
  assertPhase0ASupportedScenarioInputs(source, project)
  const dimensions = matrixDimensions(source, project)
  validateExclusions(source, dimensions)

  let combinations: Array<Record<string, MatrixValue>> = [{}]
  for (const dimension of dimensions) {
    combinations = combinations.flatMap((combination) =>
      dimension.values.map((value) => ({
        ...combination,
        [dimension.name]: value,
      })),
    )
  }

  return combinations
    .filter(
      (combination) =>
        !(source.matrix.exclude ?? []).some((rule) =>
          exactRuleMatches(rule, combination),
        ),
    )
    .map((combination) =>
      deepFreeze({
        ...combination,
        ...resolvedFeatureFlagValues(combination, project),
      }),
    )
}

/**
 * Phase 0A must not seal a plan for state inputs the Web adapter cannot apply.
 * Merely including those inputs in variant/config digests would create distinct
 * plans that capture the same browser state and therefore manufacture coverage.
 */
function assertPhase0ASupportedScenarioInputs(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
): void {
  if ((source.auth?.secretRefs?.length ?? 0) > 0) {
    throw compileError(
      "UNSUPPORTED_AUTH_SECRET_REFS",
      source.id,
      "Phase 0A does not resolve or inject auth.secretRefs. Remove auth.secretRefs until a registered secret provider is available; refusing to seal credentials the browser would ignore.",
      "auth.secretRefs",
    )
  }

  if ((source.matrix.featureFlagSets?.length ?? 0) > 0) {
    throw compileError(
      "UNSUPPORTED_FEATURE_FLAGS",
      source.id,
      "Phase 0A does not install feature flags in the candidate browser. Remove matrix.featureFlagSets until a registered feature-flag injector is available; refusing to create variants that would capture identical page state.",
      "matrix.featureFlagSets",
    )
  }

  const selectedFixtures = [
    ...(source.fixtures ?? []),
    ...(source.matrix.fixtureSets ?? []).flatMap(
      (setId) => project.value.fixtureSets?.[setId] ?? [],
    ),
  ]
  const unsupportedFixture = selectedFixtures.find(
    (fixture) => fixture.provider !== "mock-server",
  )
  if (unsupportedFixture) {
    throw compileError(
      "UNSUPPORTED_FIXTURES",
      source.id,
      `Fixture provider "${unsupportedFixture.provider}" is not executable. This runtime supports only bounded loopback mock-server fixtures; refusing to seal unused fixture state.`,
      unsupportedFixture.id,
    )
  }

  if (source.determinism.networkProfileRef !== undefined) {
    throw compileError(
      "UNSUPPORTED_NETWORK_PROFILE",
      source.id,
      "Phase 0A does not apply network profiles. Remove determinism.networkProfileRef until a registered network-profile adapter is available; refusing to seal an execution setting the browser would ignore.",
      source.determinism.networkProfileRef,
    )
  }
}

async function compileVariant(
  context: CompilationContext,
  values: Readonly<Record<string, MatrixValue>>,
): Promise<WebResolvedScenarioPlan> {
  const profileId = String(values.deviceProfile)
  const profile = context.project.value.deviceProfiles[profileId]
  if (!profile) {
    throw compileError(
      "UNKNOWN_DEVICE_PROFILE",
      context.source.id,
      `Device profile "${profileId}" is not defined by project.json.`,
      profileId,
    )
  }

  const locale = canonicalLocale(String(values.locale), context.source.id)
  const theme = values.theme as "light" | "dark"
  const timezone = canonicalTimezone(
    context.source.determinism.timezone ??
      context.project.value.defaults.timezone,
    context.source.id,
  )
  const determinism = {
    timezone,
    clock: { ...context.source.determinism.clock },
    ...(context.source.determinism.randomSeed
      ? { randomSeed: context.source.determinism.randomSeed }
      : {}),
    ...(context.source.determinism.networkProfileRef
      ? { networkProfileRef: context.source.determinism.networkProfileRef }
      : {}),
  }

  const fixtures = await resolveFixtures(context, values)
  const normalizedCheckpoints = context.source.checkpoints.map((checkpoint) => ({
    ...checkpoint,
    requiredChannels: [...checkpoint.requiredChannels].sort(),
  }))
  const evidenceRequestDigest = canonicalDigest({
    requiredCapabilities: context.requiredCapabilities,
    checkpoints: normalizedCheckpoints.map((checkpoint) => ({
      id: checkpoint.id,
      requiredChannels: checkpoint.requiredChannels,
      captureScope: checkpoint.captureScope,
      ...(checkpoint.target ? { target: checkpoint.target } : {}),
      stabilize: checkpoint.stabilize,
      ...(checkpoint.assertions ? { assertions: checkpoint.assertions } : {}),
    })),
  })
  const variantValues = { ...values }
  const variant = {
    variantKey: createVariantKey(variantValues),
    values: variantValues,
    contextDigest: canonicalDigest(variantValues),
  }
  const device = {
    profileId,
    renderSpace: {
      logicalWidth: profile.viewport.width,
      logicalHeight: profile.viewport.height,
      logicalUnit: "css-px" as const,
      deviceScaleFactor: profile.deviceScaleFactor,
      screenshotWidthPx: profile.viewport.width * profile.deviceScaleFactor,
      screenshotHeightPx: profile.viewport.height * profile.deviceScaleFactor,
      orientation:
        profile.viewport.width >= profile.viewport.height
          ? ("landscape" as const)
          : ("portrait" as const),
      ...(profile.safeArea ? { safeArea: { ...profile.safeArea } } : {}),
    },
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
  }
  const fixtureDigests = [...new Set(fixtures.map((fixture) => fixture.configDigest))].sort()
  const setup = [...(context.source.setup ?? [])]
  const steps = [...context.source.steps]
  const cleanup = [...(context.source.cleanup ?? [])]
  const checkpoints = normalizedCheckpoints
  const target = {
    platform: "web" as const,
    entrypoint: {
      baseUrl: context.baseUrl,
      path: context.source.target.entrypoint.path,
    },
  }

  const captureConfigDigest = canonicalDigest({
    projectConfigDigest: context.project.digest,
    target,
    variant,
    device,
    locale,
    theme,
    determinism,
    ...(context.auth ? { auth: context.auth } : {}),
    fixtures,
    fixtureDigests,
    requiredCapabilities: context.requiredCapabilities,
    evidenceRequestDigest,
    setup,
    steps,
    cleanup,
    checkpoints,
  })

  const planWithoutDigest = {
    scenarioId: context.source.id,
    scenarioRevision: context.source.revision,
    scenarioDigest: context.sourceDigest,
    planDigest: zeroDigest(),
    visibility: context.source.visibility,
    target,
    variant,
    device,
    locale,
    theme,
    determinism,
    ...(context.auth ? { auth: context.auth } : {}),
    fixtures,
    requiredCapabilities: context.requiredCapabilities,
    fixtureDigests,
    evidenceRequestDigest,
    captureConfigDigest,
    setup,
    steps,
    cleanup,
    checkpoints,
  } satisfies WebResolvedScenarioPlan
  const plan = {
    ...planWithoutDigest,
    planDigest: canonicalDigest(planWithoutDigest, {
      exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
    }),
  }

  try {
    return validateResolvedScenarioPlan(plan) as WebResolvedScenarioPlan
  } catch (error) {
    throw compileError(
      "INVALID_RESOLVED_PLAN",
      context.source.id,
      `Compiler produced a plan that violates the runtime contract: ${errorMessage(error)}`,
      undefined,
      error,
    )
  }
}

function matrixDimensions(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
): MatrixDimension[] {
  return [
    { name: "deviceProfile", values: source.matrix.deviceProfiles },
    {
      name: "locale",
      values: source.matrix.locales ?? [project.value.defaults.locale],
    },
    {
      name: "theme",
      values: source.matrix.themes ?? [project.value.defaults.theme],
    },
    ...(source.matrix.featureFlagSets
      ? [
          {
            name: "featureFlagSet" as const,
            values: source.matrix.featureFlagSets,
          },
        ]
      : []),
    ...(source.matrix.fixtureSets
      ? [
          {
            name: "fixtureSet" as const,
            values: source.matrix.fixtureSets,
          },
        ]
      : []),
  ]
}

function validateExclusions(
  source: Readonly<ScenarioSource>,
  dimensions: readonly MatrixDimension[],
): void {
  const dimensionValues = new Map(
    dimensions.map((dimension) => [dimension.name, new Set(dimension.values)]),
  )

  for (const [index, rule] of (source.matrix.exclude ?? []).entries()) {
    const entries = Object.entries(rule)
    if (entries.length === 0) {
      throw compileError(
        "INVALID_EXCLUDE",
        source.id,
        `matrix.exclude[${index}] cannot be empty because it would match every variant.`,
      )
    }

    for (const [key, value] of entries) {
      const allowed = dimensionValues.get(key as MatrixDimensionName)
      if (!allowed) {
        throw compileError(
          "INVALID_EXCLUDE",
          source.id,
          `matrix.exclude[${index}] uses unknown or inactive dimension "${key}". Active dimensions: ${[
            ...dimensionValues.keys(),
          ].join(", ")}.`,
          key,
        )
      }
      if (!allowed.has(value)) {
        throw compileError(
          "INVALID_EXCLUDE",
          source.id,
          `matrix.exclude[${index}].${key}=${JSON.stringify(value)} does not exactly match a declared matrix value.`,
          key,
        )
      }
    }
  }
}

function exactRuleMatches(
  rule: Readonly<Record<string, MatrixValue>>,
  values: Readonly<Record<string, MatrixValue>>,
): boolean {
  return Object.entries(rule).every(([key, expected]) => values[key] === expected)
}

function resolvedFeatureFlagValues(
  values: Readonly<Record<string, MatrixValue>>,
  project: LoadedProjectConfig,
): Record<string, MatrixValue> {
  const setName = values.featureFlagSet
  if (typeof setName !== "string") return {}
  const flags = project.value.featureFlagSets?.[setName]
  if (!flags) return {}

  return Object.fromEntries(
    Object.entries(flags)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [`featureFlag.${key}`, value]),
  )
}

function validateMatrixReferences(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
): void {
  for (const profileId of source.matrix.deviceProfiles) {
    if (!project.value.deviceProfiles[profileId]) {
      throw compileError(
        "UNKNOWN_DEVICE_PROFILE",
        source.id,
        `Device profile "${profileId}" is not defined by project.json.`,
        profileId,
      )
    }
  }
  for (const setId of source.matrix.featureFlagSets ?? []) {
    if (!project.value.featureFlagSets?.[setId]) {
      throw compileError(
        "UNKNOWN_FEATURE_FLAG_SET",
        source.id,
        `Feature flag set "${setId}" is not defined by project.json.`,
        setId,
      )
    }
  }
  for (const setId of source.matrix.fixtureSets ?? []) {
    if (!project.value.fixtureSets?.[setId]) {
      throw compileError(
        "UNKNOWN_FIXTURE_SET",
        source.id,
        `Fixture set "${setId}" is not defined by project.json.`,
        setId,
      )
    }
  }
}

function resolveBaseUrl(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
): string {
  const reference = source.target.entrypoint.baseUrlRef
  const value = project.value.baseUrls[reference]
  if (!value) {
    throw compileError(
      "UNKNOWN_BASE_URL",
      source.id,
      `Project base URL reference "${reference}" is not defined by project.json.`,
      reference,
    )
  }

  const parsed = new URL(value)
  const serialized = parsed.toString()
  return parsed.pathname === "/" && !parsed.search && !parsed.hash
    ? serialized.slice(0, -1)
    : serialized.replace(/\/$/, "")
}

function resolveCapabilities(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
  options: CompileScenarioOptions,
): CaptureCapability[] {
  const required = new Set<CaptureCapability>(source.requiredCapabilities)
  for (const checkpoint of source.checkpoints) {
    for (const channel of checkpoint.requiredChannels) required.add(channel)
  }

  const available = new Set(
    options.availableCapabilities ?? project.value.supportedCapabilities,
  )
  const unsupported = [...required].filter((capability) => !available.has(capability))
  if (unsupported.length > 0) {
    throw compileError(
      "UNSUPPORTED_CAPABILITY",
      source.id,
      `Capture adapter/project does not provide required capabilities: ${unsupported
        .sort()
        .join(", ")}. Available: ${[...available].sort().join(", ") || "none"}.`,
      unsupported.join(","),
    )
  }

  return [...required].sort()
}

async function resolveAuth(
  source: Readonly<ScenarioSource>,
  project: LoadedProjectConfig,
  options: CompileScenarioOptions,
): Promise<WebResolvedScenarioPlan["auth"] | undefined> {
  if (!source.auth) return undefined

  const reference = source.auth.storageStateRef
  const fileReference = project.value.storageStates?.[reference]
  if (!fileReference) {
    throw compileError(
      "UNKNOWN_STORAGE_STATE",
      source.id,
      `Auth storage state reference "${reference}" is not defined in project.json storageStates.`,
      reference,
    )
  }
  const materializer = requireMaterializer(source.id, options)
  const state = await readProjectJson(
    project,
    fileReference,
    `auth storage state "${reference}"`,
    source.id,
  )
  validateStorageState(state, source.id, reference)
  const storageState = await putArtifact(
    materializer,
    state,
    {
      mediaType: "application/json",
      sensitivity: "sensitive",
    },
    project,
    source.id,
    reference,
  )

  return {
    ...(source.auth.role ? { role: source.auth.role } : {}),
    storageState,
    ...(source.auth.secretRefs ? { secretRefs: [...source.auth.secretRefs] } : {}),
  }
}

async function resolveFixtures(
  context: CompilationContext,
  values: Readonly<Record<string, MatrixValue>>,
): Promise<ResolvedFixture[]> {
  const selectedFixtureSet = values.fixtureSet
  const fixtures = [
    ...(context.source.fixtures ?? []),
    ...(typeof selectedFixtureSet === "string"
      ? (context.project.value.fixtureSets?.[selectedFixtureSet] ?? [])
      : []),
  ]
  const duplicateId = firstDuplicate(fixtures.map((fixture) => fixture.id))
  if (duplicateId) {
    throw compileError(
      "INVALID_FIXTURE_SOURCE",
      context.source.id,
      `Fixture id "${duplicateId}" is declared more than once in the resolved variant.`,
      duplicateId,
    )
  }

  const resolved = await Promise.all(
    fixtures.map((fixture) => resolveFixture(context, fixture)),
  )
  return resolved.sort((left, right) => left.id.localeCompare(right.id))
}

async function resolveFixture(
  context: CompilationContext,
  fixture: FixtureSource,
): Promise<ResolvedFixture> {
  const cacheKey = canonicalDigest(fixture)
  const cached = context.fixtureCache.get(cacheKey)
  if (cached) return cached

  const pending = materializeFixture(context, fixture)
  context.fixtureCache.set(cacheKey, pending)
  try {
    return await pending
  } catch (error) {
    context.fixtureCache.delete(cacheKey)
    throw error
  }
}

async function materializeFixture(
  context: CompilationContext,
  fixture: FixtureSource,
): Promise<ResolvedFixture> {
  if (fixture.provider !== "mock-server") {
    throw compileError(
      "UNSUPPORTED_FIXTURES",
      context.source.id,
      `Fixture provider "${fixture.provider}" is not executable by this runtime.`,
      fixture.id,
    )
  }
  if (fixture.secretRefs?.length) {
    throw compileError(
      "INVALID_FIXTURE_SOURCE",
      context.source.id,
      `Fixture "${fixture.id}" declares secretRefs, which Phase 0A cannot seal in ResolvedFixture.`,
      fixture.id,
    )
  }
  if (
    !fixture.configPath ||
    fixture.artifactPath !== undefined ||
    (fixture.mediaType !== undefined && fixture.mediaType !== "application/json")
  ) {
    throw compileError(
      "INVALID_FIXTURE_SOURCE",
      context.source.id,
      `Mock-server fixture "${fixture.id}" requires configPath, cannot use artifactPath, and may declare only application/json mediaType.`,
      fixture.id,
    )
  }

  const materializer = requireMaterializer(context.source.id, context.options)
  const config = await readMockServerFixtureConfig(
    context.project,
    fixture.configPath,
    context.source.id,
    fixture.id,
  )
  const artifact = await putArtifact(
    materializer,
    config,
    {
      mediaType: "application/json",
      sensitivity: "internal",
    },
    context.project,
    context.source.id,
    fixture.id,
  )
  return {
    id: fixture.id,
    provider: fixture.provider,
    configDigest: artifact.digest,
    artifact,
  }
}

async function readMockServerFixtureConfig(
  project: LoadedProjectConfig,
  reference: string,
  scenarioId: string,
  fixtureId: string,
) {
  const label = `mock-server fixture config "${fixtureId}"`
  const path = await resolveReferencedFile(project, reference, label, scenarioId)
  let sizeBytes: number
  try {
    sizeBytes = (await stat(path)).size
  } catch (error) {
    throw compileError(
      "FILE_NOT_FOUND",
      scenarioId,
      `Could not inspect ${label}: ${errorMessage(error)}`,
      reference,
      error,
    )
  }
  if (sizeBytes > MOCK_SERVER_FIXTURE_LIMITS.maxArtifactBytes) {
    throw compileError(
      "INVALID_FIXTURE_SOURCE",
      scenarioId,
      `Mock-server fixture "${fixtureId}" exceeds the bounded config size.`,
      fixtureId,
    )
  }

  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    throw compileError(
      "FILE_NOT_FOUND",
      scenarioId,
      `Could not read ${label}: ${errorMessage(error)}`,
      reference,
      error,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw compileError(
      "INVALID_REFERENCED_JSON",
      scenarioId,
      `${label} contains invalid JSON: ${errorMessage(error)}`,
      reference,
      error,
    )
  }
  try {
    return validateMockServerFixtureConfig(parsed)
  } catch (error) {
    throw compileError(
      "INVALID_FIXTURE_SOURCE",
      scenarioId,
      `Mock-server fixture "${fixtureId}" is invalid: ${errorMessage(error)}`,
      fixtureId,
      error,
    )
  }
}

function requireMaterializer(
  scenarioId: string,
  options: CompileScenarioOptions,
): ArtifactMaterializer {
  if (!options.artifactMaterializer) {
    throw compileError(
      "ARTIFACT_MATERIALIZER_REQUIRED",
      scenarioId,
      "Scenario uses file-backed auth or fixtures. Pass an ArtifactMaterializer so the compiler can seal them before Capture.",
    )
  }
  return options.artifactMaterializer
}

async function putArtifact(
  materializer: ArtifactMaterializer,
  value: unknown,
  options: Parameters<ArtifactMaterializer["put"]>[1],
  project: LoadedProjectConfig,
  scenarioId: string,
  reference: string,
): Promise<ArtifactRef> {
  let candidate: unknown
  try {
    candidate = await materializer.put(value, options)
  } catch (error) {
    throw compileError(
      "ARTIFACT_MATERIALIZATION_FAILED",
      scenarioId,
      `Failed to materialize "${reference}" into the artifact store: ${errorMessage(error)}`,
      reference,
      error,
    )
  }

  let artifact: ArtifactRef
  try {
    artifact = validateArtifactRef(candidate)
  } catch (error) {
    throw compileError(
      "INVALID_ARTIFACT_REF",
      scenarioId,
      `Artifact materializer returned an invalid reference for "${reference}": ${errorMessage(error)}`,
      reference,
      error,
    )
  }
  if (artifact.projectId !== project.value.projectId) {
    throw compileError(
      "INVALID_ARTIFACT_REF",
      scenarioId,
      `Artifact "${reference}" belongs to project "${artifact.projectId}", expected "${project.value.projectId}".`,
      reference,
    )
  }
  if (artifact.sensitivity !== options.sensitivity) {
    throw compileError(
      "INVALID_ARTIFACT_REF",
      scenarioId,
      `Artifact "${reference}" has sensitivity "${artifact.sensitivity}", expected "${options.sensitivity}".`,
      reference,
    )
  }

  return artifact
}

async function readProjectJson(
  project: LoadedProjectConfig,
  reference: string,
  label: string,
  scenarioId: string,
): Promise<unknown> {
  const path = await resolveReferencedFile(project, reference, label, scenarioId)
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    throw compileError(
      "FILE_NOT_FOUND",
      scenarioId,
      `Could not read ${label} at ${path}: ${errorMessage(error)}`,
      reference,
      error,
    )
  }

  try {
    return JSON.parse(source)
  } catch (error) {
    throw compileError(
      "INVALID_REFERENCED_JSON",
      scenarioId,
      `${label} ${basename(path)} contains invalid JSON: ${errorMessage(error)}`,
      reference,
      error,
    )
  }
}

async function resolveReferencedFile(
  project: LoadedProjectConfig,
  reference: string,
  label: string,
  scenarioId: string,
): Promise<string> {
  try {
    return await resolveProjectFile(project, reference, label)
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      const code =
        error.code === "PATH_OUTSIDE_PROJECT"
          ? "PATH_OUTSIDE_PROJECT"
          : "FILE_NOT_FOUND"
      throw compileError(
        code,
        scenarioId,
        error.message,
        reference,
        error,
      )
    }
    throw error
  }
}

function validateStorageState(
  value: unknown,
  scenarioId: string,
  reference: string,
): void {
  if (!isPlainObject(value)) {
    throw compileError(
      "INVALID_REFERENCED_JSON",
      scenarioId,
      `Storage state "${reference}" must be a JSON object.`,
      reference,
    )
  }
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw compileError(
      "INVALID_REFERENCED_JSON",
      scenarioId,
      `Storage state "${reference}" must contain cookies[] and origins[] arrays compatible with Playwright.`,
      reference,
    )
  }
}

function assertSameOriginNavigationPath(
  path: string,
  baseUrl: string,
  scenarioId: string,
  label: string,
  reference: string,
): void {
  let resolved: URL | undefined
  try {
    resolved = new URL(path, baseUrl)
  } catch {
    // The shared failure below keeps authoring errors independent of URL parser text.
  }

  const baseOrigin = new URL(baseUrl).origin
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    resolved?.origin !== baseOrigin
  ) {
    throw compileError(
      "PLATFORM_MISMATCH",
      scenarioId,
      `${label} path "${path}" must be an origin-relative path without backslashes and resolve to ${baseOrigin}.`,
      reference,
    )
  }
}

function validateScenarioSemantics(
  source: Readonly<ScenarioSource>,
  baseUrl: string,
): void {
  const allSteps = [
    ...(source.setup ?? []),
    ...source.steps,
    ...(source.cleanup ?? []),
  ]
  assertSameOriginNavigationPath(
    source.target.entrypoint.path,
    baseUrl,
    source.id,
    "Entrypoint",
    source.target.entrypoint.path,
  )
  const duplicateStep = firstDuplicate(allSteps.map((step) => step.id))
  if (duplicateStep) {
    throw compileError(
      "DUPLICATE_STEP_ID",
      source.id,
      `Step id "${duplicateStep}" is duplicated across setup, steps, or cleanup.`,
      duplicateStep,
    )
  }
  const duplicateCheckpoint = firstDuplicate(
    source.checkpoints.map((checkpoint) => checkpoint.id),
  )
  if (duplicateCheckpoint) {
    throw compileError(
      "DUPLICATE_CHECKPOINT_ID",
      source.id,
      `Checkpoint id "${duplicateCheckpoint}" is duplicated.`,
      duplicateCheckpoint,
    )
  }

  const checkpointIds = new Set(source.checkpoints.map((checkpoint) => checkpoint.id))
  for (const step of allSteps) {
    if (step.action === "checkpoint" && !checkpointIds.has(step.checkpointId)) {
      throw compileError(
        "DANGLING_CHECKPOINT",
        source.id,
        `Step "${step.id}" references undeclared checkpoint "${step.checkpointId}".`,
        step.checkpointId,
      )
    }
    if (step.action === "goto") {
      assertSameOriginNavigationPath(
        step.path,
        baseUrl,
        source.id,
        `Goto step "${step.id}"`,
        step.id,
      )
    }
    assertWebStep(step, source.id)
  }
  for (const checkpoint of source.checkpoints) {
    assertWebLocator(checkpoint.target, source.id, `checkpoint "${checkpoint.id}"`)
    for (const assertion of checkpoint.assertions ?? []) {
      const assertionRecord = isPlainObject(assertion) ? assertion : {}
      const assertionId =
        typeof assertionRecord.id === "string" ? assertionRecord.id : "unknown"
      assertWebLocator(
        assertionRecord.target,
        source.id,
        `checkpoint assertion "${assertionId}"`,
      )
    }
    if (checkpoint.captureScope === "element" && !checkpoint.target) {
      throw compileError(
        "PLATFORM_MISMATCH",
        source.id,
        `Element checkpoint "${checkpoint.id}" requires a web target locator.`,
        checkpoint.id,
      )
    }
  }

  if (source.determinism.timezone) {
    canonicalTimezone(source.determinism.timezone, source.id)
  }
}

function assertWebStep(
  step: ScenarioSource["steps"][number],
  scenarioId: string,
): void {
  if ("target" in step) {
    assertWebLocator(step.target, scenarioId, `step "${step.id}"`)
  }
  if (step.action === "assert") {
    const assertion = isPlainObject(step.assertion) ? step.assertion : {}
    const assertionId = typeof assertion.id === "string" ? assertion.id : "unknown"
    assertWebLocator(
      assertion.target,
      scenarioId,
      `assertion "${assertionId}"`,
    )
  }
}

function assertWebLocator(
  locator: unknown,
  scenarioId: string,
  label: string,
): void {
  if (locator === undefined) return
  const platform = isPlainObject(locator) ? locator.platform : undefined
  if (platform !== "web") {
    throw compileError(
      "PLATFORM_MISMATCH",
      scenarioId,
      `Web scenario ${label} uses a ${String(platform ?? "malformed")} locator.`,
    )
  }
}

function canonicalLocale(locale: string, scenarioId: string): string {
  try {
    return new Intl.Locale(locale).toString()
  } catch (error) {
    throw compileError(
      "INVALID_LOCALE",
      scenarioId,
      `Locale "${locale}" is not a valid BCP 47 locale.`,
      locale,
      error,
    )
  }
}

function canonicalTimezone(timezone: string, scenarioId: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions()
      .timeZone
  } catch (error) {
    throw compileError(
      "INVALID_TIMEZONE",
      scenarioId,
      `Timezone "${timezone}" is not a valid IANA timezone.`,
      timezone,
      error,
    )
  }
}

function createVariantKey(values: Readonly<Record<string, MatrixValue>>): string {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("__")
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return undefined
}

function isLoadedScenario(
  source: LoadedScenarioSource | ScenarioSource,
): source is LoadedScenarioSource {
  return "value" in source && "digest" in source && "path" in source
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

function zeroDigest(): `sha256:${string}` {
  return `sha256:${"0".repeat(64)}`
}

function compileError(
  code: ScenarioCompileErrorCode,
  scenarioId: string,
  message: string,
  reference?: string,
  cause?: unknown,
): ScenarioCompileError {
  return new ScenarioCompileError({
    code,
    message: `Could not compile scenario "${scenarioId}": ${message}`,
    scenarioId,
    ...(reference ? { reference } : {}),
    cause,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}
