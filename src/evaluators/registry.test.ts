import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  canonicalDigest,
  canonicalJson,
} from "../contracts/canonical-json"
import type {
  ArtifactRef,
  EvaluationPolicy,
} from "../contracts/model"
import {
  EvaluatorRegistryError,
  loadPhase0AEvaluatorRegistry,
  type EvaluatorArtifactResolver,
} from "./registry"

type PolicyEvaluator = EvaluationPolicy["spec"]["evaluators"][number]

class MemoryArtifactResolver implements EvaluatorArtifactResolver {
  private readonly artifacts = new Map<string, Uint8Array>()

  put(value: unknown, options: { store?: boolean } = {}): ArtifactRef {
    return this.putBytes(Buffer.from(canonicalJson(value), "utf8"), options)
  }

  putBytes(
    bytes: Uint8Array,
    options: { store?: boolean } = {},
  ): ArtifactRef {
    const digest = sha256(bytes)
    if (options.store !== false) this.artifacts.set(digest, bytes)
    return {
      id: digest,
      projectId: "registry-test",
      storeId: "policy-configs",
      digest,
      mediaType: "application/json",
      sizeBytes: bytes.byteLength,
      sensitivity: "internal",
    }
  }

  replace(ref: ArtifactRef, bytes: Uint8Array): void {
    this.artifacts.set(ref.digest, bytes)
  }

  async resolve(ref: ArtifactRef): Promise<Uint8Array> {
    const bytes = this.artifacts.get(ref.digest)
    if (!bytes) throw new Error(`artifact ${ref.digest} is missing`)
    return bytes
  }
}

function evaluator(
  resolver: MemoryArtifactResolver,
  id: string,
  config: unknown,
  overrides: Partial<Pick<PolicyEvaluator, "version" | "required">> = {},
): PolicyEvaluator {
  const configRef = resolver.put(config)
  return {
    id,
    version: overrides.version ?? "0.1.0",
    configRef,
    configDigest: configRef.digest,
    required: overrides.required ?? true,
    weight: 0,
  }
}

function requiredCoreEvaluators(
  resolver: MemoryArtifactResolver,
): PolicyEvaluator[] {
  return [
    evaluator(resolver, "execution", {}),
    evaluator(resolver, "interaction", {}),
    evaluator(resolver, "runtime", {
      sameOrigin5xxIsCritical: true,
      consoleErrorIsAdvisory: true,
    }),
  ]
}

function defaultEvaluators(
  resolver: MemoryArtifactResolver,
  visualRequired = false,
): PolicyEvaluator[] {
  return [
    ...requiredCoreEvaluators(resolver),
    evaluator(
      resolver,
      "visual",
      { mode: "advisory" },
      { required: visualRequired },
    ),
  ]
}

function replaceEvaluator(
  evaluators: PolicyEvaluator[],
  replacement: PolicyEvaluator,
): PolicyEvaluator[] {
  return evaluators.map((entry) =>
    entry.id === replacement.id ? replacement : entry,
  )
}

function requiredCoreGates(): EvaluationPolicy["spec"]["gates"] {
  return [
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
  ]
}

function policy(
  evaluators: PolicyEvaluator[],
  overrides: {
    gates?: EvaluationPolicy["spec"]["gates"]
    attempts?: number
    specDigest?: ArtifactRef["digest"]
  } = {},
): EvaluationPolicy {
  const spec: EvaluationPolicy["spec"] = {
    evaluators,
    tolerances: [],
    gates: overrides.gates ?? requiredCoreGates(),
    repeatability: {
      attempts: overrides.attempts ?? 1,
      requiredAgreement: 1,
    },
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
      id: "phase-0a-default",
      projectId: "registry-test",
      revision: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      createdBy: { type: "service", id: "registry-test" },
      specDigest: overrides.specDigest ?? canonicalDigest(spec),
    },
    spec,
  }
}

