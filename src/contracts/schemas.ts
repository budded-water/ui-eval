import { Type, type TSchema } from "@sinclair/typebox"

const strict = { additionalProperties: false } as const
const nonEmpty = { minLength: 1 } as const

export const ContractVersionSchema = Type.Literal("uieval.io/v1alpha1")
export const DigestSchema = Type.String({
  pattern: "^sha256:[a-f0-9]{64}$",
})
export const TimestampSchema = Type.String({ format: "date-time" })
export const MatrixValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
])
export const StringMapSchema = Type.Record(Type.String({ minLength: 1 }), Type.String())
export const MatrixMapSchema = Type.Record(
  Type.String({ minLength: 1 }),
  MatrixValueSchema,
)

export const ActorRefSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("human"),
      Type.Literal("agent"),
      Type.Literal("ci"),
      Type.Literal("service"),
    ]),
    id: Type.String(nonEmpty),
    displayName: Type.Optional(Type.String(nonEmpty)),
  },
  strict,
)

export const ContractMetadataSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    projectId: Type.String(nonEmpty),
    revision: Type.Integer({ minimum: 1 }),
    createdAt: TimestampSchema,
    createdBy: ActorRefSchema,
    specDigest: DigestSchema,
    labels: Type.Optional(StringMapSchema),
  },
  strict,
)

/** A broad envelope schema. Concrete contracts use contractEnvelope() below. */
export const ContractEnvelopeSchema = Type.Object(
  {
    apiVersion: ContractVersionSchema,
    kind: Type.String(nonEmpty),
    metadata: ContractMetadataSchema,
    spec: Type.Unknown(),
  },
  strict,
)

export function contractEnvelope<K extends string, S extends TSchema>(
  kind: K,
  spec: S,
) {
  return Type.Object(
    {
      apiVersion: ContractVersionSchema,
      kind: Type.Literal(kind),
      metadata: ContractMetadataSchema,
      spec,
    },
    strict,
  )
}

export const ArtifactRefSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    projectId: Type.String(nonEmpty),
    storeId: Type.String(nonEmpty),
    digest: DigestSchema,
    mediaType: Type.String(nonEmpty),
    sizeBytes: Type.Integer({ minimum: 0 }),
    sensitivity: Type.Union([
      Type.Literal("public"),
      Type.Literal("internal"),
      Type.Literal("sensitive"),
    ]),
    redaction: Type.Optional(
      Type.Object(
        {
          applied: Type.Boolean(),
          policyId: Type.Optional(Type.String(nonEmpty)),
        },
        strict,
      ),
    ),
  },
  strict,
)

export const SourceRevisionSchema = Type.Object(
  {
    repository: Type.String(nonEmpty),
    commitSha: Type.String(nonEmpty),
    dirtyTree: Type.Optional(Type.Boolean()),
    diffDigest: Type.Optional(DigestSchema),
  },
  strict,
)

export const BuildIdentitySchema = Type.Object(
  {
    platform: Type.Union([
      Type.Literal("web"),
      Type.Literal("ios"),
      Type.Literal("android"),
    ]),
    artifactDigest: DigestSchema,
    buildConfigDigest: DigestSchema,
    publicEnvironmentDigest: DigestSchema,
    appId: Type.Optional(Type.String(nonEmpty)),
    version: Type.Optional(Type.String(nonEmpty)),
  },
  strict,
)

const deploymentVersion = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" })
export const DeploymentIdentitySchema = Type.Object({
  schemaVersion: Type.Literal("uieval.deployment/v1alpha1"),
  revision: deploymentVersion,
  apiContractVersion: Type.Optional(deploymentVersion),
  featureFlagsDigest: Type.Optional(DigestSchema),
  dataRevision: Type.Optional(deploymentVersion),
}, strict)
export const DeploymentExpectationSchema = Type.Omit(DeploymentIdentitySchema, ["schemaVersion"])
export const ExecutionTargetSchema = Type.Union([
  Type.Object({ profileId: Type.String(nonEmpty), mode: Type.Literal("local"), baseUrl: Type.String(nonEmpty) }, strict),
  Type.Object({ profileId: Type.String(nonEmpty), mode: Type.Literal("remote"), baseUrl: Type.String(nonEmpty),
    frontendIdentityUrl: Type.String(nonEmpty), backendIdentityUrl: Type.Optional(Type.String(nonEmpty)),
    frontend: DeploymentExpectationSchema, backend: Type.Optional(DeploymentExpectationSchema) }, strict),
])
export const DeploymentVerificationSchema = Type.Object({
  status: Type.Union([Type.Literal("verified"), Type.Literal("unverified")]),
  frontend: Type.Optional(DeploymentIdentitySchema), backend: Type.Optional(DeploymentIdentitySchema),
}, strict)

export const ResolvedVariantSchema = Type.Object(
  {
    variantKey: Type.String(nonEmpty),
    values: MatrixMapSchema,
    contextDigest: DigestSchema,
  },
  strict,
)

export const RectSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 0 }),
    height: Type.Number({ minimum: 0 }),
  },
  strict,
)

export const RenderSpaceSchema = Type.Object(
  {
    logicalWidth: Type.Number({ exclusiveMinimum: 0 }),
    logicalHeight: Type.Number({ exclusiveMinimum: 0 }),
    logicalUnit: Type.Union([
      Type.Literal("css-px"),
      Type.Literal("dp"),
      Type.Literal("pt"),
      Type.Literal("design-unit"),
    ]),
    deviceScaleFactor: Type.Number({ exclusiveMinimum: 0 }),
    screenshotWidthPx: Type.Integer({ minimum: 1 }),
    screenshotHeightPx: Type.Integer({ minimum: 1 }),
    orientation: Type.Union([
      Type.Literal("portrait"),
      Type.Literal("landscape"),
    ]),
    safeArea: Type.Optional(
      Type.Object(
        {
          top: Type.Number({ minimum: 0 }),
          right: Type.Number({ minimum: 0 }),
          bottom: Type.Number({ minimum: 0 }),
          left: Type.Number({ minimum: 0 }),
        },
        strict,
      ),
    ),
  },
  strict,
)

export const CaptureCapabilitySchema = Type.Union([
  Type.Literal("screenshot"),
  Type.Literal("element-screenshots"),
  Type.Literal("dom"),
  Type.Literal("computed-styles"),
  Type.Literal("accessibility-tree"),
  Type.Literal("view-hierarchy"),
  Type.Literal("layout-metadata"),
  Type.Literal("console"),
  Type.Literal("network"),
  Type.Literal("trace"),
  Type.Literal("video"),
  Type.Literal("device-logs"),
  Type.Literal("crash"),
  Type.Literal("performance"),
])

export const DesignCapabilitySchema = Type.Union([
  Type.Literal("rendered-image"),
  Type.Literal("node-tree"),
  Type.Literal("layout-constraints"),
  Type.Literal("computed-design-styles"),
  Type.Literal("typography-spans"),
  Type.Literal("tokens"),
  Type.Literal("asset-identity"),
])

export const WebRuntimeLocatorSchema = Type.Object(
  {
    platform: Type.Literal("web"),
    by: Type.Union([
      Type.Literal("uiId"),
      Type.Literal("testId"),
      Type.Literal("role"),
      Type.Literal("css"),
      Type.Literal("text"),
    ]),
    value: Type.String(nonEmpty),
    name: Type.Optional(Type.String(nonEmpty)),
  },
  strict,
)

