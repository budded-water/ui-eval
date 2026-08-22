import { describe, expect, it } from "vitest"

import {
  decideRawStatus,
  evaluatePolicyGates,
  type GatePolicy,
} from "./evaluate-policy"

const hardInteractionGate: GatePolicy = {
  id: "interaction",
  hard: true,
  expression: {
    metric: "interaction.failedAssertions",
    operator: "eq",
    value: 0,
  },
  onUnknown: "fail",
}

describe("evaluatePolicyGates", () => {
  it("evaluates the restricted expression AST", () => {
    const gates = evaluatePolicyGates(
      [
        hardInteractionGate,
        {
          id: "runtime-and-coverage",
          hard: true,
          expression: {
            allOf: [
              {
                metric: "runtime.criticalErrors",
                operator: "eq",
                value: 0,
              },
              {
                metric: "coverage.requiredRatio",
                operator: "gte",
                value: 1,
              },
            ],
          },
          onUnknown: "inconclusive",
        },
      ],
      {
        "interaction.failedAssertions": 0,
        "runtime.criticalErrors": 0,
        "coverage.requiredRatio": 1,
      },
    )

    expect(gates.map(({ status }) => status)).toEqual(["pass", "pass"])
  })

  it("does not convert an unknown required metric into pass", () => {
    const [gate] = evaluatePolicyGates([hardInteractionGate], {})

    expect(gate.status).toBe("unknown")
    expect(gate.unknownDisposition).toBe("fail")
  })

  it("keeps visual advisory from offsetting a hard interaction failure", () => {
    const gates = evaluatePolicyGates(
      [
        hardInteractionGate,
        {
          id: "visual-advisory",
          hard: false,
          expression: {
            metric: "visual.changedPixelRatio",
            operator: "lte",
            value: 0,
          },
          onUnknown: "review",
        },
      ],
      {
        "interaction.failedAssertions": 1,
        "visual.changedPixelRatio": 0,
      },
    )

    expect(decideRawStatus("valid", gates)).toBe("fail")
  })

  it("maps unknown policy semantics to review or inconclusive", () => {
    const review = evaluatePolicyGates(
      [
        {
          ...hardInteractionGate,
          onUnknown: "review",
        },
      ],
      {},
    )
    const inconclusive = evaluatePolicyGates(
      [
        {
          ...hardInteractionGate,
          onUnknown: "inconclusive",
        },
      ],
      {},
    )

    expect(decideRawStatus("valid", review)).toBe("needs-review")
    expect(decideRawStatus("valid", inconclusive)).toBe("inconclusive")
  })

  it.each([
    { hard: true, onUnknown: "fail", expected: "fail" },
    { hard: false, onUnknown: "fail", expected: "needs-review" },
    { hard: true, onUnknown: "review", expected: "needs-review" },
    { hard: false, onUnknown: "review", expected: "needs-review" },
    { hard: true, onUnknown: "inconclusive", expected: "inconclusive" },
    { hard: false, onUnknown: "inconclusive", expected: "inconclusive" },
  ] as const)(
    "maps a $hard gate with unknown disposition $onUnknown to $expected",
    ({ hard, onUnknown, expected }) => {
      const gates = evaluatePolicyGates(
        [{ ...hardInteractionGate, hard, onUnknown }],
        {},
      )

      expect(decideRawStatus("valid", gates)).toBe(expected)
    },
  )

  it("keeps a known soft failure advisory", () => {
    const gates = evaluatePolicyGates(
      [{ ...hardInteractionGate, hard: false }],
      { "interaction.failedAssertions": 1 },
    )

    expect(decideRawStatus("valid", gates)).toBe("needs-review")
  })

  it("gives invalid evidence and infrastructure precedence over quality gates", () => {
    const gates = evaluatePolicyGates([hardInteractionGate], {
      "interaction.failedAssertions": 0,
    })

    expect(decideRawStatus("invalid-evidence", gates)).toBe("inconclusive")
    expect(decideRawStatus("infra-error", gates)).toBe("inconclusive")
  })
})
