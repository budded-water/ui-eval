import type { EvaluationReportSpec } from "../contracts/model"
import type { EvaluationReportView } from "./render"

/** Capability labels are a projection of actual execution and canonical coverage. */
export function reportCapabilities(report: Pick<EvaluationReportSpec, "executionOutcome" | "coverage" | "provenance">): EvaluationReportView["capabilities"] {
  const executed = (id: string) => report.provenance.evaluators.some((evaluator) => evaluator.id === id)
  const dimension = (id: string) => report.coverage.byDimension.find((entry) => entry.dimension === id)?.counts
  const measured = report.executionOutcome === "valid" ? "measured" : "unknown"
  const geometry = dimension("geometry")
  const geometryStatus = !executed("geometry") ? "unsupported"
    : !geometry || geometry.invalid > 0 || geometry.unsupported > 0 ? "unknown" : "measured"
  return [
    { dimension: "Execution", status: measured, detail: "Route reachability and scenario-step execution." },
    { dimension: "Interaction / content", status: measured, detail: "Only explicit assertions declared by the scenario." },
    { dimension: "Runtime / network", status: measured, detail: "Page errors and same-origin failures are blocking; unauthenticated third-party failures are advisory." },
    { dimension: "Pixel change", status: executed("visual") && (dimension("pixel")?.evaluated ?? 0) > 0 ? "measured" : "unknown",
      detail: executed("visual") ? "Local reference trust: local-unprotected; changed pixels require review." : "No local same-size reference was evaluated." },
    { dimension: "Geometry / typography constraints", status: geometryStatus,
      detail: executed("geometry") ? "Policy-selected constraints over structured web evidence; coverage includes missing planned work. Results are not calibrated quality scores." : "No runnable geometry evaluator was selected by the policy." },
  ]
}