export const IosRuntimeLocatorSchema = Type.Object(
  {
    platform: Type.Literal("ios"),
    by: Type.Union([
      Type.Literal("testId"),
      Type.Literal("accessibilityId"),
      Type.Literal("text"),
    ]),
    value: Type.String(nonEmpty),
  },
  strict,
)

export const AndroidRuntimeLocatorSchema = Type.Object(
  {
    platform: Type.Literal("android"),
    by: Type.Union([
      Type.Literal("testId"),
      Type.Literal("accessibilityId"),
      Type.Literal("text"),
    ]),
    value: Type.String(nonEmpty),
  },
  strict,
)

export const AppRuntimeLocatorSchema = Type.Union([
  IosRuntimeLocatorSchema,
  AndroidRuntimeLocatorSchema,
])
export const RuntimeLocatorSchema = Type.Union([
  WebRuntimeLocatorSchema,
  IosRuntimeLocatorSchema,
  AndroidRuntimeLocatorSchema,
])

export const SourceHintSchema = Type.Object(
  {
    file: Type.String(nonEmpty),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    symbol: Type.Optional(Type.String(nonEmpty)),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  strict,
)

export const ElementBindingSchema = Type.Object(
  {
    uiId: Type.String(nonEmpty),
    designNodeId: Type.Optional(Type.String(nonEmpty)),
    runtimeLocators: Type.Array(RuntimeLocatorSchema, { minItems: 1 }),
    sourceHints: Type.Optional(Type.Array(SourceHintSchema)),
    method: Type.Union([
      Type.Literal("explicit"),
      Type.Literal("design-system"),
      Type.Literal("semantic"),
      Type.Literal("heuristic"),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    validForRevision: DigestSchema,
  },
  strict,
)

const DesignTargetSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    name: Type.String(nonEmpty),
    scenarioRef: Type.Optional(Type.String(nonEmpty)),
    checkpointRef: Type.Optional(Type.String(nonEmpty)),
    variantWhen: Type.Optional(MatrixMapSchema),
    frame: Type.Object(
      {
        renderSpace: RenderSpaceSchema,
        captureScope: Type.Union([
          Type.Literal("viewport"),
          Type.Literal("full-page"),
          Type.Literal("element"),
        ]),
        scrollOffset: Type.Optional(
          Type.Object({ x: Type.Number(), y: Type.Number() }, strict),
        ),
        cropInDesignUnits: Type.Optional(RectSchema),
        renderedImage: ArtifactRefSchema,
      },
      strict,
    ),
  },
  strict,
)

/**
 * Colors are compared as normalized sRGB components so that no comparison ever
 * depends on a serialization. See docs/adr/0002.
 */
export const NormalizedColorSchema = Type.Object(
  {
    r: Type.Integer({ minimum: 0, maximum: 255 }),
    g: Type.Integer({ minimum: 0, maximum: 255 }),
    b: Type.Integer({ minimum: 0, maximum: 255 }),
    alpha: Type.Number({ minimum: 0, maximum: 1 }),
  },
  strict,
)

const ColorValueSetSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    valueKind: Type.Literal("color"),
    values: Type.Array(NormalizedColorSchema, { minItems: 1 }),
  },
  strict,
)

const StringValueSetSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    valueKind: Type.Union([Type.Literal("family"), Type.Literal("keyword")]),
    values: Type.Array(Type.String(nonEmpty), { minItems: 1, uniqueItems: true }),
  },
  strict,
)

/** Expectation source for the `value-in-set` constraint kind. */
export const DesignValueSetSchema = Type.Union([
  ColorValueSetSchema,
  StringValueSetSchema,
])

export const DesignUnitSchema = Type.Union([
  Type.Literal("logical-px"),
  Type.Literal("ratio"),
  Type.Literal("unitless"),
])

/**
 * Expectation source for `value-on-scale`. Steps are explicit: an adapter that
 * knows a generative rule expands it, so the contract carries one shape and the
 * evaluator carries no generation logic.
 */
export const DesignScaleSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    unit: DesignUnitSchema,
    steps: Type.Array(Type.Number(), { minItems: 1, uniqueItems: true }),
  },
  strict,
)

/**
 * Expectation source for both `value-in-range` and `ratio`; the two differ only
 * in the unit and in how many properties the evaluator reads. A range carrying
 * neither bound is a configuration error rather than an unbounded pass.
 */
export const DesignRangeSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    unit: DesignUnitSchema,
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
  },
  strict,
)

/**
 * Normalized design facts only. Constraint selection, tolerance, and severity
 * are policy, so a producer needs no policy knowledge and two producers reading
 * different origins can emit identical token sets.
 */
export const DesignTokenSetSchema = Type.Object(
  {
    valueSets: Type.Optional(Type.Array(DesignValueSetSchema)),
    scales: Type.Optional(Type.Array(DesignScaleSchema)),
    ranges: Type.Optional(Type.Array(DesignRangeSchema)),
  },
  strict,
)

/**
 * Abstract property names. No constraint may name a CSS property, a DOM
 * concept, or a design-tool field, which is what lets one constraint run
 * against web evidence and against a view hierarchy alike. See docs/adr/0002.
 */
export const AbstractPropertySchema = Type.Union([
  Type.Literal("box.x"),
  Type.Literal("box.y"),
  Type.Literal("box.width"),
  Type.Literal("box.height"),
  Type.Literal("box.radius"),
  // Signed logical-px distance past the containing element's right edge.
  // Parent-relative rather than viewport-relative: a full-page capture's render
  // space is already inflated by the overflow it is meant to detect.
  Type.Literal("box.overflowRight"),
  Type.Literal("fill.color"),
  Type.Literal("text.color"),
  Type.Literal("stroke.color"),
  Type.Literal("text.size"),
  Type.Literal("text.weight"),
  Type.Literal("text.lineHeight"),
  Type.Literal("text.family"),
  Type.Literal("effect.shadow"),
])

const ConstraintScopeSchema = Type.Object(
  {
    visibleOnly: Type.Optional(Type.Boolean()),
    roles: Type.Optional(Type.Array(Type.String(nonEmpty), { minItems: 1 })),
  },
  strict,
)

const constraintBase = {
  id: Type.String(nonEmpty),
  scope: Type.Optional(ConstraintScopeSchema),
  /** A constraint matching nothing is invalid unless explicitly allowed. */
  requireMatch: Type.Optional(Type.Boolean()),
}

/** The five kinds from ADR 0002. A sixth requires an accepted decision. */
export const GeometryConstraintSchema = Type.Union([
  Type.Object(
    {
      ...constraintBase,
      kind: Type.Literal("value-in-set"),
      property: AbstractPropertySchema,
      valueSetRef: Type.String(nonEmpty),
    },
    strict,
  ),
  Type.Object(
    {
      ...constraintBase,
      kind: Type.Literal("value-on-scale"),
      property: AbstractPropertySchema,
      scaleRef: Type.String(nonEmpty),
      tolerance: Type.Number({ minimum: 0 }),
    },
    strict,
  ),
  Type.Object(
    {
      ...constraintBase,
      kind: Type.Literal("value-in-range"),
      property: AbstractPropertySchema,
      rangeRef: Type.String(nonEmpty),
    },
    strict,
  ),
  Type.Object(
    {
      ...constraintBase,
      kind: Type.Literal("cross-node-equal"),
      property: AbstractPropertySchema,
      tolerance: Type.Number({ minimum: 0 }),
    },
    strict,
  ),
  Type.Object(
    {
      ...constraintBase,
      kind: Type.Literal("ratio"),
      numerator: AbstractPropertySchema,
      denominator: AbstractPropertySchema,
      rangeRef: Type.String(nonEmpty),
    },
    strict,
  ),
])

