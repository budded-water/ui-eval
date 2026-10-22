import { Type, type Static } from "@sinclair/typebox"
import { isSchema } from "../contracts/validation"
import { EnginePinSchema } from "./config"
import { SourceRevisionSchema } from "../contracts/schemas"
import { canonicalDigest } from "../contracts/canonical-json"
import { VerificationRecordSchema } from "../contracts/verification"
import { assertVerificationRecord } from "../verification/assess"
import { assertIntegrationVerification, integrationVerificationSource, verificationExitCode } from "./verification"

const strict = { additionalProperties: false }
const text = Type.String({ minLength: 1 })
const duration = Type.Number({ minimum: 0 })
const status = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("needs-review"), Type.Literal("inconclusive"), Type.Literal("not-run")])
const exit = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(130), Type.Literal(143)])
const report = Type.Object({
  executionId: text, variantKey: text, status,
  reportPath: text, htmlPath: text,
  reportDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  htmlDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  evidenceDigest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
  capabilities: Type.Array(Type.Object({ dimension: text, status: text, detail: text }, strict)),
}, strict)

export const IntegrationResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/integration-v1alpha1"),
  kind: Type.Literal("IntegrationResult"),
  executionId: text,
  projectId: text,
  suiteId: text,
  suiteDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  engine: EnginePinSchema,
  adapter: Type.Union([Type.Literal("web"), Type.Literal("wechat-pilot"), Type.Literal("native-pilot")]),
  deviceId: Type.Optional(Type.String({ pattern: "^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$" })),
  executionProfile: Type.Optional(text),
  browserChannel: Type.Optional(text),
  startedAt: text,
  durationMs: duration,
  exitCode: exit,
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("needs-review"), Type.Literal("inconclusive"), Type.Literal("interrupted")]),
  stages: Type.Array(Type.Object({
    id: text,
    kind: Type.Union([Type.Literal("engine"), Type.Literal("prepare"), Type.Literal("session"), Type.Literal("check"), Type.Literal("scenario"), Type.Literal("source"), Type.Literal("evidence")]),
    dimension: Type.Optional(text),
    status,
    durationMs: duration,
    reason: text,
    cleanupSettled: Type.Optional(Type.Boolean()),
    reports: Type.Array(report),
    reusedFrom: Type.Optional(text),
    attempts: Type.Optional(Type.Array(Type.Object({ status, durationMs: duration, reason: text, reports: Type.Array(report) }, strict), { minItems: 1, maxItems: 3 })),
  }, strict)),
  sourceDigest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
  source: Type.Optional(SourceRevisionSchema),
  recoveryContextDigest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
  resumedFrom: Type.Optional(text),

  verification: Type.Optional(VerificationRecordSchema),
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
  if (!isSchema(IntegrationResultSchema, input)) throw new Error("Invalid integration result")
  if (input.source && canonicalDigest(input.source) !== input.sourceDigest) throw new Error("Integration source digest mismatch")
  if ((input.adapter === "native-pilot") !== (input.deviceId !== undefined)) throw new Error("Integration device does not match adapter")
  const ids = input.stages.map((stage) => `${stage.kind}:${stage.id}`)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate integration stages")
  for (const stage of input.stages) {
    if ((stage.reusedFrom || stage.attempts) && (input.adapter !== "native-pilot" || stage.kind !== "scenario")) throw new Error("Recovery metadata is native scenario evidence only")
    if (stage.reusedFrom && (stage.status !== "pass" || stage.attempts)) throw new Error("Only an accepted native scenario may be reused")
    if (stage.attempts) {
      const last = stage.attempts.at(-1)!
      if (last.status !== stage.status || canonicalDigest(last.reports) !== canonicalDigest(stage.reports)) throw new Error("Native attempt metadata contradicts final evidence")
      if (stage.attempts.slice(0, -1).some((attempt) => attempt.status !== "inconclusive")) throw new Error("Only infrastructure attempts may be retried")
    }
    if (stage.cleanupSettled === false && stage.status !== "inconclusive") throw new Error("Incomplete cleanup cannot pass")
    if (stage.kind !== "scenario" && stage.reports.length) throw new Error("Only scenario stages can carry adapter reports")
    if (stage.kind === "scenario" && ["pass", "fail", "needs-review"].includes(stage.status)) {
      const code = integrationExitCode(stage.reports.map((report) => ({ ...stage, status: report.status })))
      if (({ 0: "pass", 1: "fail", 2: "inconclusive", 3: "needs-review" } as const)[code] !== stage.status) {
        throw new Error("Integration scenario contradicts its adapter reports")
      }
    }
  }
  if (input.verification) {
    assertVerificationRecord(input.verification)
    assertIntegrationVerification(input)
    if (input.verification.plan.projectId !== input.projectId || input.verification.assessment.sourceDigest !== integrationVerificationSource(input)) throw new Error("Verification scope contradicts integration")
  }
  const expectedExit = verificationExitCode(integrationExitCode(input.stages), input.verification?.assessment.exitCode ?? 0)
  const expected = input.exitCode === 130 || input.exitCode === 143 ? "interrupted"
    : ({ 0: "pass", 1: "fail", 2: "inconclusive", 3: "needs-review" } as const)[expectedExit]
  if (input.status !== expected || (input.status !== "interrupted" && input.exitCode !== expectedExit)) {
    throw new Error("Integration disposition contradicts its stages")
  }
}
