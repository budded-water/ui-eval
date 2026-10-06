import { describe, expect, it } from "vitest"

import {
  canonicalDigest,
  DigestExclusionProfiles,
} from "./canonical-json"

import {
  ContractValidationError,
  validateArtifactRef,
  validateCaptureBundle,
  validateConsoleEvidencePayload,
  validateDesignContract,
  validateDomEvidencePayload,
  validateEvaluationPlan,
  validateEvaluationPolicy,
  validateEvaluationReport,
  validateFinding,
  validateLayoutEvidencePayload,
  validateMockServerFixtureConfig,
  validateNetworkEvidencePayload,
  validatePolicySource,
  validateResolvedScenarioPlan,
  validateScenarioManifest,
  validateScenarioSource,
  validateSealedRunManifest,
  validateStylesEvidencePayload,
} from "./validation"

const digest = (character: string) => `sha256:${character.repeat(64)}`

const artifact = {
  id: "artifact-1",
  projectId: "project-1",
  storeId: "local",
  digest: digest("a"),
  mediaType: "application/json",
  sizeBytes: 42,
  sensitivity: "internal",
}

const metadata = {
  id: "contract-1",
  projectId: "project-1",
  revision: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  createdBy: { type: "ci", id: "ci-1" },
  specDigest: digest("b"),
}

const renderSpace = {
  logicalWidth: 1440,
  logicalHeight: 900,
  logicalUnit: "css-px",
  deviceScaleFactor: 1,
  screenshotWidthPx: 1440,
  screenshotHeightPx: 900,
  orientation: "landscape",
}

const checkpoint = {
  id: "ready",
  requiredChannels: [
    "screenshot",
    "dom",
    "layout-metadata",
    "computed-styles",
    "console",
    "network",
  ],
  captureScope: "viewport",
  stabilize: {
    disableAnimations: true,
    waitForFonts: true,
    stableFrames: 2,
    timeoutMs: 5_000,
  },
}

const scenarioSource = {
  apiVersion: "uieval.io/v1alpha1",
  kind: "ScenarioSource",
  id: "terms-desktop",
  revision: 1,
  name: "Terms desktop",
  visibility: "agent-visible",
  tags: ["pilot"],
  target: {
    platform: "web",
    entrypoint: { baseUrlRef: "local", path: "/terms" },
  },
  auth: { storageStateRef: "market-selected" },
  determinism: {
    timezone: "UTC",
    clock: { mode: "fixed", value: "2026-08-10T00:00:00.000Z" },
    randomSeed: "pilot-seed",
  },
  requiredCapabilities: checkpoint.requiredChannels,
  matrix: {
    deviceProfiles: ["desktop"],
    locales: ["en"],
    themes: ["light"],
  },
  setup: [],
  steps: [
    { id: "goto", action: "goto", path: "/terms" },
    { id: "capture", action: "checkpoint", checkpointId: "ready" },
  ],
  cleanup: [],
  checkpoints: [checkpoint],
}

const resolvedScenario = {
  scenarioId: "terms-desktop",
  scenarioRevision: 1,
  scenarioDigest: digest("c"),
  planDigest: digest("d"),
  visibility: "agent-visible",
  target: {
    platform: "web",
    entrypoint: { baseUrl: "http://127.0.0.1:3000", path: "/terms" },
  },
  variant: {
    variantKey: "desktop--en--light",
    values: { device: "desktop", locale: "en", theme: "light" },
    contextDigest: digest("e"),
  },
  device: { profileId: "desktop", renderSpace },
  locale: "en",
  theme: "light",
  determinism: scenarioSource.determinism,
  auth: { storageState: artifact },
  fixtures: [],
  requiredCapabilities: checkpoint.requiredChannels,
  fixtureDigests: [],
  evidenceRequestDigest: digest("f"),
  captureConfigDigest: digest("0"),
  setup: [],
  steps: scenarioSource.steps,
  cleanup: [],
  checkpoints: [checkpoint],
}
resolvedScenario.planDigest = canonicalDigest(resolvedScenario, {
  exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
})

