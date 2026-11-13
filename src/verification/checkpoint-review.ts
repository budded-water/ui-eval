import { Type } from "@sinclair/typebox"

const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
/** Shared human-observation fields; adapter-specific evidence validation stays with its owner. */
export const CheckpointReviewFields = {
  executionId: Type.String(), projectId: Type.String(), reviewId: Type.String(), scenarioId: Type.String(),
  checkpointId: Type.String(), criterion: Type.String(),
  method: Type.Literal("human-observation"),
  decision: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("inconclusive")]),
  reviewerAlias: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
  note: Type.String({ minLength: 1, maxLength: 1000 }),
  sourceDigest: digest, reportDigest: digest, screenshotDigest: digest,
  reportPath: Type.String(), recordedAt: Type.String(),
}
