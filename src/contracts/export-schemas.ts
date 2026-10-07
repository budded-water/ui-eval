import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { TSchema } from "@sinclair/typebox"
import { AgentSuiteSchema } from "../agent/config"
import { AgentRunResultSchema } from "../agent/model"
import { WechatPilotProjectSchema, WechatPilotScenarioSchema } from "../wechat-pilot/config"
import { WechatPilotResultSchema } from "../wechat-pilot/report"
import { EnginePinSchema, IntegrationSuiteSchema } from "../integration/config"
import { IntegrationResultSchema } from "../integration/model"

import {
  ProjectConfigSchema,
  ScenarioSourceSchema as AuthoringScenarioSourceSchema,
  WebPolicySourceSchema,
} from "../project/config"
import {
  CaptureBundleSchema,
  DesignContractSchema,
  DeploymentIdentitySchema,
  GeometryEvaluatorConfigSchema,
  MockServerFixtureConfigSchema,
  EvaluationPlanSchema,
  EvaluationPolicySchema,
  EvaluationReportSchema,
  ResolvedScenarioPlanSchema,
  ScenarioManifestSchema,
  SealedRunManifestSchema,
} from "./schemas"

const DRAFT = "https://json-schema.org/draft/2020-12/schema"

const schemaFiles: ReadonlyArray<readonly [string, TSchema]> = [
  ["engine-pin.schema.json", EnginePinSchema],
  ["integration-suite.schema.json", IntegrationSuiteSchema],
  ["integration-result.schema.json", IntegrationResultSchema],
  ["wechat-pilot-project.schema.json", WechatPilotProjectSchema],
  ["wechat-pilot-scenario.schema.json", WechatPilotScenarioSchema],
  ["wechat-pilot-result.schema.json", WechatPilotResultSchema],
  ["deployment-identity.schema.json", DeploymentIdentitySchema],
  ["agent-suite.schema.json", AgentSuiteSchema],
  ["agent-summary.schema.json", AgentRunResultSchema],
  ["project.schema.json", ProjectConfigSchema],
  ["scenario-source.schema.json", AuthoringScenarioSourceSchema],
  ["policy-source.schema.json", WebPolicySourceSchema],
  ["scenario-manifest.schema.json", ScenarioManifestSchema],
  ["resolved-scenario-plan.schema.json", ResolvedScenarioPlanSchema],
  ["sealed-run-manifest.schema.json", SealedRunManifestSchema],
  ["design-contract.schema.json", DesignContractSchema],
  ["geometry-evaluator-config.schema.json", GeometryEvaluatorConfigSchema],
  ["mock-server-fixture-config.schema.json", MockServerFixtureConfigSchema],
  ["capture-bundle.schema.json", CaptureBundleSchema],
  ["evaluation-plan.schema.json", EvaluationPlanSchema],
  ["evaluation-policy.schema.json", EvaluationPolicySchema],
  ["evaluation-report.schema.json", EvaluationReportSchema],
]

export async function exportContractSchemas(outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true })
  for (const [name, schema] of schemaFiles) {
    const output = {
      $schema: DRAFT,
      ...schema,
    }
    await writeFile(
      resolve(outputDirectory, name),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    )
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(
    process.cwd(),
    process.argv[2] ?? "schemas",
  )
  void exportContractSchemas(outputDirectory).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Failed to export UI Eval schemas: ${message}\n`)
    process.exitCode = 1
  })
}