/**
 * Sealed configuration for the geometry evaluator.
 *
 * The token set carries design facts and the constraints carry strictness, so
 * that a producer needs no policy knowledge. They are sealed together here
 * because binding a standalone `DesignContract` at gate time has no loading
 * path yet; see docs/limitations.md.
 */
export const GeometryEvaluatorConfigSchema = Type.Object(
  {
    tokenSet: DesignTokenSetSchema,
    constraints: Type.Array(GeometryConstraintSchema, { minItems: 1 }),
  },
  strict,
)

const DesignSourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("image"),
      artifacts: Type.Array(ArtifactRefSchema, { minItems: 1 }),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("structured"),
      producer: Type.Object(
        { id: Type.String(nonEmpty), version: Type.String(nonEmpty) },
        strict,
      ),
      artifacts: Type.Array(ArtifactRefSchema, { minItems: 1 }),
    },
    strict,
  ),
])

/**
 * Capabilities use the one forward-facing design vocabulary. Which members this
 * version can actually carry is enforced structurally rather than by a second,
 * narrower vocabulary that would drift from it. A declaration is still not
 * proof of runtime support: no evaluator consumes `tokens` yet.
 */
export const DesignContractSpecSchema = Type.Object(
  {
    capabilities: Type.Array(DesignCapabilitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    source: DesignSourceSchema,
    targets: Type.Optional(Type.Array(DesignTargetSchema, { minItems: 1 })),
    tokenSet: Type.Optional(DesignTokenSetSchema),
  },
  strict,
)
export const DesignContractSchema = contractEnvelope(
  "DesignContract",
  DesignContractSpecSchema,
)

export const FixtureRefSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    provider: Type.Union([
      Type.Literal("static"),
      Type.Literal("mock-server"),
      Type.Literal("seed-script"),
      Type.Literal("remote"),
    ]),
    configDigest: DigestSchema,
    artifact: Type.Optional(ArtifactRefSchema),
    secretRefs: Type.Optional(Type.Array(Type.String(nonEmpty), { uniqueItems: true })),
  },
  strict,
)

/** Project-relative inputs exist only in authoring and are materialized before execution. */
export const FixtureSourceSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    provider: Type.Union([
      Type.Literal("static"),
      Type.Literal("mock-server"),
      Type.Literal("seed-script"),
      Type.Literal("remote"),
    ]),
    configPath: Type.Optional(Type.String(nonEmpty)),
    artifactPath: Type.Optional(Type.String(nonEmpty)),
    mediaType: Type.Optional(Type.String(nonEmpty)),
    secretRefs: Type.Optional(Type.Array(Type.String(nonEmpty), { uniqueItems: true })),
  },
  strict,
)

export const MOCK_SERVER_FIXTURE_LIMITS = {
  maxRoutes: 32,
  maxPathLength: 2_048,
  maxBodyBytes: 65_536,
  maxArtifactBytes: 2_097_152,
} as const

const MockServerResponseStatusSchema = Type.Union([
  Type.Integer({ minimum: 200, maximum: 299 }),
  Type.Integer({ minimum: 400, maximum: 599 }),
])

export const MockServerFixtureConfigSchema = Type.Object(
  {
    apiVersion: ContractVersionSchema,
    kind: Type.Literal("MockServerFixtureConfig"),
    listen: Type.Object(
      {
        port: Type.Integer({ minimum: 1_024, maximum: 65_535 }),
      },
      strict,
    ),
    routes: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          method: Type.Union([Type.Literal("GET"), Type.Literal("HEAD")]),
          path: Type.String({
            minLength: 1,
            maxLength: MOCK_SERVER_FIXTURE_LIMITS.maxPathLength,
            pattern: "^/(?!/)[^#\\r\\n\\\\]*$",
          }),
          required: Type.Boolean(),
          response: Type.Object(
            {
              status: MockServerResponseStatusSchema,
              contentType: Type.Union([
                Type.Literal("application/json"),
                Type.Literal("text/plain"),
              ]),
              body: Type.String({
                maxLength: MOCK_SERVER_FIXTURE_LIMITS.maxBodyBytes,
              }),
            },
            strict,
          ),
        },
        strict,
      ),
      { minItems: 1, maxItems: MOCK_SERVER_FIXTURE_LIMITS.maxRoutes },
    ),
  },
  {
    ...strict,
    $id: "https://uieval.io/fixture/mock-server-config",
  },
)

export const ResolvedFixtureSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    provider: Type.Union([
      Type.Literal("static"),
      Type.Literal("mock-server"),
      Type.Literal("seed-script"),
      Type.Literal("remote"),
    ]),
    configDigest: DigestSchema,
    artifact: Type.Optional(ArtifactRefSchema),
  },
  strict,
)

export const DeterminismSchema = Type.Object(
  {
    timezone: Type.String(nonEmpty),
    clock: Type.Object(
      {
        mode: Type.Union([Type.Literal("fixed"), Type.Literal("real")]),
        value: Type.Optional(TimestampSchema),
      },
      strict,
    ),
    randomSeed: Type.Optional(Type.String(nonEmpty)),
    networkProfileRef: Type.Optional(Type.String(nonEmpty)),
  },
  strict,
)

const ScenarioSourceDeterminismSchema = Type.Object(
  {
    timezone: Type.Optional(Type.String(nonEmpty)),
    clock: Type.Union([
      Type.Object(
        { mode: Type.Literal("fixed"), value: TimestampSchema },
        strict,
      ),
      Type.Object({ mode: Type.Literal("real") }, strict),
    ]),
    randomSeed: Type.Optional(Type.String(nonEmpty)),
    networkProfileRef: Type.Optional(Type.String(nonEmpty)),
  },
  strict,
)

function assertionSchema(locator: TSchema) {
  return Type.Object(
    {
      id: Type.String(nonEmpty),
      kind: Type.Union([
        Type.Literal("visible"),
        Type.Literal("hidden"),
        Type.Literal("enabled"),
        Type.Literal("text"),
        Type.Literal("url"),
        Type.Literal("no-crash"),
      ]),
      target: Type.Optional(locator),
      expected: Type.Optional(MatrixValueSchema),
    },
    strict,
  )
}

export const WebAssertionSpecSchema = assertionSchema(WebRuntimeLocatorSchema)
export const IosAssertionSpecSchema = assertionSchema(IosRuntimeLocatorSchema)
export const AndroidAssertionSpecSchema = assertionSchema(AndroidRuntimeLocatorSchema)
export const AssertionSpecSchema = assertionSchema(RuntimeLocatorSchema)

