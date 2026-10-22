import { Type, type Static, type TLiteral } from "@sinclair/typebox"
import { isSchema } from "./validation"
import { DigestSchema } from "./schemas"

const strict = { additionalProperties: false }
const text = Type.String({ minLength: 1, maxLength: 2048 })
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" })
const choice = <const T extends string[]>(values: T) => Type.Union(values.map((value) => Type.Literal(value)) as { [K in keyof T]: TLiteral<T[K]> })
export const VerificationLevelSchema = choice(["L1", "L2", "L3", "L4", "L5"])
export const VerificationEnvironmentSchema = Type.Object({
  platform: choice(["host", "web", "ios-simulator", "wechat-devtools", "physical-device"]),
  profile: Type.Optional(text),
  deviceId: Type.Optional(text),
  variantKey: Type.Optional(text),
}, strict)
const selector = Type.Object({ kind: choice(["check", "scenario", "external"]), id }, strict)
export const VerificationPlanSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/verification-v1alpha1"),
  kind: Type.Literal("VerificationPlan"),
  id, projectId: id,
  outcome: text,
  plannedAt: Type.String({ format: "date-time" }),
  planningContext: text,
  requirements: Type.Array(Type.Object({
    id, category: choice(["code", "ui", "release"]),
    rationale: text, expectedOutcome: text,
    level: VerificationLevelSchema,
    environment: VerificationEnvironmentSchema,
    selector,
    visualReview: Type.Boolean(),
  }, strict), { minItems: 1, maxItems: 200 }),
  omissions: Type.Array(Type.Object({ scope: text, reason: text }, strict), { maxItems: 100 }),
}, strict)
export type VerificationPlan = Static<typeof VerificationPlanSchema>
export type VerificationEnvironment = Static<typeof VerificationEnvironmentSchema>
export const VerificationEvidenceSchema = Type.Object({
  id: text, projectId: id, sourceDigest: DigestSchema,
  level: VerificationLevelSchema,
  environment: VerificationEnvironmentSchema,
  selector,
  status: choice(["pass", "fail", "needs-review", "inconclusive", "not-run"]),
  references: Type.Array(text, { minItems: 1, maxItems: 100 }),
  origin: choice(["validated-adapter", "declared-command"]),
}, strict)
export type VerificationEvidence = Static<typeof VerificationEvidenceSchema>
const disposition = choice(["pass", "fail", "needs-review", "inconclusive", "not-run", "invalid-evidence", "not-assessed"])
export const VerificationAssessmentSchema = Type.Object({
  planDigest: DigestSchema, sourceDigest: DigestSchema,
  requirements: Type.Array(Type.Object({
    id, status: disposition,
    evidenceIds: Type.Array(text),
    reasons: Type.Array(text),
  }, strict)),
  conclusions: Type.Object({ code: disposition, ui: disposition, release: disposition }, strict),
  exitCode: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
}, strict)
export type VerificationAssessment = Static<typeof VerificationAssessmentSchema>
export const VerificationRecordSchema = Type.Object({
  plan: VerificationPlanSchema,
  evidence: Type.Array(VerificationEvidenceSchema, { maxItems: 2000 }),
  assessment: VerificationAssessmentSchema,
}, strict)
export type VerificationRecord = Static<typeof VerificationRecordSchema>

export function assertVerificationPlan(input: unknown): asserts input is VerificationPlan {
  if (!isSchema(VerificationPlanSchema, input)) throw new Error("Invalid verification plan")
  if (new Set(input.requirements.map((item) => item.id)).size !== input.requirements.length) throw new Error("Duplicate verification requirement")
  for (const item of input.requirements) {
    if (item.category === "ui" && !["L4", "L5"].includes(item.level)) throw new Error("UI requirements need runtime evidence")
    if (item.level === "L5" && item.environment.platform !== "physical-device") throw new Error("L5 needs a physical-device environment")
    if (item.level === "L4" && !["web", "ios-simulator", "wechat-devtools"].includes(item.environment.platform)) throw new Error("L4 needs a supported UI environment")
  }
}