const sourceRevision = {
  repository: "example-project",
  commitSha: "abcdef123456",
  dirtyTree: true,
  diffDigest: digest("1"),
}

const build = {
  platform: "web",
  artifactDigest: digest("2"),
  buildConfigDigest: digest("3"),
  publicEnvironmentDigest: digest("4"),
}

const policySource = {
  apiVersion: "uieval.io/v1alpha1",
  kind: "PolicySource",
  id: "default",
  revision: 1,
  evaluators: [
    {
      id: "execution",
      version: "1.0.0",
      config: {},
      required: true,
      weight: 1,
    },
  ],
  tolerances: [],
  gates: [
    {
      id: "execution-pass",
      hard: true,
      expression: { metric: "execution.failed", operator: "eq", value: 0 },
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

const finding = {
  findingId: "finding-1",
  fingerprint: "fingerprint-1",
  ruleId: "assertion.failed",
  ruleSemanticVersion: "1.0.0",
  metricKey: "interaction.failed",
  evaluatorId: "interaction",
  evaluatorVersion: "1.0.0",
  comparison: "runtime-contract",
  dimension: "interaction",
  severity: "critical",
  confidence: 1,
  scenarioId: "terms-desktop",
  executionId: "execution-1",
  checkpointId: "ready",
  variantKey: "desktop--en--light",
  contextDigest: digest("e"),
  measurement: {
    expected: { kind: "boolean", value: true },
    actual: { kind: "boolean", value: false },
  },
  summary: "Assertion failed",
  evidence: [artifact],
}

describe("Phase 0A contracts", () => {
  it("validates and round-trips the sealed contract chain", () => {
    expect(validateArtifactRef(artifact)).toEqual(artifact)

    const designContract = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "DesignContract",
      metadata,
      spec: {
        capabilities: ["rendered-image"],
        source: { kind: "image", artifacts: [artifact] },
        targets: [
          {
            id: "terms",
            name: "Terms",
            checkpointRef: "ready",
            frame: {
              renderSpace,
              captureScope: "viewport",
              renderedImage: { ...artifact, mediaType: "image/png" },
            },
          },
        ],
      },
    }
    designContract.metadata = {
      ...metadata,
      specDigest: canonicalDigest(designContract.spec),
    }
    expect(validateDesignContract(designContract)).toEqual(designContract)
    expect(validateScenarioSource(scenarioSource)).toEqual(scenarioSource)

    const manifestSpec: Partial<typeof scenarioSource> = { ...scenarioSource }
    delete manifestSpec.apiVersion
    delete manifestSpec.kind
    delete manifestSpec.id
    delete manifestSpec.revision
    const scenarioManifest = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "ScenarioManifest",
      metadata,
      spec: {
        ...manifestSpec,
        auth: { stateArtifact: artifact },
      },
    }
    scenarioManifest.metadata = {
      ...metadata,
      specDigest: canonicalDigest(scenarioManifest.spec),
    }
    expect(validateScenarioManifest(scenarioManifest)).toEqual(scenarioManifest)
    expect(validateResolvedScenarioPlan(resolvedScenario)).toEqual(resolvedScenario)

    const runManifest = {
      executionId: "execution-1",
      scenarioPlanDigest: resolvedScenario.planDigest,
      sourceRevision,
      build,
      adapter: { id: "playwright", version: "1.62.1" },
      environmentDigest: digest("5"),
      captureKey: digest("6"),
    }
    runManifest.captureKey = canonicalDigest(runManifest, {
      exclusions: DigestExclusionProfiles.sealedRunManifest,
    })
    expect(validateSealedRunManifest(runManifest)).toEqual(runManifest)
    const remoteManifest = { ...runManifest, executionTarget: { profileId: "preview", mode: "remote",
      baseUrl: "https://preview.example.invalid/", frontendIdentityUrl: "https://preview.example.invalid/version",
      frontend: { revision: sourceRevision.commitSha },
    } }
    remoteManifest.captureKey = canonicalDigest(remoteManifest, { exclusions: DigestExclusionProfiles.sealedRunManifest })
    expect(validateSealedRunManifest(remoteManifest)).toEqual(remoteManifest)
    const alteredTarget = structuredClone(remoteManifest)
    alteredTarget.executionTarget.frontend.revision = "other"
    expect(() => validateSealedRunManifest(alteredTarget)).toThrow(/captureKey/)
    alteredTarget.captureKey = canonicalDigest(alteredTarget, { exclusions: DigestExclusionProfiles.sealedRunManifest })
    expect(() => validateSealedRunManifest(alteredTarget)).toThrow(/checked-out revision/)

    const capturedEvidence = checkpoint.requiredChannels.map((channel, index) => ({
      channel,
      required: true,
      status: "captured",
      artifact: { ...artifact, id: `evidence-${index}` },
    }))
    const captureBundle = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "CaptureBundle",
      metadata,
      spec: {
        executionId: runManifest.executionId,
        runManifestDigest: digest("7"),
        captureKey: runManifest.captureKey,
        scenarioId: "terms-desktop",
        variant: resolvedScenario.variant,
        sourceRevision,
        build,
        adapter: { id: "playwright", version: "1.62.1", platform: "web" },
        environment: {
          os: "darwin",
          architecture: "arm64",
          rendererProfile: "chromium-headless",
          browserOrDevice: "chromium",
          browserOrOsVersion: "140",
          driverVersion: "1.62.1",
          locale: "en",
          timezone: "UTC",
          fontSetDigest: digest("8"),
          environmentDigest: digest("5"),
        },
        capabilities: checkpoint.requiredChannels,
        status: "completed",
        completeness: {
          expectedRequired: capturedEvidence.length,
          capturedRequired: capturedEvidence.length,
          missingRequired: 0,
        },
        stepResults: [
          { stepId: "goto", status: "passed", origin: "product" },
          { stepId: "capture", status: "passed", origin: "product" },
        ],
        assertionResults: [],
        checkpoints: [
          {
            checkpointId: "ready",
            renderSpace,
            capturedAt: "2026-08-10T00:00:00.000Z",
            evidence: capturedEvidence,
          },
        ],
      },
    }
    captureBundle.metadata = {
      ...metadata,
      specDigest: canonicalDigest(captureBundle.spec),
    }
    expect(validateCaptureBundle(captureBundle)).toEqual(captureBundle)

    const completedWithRunnerError = structuredClone(captureBundle)
    Object.assign(completedWithRunnerError.spec, {
      executionErrors: [
        {
          origin: "runner",
          phase: "checkpoint",
          code: "auth-cross-origin-egress-blocked",
          message: "Authenticated cross-origin egress was blocked",
          retryable: false,
        },
      ],
    })
    completedWithRunnerError.metadata.specDigest = canonicalDigest(
      completedWithRunnerError.spec,
    )
    expect(() => validateCaptureBundle(completedWithRunnerError)).toThrow(
      /completed capture cannot contain infrastructure or security-boundary errors/,
    )

    const materializedEvaluator = {
      id: "execution",
      version: "1.0.0",
      configRef: artifact,
      configDigest: artifact.digest,
      required: true,
      weight: 1,
    }
    const evaluationPolicy = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "EvaluationPolicy",
      metadata,
      spec: {
        ...policySource,
        evaluators: [materializedEvaluator],
      },
    }
    delete (evaluationPolicy.spec as Record<string, unknown>).apiVersion
    delete (evaluationPolicy.spec as Record<string, unknown>).kind
    delete (evaluationPolicy.spec as Record<string, unknown>).id
    delete (evaluationPolicy.spec as Record<string, unknown>).revision
    evaluationPolicy.metadata = {
      ...metadata,
      specDigest: canonicalDigest(evaluationPolicy.spec),
    }
    expect(validatePolicySource(policySource)).toEqual(policySource)
    expect(validateEvaluationPolicy(evaluationPolicy)).toEqual(evaluationPolicy)

    const evaluationPlan = {
      evaluationId: "evaluation-1",
      candidate: {
        captureBundleDigest: digest("9"),
        normalizedCandidateEvidenceDigest: digest("a"),
      },
      design: { contractDigest: digest("b"), targetIds: ["terms"] },
      policy: {
        policyDigest: digest("c"),
        evaluators: [
          {
            id: materializedEvaluator.id,
            version: materializedEvaluator.version,
            configRef: materializedEvaluator.configRef,
            configDigest: materializedEvaluator.configDigest,
            required: materializedEvaluator.required,
          },
        ],
      },
      evaluationKey: digest("d"),
    }
    evaluationPlan.evaluationKey = canonicalDigest(evaluationPlan, {
      exclusions: DigestExclusionProfiles.evaluationPlan,
    })
    expect(validateEvaluationPlan(evaluationPlan)).toEqual(evaluationPlan)
    expect(validateFinding(finding)).toEqual(finding)

    const counts = {
      expected: 1,
      evaluated: 1,
      passed: 0,
      failed: 1,
      unsupported: 0,
      invalid: 0,
    }
    const report = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "EvaluationReport",
      metadata,
      spec: {
        evaluationKey: evaluationPlan.evaluationKey,
        inputs: {
          designContractDigest: digest("b"),
          candidateCaptureDigest: digest("9"),
          normalizedCandidateEvidenceDigest: digest("a"),
          scenarioDigest: resolvedScenario.scenarioDigest,
          policyDigest: digest("c"),
          sourceRevision,
        },
        executionOutcome: "valid",
        rawStatus: "fail",
        coverage: {
          total: counts,
          byDimension: [{ dimension: "interaction", counts }],
        },
        gates: [
          {
            gateId: "execution-pass",
            hard: true,
            status: "fail",
            reason: "interaction.failed is 1",
            relatedFindingFingerprints: [finding.fingerprint],
          },
        ],
        findings: [finding],
        provenance: {
          orchestratorVersion: "0.1.0",
          evaluators: [
            { id: "execution", version: "1.0.0", configDigest: artifact.digest },
          ],
        },
      },
    }
    report.metadata = {
      ...metadata,
      specDigest: canonicalDigest(report.spec),
    }
    const roundTripped = JSON.parse(JSON.stringify(report))
    expect(validateEvaluationReport(roundTripped)).toEqual(report)

    const remote = { ...report, spec: { ...report.spec,
      inputs: { ...report.spec.inputs, sourceRevision: { ...sourceRevision, dirtyTree: false }, executionTarget: {
        profileId: "preview", mode: "remote", baseUrl: "https://preview.example.invalid/", frontendIdentityUrl: "https://preview.example.invalid/version",
        frontend: { revision: sourceRevision.commitSha }, backend: { revision: "api-v2" }, backendIdentityUrl: "https://api.example.invalid/version",
      } },
      provenance: { ...report.spec.provenance, deploymentVerification: { status: "verified",
        frontend: { schemaVersion: "uieval.deployment/v1alpha1", revision: sourceRevision.commitSha },
        backend: { schemaVersion: "uieval.deployment/v1alpha1", revision: "api-v2" },
      } },
    } }
    remote.metadata = { ...metadata, specDigest: canonicalDigest(remote.spec) }
    expect(validateEvaluationReport(JSON.parse(JSON.stringify(remote)))).toEqual(remote)
    for (const mutate of [
      (copy: typeof remote) => { copy.spec.provenance.deploymentVerification.status = "unverified" },
      (copy: typeof remote) => { copy.spec.provenance.deploymentVerification.backend.revision = "other" },
      (copy: typeof remote) => { copy.spec.inputs.executionTarget.frontend.revision = "other" },
      (copy: typeof remote) => { copy.spec.inputs.sourceRevision.dirtyTree = true },
      (copy: typeof remote) => { copy.spec.inputs.executionTarget.backendIdentityUrl = "" },
    ]) {
      const copy = structuredClone(remote)
      mutate(copy)
      copy.metadata.specDigest = canonicalDigest(copy.spec)
      expect(() => validateEvaluationReport(copy)).toThrow()
    }

    const measuredReport = { ...report, spec: { ...report.spec, metrics: { "visual.changedPixelRatio": 0 } } }
    measuredReport.metadata = { ...metadata, specDigest: canonicalDigest(measuredReport.spec) }
    expect(validateEvaluationReport(JSON.parse(JSON.stringify(measuredReport)))).toEqual(measuredReport)
    const alteredMetric = structuredClone(measuredReport)
    alteredMetric.spec.metrics["visual.changedPixelRatio"] = 0.1
    expect(() => validateEvaluationReport(alteredMetric)).toThrow(/specDigest/)
    const invalidMetric = structuredClone(measuredReport)
    invalidMetric.spec.metrics["visual.changedPixelRatio"] = 2
    invalidMetric.metadata.specDigest = canonicalDigest(invalidMetric.spec)
    expect(() => validateEvaluationReport(invalidMetric)).toThrow(/finite ratio/)

    const invalidEvidencePass = structuredClone(report)
    invalidEvidencePass.spec.executionOutcome = "infra-error"
    invalidEvidencePass.spec.rawStatus = "pass"
    invalidEvidencePass.metadata.specDigest = canonicalDigest(
      invalidEvidencePass.spec,
    )
    expect(() => validateEvaluationReport(invalidEvidencePass)).toThrow(
      /inconclusive raw status/,
    )

    const failedGatePass = structuredClone(report)
    failedGatePass.spec.rawStatus = "pass"
    failedGatePass.metadata.specDigest = canonicalDigest(failedGatePass.spec)
    expect(() => validateEvaluationReport(failedGatePass)).toThrow(
      /cannot contain failed or unknown policy gates/,
    )
  }, 10_000)

  it("validates versioned DOM, layout, style, console, and network payloads", () => {
    const node = {
      nodeId: "node-1",
      uiId: "terms.heading",
      tagName: "h1",
      text: "Terms",
      visible: true,
      rect: { x: 20, y: 20, width: 400, height: 48 },
      computedStyle: { display: "block", fontSize: "40px" },
    }
    expect(
      validateDomEvidencePayload({
        schemaVersion: "uieval.dom/v1alpha1",
        url: "http://127.0.0.1:3000/terms",
        title: "Terms",
        nodes: [node],
      }).nodes,
    ).toEqual([node])
    expect(
      validateLayoutEvidencePayload({
        schemaVersion: "uieval.layout/v1alpha1",
        renderSpace,
        nodes: [
          {
            nodeId: node.nodeId,
            uiId: node.uiId,
            rect: node.rect,
            visible: true,
          },
        ],
      }).nodes,
    ).toHaveLength(1)
    expect(
      validateStylesEvidencePayload({
        schemaVersion: "uieval.styles/v1alpha1",
        nodes: [
          {
            nodeId: node.nodeId,
            uiId: node.uiId,
            computedStyle: node.computedStyle,
          },
        ],
      }).nodes,
    ).toHaveLength(1)
    expect(
      validateConsoleEvidencePayload({
        schemaVersion: "uieval.console/v1alpha1",
        collection: {
          capturedCount: 1,
          droppedCount: 0,
          truncatedCount: 0,
        },
        entries: [{ level: "error", text: "boom", url: "app.js" }],
      }).entries,
    ).toHaveLength(1)
    expect(
      validateNetworkEvidencePayload({
        schemaVersion: "uieval.network/v1alpha1",
        collection: {
          capturedCount: 1,
          droppedCount: 0,
          truncatedCount: 0,
        },
        entries: [
          {
            url: "http://127.0.0.1:3000/api/terms",
            method: "GET",
            status: 500,
            sameOrigin: true,
          },
        ],
      }).entries,
    ).toHaveLength(1)
  })

  it("rejects dishonest runtime evidence collection metadata", () => {
    expect(() =>
      validateConsoleEvidencePayload({
        schemaVersion: "uieval.console/v1alpha1",
        collection: {
          capturedCount: 0,
          droppedCount: 1,
          truncatedCount: 1,
        },
        entries: [{ level: "error", text: "retained" }],
      }),
    ).toThrow(ContractValidationError)

    expect(() =>
      validateNetworkEvidencePayload({
        schemaVersion: "uieval.network/v1alpha1",
        collection: {
          capturedCount: 1,
          droppedCount: 0,
          truncatedCount: 0,
          limitReason: "entry-count",
        },
        entries: [
          {
            url: "http://127.0.0.1:3000/api/terms",
            method: "GET",
            status: 200,
            sameOrigin: true,
          },
        ],
      }),
    ).toThrow(ContractValidationError)
  })

  it("rejects malformed values and arbitrary physical artifact paths", () => {
    expect(() =>
      validateArtifactRef({ ...artifact, path: "/tmp/evidence.json" }),
    ).toThrow(ContractValidationError)
    expect(() => validateArtifactRef({ ...artifact, digest: "sha256:nope" })).toThrow(
      ContractValidationError,
    )
  })

  it("rejects tampered sealed digests and envelope spec digests", () => {
    expect(() =>
      validateResolvedScenarioPlan({
        ...resolvedScenario,
        locale: "zh-CN",
      }),
    ).toThrow(/planDigest does not match/)

    const spec = {
      evaluators: [
        {
          id: "execution",
          version: "1.0.0",
          configRef: artifact,
          configDigest: artifact.digest,
          required: true,
          weight: 1,
        },
      ],
      tolerances: [],
      gates: [policySource.gates[0]],
      repeatability: policySource.repeatability,
      dynamicRegions: [],
      agentMutation: policySource.agentMutation,
    }
    expect(() =>
      validateEvaluationPolicy({
        apiVersion: "uieval.io/v1alpha1",
        kind: "EvaluationPolicy",
        metadata,
        spec,
      }),
    ).toThrow(/metadata.specDigest does not match/)
  })

  it("rejects a cross-platform locator in a Web scenario", () => {
    const invalid = structuredClone(scenarioSource)
    invalid.steps.splice(1, 0, {
      id: "invalid-tap",
      action: "tap",
      target: {
        platform: "ios",
        by: "accessibilityId",
        value: "continue",
      },
    } as never)

    expect(() => validateScenarioSource(invalid)).toThrow(ContractValidationError)

    const invalidResolved = structuredClone(resolvedScenario)
    invalidResolved.steps.splice(1, 0, {
      id: "invalid-tap",
      action: "tap",
      target: {
        platform: "android",
        by: "accessibilityId",
        value: "continue",
      },
    } as never)
    expect(() => validateResolvedScenarioPlan(invalidResolved)).toThrow(
      ContractValidationError,
    )
  })

  it("rejects duplicate gate IDs in source and materialized policies", () => {
    const duplicatedSource = structuredClone(policySource)
    duplicatedSource.gates.push({ ...duplicatedSource.gates[0] })
    expect(() => validatePolicySource(duplicatedSource)).toThrow(/duplicates index 0/)

    const materialized = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "EvaluationPolicy",
      metadata,
      spec: {
        evaluators: [
          {
            id: "execution",
            version: "1.0.0",
            configRef: artifact,
            configDigest: artifact.digest,
            required: true,
            weight: 1,
          },
        ],
        tolerances: [],
        gates: [policySource.gates[0], { ...policySource.gates[0] }],
        repeatability: policySource.repeatability,
        dynamicRegions: [],
        agentMutation: policySource.agentMutation,
      },
    }
    expect(() => validateEvaluationPolicy(materialized)).toThrow(/duplicates index 0/)
  })
})

