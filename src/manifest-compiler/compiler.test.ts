import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ArtifactRef } from "../contracts/model"
import {
  loadProjectConfig,
  loadScenarioSource,
  type LoadedProjectConfig,
  type LoadedScenarioSource,
} from "../project/config"
import {
  compileScenario,
  type ArtifactMaterializer,
} from "./compiler"

const createdDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")

  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function createLoadedSources(options?: {
  project?: Record<string, unknown>
  scenario?: Record<string, unknown>
  files?: Record<string, unknown>
}): Promise<{
  root: string
  project: LoadedProjectConfig
  scenario: LoadedScenarioSource
}> {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-compiler-"))
  createdDirectories.push(root)
  await mkdir(join(root, "ui-eval", "scenarios"), { recursive: true })
  await mkdir(join(root, "ui-eval", "fixtures"), { recursive: true })

  const project = {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ProjectConfig",
    projectId: "compiler-test",
    artifactRoot: ".ui-eval",
    devServer: {
      command: "bun",
      args: ["run", "dev"],
      url: "http://127.0.0.1:3000",
      reuseExisting: true,
      readiness: {
        path: "/__ui_eval_health",
        bodyIncludes: "ui-eval-project:compiler-test",
      },
      startupTimeoutMs: 30_000,
    },
    baseUrls: { local: "http://127.0.0.1:3000/" },
    deviceProfiles: {
      desktop: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        userAgent: "ui-eval-test",
      },
      mobile: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
      },
    },
    defaults: { locale: "en-US", theme: "light", timezone: "UTC" },
    storageStates: { signedIn: "fixtures/signed-in.storage-state.json" },
    fixtureSets: {
      seeded: [
        {
          id: "catalog",
          provider: "static",
          configPath: "fixtures/catalog.json",
        },
      ],
    },
    featureFlagSets: {
      control: { redesign: false },
      redesign: { redesign: true },
    },
    supportedCapabilities: [
      "screenshot",
      "dom",
      "computed-styles",
      "console",
      "network",
      "trace",
      "crash",
    ],
    ...options?.project,
  }
  const scenario = {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ScenarioSource",
    id: "matrix",
    revision: 3,
    name: "Matrix scenario",
    visibility: "agent-visible",
    tags: ["smoke"],
    target: {
      platform: "web",
      entrypoint: { baseUrlRef: "local", path: "/terms" },
    },
    auth: { role: "member", storageStateRef: "signedIn" },
    determinism: {
      timezone: "Asia/Shanghai",
      clock: { mode: "fixed", value: "2026-08-10T00:00:00.000Z" },
      randomSeed: "phase-0a",
    },
    requiredCapabilities: ["screenshot", "dom", "console", "crash"],
    matrix: {
      deviceProfiles: ["desktop", "mobile"],
      locales: ["en-US", "zh-CN"],
      themes: ["light", "dark"],
      exclude: [
        {
          deviceProfile: "mobile",
          locale: "zh-CN",
          theme: "dark",
        },
      ],
    },
    setup: [{ id: "setup", action: "goto", path: "/terms" }],
    steps: [
      {
        id: "title-visible",
        action: "assert",
        assertion: {
          id: "terms-title",
          kind: "visible",
          target: { platform: "web", by: "role", value: "heading" },
        },
      },
      { id: "capture", action: "checkpoint", checkpointId: "page" },
    ],
    cleanup: [],
    checkpoints: [
      {
        id: "page",
        requiredChannels: ["screenshot", "dom", "console", "crash"],
        captureScope: "viewport",
        stabilize: {
          disableAnimations: true,
          waitForFonts: true,
          stableFrames: 2,
          timeoutMs: 5_000,
        },
      },
    ],
    ...options?.scenario,
  }

  await writeJson(join(root, "ui-eval", "project.json"), project)
  await writeJson(join(root, "ui-eval", "scenarios", "matrix.json"), scenario)
  await writeJson(join(root, "ui-eval", "fixtures", "signed-in.storage-state.json"), {
    cookies: [],
    origins: [
      {
        origin: "http://127.0.0.1:3000",
        localStorage: [{ name: "market_country", value: "CHN" }],
      },
    ],
  })
  await writeJson(join(root, "ui-eval", "fixtures", "catalog.json"), {
    listings: [{ id: "listing-1" }],
  })

  for (const [relativePath, value] of Object.entries(options?.files ?? {})) {
    await writeJson(join(root, "ui-eval", relativePath), value)
  }

  const loadedProject = await loadProjectConfig({ projectRoot: root })
  const loadedScenario = await loadScenarioSource(
    loadedProject,
    "scenarios/matrix.json",
  )

  return { root, project: loadedProject, scenario: loadedScenario }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function createMaterializer(): ArtifactMaterializer & { values: unknown[] } {
  const values: unknown[] = []

  return {
    values,
    async put(value, options) {
      values.push(value)
      const index = values.length.toString().padStart(64, "0")
      return {
        id: `sha256:${index}`,
        projectId: "compiler-test",
        storeId: "test-cas",
        digest: `sha256:${index}`,
        mediaType: options.mediaType,
        sizeBytes: JSON.stringify(value).length,
        sensitivity: options.sensitivity,
      } satisfies ArtifactRef
    },
  }
}