function sharedInteractionSteps(locator: TSchema, assertion: TSchema) {
  return [
    Type.Object(
      { id: Type.String(nonEmpty), action: Type.Literal("tap"), target: locator },
      strict,
    ),
    Type.Object(
      {
        id: Type.String(nonEmpty),
        action: Type.Literal("fill"),
        target: locator,
        value: Type.String(),
      },
      strict,
    ),
    Type.Object(
      {
        id: Type.String(nonEmpty),
        action: Type.Literal("select"),
        target: locator,
        value: Type.String(),
      },
      strict,
    ),
    Type.Object(
      { id: Type.String(nonEmpty), action: Type.Literal("press"), key: Type.String(nonEmpty) },
      strict,
    ),
    Type.Object(
      {
        id: Type.String(nonEmpty),
        action: Type.Literal("waitFor"),
        target: Type.Optional(locator),
        condition: Type.Union([
          Type.Literal("visible"),
          Type.Literal("hidden"),
          Type.Literal("enabled"),
          Type.Literal("app-ready"),
        ]),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      strict,
    ),
    Type.Object(
      { id: Type.String(nonEmpty), action: Type.Literal("assert"), assertion },
      strict,
    ),
    Type.Object(
      {
        id: Type.String(nonEmpty),
        action: Type.Literal("checkpoint"),
        checkpointId: Type.String(nonEmpty),
      },
      strict,
    ),
  ]
}

export const WebScenarioStepSchema = Type.Union([
  Type.Object(
    { id: Type.String(nonEmpty), action: Type.Literal("goto"), path: Type.String({ pattern: "^/" }) },
    strict,
  ),
  ...sharedInteractionSteps(WebRuntimeLocatorSchema, WebAssertionSpecSchema),
])

function appScenarioStepSchema(locator: TSchema, assertion: TSchema) {
  return Type.Union([
    Type.Object(
      {
        id: Type.String(nonEmpty),
        action: Type.Literal("launchApp"),
        clearState: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    ...sharedInteractionSteps(locator, assertion),
  ])
}

export const IosScenarioStepSchema = appScenarioStepSchema(
  IosRuntimeLocatorSchema,
  IosAssertionSpecSchema,
)
export const AndroidScenarioStepSchema = appScenarioStepSchema(
  AndroidRuntimeLocatorSchema,
  AndroidAssertionSpecSchema,
)
export const ScenarioStepSchema = Type.Union([
  WebScenarioStepSchema,
  IosScenarioStepSchema,
  AndroidScenarioStepSchema,
])

function checkpointSchema(locator: TSchema, assertion: TSchema) {
  return Type.Object(
    {
      id: Type.String(nonEmpty),
      designTargetRef: Type.Optional(Type.String(nonEmpty)),
      requiredChannels: Type.Array(CaptureCapabilitySchema, {
        minItems: 1,
        uniqueItems: true,
      }),
      captureScope: Type.Union([
        Type.Literal("viewport"),
        Type.Literal("full-page"),
        Type.Literal("element"),
      ]),
      target: Type.Optional(locator),
      stabilize: Type.Object(
        {
          disableAnimations: Type.Boolean(),
          waitForFonts: Type.Boolean(),
          stableFrames: Type.Integer({ minimum: 1 }),
          timeoutMs: Type.Integer({ minimum: 1 }),
        },
        strict,
      ),
      assertions: Type.Optional(Type.Array(assertion)),
    },
    strict,
  )
}

export const WebCheckpointSpecSchema = checkpointSchema(
  WebRuntimeLocatorSchema,
  WebAssertionSpecSchema,
)
export const IosCheckpointSpecSchema = checkpointSchema(
  IosRuntimeLocatorSchema,
  IosAssertionSpecSchema,
)
export const AndroidCheckpointSpecSchema = checkpointSchema(
  AndroidRuntimeLocatorSchema,
  AndroidAssertionSpecSchema,
)
export const CheckpointSpecSchema = checkpointSchema(
  RuntimeLocatorSchema,
  AssertionSpecSchema,
)

const ScenarioMatrixSchema = Type.Object(
  {
    deviceProfiles: Type.Array(Type.String(nonEmpty), { minItems: 1, uniqueItems: true }),
    locales: Type.Optional(Type.Array(Type.String(nonEmpty), { minItems: 1, uniqueItems: true })),
    themes: Type.Optional(
      Type.Array(Type.Union([Type.Literal("light"), Type.Literal("dark")]), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    featureFlagSets: Type.Optional(
      Type.Array(Type.String(nonEmpty), { minItems: 1, uniqueItems: true }),
    ),
    fixtureSets: Type.Optional(
      Type.Array(Type.String(nonEmpty), { minItems: 1, uniqueItems: true }),
    ),
    exclude: Type.Optional(Type.Array(MatrixMapSchema)),
  },
  strict,
)

const ScenarioSourceAuthSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("authenticated"), Type.Literal("public-state")]),
    ),
    role: Type.Optional(Type.String(nonEmpty)),
    storageStateRef: Type.String(nonEmpty),
    secretRefs: Type.Optional(Type.Array(Type.String(nonEmpty), { uniqueItems: true })),
  },
  strict,
)

const ScenarioManifestAuthSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("authenticated"), Type.Literal("public-state")]),
    ),
    role: Type.Optional(Type.String(nonEmpty)),
    stateArtifact: Type.Optional(ArtifactRefSchema),
    secretRefs: Type.Optional(Type.Array(Type.String(nonEmpty), { uniqueItems: true })),
  },
  strict,
)