describe("loadPhase0AEvaluatorRegistry", () => {
  it("loads only the Phase 0A allowlist and derives provenance from actual executions", async () => {
    const resolver = new MemoryArtifactResolver()
    const sealedPolicy = policy(defaultEvaluators(resolver))

    const registry = await loadPhase0AEvaluatorRegistry(sealedPolicy, {
      artifactResolver: resolver,
      visualReferenceAvailable: true,
    })

    expect(registry.runnable.map(({ id }) => id)).toEqual([
      "execution",
      "interaction",
      "runtime",
      "visual",
    ])
    expect(registry.skipped).toEqual([])
    expect(registry.get("runtime")?.config).toEqual({
      sameOrigin5xxIsCritical: true,
      consoleErrorIsAdvisory: true,
    })

    const provenance = registry.provenanceFor(["execution", "runtime"])
    expect(provenance).toEqual(
      sealedPolicy.spec.evaluators
        .filter(({ id }) => ["execution", "runtime"].includes(id))
        .map(({ id, version, configDigest }) => ({
          id,
          version,
          configDigest,
        })),
    )
    expect(provenance.map(({ id }) => id)).not.toContain("visual")
  })

  it("truthfully skips optional visual evaluation when no reference exists", async () => {
    const resolver = new MemoryArtifactResolver()
    const registry = await loadPhase0AEvaluatorRegistry(
      policy(defaultEvaluators(resolver)),
      {
        artifactResolver: resolver,
        visualReferenceAvailable: false,
      },
    )

    expect(registry.runnable.map(({ id }) => id)).toEqual([
      "execution",
      "interaction",
      "runtime",
    ])
    expect(registry.skipped).toMatchObject([
      {
        id: "visual",
        status: "skipped",
        required: false,
        reason: "reference-unavailable",
      },
    ])
    expect(() => registry.provenanceFor(["visual"])).toThrowError(
      expect.objectContaining({
        code: "EVALUATOR_NOT_RUNNABLE",
        evaluatorId: "visual",
      }),
    )
  })

  it("rejects required visual evaluation when no reference exists", async () => {
    const resolver = new MemoryArtifactResolver()

    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(defaultEvaluators(resolver, true)),
        {
          artifactResolver: resolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "REQUIRED_EVALUATOR_UNAVAILABLE",
      evaluatorId: "visual",
      required: true,
    })
  })

  it("requires execution, interaction, and runtime@0.1.0 to be declared required", async () => {
    const missingResolver = new MemoryArtifactResolver()
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy([
          evaluator(
            missingResolver,
            "visual",
            { mode: "advisory" },
            { required: false },
          ),
        ]),
        {
          artifactResolver: missingResolver,
          visualReferenceAvailable: true,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      evaluatorId: "execution",
    })

    const optionalResolver = new MemoryArtifactResolver()
    const optionalExecution = evaluator(
      optionalResolver,
      "execution",
      {},
      { required: false },
    )
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(
          replaceEvaluator(
            requiredCoreEvaluators(optionalResolver),
            optionalExecution,
          ),
        ),
        {
          artifactResolver: optionalResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      evaluatorId: "execution",
      required: false,
    })

    const versionResolver = new MemoryArtifactResolver()
    const wrongRuntimeVersion = evaluator(
      versionResolver,
      "runtime",
      {
        sameOrigin5xxIsCritical: true,
        consoleErrorIsAdvisory: true,
      },
      { version: "0.2.0" },
    )
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(
          replaceEvaluator(
            requiredCoreEvaluators(versionResolver),
            wrongRuntimeVersion,
          ),
        ),
        {
          artifactResolver: versionResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      evaluatorId: "runtime",
      evaluatorVersion: "0.2.0",
    })
  })

  it("rejects unsupported required evaluators and skips optional ones", async () => {
    const requiredResolver = new MemoryArtifactResolver()
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy([
          ...requiredCoreEvaluators(requiredResolver),
          evaluator(requiredResolver, "not-an-evaluator", {}),
        ]),
        {
          artifactResolver: requiredResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_EVALUATOR",
      evaluatorId: "not-an-evaluator",
      required: true,
    })

    const optionalResolver = new MemoryArtifactResolver()
    const registry = await loadPhase0AEvaluatorRegistry(
      policy([
        ...requiredCoreEvaluators(optionalResolver),
        evaluator(optionalResolver, "not-an-evaluator", {}, { required: false }),
      ]),
      {
        artifactResolver: optionalResolver,
        visualReferenceAvailable: false,
      },
    )
    expect(registry.runnable.map(({ id }) => id)).toEqual([
      "execution",
      "interaction",
      "runtime",
    ])
    expect(registry.skipped).toMatchObject([
      { id: "not-an-evaluator", reason: "unsupported-evaluator", required: false },
    ])
  })

  it("fails closed for a missing required config and skips a missing optional config", async () => {
    const requiredResolver = new MemoryArtifactResolver()
    const requiredRef = requiredResolver.putBytes(
      Buffer.from("missing-config", "utf8"),
      { store: false },
    )
    const requiredEntry: PolicyEvaluator = {
      id: "execution",
      version: "0.1.0",
      configRef: requiredRef,
      configDigest: requiredRef.digest,
      required: true,
      weight: 0,
    }
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(
          replaceEvaluator(
            requiredCoreEvaluators(requiredResolver),
            requiredEntry,
          ),
        ),
        {
          artifactResolver: requiredResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      evaluatorId: "execution",
      required: true,
      cause: expect.objectContaining({ code: "CONFIG_UNAVAILABLE" }),
    })

    const optionalResolver = new MemoryArtifactResolver()
    const optionalRef = optionalResolver.put(
      { mode: "advisory" },
      { store: false },
    )
    const optionalEntry: PolicyEvaluator = {
      id: "visual",
      version: "0.1.0",
      configRef: optionalRef,
      configDigest: optionalRef.digest,
      required: false,
      weight: 0,
    }
    const registry = await loadPhase0AEvaluatorRegistry(
      policy([...requiredCoreEvaluators(optionalResolver), optionalEntry]),
      {
        artifactResolver: optionalResolver,
        visualReferenceAvailable: false,
      },
    )
    expect(registry.skipped).toMatchObject([
      { id: "visual", reason: "config-unavailable", required: false },
    ])
  })

  it.each([
    ["execution", { ignoredOption: true }],
    [
      "runtime",
      {
        sameOrigin5xxIsCritical: false,
        consoleErrorIsAdvisory: true,
      },
    ],
    ["visual", { mode: "blocking" }],
  ])("rejects unsupported %s config without silently ignoring it", async (id, config) => {
    const resolver = new MemoryArtifactResolver()
    const invalidEvaluator = evaluator(resolver, id, config)
    const evaluators =
      id === "visual"
        ? [...requiredCoreEvaluators(resolver), invalidEvaluator]
        : replaceEvaluator(
            requiredCoreEvaluators(resolver),
            invalidEvaluator,
          )

    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(evaluators),
        {
          artifactResolver: resolver,
          visualReferenceAvailable: true,
        },
      ),
    ).rejects.toMatchObject({
      code:
        id === "visual"
          ? "CONFIG_SHAPE_UNSUPPORTED"
          : "MISSING_REQUIRED_CORE_EVALUATOR",
      evaluatorId: id,
      ...(id === "visual"
        ? {}
        : {
            cause: expect.objectContaining({
              code: "CONFIG_SHAPE_UNSUPPORTED",
            }),
          }),
    })
  })

  it("rejects corrupt, invalid, and non-canonical CAS config bytes", async () => {
    const corruptResolver = new MemoryArtifactResolver()
    const corruptRef = corruptResolver.putBytes(Buffer.from('{"x":0}', "utf8"))
    corruptResolver.replace(corruptRef, Buffer.from('{"x":1}', "utf8"))
    const corruptExecution: PolicyEvaluator = {
      id: "execution",
      version: "0.1.0",
      configRef: corruptRef,
      configDigest: corruptRef.digest,
      required: true,
      weight: 0,
    }
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(
          replaceEvaluator(
            requiredCoreEvaluators(corruptResolver),
            corruptExecution,
          ),
        ),
        {
          artifactResolver: corruptResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      cause: expect.objectContaining({ code: "CONFIG_INTEGRITY_MISMATCH" }),
    })

    const invalidResolver = new MemoryArtifactResolver()
    const invalidRef = invalidResolver.putBytes(Buffer.from("{", "utf8"))
    const invalidExecution: PolicyEvaluator = {
      id: "execution",
      version: "0.1.0",
      configRef: invalidRef,
      configDigest: invalidRef.digest,
      required: true,
      weight: 0,
    }
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(
          replaceEvaluator(
            requiredCoreEvaluators(invalidResolver),
            invalidExecution,
          ),
        ),
        {
          artifactResolver: invalidResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      cause: expect.objectContaining({ code: "CONFIG_INVALID_JSON" }),
    })

    const nonCanonicalResolver = new MemoryArtifactResolver()
    const nonCanonicalRef = nonCanonicalResolver.putBytes(
      Buffer.from('{ "sameOrigin5xxIsCritical": true, "consoleErrorIsAdvisory": true }', "utf8"),
    )
    const nonCanonicalRuntime: PolicyEvaluator = {
      id: "runtime",
      version: "0.1.0",
      configRef: nonCanonicalRef,
      configDigest: nonCanonicalRef.digest,
      required: true,
      weight: 0,
    }
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(
          replaceEvaluator(
            requiredCoreEvaluators(nonCanonicalResolver),
            nonCanonicalRuntime,
          ),
        ),
        {
          artifactResolver: nonCanonicalResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "MISSING_REQUIRED_CORE_EVALUATOR",
      cause: expect.objectContaining({ code: "CONFIG_DIGEST_MISMATCH" }),
    })
  })

  it("rejects Phase 0A policies with repeat attempts or no gates", async () => {
    const repeatResolver = new MemoryArtifactResolver()
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(defaultEvaluators(repeatResolver), { attempts: 2 }),
        {
          artifactResolver: repeatResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_REPEATABILITY" })

    const noGateResolver = new MemoryArtifactResolver()
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(defaultEvaluators(noGateResolver), { gates: [] }),
        {
          artifactResolver: noGateResolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_HAS_NO_GATES" })
  })

  it("rejects policy semantics that Phase 0A does not execute", async () => {
    const variants = [
      (sealed: EvaluationPolicy) => {
        sealed.spec.evaluators[0].weight = 1
      },
      (sealed: EvaluationPolicy) => {
        sealed.spec.tolerances.push({
          id: "pixel-tolerance",
          priority: 1,
          dimension: "pixel",
          metric: "visual.changedPixelRatio",
          value: { kind: "number", value: 0.01 },
        })
      },
      (sealed: EvaluationPolicy) => {
        sealed.spec.dynamicRegions.push({
          scenarioId: "terms-desktop",
          checkpointId: "ready",
          target: { platform: "web", by: "css", value: "[data-clock]" },
          mode: "mask",
          approvalRef: "approval-1",
          reason: "clock changes",
        })
      },
    ]

    for (const mutate of variants) {
      const resolver = new MemoryArtifactResolver()
      const sealed = policy(defaultEvaluators(resolver))
      mutate(sealed)
      sealed.metadata.specDigest = canonicalDigest(sealed.spec)
      await expect(
        loadPhase0AEvaluatorRegistry(sealed, {
          artifactResolver: resolver,
          visualReferenceAvailable: false,
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_POLICY_FEATURE" })
    }
  })

  it("requires independent, non-bypassable hard gates for every core metric", async () => {
    const invalidGateSets: EvaluationPolicy["spec"]["gates"][] = [
      [
        {
          id: "irrelevant",
          hard: true,
          expression: {
            metric: "coverage.requiredRatio",
            operator: "gte",
            value: 0,
          },
          onUnknown: "fail",
        },
      ],
      requiredCoreGates().map((gate) =>
        gate.id === "interaction-assertions"
          ? { ...gate, hard: false }
          : gate,
      ),
      requiredCoreGates().map((gate) =>
        gate.id === "runtime-critical-errors"
          ? { ...gate, onUnknown: "inconclusive" as const }
          : gate,
      ),
      [
        ...requiredCoreGates().filter((gate) => gate.id !== "execution-valid"),
        {
          id: "bypassable-execution",
          hard: true,
          expression: {
            anyOf: [
              {
                metric: "execution.valid",
                operator: "eq",
                value: true,
              },
              {
                metric: "coverage.requiredRatio",
                operator: "gte",
                value: 0,
              },
            ],
          },
          onUnknown: "fail",
        },
      ],
    ]

    for (const gates of invalidGateSets) {
      const resolver = new MemoryArtifactResolver()
      await expect(
        loadPhase0AEvaluatorRegistry(
          policy(defaultEvaluators(resolver), { gates }),
          {
            artifactResolver: resolver,
            visualReferenceAvailable: false,
          },
        ),
      ).rejects.toMatchObject({ code: "MISSING_REQUIRED_CORE_GATE" })
    }
  })

  it("rejects a stale sealed policy digest", async () => {
    const resolver = new MemoryArtifactResolver()
    await expect(
      loadPhase0AEvaluatorRegistry(
        policy(defaultEvaluators(resolver), {
          specDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        {
          artifactResolver: resolver,
          visualReferenceAvailable: false,
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DIGEST_MISMATCH" })
  })

  it("rejects duplicate execution claims in provenance", async () => {
    const resolver = new MemoryArtifactResolver()
    const registry = await loadPhase0AEvaluatorRegistry(
      policy(defaultEvaluators(resolver)),
      {
        artifactResolver: resolver,
        visualReferenceAvailable: false,
      },
    )

    expect(() => registry.provenanceFor(["execution", "execution"])).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_EXECUTION" }),
    )
    expect(
      (() => {
        try {
          registry.provenanceFor(["execution", "execution"])
        } catch (error) {
          return error
        }
      })(),
    ).toBeInstanceOf(EvaluatorRegistryError)
  })
})

function sha256(bytes: Uint8Array): ArtifactRef["digest"] {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
