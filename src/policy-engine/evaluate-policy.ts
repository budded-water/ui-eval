export type MetricPrimitive = string | number | boolean

export type GateExpression =
  | {
      metric: string
      operator: "lt" | "lte" | "gt" | "gte" | "eq"
      value: MetricPrimitive
    }
  | { allOf: GateExpression[] }
  | { anyOf: GateExpression[] }
  | { not: GateExpression }

export interface GatePolicy {
  id: string
  hard: boolean
  expression: GateExpression
  onUnknown: "fail" | "inconclusive" | "review"
}

export interface EvaluatedGate {
  gateId: string
  hard: boolean
  status: "pass" | "fail" | "unknown"
  reason: string
  unknownDisposition?: GatePolicy["onUnknown"]
}

type ExpressionResult =
  | { status: "pass" | "fail"; reason: string }
  | { status: "unknown"; reason: string }

function compare(
  actual: MetricPrimitive,
  operator: Extract<GateExpression, { metric: string }>["operator"],
  expected: MetricPrimitive,
): boolean | null {
  if (operator === "eq") return actual === expected
  if (typeof actual !== "number" || typeof expected !== "number") return null

  switch (operator) {
    case "lt":
      return actual < expected
    case "lte":
      return actual <= expected
    case "gt":
      return actual > expected
    case "gte":
      return actual >= expected
  }
}

function evaluateExpression(
  expression: GateExpression,
  metrics: Readonly<Record<string, MetricPrimitive | undefined>>,
): ExpressionResult {
  if ("metric" in expression) {
    const actual = metrics[expression.metric]
    if (actual === undefined) {
      return {
        status: "unknown",
        reason: `metric ${expression.metric} is unavailable`,
      }
    }

    const result = compare(actual, expression.operator, expression.value)
    if (result === null) {
      return {
        status: "unknown",
        reason: `metric ${expression.metric} has an incompatible type`,
      }
    }

    return {
      status: result ? "pass" : "fail",
      reason: `${expression.metric}=${String(actual)} ${expression.operator} ${String(expression.value)}`,
    }
  }

  if ("not" in expression) {
    const child = evaluateExpression(expression.not, metrics)
    if (child.status === "unknown") return child
    return {
      status: child.status === "pass" ? "fail" : "pass",
      reason: `not (${child.reason})`,
    }
  }

  const expressions = "allOf" in expression ? expression.allOf : expression.anyOf
  if (expressions.length === 0) {
    return {
      status: "unknown",
      reason: "empty compound expression",
    }
  }

  const children = expressions.map((child) => evaluateExpression(child, metrics))
  if ("allOf" in expression) {
    const failed = children.find((child) => child.status === "fail")
    if (failed) return failed
    const unknown = children.find((child) => child.status === "unknown")
    if (unknown) return unknown
    return { status: "pass", reason: "all expressions passed" }
  }

  const passed = children.find((child) => child.status === "pass")
  if (passed) return passed
  const unknown = children.find((child) => child.status === "unknown")
  if (unknown) return unknown
  return { status: "fail", reason: "all alternative expressions failed" }
}

export function evaluatePolicyGates(
  policies: readonly GatePolicy[],
  metrics: Readonly<Record<string, MetricPrimitive | undefined>>,
): EvaluatedGate[] {
  return policies.map((policy) => {
    const result = evaluateExpression(policy.expression, metrics)
    return {
      gateId: policy.id,
      hard: policy.hard,
      status: result.status,
      reason: result.reason,
      ...(result.status === "unknown"
        ? { unknownDisposition: policy.onUnknown }
        : {}),
    }
  })
}

export function decideRawStatus(
  executionOutcome: "valid" | "invalid-evidence" | "infra-error",
  gates: readonly EvaluatedGate[],
): "pass" | "fail" | "needs-review" | "inconclusive" {
  if (executionOutcome !== "valid") return "inconclusive"

  const isFailure = (gate: EvaluatedGate): boolean =>
    gate.status === "fail" ||
    (gate.status === "unknown" && gate.unknownDisposition === "fail")

  const hardFailure = gates.some(
    (gate) => gate.hard && isFailure(gate),
  )
  if (hardFailure) return "fail"

  const inconclusive = gates.some(
    (gate) =>
      gate.status === "unknown" && gate.unknownDisposition === "inconclusive",
  )
  if (inconclusive) return "inconclusive"

  const review = gates.some(
    (gate) =>
      (!gate.hard && isFailure(gate)) ||
      (gate.status === "unknown" && gate.unknownDisposition === "review"),
  )
  if (review) return "needs-review"

  return "pass"
}
