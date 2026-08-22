import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  loadPolicySource,
  loadProjectConfig,
  loadScenarioSource,
} from "./config"

const createdDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")

  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-project-"))
  createdDirectories.push(root)
  await mkdir(join(root, "ui-eval", "scenarios"), { recursive: true })
  await mkdir(join(root, "ui-eval", "policies"), { recursive: true })

  await writeJson(join(root, "ui-eval", "project.json"), validProjectSource())
  return root
}

function validProjectSource() {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ProjectConfig",
    projectId: "example-project",
    artifactRoot: ".ui-eval",
    devServer: {
      command: "bun",
      args: ["run", "dev"],
      url: "http://127.0.0.1:3000",
      reuseExisting: true,
      readiness: {
        path: "/__ui_eval_health",
        bodyIncludes: "ui-eval-project:example-project",
      },
      startupTimeoutMs: 30_000,
    },
    baseUrls: {
      local: "http://127.0.0.1:3000",
    },
    deviceProfiles: {
      desktop: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    defaults: {
      locale: "en-US",
      theme: "light",
      timezone: "UTC",
    },
    storageStates: {},
    fixtureSets: {},
    featureFlagSets: {},
    supportedCapabilities: ["screenshot", "dom", "console"],
  }
}

function validScenarioSource() {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ScenarioSource",
    id: "terms",
    revision: 1,
    name: "Terms",
    visibility: "agent-visible",
    tags: ["smoke"],
    target: {
      platform: "web",
      entrypoint: { baseUrlRef: "local", path: "/terms" },
    },
    determinism: {
      timezone: "UTC",
      clock: { mode: "fixed", value: "2026-08-10T00:00:00.000Z" },
    },
    requiredCapabilities: ["screenshot"],
    matrix: { deviceProfiles: ["desktop"] },
    steps: [{ id: "open", action: "goto", path: "/terms" }],
    checkpoints: [
      {
        id: "ready",
        requiredChannels: ["screenshot"],
        captureScope: "viewport",
        stabilize: {
          disableAnimations: true,
          waitForFonts: true,
          stableFrames: 2,
          timeoutMs: 5_000,
        },
      },
    ],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

describe("project authoring loaders", () => {
  it("loads and validates project, scenario, and policy source documents", async () => {
    const root = await createProject()
    await writeJson(
      join(root, "ui-eval", "scenarios", "terms.json"),
      validScenarioSource(),
    )
    await writeJson(join(root, "ui-eval", "policies", "default.json"), {
      apiVersion: "uieval.io/v1alpha1",
      kind: "PolicySource",
      id: "default",
      revision: 1,
      evaluators: [
        {
          id: "execution",
          version: "0.1.0",
          config: {},
          required: true,
          weight: 1,
        },
      ],
      tolerances: [],
      gates: [],
      repeatability: { attempts: 1, requiredAgreement: 1 },
      dynamicRegions: [],
      agentMutation: {
        allowedPathGlobs: ["app/**"],
        protectedPathGlobs: ["ui-eval/**"],
      },
    })

    const project = await loadProjectConfig({ projectRoot: root })
    const scenario = await loadScenarioSource(project, "scenarios/terms.json")
    const policy = await loadPolicySource(project, "policies/default.json")

    expect(project.value.projectId).toBe("example-project")
    expect(project.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(scenario.value.kind).toBe("ScenarioSource")
    expect(scenario.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(policy.value.kind).toBe("PolicySource")
    expect(policy.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("accepts a path-backed evaluator config and rejects ambiguous config sources", async () => {
    const root = await createProject()
    const policyPath = join(root, "ui-eval", "policies", "default.json")
    const policy = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "PolicySource",
      id: "default",
      revision: 1,
      evaluators: [
        {
          id: "runtime",
          version: "0.1.0",
          configPath: "runtime.json",
          required: true,
          weight: 1,
        },
      ],
      tolerances: [],
      gates: [],
      repeatability: { attempts: 1, requiredAgreement: 1 },
      dynamicRegions: [],
      agentMutation: {
        allowedPathGlobs: ["app/**"],
        protectedPathGlobs: ["ui-eval/**"],
      },
    }
    await writeJson(policyPath, policy)
    const project = await loadProjectConfig({ projectRoot: root })

    await expect(
      loadPolicySource(project, "policies/default.json"),
    ).resolves.toMatchObject({ value: { id: "default" } })

    policy.evaluators[0] = {
      ...policy.evaluators[0],
      config: {},
    } as (typeof policy.evaluators)[number]
    await writeJson(policyPath, policy)
    await expect(
      loadPolicySource(project, "policies/default.json"),
    ).rejects.toMatchObject({ code: "SEMANTIC_INVALID" })
  })

  it("uses canonical content rather than JSON formatting for source digests", async () => {
    const root = await createProject()
    const first = await loadProjectConfig({ projectRoot: root })

    await writeFile(
      join(root, "ui-eval", "project.json"),
      JSON.stringify(validProjectSource()),
      "utf8",
    )
    const second = await loadProjectConfig({ projectRoot: root })

    expect(second.digest).toBe(first.digest)
  })

  it("materializes the default artifact root into the loaded config", async () => {
    const root = await createProject()
    const withoutArtifactRoot: Omit<
      ReturnType<typeof validProjectSource>,
      "artifactRoot"
    > & { artifactRoot?: string } = validProjectSource()
    delete withoutArtifactRoot.artifactRoot
    await writeJson(join(root, "ui-eval", "project.json"), withoutArtifactRoot)

    const project = await loadProjectConfig({ projectRoot: root })

    expect(project.value.artifactRoot).toBe(".ui-eval")
  })

  it("rejects an artifact root symlink even when its target is a directory", async () => {
    const root = await createProject()
    const target = join(root, "generated-artifacts")
    await mkdir(target)
    await symlink(target, join(root, ".ui-eval"))

    await expect(
      loadProjectConfig({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: "SEMANTIC_INVALID",
      details: [expect.stringContaining("must not be a symbolic link")],
    })
  })

  it("rejects an artifact root symlink that escapes the project", async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), "ui-eval-root-outside-"))
    createdDirectories.push(outside)
    await symlink(outside, join(root, ".ui-eval"))

    await expect(
      loadProjectConfig({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: "SEMANTIC_INVALID",
      details: [expect.stringContaining("must not be a symbolic link")],
    })
  })

  it("rejects a missing artifact root beneath an ancestor symlink outside the project", async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), "ui-eval-artifacts-outside-"))
    createdDirectories.push(outside)
    await symlink(outside, join(root, "generated"))
    await writeJson(join(root, "ui-eval", "project.json"), {
      ...validProjectSource(),
      artifactRoot: "generated/ui-eval",
    })

    await expect(
      loadProjectConfig({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: "SEMANTIC_INVALID",
      details: [expect.stringContaining("outside the project")],
    })
  })

  it("rejects references that lexically escape the project root", async () => {
    const root = await createProject()

    await expect(
      loadProjectConfig({
        projectRoot: root,
        configPath: "../outside/project.json",
      }),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_PROJECT",
    })
  })

  it("rejects a symlink whose real target escapes the project root", async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), "ui-eval-outside-"))
    createdDirectories.push(outside)
    const outsideScenario = join(outside, "scenario.json")
    await writeJson(outsideScenario, validScenarioSource())
    await symlink(
      outsideScenario,
      join(root, "ui-eval", "scenarios", "escaped.json"),
    )
    const project = await loadProjectConfig({ projectRoot: root })

    await expect(
      loadScenarioSource(project, "scenarios/escaped.json"),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_PROJECT",
    })
  })

  it("reports invalid JSON with the document path and a useful code", async () => {
    const root = await createProject()
    const scenarioPath = join(root, "ui-eval", "scenarios", "broken.json")
    await writeFile(scenarioPath, "{ not-json", "utf8")
    const project = await loadProjectConfig({ projectRoot: root })

    await expect(
      loadScenarioSource(project, "scenarios/broken.json"),
    ).rejects.toMatchObject({ code: "INVALID_JSON" })
    await expect(
      loadScenarioSource(project, "scenarios/broken.json"),
    ).rejects.toThrow(/broken\.json/)
  })

  it("reports schema failures with the failing field", async () => {
    const root = await createProject()
    const invalid = validScenarioSource()
    invalid.target.entrypoint.path = "terms"
    await writeJson(
      join(root, "ui-eval", "scenarios", "invalid.json"),
      invalid,
    )
    const project = await loadProjectConfig({ projectRoot: root })

    await expect(
      loadScenarioSource(project, "scenarios/invalid.json"),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" })
    await expect(
      loadScenarioSource(project, "scenarios/invalid.json"),
    ).rejects.toThrow(/target.*entrypoint.*path/i)
  })

  it("rejects app locators at the Web ScenarioSource loader boundary", async () => {
    const root = await createProject()
    const invalid = validScenarioSource()
    invalid.steps = [
      {
        id: "wrong-platform",
        action: "tap",
        target: {
          platform: "ios",
          by: "accessibilityId",
          value: "terms-title",
        },
      },
    ] as never
    await writeJson(
      join(root, "ui-eval", "scenarios", "wrong-platform.json"),
      invalid,
    )
    const project = await loadProjectConfig({ projectRoot: root })

    await expect(
      loadScenarioSource(project, "scenarios/wrong-platform.json"),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" })
  })
})