describe("compileScenario", () => {
  it("expands the complete matrix and applies full exact-match exclusions", async () => {
    const { project, scenario } = await createLoadedSources()
    const plans = await compileScenario(scenario, project, {
      artifactMaterializer: createMaterializer(),
    })

    expect(plans).toHaveLength(7)
    expect(
      plans.some(
        (plan) =>
          plan.variant.values.deviceProfile === "mobile" &&
          plan.variant.values.locale === "zh-CN" &&
          plan.variant.values.theme === "dark",
      ),
    ).toBe(false)
    expect(
      plans.some(
        (plan) =>
          plan.variant.values.deviceProfile === "desktop" &&
          plan.variant.values.locale === "zh-CN" &&
          plan.variant.values.theme === "dark",
      ),
    ).toBe(true)
  })

  it("seals every execution input and never leaves authoring references", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        matrix: {
          deviceProfiles: ["mobile"],
          locales: ["zh-CN"],
          themes: ["dark"],
        },
      },
    })
    const materializer = createMaterializer()

    const [plan] = await compileScenario(scenario, project, {
      artifactMaterializer: materializer,
    })

    expect(plan.target).toEqual({
      platform: "web",
      entrypoint: { baseUrl: "http://127.0.0.1:3000", path: "/terms" },
    })
    expect(plan.device).toMatchObject({
      profileId: "mobile",
      renderSpace: {
        logicalWidth: 390,
        logicalHeight: 844,
        logicalUnit: "css-px",
        deviceScaleFactor: 3,
        screenshotWidthPx: 1170,
        screenshotHeightPx: 2532,
        orientation: "portrait",
      },
    })
    expect(plan.locale).toBe("zh-CN")
    expect(plan.theme).toBe("dark")
    expect(plan.determinism.timezone).toBe("Asia/Shanghai")
    expect(plan.auth).toMatchObject({
      role: "member",
      storageState: {
        projectId: "compiler-test",
        storeId: "test-cas",
      },
    })
    expect(plan.requiredCapabilities).toEqual([
      "console",
      "crash",
      "dom",
      "screenshot",
    ])
    expect(plan.setup).toHaveLength(1)
    expect(plan.steps).toHaveLength(2)
    expect(plan.cleanup).toEqual([])
    expect(plan.checkpoints).toHaveLength(1)
    expect(plan.fixtures).toEqual([])
    expect(plan.fixtureDigests).toEqual([])
    expect(plan.scenarioDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(plan.evidenceRequestDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(plan.captureConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(plan.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(plan)).not.toMatch(
      /baseUrlRef|storageStateRef|configPath|\.\.\//,
    )
    expect(materializer.values).toHaveLength(1)
  })

  it("uses project defaults when locale, theme, and timezone are omitted", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        auth: undefined,
        determinism: { clock: { mode: "real" } },
        matrix: { deviceProfiles: ["desktop"] },
      },
    })

    const [plan] = await compileScenario(scenario, project)

    expect(plan.locale).toBe("en-US")
    expect(plan.theme).toBe("light")
    expect(plan.determinism.timezone).toBe("UTC")
    expect(plan.device.renderSpace.deviceScaleFactor).toBe(1)
  })

  it("produces stable plans regardless of source object key order or JSON formatting", async () => {
    const first = await createLoadedSources({
      scenario: {
        auth: undefined,
        matrix: { deviceProfiles: ["desktop"], locales: ["en-US"] },
      },
    })
    const firstPlans = await compileScenario(first.scenario, first.project)

    await writeFile(
      first.scenario.path,
      JSON.stringify({
        ...first.scenario.value,
        matrix: { locales: ["en-US"], deviceProfiles: ["desktop"] },
      }),
      "utf8",
    )
    const reordered = await loadScenarioSource(
      first.project,
      "scenarios/matrix.json",
    )
    const secondPlans = await compileScenario(reordered, first.project)

    expect(secondPlans).toEqual(firstPlans)
  })

  it("rejects unsupported or unknown capabilities before capture", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: { requiredCapabilities: ["screenshot", "performance"] },
    })

    await expect(compileScenario(scenario, project)).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    })
  })

  it("fails closed for feature-flag state before materializing auth", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        matrix: {
          deviceProfiles: ["desktop"],
          featureFlagSets: ["redesign"],
        },
      },
    })
    const materializer = createMaterializer()

    await expect(
      compileScenario(scenario, project, { artifactMaterializer: materializer }),
    ).rejects.toMatchObject({
      name: "ScenarioCompileError",
      code: "UNSUPPORTED_FEATURE_FLAGS",
      scenarioId: "matrix",
      reference: "matrix.featureFlagSets",
    })
    expect(materializer.values).toEqual([])
  })

  it("fails closed for auth secret references before reading or materializing auth", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        auth: {
          role: "member",
          storageStateRef: "signedIn",
          secretRefs: ["UI_EVAL_SESSION_TOKEN"],
        },
      },
    })
    const materializer = createMaterializer()

    await expect(
      compileScenario(scenario, project, { artifactMaterializer: materializer }),
    ).rejects.toMatchObject({
      name: "ScenarioCompileError",
      code: "UNSUPPORTED_AUTH_SECRET_REFS",
      scenarioId: "matrix",
      reference: "auth.secretRefs",
    })
    expect(materializer.values).toEqual([])
  })

  it("fails closed for unsupported fixture providers before reading or materializing them", async () => {
    const cases: Array<{
      scenario: Record<string, unknown>
      reference: string
    }> = [
      {
        scenario: {
          matrix: {
            deviceProfiles: ["desktop"],
            fixtureSets: ["seeded"],
          },
        },
        reference: "catalog",
      },
      {
        scenario: {
          matrix: { deviceProfiles: ["desktop"] },
          fixtures: [{ id: "provider-only", provider: "static" }],
        },
        reference: "provider-only",
      },
      {
        scenario: {
          matrix: { deviceProfiles: ["desktop"] },
          fixtures: [
            {
              id: "catalog-config",
              provider: "static",
              configPath: "fixtures/catalog.json",
            },
          ],
        },
        reference: "catalog-config",
      },
    ]

    for (const testCase of cases) {
      const { project, scenario } = await createLoadedSources({
        scenario: testCase.scenario,
      })
      const materializer = createMaterializer()

      await expect(
        compileScenario(scenario, project, { artifactMaterializer: materializer }),
      ).rejects.toMatchObject({
        name: "ScenarioCompileError",
        code: "UNSUPPORTED_FIXTURES",
        scenarioId: "matrix",
        reference: testCase.reference,
      })
      expect(materializer.values).toEqual([])
    }
  })

  it("seals a validated mock-server fixture config into the resolved plan", async () => {
    const mockConfig = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "MockServerFixtureConfig",
      listen: { port: 18_001 },
      routes: [
        {
          id: "catalog",
          method: "GET",
          path: "/api/catalog",
          required: true,
          response: {
            status: 200,
            contentType: "application/json",
            body: "[]",
          },
        },
      ],
    }
    const { project, scenario } = await createLoadedSources({
      scenario: {
        auth: undefined,
        matrix: { deviceProfiles: ["desktop"] },
        fixtures: [
          {
            id: "catalog-api",
            provider: "mock-server",
            configPath: "fixtures/mock-server.json",
          },
        ],
      },
      files: { "fixtures/mock-server.json": mockConfig },
    })
    const materializer = createMaterializer()

    const [plan] = await compileScenario(scenario, project, {
      artifactMaterializer: materializer,
    })

    expect(plan.fixtures).toEqual([
      expect.objectContaining({
        id: "catalog-api",
        provider: "mock-server",
        artifact: expect.objectContaining({ mediaType: "application/json" }),
      }),
    ])
    expect(plan.fixtureDigests).toEqual([plan.fixtures[0].configDigest])
    expect(materializer.values).toEqual([mockConfig])
  })

  it("rejects malformed mock-server configs before artifact materialization", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        auth: undefined,
        matrix: { deviceProfiles: ["desktop"] },
        fixtures: [
          {
            id: "catalog-api",
            provider: "mock-server",
            configPath: "fixtures/catalog.json",
          },
        ],
      },
    })
    const materializer = createMaterializer()

    await expect(
      compileScenario(scenario, project, { artifactMaterializer: materializer }),
    ).rejects.toMatchObject({
      code: "INVALID_FIXTURE_SOURCE",
      reference: "catalog-api",
    })
    expect(materializer.values).toEqual([])
  })

  it("fails closed for network profiles before materializing auth", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        determinism: {
          clock: { mode: "fixed", value: "2026-08-10T00:00:00.000Z" },
          networkProfileRef: "offline",
        },
        matrix: { deviceProfiles: ["desktop"] },
      },
    })
    const materializer = createMaterializer()

    await expect(
      compileScenario(scenario, project, { artifactMaterializer: materializer }),
    ).rejects.toMatchObject({
      name: "ScenarioCompileError",
      code: "UNSUPPORTED_NETWORK_PROFILE",
      scenarioId: "matrix",
      reference: "offline",
    })
    expect(materializer.values).toEqual([])
  })

  it("rejects missing project references with the reference name", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        auth: undefined,
        target: {
          platform: "web",
          entrypoint: { baseUrlRef: "preview", path: "/terms" },
        },
      },
    })

    await expect(compileScenario(scenario, project)).rejects.toThrow(
      /base URL.*preview/i,
    )
  })

  it("rejects exact-match exclusions with unknown dimensions", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: {
        auth: undefined,
        matrix: {
          deviceProfiles: ["desktop"],
          exclude: [{ device: "desktop" }],
        },
      },
    })

    await expect(compileScenario(scenario, project)).rejects.toMatchObject({
      code: "INVALID_EXCLUDE",
    })
  })

  it("rejects duplicate step ids and dangling checkpoint steps", async () => {
    const duplicate = await createLoadedSources({
      scenario: {
        auth: undefined,
        setup: [{ id: "same", action: "goto", path: "/terms" }],
        steps: [{ id: "same", action: "checkpoint", checkpointId: "missing" }],
      },
    })

    await expect(
      compileScenario(duplicate.scenario, duplicate.project),
    ).rejects.toMatchObject({ code: "DUPLICATE_STEP_ID" })
  })

  it("rejects entrypoint and goto URLs that can escape the candidate origin", async () => {
    const { project, scenario } = await createLoadedSources({
      scenario: { auth: undefined },
    })
    const unsafeEntrypoint = {
      ...scenario.value,
      target: {
        platform: "web" as const,
        entrypoint: {
          baseUrlRef: "local",
          path: "/\\evil.example",
        },
      },
    }

    await expect(
      compileScenario(unsafeEntrypoint, project),
    ).rejects.toMatchObject({ code: "PLATFORM_MISMATCH" })

    for (const path of ["//evil.example/path", "/\\evil.example/path"]) {
      const unsafeGoto = {
        ...scenario.value,
        setup: [{ id: "unsafe-goto", action: "goto" as const, path }],
      }
      await expect(compileScenario(unsafeGoto, project)).rejects.toMatchObject({
        code: "PLATFORM_MISMATCH",
        reference: "unsafe-goto",
      })
    }
  })

  it("requires an artifact materializer for auth storage-state input", async () => {
    const { project, scenario } = await createLoadedSources()

    await expect(compileScenario(scenario, project)).rejects.toMatchObject({
      code: "ARTIFACT_MATERIALIZER_REQUIRED",
    })
  })

  it("rejects storage-state paths that escape through symlinks", async () => {
    const { root, project, scenario } = await createLoadedSources()
    const outside = await mkdtemp(join(tmpdir(), "ui-eval-fixture-outside-"))
    createdDirectories.push(outside)
    await writeJson(join(outside, "state.json"), { cookies: [], origins: [] })
    const { rm, symlink } = await import("node:fs/promises")
    await rm(join(root, "ui-eval", "fixtures", "signed-in.storage-state.json"))
    await symlink(
      join(outside, "state.json"),
      join(root, "ui-eval", "fixtures", "signed-in.storage-state.json"),
    )

    await expect(
      compileScenario(scenario, project, {
        artifactMaterializer: createMaterializer(),
      }),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_PROJECT",
    })
  })
})