describe("design contract token sets", () => {
  const sealed = (spec: unknown) => ({
    apiVersion: "uieval.io/v1alpha1",
    kind: "DesignContract",
    metadata: { ...metadata, specDigest: canonicalDigest(spec) },
    spec,
  })

  const tokenSpec = {
    capabilities: ["tokens"],
    source: {
      kind: "structured",
      producer: { id: "tailwind-theme", version: "0.1.0" },
      artifacts: [artifact],
    },
    tokenSet: {
      valueSets: [
        {
          id: "brand-palette",
          valueKind: "color",
          values: [{ r: 46, g: 139, b: 87, alpha: 1 }],
        },
        { id: "approved-families", valueKind: "family", values: ["inter"] },
      ],
      scales: [{ id: "spacing", unit: "logical-px", steps: [0, 4, 8, 12] }],
      ranges: [{ id: "touch-target", unit: "logical-px", min: 44 }],
    },
  }

  it("accepts a token-only contract with no design targets", () => {
    const contract = sealed(tokenSpec)
    expect(validateDesignContract(contract)).toEqual(contract)
  })

  it("rejects a declared capability that carries no payload", () => {
    const spec = { ...tokenSpec }
    delete (spec as { tokenSet?: unknown }).tokenSet
    expect(() => validateDesignContract(sealed(spec))).toThrow(
      /requires 'tokenSet'/,
    )
  })

  it("rejects a payload whose capability was never declared", () => {
    expect(() =>
      validateDesignContract(sealed({ ...tokenSpec, capabilities: ["rendered-image"] })),
    ).toThrow(/requires capability 'tokens'/)
  })

  it("rejects a capability this contract version cannot carry", () => {
    expect(() =>
      validateDesignContract(
        sealed({ ...tokenSpec, capabilities: ["tokens", "node-tree"] }),
      ),
    ).toThrow(/no payload in this contract version/)
  })

  it("rejects a range that bounds nothing", () => {
    const spec = {
      ...tokenSpec,
      tokenSet: {
        ...tokenSpec.tokenSet,
        ranges: [{ id: "touch-target", unit: "logical-px" }],
      },
    }
    expect(() => validateDesignContract(sealed(spec))).toThrow(
      /declares neither min nor max/,
    )
  })

  it("rejects an inverted range", () => {
    const spec = {
      ...tokenSpec,
      tokenSet: {
        ...tokenSpec.tokenSet,
        ranges: [{ id: "line-height", unit: "ratio", min: 1.8, max: 1.2 }],
      },
    }
    expect(() => validateDesignContract(sealed(spec))).toThrow(
      /min greater than max/,
    )
  })

  it("rejects duplicate token identifiers", () => {
    const spec = {
      ...tokenSpec,
      tokenSet: {
        ...tokenSpec.tokenSet,
        scales: [
          { id: "spacing", unit: "logical-px", steps: [0, 4] },
          { id: "spacing", unit: "logical-px", steps: [0, 8] },
        ],
      },
    }
    expect(() => validateDesignContract(sealed(spec))).toThrow(/duplicates index 0/)
  })
})

