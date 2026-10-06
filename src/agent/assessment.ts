import type { EvaluationRunResult } from "../orchestrator/evaluate"
import type { AgentSuite } from "./config"
import type { AgentCheckResult, AgentScenarioResult, AgentDimensionResult } from "./model"

function visualRatio(run: EvaluationRunResult): number | undefined {
  const ratio = run.report.spec.metrics?.["visual.changedPixelRatio"]
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? ratio : undefined
}

export function assessScenario(
  scenario: AgentSuite["scenarios"][number],
  runs: EvaluationRunResult[],
): AgentScenarioResult {
  const reasons: string[] = []
  let score = 1
  if (runs.length === 0) {
    reasons.push("no sealed evaluation runs were produced")
    score = 0
  }
  const ratios = runs.map(visualRatio).filter((value): value is number => value !== undefined)
  const ratio = ratios.length > 0 ? Math.max(...ratios) : undefined

  for (const run of runs) {
    if (run.rawStatus === "fail" || run.rawStatus === "inconclusive" ||
      (run.rawStatus === "needs-review" && !scenario.reference)) {
      reasons.push(`${run.variantKey}: report ${run.rawStatus}`)
      score = 0
    }
    if (run.executionOutcome !== "valid") {
      reasons.push(`${run.variantKey}: evidence ${run.executionOutcome}`)
      score = 0
    }
    const failedHardGates = run.report.spec.gates.filter(
      (gate) => gate.hard && gate.status !== "pass",
    )
    if (failedHardGates.length > 0) {
      reasons.push(
        `${run.variantKey}: hard gates ${failedHardGates.map((gate) => gate.gateId).join(", ")}`,
      )
      score = 0
    }
    const nonVisualFindings = run.report.spec.findings.filter(
      (finding) => finding.dimension !== "pixel",
    )
    if (nonVisualFindings.length > 0) {
      reasons.push(`${run.variantKey}: ${nonVisualFindings.length} non-visual findings`)
      score = Math.min(score, 0.5)
    }
    if (scenario.reference && visualRatio(run) === undefined) {
      reasons.push(`${run.variantKey}: visual reference was declared but no pixel metric was produced`)
      score = 0
    }
  }

  if (scenario.reference) {
    if (scenario.maxChangedPixelRatio === undefined) {
      reasons.push("visual reference has no predeclared acceptance threshold")
      score = 0
    } else if (ratio !== undefined && ratio > scenario.maxChangedPixelRatio) {
      reasons.push(
        `pixel ratio ${ratio.toFixed(6)} exceeds ${scenario.maxChangedPixelRatio.toFixed(6)}`,
      )
      score = Math.min(score, Math.max(0, 1 - ratio))
    }
  }

  return {
    id: scenario.id,
    accepted: reasons.length === 0,
    score,
    ...(ratio === undefined ? {} : { changedPixelRatio: ratio }),
    ...(scenario.maxChangedPixelRatio === undefined
      ? {}
      : { maxChangedPixelRatio: scenario.maxChangedPixelRatio }),
    reports: runs.map((run) => ({
      variantKey: run.variantKey,
      rawStatus: run.rawStatus,
      executionOutcome: run.executionOutcome,
      reportPath: run.reportPath,
      htmlPath: run.htmlPath,
    })),
    reasons,
  }
}

export function assessDimensions(
  suite: AgentSuite,
  checks: AgentCheckResult[],
  scenarios: AgentScenarioResult[],
): AgentDimensionResult[] {
  return suite.requiredDimensions.map((id) => {
    const checkEvidence = suite.checks
      .map((check, index) => ({ config: check, result: checks[index] }))
      .filter(({ config }) => config.dimension === id && config !== undefined)
      .map(({ result }) => result)
      .filter((result): result is AgentCheckResult => result !== undefined)
    const scenarioEvidence = suite.scenarios
      .filter((scenario) => scenario.dimensions.includes(id))
      .map((scenario) => scenarios.find((result) => result.id === scenario.id))
      .filter((result): result is AgentScenarioResult => result !== undefined)
    const evidence = [
      ...checkEvidence.map((check) => `check:${check.id}`),
      ...scenarioEvidence.map((scenario) => `scenario:${scenario.id}`),
    ]
    if (evidence.length === 0) {
      return { id, status: "not-evaluated", score: 0, evidence }
    }
    const passed =
      checkEvidence.every((check) => check.passed) &&
      scenarioEvidence.every((scenario) => scenario.accepted)
    return {
      id,
      status: passed ? "pass" : "fail",
      score: passed ? 1 : 0,
      evidence,
    }
  })
}

export function repairProgress(
  suite: AgentSuite,
  checks: readonly AgentCheckResult[],
  scenarios: readonly AgentScenarioResult[],
): number {
  const checkScores = suite.checks.map((check) =>
    checks.find((result) => result.id === check.id)?.passed ? 1 : 0,
  )
  const scenarioScores = suite.scenarios.map((scenario) =>
    scenarios.find((result) => result.id === scenario.id)?.score ?? 0,
  )
  const scores = [...checkScores, ...scenarioScores]
  return Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(6))
}
