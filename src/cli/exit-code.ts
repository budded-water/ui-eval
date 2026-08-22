export interface EvaluationOutcomeLike {
  executionOutcome: "valid" | "invalid-evidence" | "infra-error"
  rawStatus: "pass" | "fail" | "needs-review" | "inconclusive"
}

export function evaluationExitCode(outcome: EvaluationOutcomeLike): number {
  if (outcome.executionOutcome !== "valid") return 2

  switch (outcome.rawStatus) {
    case "pass":
      return 0
    case "fail":
      return 1
    case "needs-review":
      return 3
    case "inconclusive":
      return 2
  }
}