function scenarioFieldsFor(
  target: TSchema,
  step: TSchema,
  checkpoint: TSchema,
  auth: TSchema,
  determinism: TSchema,
  fixture: TSchema,
) {
  return {
    name: Type.String(nonEmpty),
    visibility: Type.Union([
      Type.Literal("agent-visible"),
      Type.Literal("holdout"),
    ]),
    tags: Type.Array(Type.String(nonEmpty), { uniqueItems: true }),
    owner: Type.Optional(Type.String(nonEmpty)),
    target,
    auth: Type.Optional(auth),
    determinism,
    requiredCapabilities: Type.Array(CaptureCapabilitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    matrix: ScenarioMatrixSchema,
    fixtures: Type.Optional(Type.Array(fixture)),
    setup: Type.Optional(Type.Array(step)),
    steps: Type.Array(step),
    cleanup: Type.Optional(Type.Array(step)),
    checkpoints: Type.Array(checkpoint, { minItems: 1 }),
  }
}

const WebScenarioTargetSchema = Type.Object(
  {
    platform: Type.Literal("web"),
    entrypoint: Type.Object(
      {
        baseUrlRef: Type.String(nonEmpty),
        path: Type.String({ pattern: "^/" }),
      },
      strict,
    ),
  },
  strict,
)
const IosScenarioTargetSchema = Type.Object(
  {
    platform: Type.Literal("ios"),
    entrypoint: Type.Object(
      {
        appId: Type.String(nonEmpty),
        deepLink: Type.Optional(Type.String(nonEmpty)),
      },
      strict,
    ),
  },
  strict,
)
const AndroidScenarioTargetSchema = Type.Object(
  {
    platform: Type.Literal("android"),
    entrypoint: Type.Object(
      {
        appId: Type.String(nonEmpty),
        deepLink: Type.Optional(Type.String(nonEmpty)),
      },
      strict,
    ),
  },
  strict,
)

function scenarioAuthoringFor(target: TSchema, step: TSchema, checkpoint: TSchema) {
  return Type.Object(
    {
      apiVersion: ContractVersionSchema,
      kind: Type.Literal("ScenarioSource"),
      $schema: Type.Optional(Type.String(nonEmpty)),
      id: Type.String(nonEmpty),
      revision: Type.Integer({ minimum: 1 }),
      ...scenarioFieldsFor(
        target,
        step,
        checkpoint,
        ScenarioSourceAuthSchema,
        ScenarioSourceDeterminismSchema,
        FixtureSourceSchema,
      ),
    },
    strict,
  )
}

function scenarioManifestSpecFor(
  target: TSchema,
  step: TSchema,
  checkpoint: TSchema,
) {
  return Type.Object(
    scenarioFieldsFor(
      target,
      step,
      checkpoint,
      ScenarioManifestAuthSchema,
      DeterminismSchema,
      FixtureRefSchema,
    ),
    strict,
  )
}

export const WebScenarioAuthoringSchema = scenarioAuthoringFor(
  WebScenarioTargetSchema,
  WebScenarioStepSchema,
  WebCheckpointSpecSchema,
)

export const IosScenarioAuthoringSchema = scenarioAuthoringFor(
  IosScenarioTargetSchema,
  IosScenarioStepSchema,
  IosCheckpointSpecSchema,
)

export const AndroidScenarioAuthoringSchema = scenarioAuthoringFor(
  AndroidScenarioTargetSchema,
  AndroidScenarioStepSchema,
  AndroidCheckpointSpecSchema,
)

export const ScenarioAuthoringSchema = Type.Union([
  WebScenarioAuthoringSchema,
  IosScenarioAuthoringSchema,
  AndroidScenarioAuthoringSchema,
])
export const ScenarioSourceSchema = ScenarioAuthoringSchema
export const ScenarioManifestSpecSchema = Type.Union([
  scenarioManifestSpecFor(
    WebScenarioTargetSchema,
    WebScenarioStepSchema,
    WebCheckpointSpecSchema,
  ),
  scenarioManifestSpecFor(
    IosScenarioTargetSchema,
    IosScenarioStepSchema,
    IosCheckpointSpecSchema,
  ),
  scenarioManifestSpecFor(
    AndroidScenarioTargetSchema,
    AndroidScenarioStepSchema,
    AndroidCheckpointSpecSchema,
  ),
])
export const ScenarioManifestSchema = contractEnvelope(
  "ScenarioManifest",
  ScenarioManifestSpecSchema,
)

const ResolvedAuthSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("authenticated"), Type.Literal("public-state")]),
    ),
    role: Type.Optional(Type.String(nonEmpty)),
    storageState: ArtifactRefSchema,
    secretRefs: Type.Optional(Type.Array(Type.String(nonEmpty), { uniqueItems: true })),
  },
  strict,
)

function resolvedScenarioFor(
  target: TSchema,
  step: TSchema,
  checkpoint: TSchema,
) {
  return Type.Object(
    {
      scenarioId: Type.String(nonEmpty),
      scenarioRevision: Type.Integer({ minimum: 1 }),
      scenarioDigest: DigestSchema,
      planDigest: DigestSchema,
      visibility: Type.Union([
        Type.Literal("agent-visible"),
        Type.Literal("holdout"),
      ]),
      target,
      variant: ResolvedVariantSchema,
      device: Type.Object(
        {
          profileId: Type.String(nonEmpty),
          renderSpace: RenderSpaceSchema,
          userAgent: Type.Optional(Type.String(nonEmpty)),
        },
        strict,
      ),
      locale: Type.String(nonEmpty),
      theme: Type.Union([Type.Literal("light"), Type.Literal("dark")]),
      determinism: DeterminismSchema,
      auth: Type.Optional(ResolvedAuthSchema),
      fixtures: Type.Array(ResolvedFixtureSchema),
      requiredCapabilities: Type.Array(CaptureCapabilitySchema, {
        minItems: 1,
        uniqueItems: true,
      }),
      fixtureDigests: Type.Array(DigestSchema, { uniqueItems: true }),
      evidenceRequestDigest: DigestSchema,
      captureConfigDigest: DigestSchema,
      setup: Type.Array(step),
      steps: Type.Array(step),
      cleanup: Type.Array(step),
      checkpoints: Type.Array(checkpoint, { minItems: 1 }),
    },
    strict,
  )
}

export const WebResolvedScenarioPlanSchema = resolvedScenarioFor(
  Type.Object(
    {
      platform: Type.Literal("web"),
      entrypoint: Type.Object(
        {
          baseUrl: Type.String({ format: "uri" }),
          path: Type.String({ pattern: "^/" }),
        },
        strict,
      ),
    },
    strict,
  ),
  WebScenarioStepSchema,
  WebCheckpointSpecSchema,
)
export const IosResolvedScenarioPlanSchema = resolvedScenarioFor(
  Type.Object(
    {
      platform: Type.Literal("ios"),
      entrypoint: Type.Object(
        {
          appId: Type.String(nonEmpty),
          deepLink: Type.Optional(Type.String(nonEmpty)),
        },
        strict,
      ),
    },
    strict,
  ),
  IosScenarioStepSchema,
  IosCheckpointSpecSchema,
)
export const AndroidResolvedScenarioPlanSchema = resolvedScenarioFor(
  Type.Object(
    {
      platform: Type.Literal("android"),
      entrypoint: Type.Object(
        {
          appId: Type.String(nonEmpty),
          deepLink: Type.Optional(Type.String(nonEmpty)),
        },
        strict,
      ),
    },
    strict,
  ),
  AndroidScenarioStepSchema,
  AndroidCheckpointSpecSchema,
)
export const ResolvedScenarioPlanSchema = Type.Union([
  WebResolvedScenarioPlanSchema,
  IosResolvedScenarioPlanSchema,
  AndroidResolvedScenarioPlanSchema,
])

export const SealedRunManifestSchema = Type.Object(
  {
    executionId: Type.String(nonEmpty),
    executionTarget: Type.Optional(ExecutionTargetSchema),
    scenarioPlanDigest: DigestSchema,
    sourceRevision: SourceRevisionSchema,
    build: BuildIdentitySchema,
    adapter: Type.Object(
      { id: Type.String(nonEmpty), version: Type.String(nonEmpty) },
      strict,
    ),
    environmentDigest: DigestSchema,
    captureKey: DigestSchema,
  },
  strict,
)

export const MetricValueSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("number"),
      value: Type.Number(),
      unit: Type.Optional(Type.String(nonEmpty)),
    },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("string"), value: Type.String() },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("boolean"), value: Type.Boolean() },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("rect"),
      value: RectSchema,
      unit: Type.String(nonEmpty),
    },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("color"), value: Type.String(nonEmpty) },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("ratio"), value: Type.Number({ minimum: 0 }) },
    strict,
  ),
])

export const ExecutionEnvironmentSchema = Type.Object(
  {
    os: Type.String(nonEmpty),
    architecture: Type.String(nonEmpty),
    rendererProfile: Type.String(nonEmpty),
    browserOrDevice: Type.String(nonEmpty),
    browserOrOsVersion: Type.String(nonEmpty),
    driverVersion: Type.String(nonEmpty),
    locale: Type.String(nonEmpty),
    timezone: Type.String(nonEmpty),
    fontSetDigest: DigestSchema,
    containerOrDeviceImageDigest: Type.Optional(DigestSchema),
    environmentDigest: DigestSchema,
  },
  strict,
)

