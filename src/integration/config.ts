import { lstat, readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { containedPath } from "../wechat-pilot/config"

const strict = { additionalProperties: false }
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" })
const text = Type.String({ minLength: 1, maxLength: 2048 })
export const IntegrationCommandSchema = Type.Object({
  command: text,
  args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 1_800_000 }),
}, strict)

export const EnginePinSchema = Type.Object({
  repository: Type.String({ pattern: "^https://[^/@?#]+/[^?#]+$", maxLength: 512 }),
  revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  bunVersion: Type.Optional(Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" })),
}, strict)
export type EnginePin = Static<typeof EnginePinSchema>

export const IntegrationSuiteSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/integration-v1alpha1"),
  kind: Type.Literal("IntegrationSuite"),
  id,
  projectId: id,
  adapter: Type.Union([Type.Literal("web"), Type.Literal("wechat-pilot")]),
  executionProfile: Type.Optional(id),
  browserChannel: Type.Optional(text),
  driver: Type.Optional(text),
  prepare: Type.Optional(IntegrationCommandSchema),
  checks: Type.Array(Type.Object({
    ...IntegrationCommandSchema.properties,
    id,
    phase: Type.Union([Type.Literal("before"), Type.Literal("after")]),
    dimension: id,
    failureOutcome: Type.Union([Type.Literal("candidate"), Type.Literal("infrastructure")]),
  }, strict), { maxItems: 100 }),
  scenarios: Type.Array(Type.Object({
    id,
    policy: Type.Optional(text),
    reference: Type.Optional(text),
    timeoutMs: Type.Integer({ minimum: 1000, maximum: 1_800_000 }),
  }, strict), { minItems: 1, maxItems: 100 }),
}, strict)
export type IntegrationSuite = Static<typeof IntegrationSuiteSchema>

/** Project inputs must be bounded regular files with no symlink ancestors. */
export async function readIntegrationJson(root: string, reference: string, limit = 1024 * 1024): Promise<unknown> {
  const path = await containedPath(root, reference)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size > limit) throw new Error("Integration input is not a bounded regular file")
  return JSON.parse(await readFile(path, "utf8"))
}

export async function loadIntegrationSuite(projectRoot: string, suite: string) {
  const root = await realpath(projectRoot)
  const path = suite.includes("/") || suite.endsWith(".json") ? suite : `ui-eval/integrations/${suite}.json`
  const input = await readIntegrationJson(root, path)
  if (!Value.Check(IntegrationSuiteSchema, input)) throw new Error("Invalid integration suite")
  const unique = (ids: string[]) => new Set(ids).size === ids.length
  if (!unique(input.scenarios.map((entry) => entry.id)) || !unique(input.checks.map((entry) => entry.id))) {
    throw new Error("Integration scenario and check IDs must be unique")
  }
  if (input.adapter === "web" ? input.driver !== undefined :
    input.executionProfile !== undefined || input.browserChannel !== undefined || input.scenarios.some((entry) => entry.policy || entry.reference)) {
    throw new Error("Integration options are not supported by the selected adapter")
  }
  return { projectRoot: root, path: resolve(root, path), value: input }
}

export async function loadEnginePin(root: string): Promise<EnginePin> {
  const input = await readIntegrationJson(root, "ui-eval/engine.json")
  if (!Value.Check(EnginePinSchema, input)) throw new Error("Invalid ui-eval/engine.json pin")
  return input
}
