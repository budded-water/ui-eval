import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { describe, expect, it } from "vitest"

import {
  ProjectConfigError,
  ProjectConfigSchema,
  WebScenarioSourceSchema,
  WebPolicySourceSchema,
  assertProjectConfig,
  assertWebScenarioSource,
  validateProjectConfig,
  validateWebScenarioSource,
  validateWebPolicySource,
  forwardContracts,
  type ProjectConfig,
  type WebScenarioSource,
} from "../index"

function validProjectConfig(): Record<string, unknown> {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ProjectConfig",
    projectId: "public-contract",
    devServer: {
      command: "bun",
      args: ["run", "dev"],
      url: "http://127.0.0.1:3000",
      reuseExisting: true,
      readiness: {
        path: "/__ui_eval_health",
        bodyIncludes: "ui-eval-project:public-contract",
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
    supportedCapabilities: ["screenshot", "dom", "console"],
  }
}

function validWebScenarioSource(): Record<string, unknown> {
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

async function checkedInValidator(name: string): Promise<ValidateFunction> {
  const schemaPath = fileURLToPath(
    new URL(`../../schemas/${name}`, import.meta.url),
  )
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: true,
    useDefaults: true,
  })
  ;(addFormats as unknown as (instance: Ajv2020) => Ajv2020)(ajv)
  return ajv.compile(schema)
}

describe("public active authoring contracts", () => {
  it("exports the active schemas under names distinct from forward contracts", () => {
    expect(ProjectConfigSchema.$id).toBe(
      "https://uieval.io/source/project-config",
    )
    expect(WebScenarioSourceSchema.$id).toBe(
      "https://uieval.io/source/scenario",
    )
    expect(WebPolicySourceSchema.$id).toBe("https://uieval.io/source/web-policy")
    expect(forwardContracts.ScenarioSourceSchema).not.toBe(WebScenarioSourceSchema)
  })

  it("validates compact policy authoring in parity with its generated schema", async () => {
    const checkedIn = await checkedInValidator("policy-source.schema.json")
    const minimal = { apiVersion: "uieval.io/v1alpha1", kind: "PolicySource", id: "default", revision: 1, profile: "web-default" }
    for (const candidate of [minimal, { ...minimal, extra: true }, { ...minimal, profile: "unknown" }, { ...minimal, gates: [] }]) {
      expect(validateWebPolicySource(structuredClone(candidate))).toBe(checkedIn(structuredClone(candidate)))
    }
  })

  it("validates ProjectConfig in parity with the checked-in generated schema", async () => {
    const checkedIn = await checkedInValidator("project.schema.json")
    const cases = [
      validProjectConfig(),
      { ...validProjectConfig(), unexpected: true },
      { ...validProjectConfig(), projectId: "spaces are invalid" },
      { ...validProjectConfig(), devServer: undefined },
    ]

    for (const candidate of cases) {
      const publicInput = structuredClone(candidate)
      const schemaInput = structuredClone(candidate)
      expect(validateProjectConfig(publicInput)).toBe(checkedIn(schemaInput))
    }

    const accepted = validProjectConfig()
    expect(assertProjectConfig(accepted)).toBe(accepted)
    expect((accepted as Partial<ProjectConfig>).artifactRoot).toBe(".ui-eval")
    expect(() =>
      assertProjectConfig({ ...validProjectConfig(), unexpected: true }),
    ).toThrow(ProjectConfigError)
  })

  it("validates executable web scenarios in parity with the checked-in schema", async () => {
    const checkedIn = await checkedInValidator("scenario-source.schema.json")
    const iosForwardContractOnly = {
      ...validWebScenarioSource(),
      target: {
        platform: "ios",
        entrypoint: { appId: "com.example.app" },
      },
      steps: [{ id: "launch", action: "launchApp" }],
    }
    const cases = [
      validWebScenarioSource(),
      { ...validWebScenarioSource(), unexpected: true },
      {
        ...validWebScenarioSource(),
        target: {
          platform: "web",
          entrypoint: { baseUrlRef: "local", path: "missing-leading-slash" },
        },
      },
      iosForwardContractOnly,
    ]

    for (const candidate of cases) {
      const publicInput = structuredClone(candidate)
      const schemaInput = structuredClone(candidate)
      expect(validateWebScenarioSource(publicInput)).toBe(checkedIn(schemaInput))
    }

    const accepted = validWebScenarioSource()
    expect(assertWebScenarioSource(accepted)).toBe(accepted)
    expect((accepted as Partial<WebScenarioSource>).target?.platform).toBe("web")
    expect(() => assertWebScenarioSource(iosForwardContractOnly)).toThrow(
      ProjectConfigError,
    )
  })
})