export const EvidenceRecordSchema = Type.Object(
  {
    channel: CaptureCapabilitySchema,
    required: Type.Boolean(),
    status: Type.Union([
      Type.Literal("captured"),
      Type.Literal("missing"),
      Type.Literal("corrupt"),
      Type.Literal("not-applicable"),
    ]),
    artifact: Type.Optional(ArtifactRefSchema),
    coordinateSpace: Type.Optional(RenderSpaceSchema),
    error: Type.Optional(
      Type.Object(
        { code: Type.String(nonEmpty), message: Type.String(nonEmpty) },
        strict,
      ),
    ),
  },
  strict,
)

export const ExecutionErrorSchema = Type.Object(
  {
    origin: Type.Union([
      Type.Literal("product"),
      Type.Literal("runner"),
      Type.Literal("driver"),
      Type.Literal("fixture"),
      Type.Literal("external-service"),
    ]),
    phase: Type.Union([
      Type.Literal("prepare"),
      Type.Literal("setup"),
      Type.Literal("action"),
      Type.Literal("checkpoint"),
      Type.Literal("cleanup"),
    ]),
    code: Type.String(nonEmpty),
    message: Type.String(nonEmpty),
    retryable: Type.Boolean(),
    stepId: Type.Optional(Type.String(nonEmpty)),
    evidence: Type.Optional(Type.Array(ArtifactRefSchema)),
  },
  strict,
)

export const StepResultSchema = Type.Object(
  {
    stepId: Type.String(nonEmpty),
    status: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
      Type.Literal("not-executed"),
    ]),
    origin: Type.Union([
      Type.Literal("product"),
      Type.Literal("runner"),
      Type.Literal("driver"),
      Type.Literal("fixture"),
    ]),
    errorCode: Type.Optional(Type.String(nonEmpty)),
    evidence: Type.Optional(Type.Array(ArtifactRefSchema)),
  },
  strict,
)

export const AssertionResultSchema = Type.Object(
  {
    assertionId: Type.String(nonEmpty),
    stepId: Type.Optional(Type.String(nonEmpty)),
    checkpointId: Type.Optional(Type.String(nonEmpty)),
    status: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("not-evaluated"),
    ]),
    origin: Type.Union([
      Type.Literal("product"),
      Type.Literal("runner"),
      Type.Literal("driver"),
      Type.Literal("fixture"),
    ]),
    expected: Type.Optional(MetricValueSchema),
    actual: Type.Optional(MetricValueSchema),
    evidence: Type.Optional(Type.Array(ArtifactRefSchema)),
  },
  strict,
)

export const CapturedCheckpointSchema = Type.Object(
  {
    checkpointId: Type.String(nonEmpty),
    renderSpace: RenderSpaceSchema,
    capturedAt: TimestampSchema,
    evidence: Type.Array(EvidenceRecordSchema, { minItems: 1 }),
  },
  strict,
)

export const CaptureBundleSpecSchema = Type.Object(
  {
    executionId: Type.String(nonEmpty),
    runManifestDigest: DigestSchema,
    captureKey: DigestSchema,
    scenarioId: Type.String(nonEmpty),
    variant: ResolvedVariantSchema,
    sourceRevision: SourceRevisionSchema,
    build: BuildIdentitySchema,
    adapter: Type.Object(
      {
        id: Type.String(nonEmpty),
        version: Type.String(nonEmpty),
        platform: Type.Union([
          Type.Literal("web"),
          Type.Literal("ios"),
          Type.Literal("android"),
        ]),
      },
      strict,
    ),
    environment: ExecutionEnvironmentSchema,
    capabilities: Type.Array(CaptureCapabilitySchema, { uniqueItems: true }),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("partial"),
    ]),
    completeness: Type.Object(
      {
        expectedRequired: Type.Integer({ minimum: 0 }),
        capturedRequired: Type.Integer({ minimum: 0 }),
        missingRequired: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
    stepResults: Type.Array(StepResultSchema),
    assertionResults: Type.Array(AssertionResultSchema),
    checkpoints: Type.Array(CapturedCheckpointSchema),
    executionErrors: Type.Optional(Type.Array(ExecutionErrorSchema)),
    repeatability: Type.Optional(
      Type.Object(
        {
          attempt: Type.Integer({ minimum: 1 }),
          repeatGroupId: Type.Optional(Type.String(nonEmpty)),
        },
        strict,
      ),
    ),
  },
  strict,
)
export const CaptureBundleSchema = contractEnvelope(
  "CaptureBundle",
  CaptureBundleSpecSchema,
)

export const EvaluationPlanSchema = Type.Object(
  {
    evaluationId: Type.String(nonEmpty),
    candidate: Type.Object(
      {
        captureBundleDigest: DigestSchema,
        normalizedCandidateEvidenceDigest: DigestSchema,
      },
      strict,
    ),
    design: Type.Optional(
      Type.Object(
        {
          contractDigest: DigestSchema,
          targetIds: Type.Array(Type.String(nonEmpty), { minItems: 1, uniqueItems: true }),
        },
        strict,
      ),
    ),
    baseline: Type.Optional(
      Type.Object(
        {
          captureDigests: Type.Array(DigestSchema, { minItems: 1, uniqueItems: true }),
          environmentCompatibilityDigest: DigestSchema,
        },
        strict,
      ),
    ),
    policy: Type.Object(
      {
        policyDigest: DigestSchema,
        evaluators: Type.Array(
          Type.Object(
            {
              id: Type.String(nonEmpty),
              version: Type.String(nonEmpty),
              configRef: ArtifactRefSchema,
              configDigest: DigestSchema,
              required: Type.Boolean(),
            },
            strict,
          ),
          { minItems: 1 },
        ),
      },
      strict,
    ),
    localReference: Type.Optional(
      Type.Object(
        {
          inputDigest: DigestSchema,
          trust: Type.Literal("local-unprotected"),
          checkpointId: Type.String(nonEmpty),
          candidateArtifactDigest: Type.Optional(DigestSchema),
        },
        strict,
      ),
    ),
    evaluationKey: DigestSchema,
  },
  strict,
)

export const FindingDimensionSchema = Type.Union([
  Type.Literal("geometry"),
  Type.Literal("typography"),
  Type.Literal("color"),
  Type.Literal("border"),
  Type.Literal("shadow"),
  Type.Literal("asset"),
  Type.Literal("pixel"),
  Type.Literal("content"),
  Type.Literal("interaction"),
  Type.Literal("accessibility"),
  Type.Literal("runtime"),
  Type.Literal("network"),
  Type.Literal("performance"),
])

