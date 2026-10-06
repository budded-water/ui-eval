import { Type, type Static } from "@sinclair/typebox"
import { EvaluationReportSpecSchema } from "../contracts/schemas"

const strict = { additionalProperties: false }
const text = Type.String({ minLength: 1 })
const score = Type.Number({ minimum: 0, maximum: 1 })
const AgentStatusSchema = Type.Union((["accepted", "blocked", "exhausted", "plateau"] as const).map((status) => Type.Literal(status)))
const AgentCheckResultSchema = Type.Object({
  id: text, passed: Type.Boolean(),
  onFailure: Type.Union([Type.Literal("repair"), Type.Literal("block")]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  durationMs: Type.Number({ minimum: 0 }), output: Type.String(),
}, strict)
const AgentScenarioResultSchema = Type.Object({
  id: text, accepted: Type.Boolean(), score,
  changedPixelRatio: Type.Optional(score), maxChangedPixelRatio: Type.Optional(score),
  reusedFromIteration: Type.Optional(Type.Integer({ minimum: 1 })),
  cleanupSettled: Type.Optional(Type.Boolean()),
  reports: Type.Array(Type.Object({
    variantKey: text,
    rawStatus: EvaluationReportSpecSchema.properties.rawStatus,
    executionOutcome: EvaluationReportSpecSchema.properties.executionOutcome,
    reportPath: text, htmlPath: text,
  }, strict)),
  reasons: Type.Array(Type.String()),
}, strict)
const AgentDimensionResultSchema = Type.Object({
  id: text,
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("not-evaluated")]),
  score: Type.Union([Type.Literal(0), Type.Literal(1)]), evidence: Type.Array(text),
}, strict)
const AgentIterationSchema = Type.Object({
  iteration: Type.Integer({ minimum: 1 }), score,
  progressScore: Type.Optional(score), accepted: Type.Boolean(),
  checks: Type.Array(AgentCheckResultSchema), scenarios: Type.Array(AgentScenarioResultSchema),
  dimensions: Type.Array(AgentDimensionResultSchema), changedFiles: Type.Array(text),
  repairRequestPath: Type.Optional(text),
}, strict)
export const AgentRunResultSchema = Type.Object({
  suiteId: text, status: AgentStatusSchema, accepted: Type.Boolean(),
  iterations: Type.Array(AgentIterationSchema), summaryPath: text, summaryHtmlPath: text,
  generatedAt: Type.String({ format: "date-time" }), reason: text,
}, strict)

export type AgentStatus = Static<typeof AgentStatusSchema>
export type AgentCheckResult = Static<typeof AgentCheckResultSchema>
export type AgentScenarioResult = Static<typeof AgentScenarioResultSchema>
export type AgentDimensionResult = Static<typeof AgentDimensionResultSchema>
export type AgentIteration = Static<typeof AgentIterationSchema>
export type AgentRunResult = Static<typeof AgentRunResultSchema>
