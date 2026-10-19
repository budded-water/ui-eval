import { Type, type Static } from "@sinclair/typebox"

const strict = { additionalProperties: false }
const apiVersion = Type.Literal("uieval.io/integration-session-v1")
const sessionId = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" })
const text = Type.String({ minLength: 1, maxLength: 4096 })

/** Trusted, argv-only lifecycle for resources shared by one integration suite. */
export const IntegrationSessionSchema = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 2048 }),
  args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
  startupTimeoutMs: Type.Integer({ minimum: 1, maximum: 300_000 }),
  cleanupTimeoutMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
}, strict)
export type IntegrationSession = Static<typeof IntegrationSessionSchema>

export const IntegrationSessionStartSchema = Type.Object({
  apiVersion, kind: Type.Literal("start"), sessionId,
  executionId: text,
  projectId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" }),
  integrationDirectory: text,
  suiteDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  deviceId: Type.Optional(text),
}, strict)
export type IntegrationSessionStart = Static<typeof IntegrationSessionStartSchema>
export type IntegrationSessionContext = Omit<IntegrationSessionStart, "apiVersion" | "kind" | "sessionId">

export const IntegrationSessionReadySchema = Type.Object({
  apiVersion, kind: Type.Literal("ready"), sessionId,
}, strict)
export type IntegrationSessionReady = Static<typeof IntegrationSessionReadySchema>

export const IntegrationSessionStopSchema = Type.Object({
  apiVersion, kind: Type.Literal("stop"), sessionId,
}, strict)
export type IntegrationSessionStop = Static<typeof IntegrationSessionStopSchema>

export const IntegrationSessionStoppedSchema = Type.Object({
  apiVersion, kind: Type.Literal("stopped"), sessionId,
  status: Type.Union([Type.Literal("pass"), Type.Literal("inconclusive")]),
}, strict)
export type IntegrationSessionStopped = Static<typeof IntegrationSessionStoppedSchema>