export const FindingSchema = Type.Object(
  {
    findingId: Type.String(nonEmpty),
    fingerprint: Type.String(nonEmpty),
    ruleId: Type.String(nonEmpty),
    ruleSemanticVersion: Type.String(nonEmpty),
    metricKey: Type.String(nonEmpty),
    evaluatorId: Type.String(nonEmpty),
    evaluatorVersion: Type.String(nonEmpty),
    comparison: Type.Union([
      Type.Literal("design-candidate"),
      Type.Literal("baseline-candidate"),
      Type.Literal("design-baseline"),
      Type.Literal("local-reference-candidate"),
      Type.Literal("runtime-contract"),
    ]),
    dimension: FindingDimensionSchema,
    severity: Type.Union([
      Type.Literal("blocker"),
      Type.Literal("critical"),
      Type.Literal("major"),
      Type.Literal("minor"),
      Type.Literal("info"),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    scenarioId: Type.String(nonEmpty),
    executionId: Type.String(nonEmpty),
    checkpointId: Type.String(nonEmpty),
    variantKey: Type.String(nonEmpty),
    contextDigest: DigestSchema,
    target: Type.Optional(
      Type.Object(
        {
          uiId: Type.Optional(Type.String(nonEmpty)),
          designNodeId: Type.Optional(Type.String(nonEmpty)),
          runtimeLocators: Type.Optional(Type.Array(RuntimeLocatorSchema)),
        },
        strict,
      ),
    ),
    measurement: Type.Optional(
      Type.Object(
        {
          expected: Type.Optional(MetricValueSchema),
          actual: Type.Optional(MetricValueSchema),
          delta: Type.Optional(MetricValueSchema),
          tolerance: Type.Optional(MetricValueSchema),
        },
        strict,
      ),
    ),
    summary: Type.String(nonEmpty),
    explanation: Type.Optional(Type.String(nonEmpty)),
    sourceHints: Type.Optional(Type.Array(SourceHintSchema)),
    evidence: Type.Array(ArtifactRefSchema),
    causalGroupId: Type.Optional(Type.String(nonEmpty)),
  },
  strict,
)

export const GateExpressionSchema = Type.Recursive(
  (Self) =>
    Type.Union([
      Type.Object(
        {
          metric: Type.String(nonEmpty),
          operator: Type.Union([
            Type.Literal("lt"),
            Type.Literal("lte"),
            Type.Literal("gt"),
            Type.Literal("gte"),
            Type.Literal("eq"),
          ]),
          value: MatrixValueSchema,
        },
        strict,
      ),
      Type.Object({ allOf: Type.Array(Self, { minItems: 1 }) }, strict),
      Type.Object({ anyOf: Type.Array(Self, { minItems: 1 }) }, strict),
      Type.Object({ not: Self }, strict),
    ]),
  { $id: "uieval-gate-expression-v1alpha1" },
)

const ToleranceSchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    priority: Type.Integer(),
    dimension: FindingDimensionSchema,
    platform: Type.Optional(
      Type.Union([
        Type.Literal("web"),
        Type.Literal("ios"),
        Type.Literal("android"),
      ]),
    ),
    variantSelector: Type.Optional(MatrixMapSchema),
    uiIdPattern: Type.Optional(Type.String(nonEmpty)),
    metric: Type.String(nonEmpty),
    value: MetricValueSchema,
  },
  strict,
)

const GatePolicySchema = Type.Object(
  {
    id: Type.String(nonEmpty),
    hard: Type.Boolean(),
    expression: GateExpressionSchema,
    onUnknown: Type.Union([
      Type.Literal("fail"),
      Type.Literal("inconclusive"),
      Type.Literal("review"),
    ]),
  },
  strict,
)

const RepeatabilityPolicySchema = Type.Object(
  {
    attempts: Type.Integer({ minimum: 1 }),
    requiredAgreement: Type.Number({ minimum: 0 }),
  },
  strict,
)

const DynamicRegionSchema = Type.Object(
  {
    scenarioId: Type.String(nonEmpty),
    checkpointId: Type.String(nonEmpty),
    target: RuntimeLocatorSchema,
    mode: Type.Union([
      Type.Literal("freeze"),
      Type.Literal("normalize"),
      Type.Literal("mask"),
    ]),
    approvalRef: Type.String(nonEmpty),
    reason: Type.String(nonEmpty),
    expiresAt: Type.Optional(TimestampSchema),
  },
  strict,
)

const AgentMutationPolicySchema = Type.Object(
  {
    allowedPathGlobs: Type.Array(Type.String(nonEmpty), { uniqueItems: true }),
    protectedPathGlobs: Type.Array(Type.String(nonEmpty), { uniqueItems: true }),
    maxChangedFiles: Type.Optional(Type.Integer({ minimum: 0 })),
    maxChangedLines: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
)

const SharedPolicyFields = {
  tolerances: Type.Array(ToleranceSchema),
  gates: Type.Array(GatePolicySchema),
  repeatability: RepeatabilityPolicySchema,
  dynamicRegions: Type.Array(DynamicRegionSchema),
  agentMutation: AgentMutationPolicySchema,
}

/** Human-authored Policy. Evaluator config is inline canonical JSON. */
export const PolicySourceSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String(nonEmpty)),
    apiVersion: ContractVersionSchema,
    kind: Type.Literal("PolicySource"),
    id: Type.String(nonEmpty),
    revision: Type.Integer({ minimum: 1 }),
    evaluators: Type.Array(
      Type.Object(
        {
          id: Type.String(nonEmpty),
          version: Type.String(nonEmpty),
          config: Type.Optional(Type.Unknown()),
          configPath: Type.Optional(Type.String(nonEmpty)),
          required: Type.Boolean(),
          weight: Type.Number({ minimum: 0 }),
        },
        strict,
      ),
      {},
    ),
    tolerances: Type.Array(
      Type.Object(
        {
          id: Type.String(nonEmpty),
          priority: Type.Integer(),
          dimension: Type.String(nonEmpty),
          platform: Type.Optional(
            Type.Union([
              Type.Literal("web"),
              Type.Literal("ios"),
              Type.Literal("android"),
            ]),
          ),
          variantSelector: Type.Optional(MatrixMapSchema),
          uiIdPattern: Type.Optional(Type.String(nonEmpty)),
          metric: Type.String(nonEmpty),
          value: Type.Unknown(),
        },
        strict,
      ),
    ),
    gates: SharedPolicyFields.gates,
    repeatability: SharedPolicyFields.repeatability,
    dynamicRegions: SharedPolicyFields.dynamicRegions,
    agentMutation: SharedPolicyFields.agentMutation,
  },
  strict,
)

export const EvaluationPolicySpecSchema = Type.Object(
  {
    evaluators: Type.Array(
      Type.Object(
        {
          id: Type.String(nonEmpty),
          version: Type.String(nonEmpty),
          configRef: ArtifactRefSchema,
          configDigest: DigestSchema,
          required: Type.Boolean(),
          weight: Type.Number({ minimum: 0 }),
        },
        strict,
      ),
      { minItems: 1 },
    ),
    ...SharedPolicyFields,
  },
  strict,
)
export const EvaluationPolicySchema = contractEnvelope(
  "EvaluationPolicy",
  EvaluationPolicySpecSchema,
)

export const CoverageCountsSchema = Type.Object(
  {
    expected: Type.Integer({ minimum: 0 }),
    evaluated: Type.Integer({ minimum: 0 }),
    passed: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    unsupported: Type.Integer({ minimum: 0 }),
    invalid: Type.Integer({ minimum: 0 }),
  },
  strict,
)

export const CoverageReportSchema = Type.Object(
  {
    total: CoverageCountsSchema,
    byDimension: Type.Array(
      Type.Object(
        {
          dimension: FindingDimensionSchema,
          counts: CoverageCountsSchema,
        },
        strict,
      ),
    ),
  },
  strict,
)

