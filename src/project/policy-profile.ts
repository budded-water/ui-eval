import { Type, type Static } from "@sinclair/typebox"
import { CORE_EVALUATOR_CONFIGS, CORE_EVALUATOR_VERSION, CORE_GATE_REQUIREMENTS } from "../contracts/core-policy"
import { GateExpressionSchema, PolicySourceSchema } from "../contracts/schemas"
import type { PolicySource } from "../contracts/model"

const fields = PolicySourceSchema.properties
// Share one recursive expression definition across both authoring branches.
const gates = Type.Array(Type.Object({
  ...fields.gates.items.properties,
  expression: Type.Ref(GateExpressionSchema),
}, { additionalProperties: false }))
const WebDefaultPolicySourceSchema = Type.Object({
  $schema: fields.$schema,
  apiVersion: fields.apiVersion,
  kind: fields.kind,
  id: fields.id,
  revision: fields.revision,
  profile: Type.Literal("web-default"),
  evaluators: Type.Optional(fields.evaluators),
  gates: Type.Optional(gates),
}, { additionalProperties: false })

/** Active web authoring accepts a compact profile or the existing full policy. */
export const WebPolicySourceSchema = Type.Union([
  WebDefaultPolicySourceSchema,
  Type.Object({ ...fields, gates }, { additionalProperties: false }),
], {
  $id: "https://uieval.io/source/web-policy",
  $defs: { gateExpression: GateExpressionSchema },
})
export type WebPolicySource = Static<typeof WebPolicySourceSchema>

export function expandWebPolicy(source: WebPolicySource): PolicySource {
  if (!("profile" in source)) return source
  const evaluators: PolicySource["evaluators"] = Object.entries(CORE_EVALUATOR_CONFIGS).map(([id, config]) => ({
    id, version: CORE_EVALUATOR_VERSION, config: structuredClone(config), required: true, weight: 0,
  }))
  evaluators.push({ id: "visual", version: CORE_EVALUATOR_VERSION, config: { mode: "advisory" }, required: false, weight: 0 })
  const gates: PolicySource["gates"] = CORE_GATE_REQUIREMENTS.map(({ id, metric, value }) => ({
    id, hard: true, expression: { metric, operator: "eq", value }, onUnknown: "fail",
  }))
  gates.push({
    id: "required-evidence-coverage", hard: true,
    expression: { metric: "coverage.requiredRatio", operator: "gte", value: 1 }, onUnknown: "inconclusive",
  })
  // Additions cannot replace or weaken profile invariants. Existing full
  // policies remain the explicit authoring path for different optional settings.
  return {
    apiVersion: source.apiVersion, kind: source.kind, id: source.id, revision: source.revision,
    evaluators: [...evaluators, ...(source.evaluators ?? [])],
    gates: [...gates, ...(source.gates ?? [])],
    tolerances: [], repeatability: { attempts: 1, requiredAgreement: 1 }, dynamicRegions: [],
    agentMutation: {
      allowedPathGlobs: ["src/**", "app/**", "components/**", "lib/**"],
      protectedPathGlobs: ["ui-eval/policies/**", "ui-eval/baselines/**", ".ui-eval/**"],
      maxChangedFiles: 12, maxChangedLines: 800,
    },
  }
}
