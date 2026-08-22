import { describe, expect, it } from "vitest"

import { evaluationExitCode } from "./exit-code"

describe("evaluationExitCode", () => {
  it.each([
    ["valid", "pass", 0],
    ["valid", "fail", 1],
    ["valid", "needs-review", 3],
    ["invalid-evidence", "inconclusive", 2],
    ["infra-error", "inconclusive", 2],
  ] as const)(
    "maps %s/%s to %i",
    (executionOutcome, rawStatus, expected) => {
      expect(evaluationExitCode({ executionOutcome, rawStatus })).toBe(expected)
    },
  )
})
