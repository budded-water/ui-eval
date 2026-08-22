import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { canonicalDigest } from "../contracts/canonical-json"
import type { PolicySource } from "../contracts/model"
import {
  validateEvaluationPolicy,
  validatePolicySource,
} from "../contracts/validation"
import {
  loadPolicySource,
  loadProjectConfig,
  type LoadedPolicySource,
} from "../project/config"
import { LocalArtifactStore } from "../storage-local/artifact-store"
import { materializePolicy } from "./policy"

const createdDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function createProject(): Promise<{
  root: string
  project: Awaited<ReturnType<typeof loadProjectConfig>>
  store: LocalArtifactStore
}> {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-policy-"))
  createdDirectories.push(root)
  await mkdir(join(root, "ui-eval", "policies", "configs"), {
    recursive: true,
  })
  await writeJson(join(root, "ui-eval", "project.json"), {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ProjectConfig",
    projectId: "policy-test",
    artifactRoot: ".ui-eval",
    devServer: {
      command: "bun",
      args: ["run", "dev"],
      url: "http://127.0.0.1:3000",
      reuseExisting: true,
      readiness: {
        path: "/__ui_eval_health",
        bodyIncludes: "ui-eval-project:policy-test",
      },
      startupTimeoutMs: 30_000,
    },
    baseUrls: { local: "http://127.0.0.1:3000" },
    deviceProfiles: {
      desktop: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    defaults: { locale: "en-US", theme: "light", timezone: "UTC" },
    supportedCapabilities: ["screenshot"],
  })
  const project = await loadProjectConfig({ projectRoot: root })
  const store = new LocalArtifactStore({
    root: join(root, ".ui-eval"),
    projectId: project.value.projectId,
    storeId: "policy-configs",
  })
  return { root, project, store }
}

function policySource(
  evaluatorConfig: { config?: unknown; configPath?: string } = {
    config: { threshold: 0, channels: ["console", "crash"] },
  },
): PolicySource {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "PolicySource",
    id: "default",
    revision: 2,
    evaluators: [
      {
        id: "runtime",
        version: "0.1.0",
        ...evaluatorConfig,
        required: true,
        weight: 1,
      },
    ],
    tolerances: [],
    gates: [
      {
        id: "runtime-hard",
        hard: true,
        expression: {
          metric: "runtime.errors",
          operator: "eq",
          value: 0,
        },
        onUnknown: "inconclusive",
      },
    ],
    repeatability: { attempts: 1, requiredAgreement: 1 },
    dynamicRegions: [],
    agentMutation: {
      allowedPathGlobs: ["app/**"],
      protectedPathGlobs: ["ui-eval/**"],
    },
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function loadedPolicy(
  root: string,
  value: PolicySource,
): Promise<LoadedPolicySource> {
  const path = join(root, "ui-eval", "policies", "default.json")
  await writeJson(path, value)
  return {
    value: validatePolicySource(value),
    path,
    digest: canonicalDigest(value),
  }
}

describe("materializePolicy", () => {
  it("seals inline evaluator config and returns a valid EvaluationPolicy", async () => {
    const { root, project, store } = await createProject()
    const source = policySource()
    await writeJson(join(root, "ui-eval", "policies", "default.json"), source)
    const loaded = await loadPolicySource(project, "policies/default.json")

    const policy = await materializePolicy(loaded, project, {
      artifactMaterializer: store,
      createdAt: "2026-08-10T00:00:00.000Z",
      createdBy: { type: "human", id: "test-author" },
    })

    expect(validateEvaluationPolicy(policy)).toEqual(policy)
    expect(policy).toMatchObject({
      apiVersion: "uieval.io/v1alpha1",
      kind: "EvaluationPolicy",
      metadata: {
        id: "default",
        projectId: "policy-test",
        revision: 2,
        createdBy: { type: "human", id: "test-author" },
      },
      spec: {
        evaluators: [
          {
            id: "runtime",
            configRef: { storeId: "policy-configs" },
          },
        ],
      },
    })
    expect(policy.spec.evaluators[0].configDigest).toBe(
      policy.spec.evaluators[0].configRef.digest,
    )
    expect(policy.metadata.specDigest).toBe(canonicalDigest(policy.spec))
    const stored = await store.resolve(
      policy.spec.evaluators[0]
        .configRef as Parameters<LocalArtifactStore["resolve"]>[0],
    )
    expect(JSON.parse(stored.toString("utf8"))).toEqual(
      source.evaluators[0].config,
    )
    expect(JSON.stringify(policy)).not.toContain(root)
    expect(JSON.stringify(policy)).not.toContain("configPath")
  })

  it("resolves configPath relative to the policy document and seals JSON", async () => {
    const { root, project, store } = await createProject()
    const config = { maxErrors: 0, failOnPageError: true }
    await writeJson(
      join(root, "ui-eval", "policies", "configs", "runtime.json"),
      config,
    )
    const loaded = await loadedPolicy(
      root,
      policySource({ configPath: "configs/runtime.json" }),
    )

    const policy = await materializePolicy(loaded, project, {
      artifactMaterializer: store,
      createdAt: "2026-08-10T00:00:00.000Z",
    })

    const stored = await store.resolve(
      policy.spec.evaluators[0]
        .configRef as Parameters<LocalArtifactStore["resolve"]>[0],
    )
    expect(JSON.parse(stored.toString("utf8"))).toEqual(config)
    expect(JSON.stringify(policy)).not.toContain("configs/runtime.json")
  })

  it("keeps specDigest stable across source formatting and envelope time", async () => {
    const { root, project, store } = await createProject()
    const source = policySource({ config: { z: 1, a: 2 } })
    const loaded = await loadedPolicy(root, source)

    const first = await materializePolicy(loaded, project, {
      artifactMaterializer: store,
      createdAt: "2026-08-10T00:00:00.000Z",
    })
    const reordered = policySource({ config: { a: 2, z: 1 } })
    const second = await materializePolicy(reordered, project, {
      artifactMaterializer: store,
      createdAt: "2027-01-01T00:00:00.000Z",
    })

    expect(second.metadata.specDigest).toBe(first.metadata.specDigest)
    expect(second.spec).toEqual(first.spec)
    expect(second.metadata.createdAt).not.toBe(first.metadata.createdAt)
  })

  it("rejects missing and non-JSON path configs with structured errors", async () => {
    const { root, project, store } = await createProject()
    const missing = await loadedPolicy(
      root,
      policySource({ configPath: "configs/missing.json" }),
    )

    await expect(
      materializePolicy(missing, project, { artifactMaterializer: store }),
    ).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
      evaluatorId: "runtime",
      reference: "configs/missing.json",
    })

    await writeFile(
      join(root, "ui-eval", "policies", "configs", "broken.json"),
      "{ nope",
      "utf8",
    )
    const broken = await loadedPolicy(
      root,
      policySource({ configPath: "configs/broken.json" }),
    )
    await expect(
      materializePolicy(broken, project, { artifactMaterializer: store }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG_JSON" })
  })

  it("rejects config symlinks that escape the project root", async () => {
    const { root, project, store } = await createProject()
    const outside = await mkdtemp(join(tmpdir(), "ui-eval-policy-outside-"))
    createdDirectories.push(outside)
    await writeJson(join(outside, "runtime.json"), { maxErrors: 0 })
    await symlink(
      join(outside, "runtime.json"),
      join(root, "ui-eval", "policies", "configs", "escaped.json"),
    )
    const loaded = await loadedPolicy(
      root,
      policySource({ configPath: "configs/escaped.json" }),
    )

    await expect(
      materializePolicy(loaded, project, { artifactMaterializer: store }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" })
  })

  it("rejects evaluator definitions with no config source", async () => {
    const { project, store } = await createProject()
    const source = policySource({})

    await expect(
      materializePolicy(source, project, { artifactMaterializer: store }),
    ).rejects.toMatchObject({ code: "CONFIG_SOURCE_REQUIRED" })
  })
})
