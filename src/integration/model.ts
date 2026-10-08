import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { EnginePinSchema } from "./config"

const strict = { additionalProperties: false }
const text = Type.String({ minLength: 1 })
const duration = Type.Number({ minimum: 0 })
const status = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("needs-review"), Type.Literal("inconclusive"), Type.Literal("not-run")])
const exit = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(130), Type.Literal(143)])

export const IntegrationResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/integration-v1alpha1"),
  kind: Type.Literal("IntegrationResult"),
  executionId: text,
  projectId: text,
  suiteId: text,
  suiteDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  engine: EnginePinSchema,
  adapter: Type.Union([Type.Literal("web"), Type.Literal("wechat-pilot")]),
  executionProfile: Type.Optional(text),
  browserChannel: Type.Optional(text),
  startedAt: text,
  durationMs: duration,
  exitCode: exit,
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("needs-review"), Type.Literal("inconclusive"), Type.Literal("interrupted")]),
  stages: Type.Array(Type.Object({
    id: text,
    kind: Type.Union([Type.Literal("engine"), Type.Literal("prepare"), Type.Literal("check"), Type.Literal("scenario"), Type.Literal("source"), Type.Literal("evidence")]),
    dimension: Type.Optional(text),
    status,
    durationMs: duration,
    reason: text,
    cleanupSettled: Type.Optional(Type.Boolean()),
    reports: Type.Array(Type.Object({
      executionId: text, variantKey: text, status,
      reportPath: text, htmlPath: text,
      reportDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
      htmlDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
      capabilities: Type.Array(Type.Object({ dimension: text, status: text, detail: text }, strict)),
    }, strict)),
  }, strict)),
  sourceDigest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
  summaryPath: text,
  summaryHtmlPath: text,
  limitations: Type.Array(text),
}, strict)
export type IntegrationResult = Static<typeof IntegrationResultSchema>
export type IntegrationStage = IntegrationResult["stages"][number]

/** Infrastructure and incomplete scope take precedence over candidate/review results. */
export function integrationExitCode(stages: readonly IntegrationStage[]): 0 | 1 | 2 | 3 {
  if (!stages.length || stages.some((stage) => ["inconclusive", "not-run"].includes(stage.status))) return 2
  if (stages.some((stage) => stage.status === "fail")) return 1
  if (stages.some((stage) => stage.status === "needs-review")) return 3
  return 0
}

export function assertIntegrationResult(input: unknown): asserts input is IntegrationResult {
  if (!Value.Check(IntegrationResultSchema, input)) throw new Error("Invalid integration result")
  const ids = input.stages.map((stage) => `${stage.kind}:${stage.id}`)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate integration stages")
  for (const stage of input.stages) {
    if (stage.cleanupSettled === false && stage.status !== "inconclusive") throw new Error("Incomplete cleanup cannot pass")
    if (stage.kind !== "scenario" && stage.reports.length) throw new Error("Only scenario stages can carry adapter reports")
    if (stage.kind === "scenario" && ["pass", "fail", "needs-review"].includes(stage.status)) {
      const code = integrationExitCode(stage.reports.map((report) => ({ ...stage, status: report.status })))
      if (({ 0: "pass", 1: "fail", 2: "inconclusive", 3: "needs-review" } as const)[code] !== stage.status) {
        throw new Error("Integration scenario contradicts its adapter reports")
      }
    }
  }
  const expected = input.exitCode === 130 || input.exitCode === 143 ? "interrupted"
    : ({ 0: "pass", 1: "fail", 2: "inconclusive", 3: "needs-review" } as const)[integrationExitCode(input.stages)]
  if (input.status !== expected || (input.status !== "interrupted" && input.exitCode !== integrationExitCode(input.stages))) {
    throw new Error("Integration disposition contradicts its stages")
  }
}