export const GateResultSchema = Type.Object(
  {
    gateId: Type.String(nonEmpty),
    hard: Type.Boolean(),
    status: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("unknown"),
    ]),
    reason: Type.String(nonEmpty),
    relatedFindingFingerprints: Type.Optional(
      Type.Array(Type.String(nonEmpty), { uniqueItems: true }),
    ),
  },
  strict,
)

export const DimensionScoreSchema = Type.Object(
  {
    dimension: FindingDimensionSchema,
    status: Type.Union([
      Type.Literal("measured"),
      Type.Literal("unknown"),
      Type.Literal("not-applicable"),
    ]),
    score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    weight: Type.Number({ minimum: 0 }),
    sampleCount: Type.Integer({ minimum: 0 }),
  },
  strict,
)

export const EvaluationReportSpecSchema = Type.Object(
  {
    evaluationKey: DigestSchema,
    inputs: Type.Object(
      {
        executionTarget: Type.Optional(ExecutionTargetSchema),
        designContractDigest: Type.Optional(DigestSchema),
        baselineCaptureDigest: Type.Optional(DigestSchema),
        localReferenceDigest: Type.Optional(DigestSchema),
        candidateCaptureDigest: DigestSchema,
        normalizedCandidateEvidenceDigest: DigestSchema,
        scenarioDigest: DigestSchema,
        policyDigest: DigestSchema,
        sourceRevision: SourceRevisionSchema,
      },
      strict,
    ),
    executionOutcome: Type.Union([
      Type.Literal("valid"),
      Type.Literal("invalid-evidence"),
      Type.Literal("infra-error"),
    ]),
    rawStatus: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("needs-review"),
      Type.Literal("inconclusive"),
    ]),
    scores: Type.Optional(Type.Array(DimensionScoreSchema)),
    // Raw evaluator measurements, including zero. Not calibrated quality scores.
    metrics: Type.Optional(Type.Record(Type.String(nonEmpty), MatrixValueSchema)),
    coverage: CoverageReportSchema,
    gates: Type.Array(GateResultSchema),
    findings: Type.Array(FindingSchema),
    repeatability: Type.Optional(
      Type.Object(
        {
          attempts: Type.Integer({ minimum: 1 }),
          requiredAgreement: Type.Number({ minimum: 0, maximum: 1 }),
          observedAgreement: Type.Number({ minimum: 0, maximum: 1 }),
          flakyFindingFingerprints: Type.Array(Type.String(nonEmpty), {
            uniqueItems: true,
          }),
        },
        strict,
      ),
    ),
    provenance: Type.Object(
      {
        deploymentVerification: Type.Optional(DeploymentVerificationSchema),
        orchestratorVersion: Type.String(nonEmpty),
        evaluators: Type.Array(
          Type.Object(
            {
              id: Type.String(nonEmpty),
              version: Type.String(nonEmpty),
              configDigest: DigestSchema,
            },
            strict,
          ),
        ),
      },
      strict,
    ),
  },
  strict,
)
export const EvaluationReportSchema = contractEnvelope(
  "EvaluationReport",
  EvaluationReportSpecSchema,
)

const RuntimeNodeIdentityFields = {
  nodeId: Type.String(nonEmpty),
  uiId: Type.Optional(Type.String(nonEmpty)),
  testId: Type.Optional(Type.String(nonEmpty)),
  role: Type.Optional(Type.String(nonEmpty)),
  accessibleName: Type.Optional(Type.String()),
}

export const ComputedStyleEvidenceSchema = Type.Object(
  {
    display: Type.Optional(Type.String()),
    position: Type.Optional(Type.String()),
    color: Type.Optional(Type.String()),
    backgroundColor: Type.Optional(Type.String()),
    borderColor: Type.Optional(Type.String()),
    borderRadius: Type.Optional(Type.String()),
    boxShadow: Type.Optional(Type.String()),
    fontFamily: Type.Optional(Type.String()),
    fontSize: Type.Optional(Type.String()),
    fontWeight: Type.Optional(Type.String()),
    lineHeight: Type.Optional(Type.String()),
  },
  strict,
)

export const RuntimeNodeEvidenceSchema = Type.Object(
  {
    ...RuntimeNodeIdentityFields,
    parentNodeId: Type.Optional(Type.String(nonEmpty)),
    tagName: Type.String(nonEmpty),
    text: Type.Optional(Type.String()),
    visible: Type.Boolean(),
    enabled: Type.Optional(Type.Boolean()),
    rect: RectSchema,
    computedStyle: Type.Optional(ComputedStyleEvidenceSchema),
  },
  strict,
)

export const DomEvidencePayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal("uieval.dom/v1alpha1"),
    url: Type.String({ format: "uri" }),
    title: Type.String(),
    nodes: Type.Array(RuntimeNodeEvidenceSchema),
  },
  strict,
)

export const LayoutEvidencePayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal("uieval.layout/v1alpha1"),
    renderSpace: RenderSpaceSchema,
    nodes: Type.Array(
      Type.Object(
        {
          ...RuntimeNodeIdentityFields,
          parentNodeId: Type.Optional(Type.String(nonEmpty)),
          rect: RectSchema,
          visible: Type.Boolean(),
        },
        strict,
      ),
    ),
  },
  strict,
)

export const StylesEvidencePayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal("uieval.styles/v1alpha1"),
    nodes: Type.Array(
      Type.Object(
        {
          ...RuntimeNodeIdentityFields,
          computedStyle: ComputedStyleEvidenceSchema,
        },
        strict,
      ),
    ),
  },
  strict,
)

const EvidenceCollectionStatsSchema = Type.Object(
  {
    capturedCount: Type.Integer({ minimum: 0 }),
    droppedCount: Type.Integer({ minimum: 0 }),
    truncatedCount: Type.Integer({ minimum: 0 }),
    limitReason: Type.Optional(
      Type.String({
        ...nonEmpty,
        pattern:
          "^(entry-count|per-entry-bytes|total-bytes)(,(entry-count|per-entry-bytes|total-bytes))*$",
      }),
    ),
  },
  strict,
)

export const ConsoleEvidencePayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal("uieval.console/v1alpha1"),
    collection: EvidenceCollectionStatsSchema,
    entries: Type.Array(
      Type.Object(
        {
          level: Type.Union([
            Type.Literal("debug"),
            Type.Literal("info"),
            Type.Literal("log"),
            Type.Literal("warning"),
            Type.Literal("error"),
          ]),
          text: Type.String(),
          url: Type.Optional(Type.String()),
        },
        strict,
      ),
    ),
  },
  strict,
)

export const NetworkEvidencePayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal("uieval.network/v1alpha1"),
    collection: EvidenceCollectionStatsSchema,
    entries: Type.Array(
      Type.Object(
        {
          url: Type.String({ format: "uri" }),
          method: Type.String(nonEmpty),
          status: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
          resourceType: Type.Optional(Type.String(nonEmpty)),
          sameOrigin: Type.Boolean(),
          failureText: Type.Optional(Type.String()),
        },
        strict,
      ),
    ),
  },
  strict,
)

export const EvidencePayloadSchema = Type.Union([
  DomEvidencePayloadSchema,
  LayoutEvidencePayloadSchema,
  StylesEvidencePayloadSchema,
  ConsoleEvidencePayloadSchema,
  NetworkEvidencePayloadSchema,
])