describe("mock server fixture config", () => {
  const config = {
    apiVersion: "uieval.io/v1alpha1",
    kind: "MockServerFixtureConfig",
    listen: { port: 18_001 },
    routes: [
      {
        id: "catalog",
        method: "GET",
        path: "/api/catalog?market=cn",
        required: true,
        response: {
          status: 200,
          contentType: "application/json",
          body: "[]",
        },
      },
    ],
  }

  it("accepts bounded exact loopback routes", () => {
    expect(validateMockServerFixtureConfig(structuredClone(config))).toEqual(config)
  })

  it("rejects duplicate request matches even when route ids differ", () => {
    const duplicate = structuredClone(config)
    duplicate.routes.push({ ...duplicate.routes[0], id: "catalog-copy" })
    expect(() => validateMockServerFixtureConfig(duplicate)).toThrow(
      /duplicates index 0/,
    )
  })

  it("rejects invalid JSON response bodies", () => {
    const invalid = structuredClone(config)
    invalid.routes[0].response.body = "{"
    expect(() => validateMockServerFixtureConfig(invalid)).toThrow(
      /must contain valid JSON/,
    )
  })

  it("rejects redirects and non-loopback listen configuration", () => {
    const redirect = structuredClone(config) as Record<string, unknown>
    ;(
      (redirect.routes as Array<{ response: { status: number } }>)[0]
        .response
    ).status = 302
    expect(() => validateMockServerFixtureConfig(redirect)).toThrow()
    expect(() =>
      validateMockServerFixtureConfig({
        ...config,
        listen: { host: "0.0.0.0", port: 18_001 },
      }),
    ).toThrow()
  })
})
