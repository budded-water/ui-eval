/**
 * Geometry and typography evaluation over normalized web evidence.
 *
 * Deterministic and side-effect free: it consumes immutable evidence plus a
 * sealed config and produces metrics, coverage counts, and findings. It never
 * drives a browser, reads a design source, or mutates candidate source.
 *
 * Structured evidence is required. Nothing here may run from raster pixels, and
 * an absent or unreadable property produces unknown rather than a pass.
 */

import type {
  CoverageCounts,
  GeometryEvaluatorConfig,
  LayoutEvidencePayload,
  StylesEvidencePayload,
} from "../../contracts/model"
import type { MetricPrimitive } from "../../policy-engine/evaluate-policy"

import {
  ConstraintConfigurationError,
  evaluateConstraints,
  type ConstraintResult,
} from "./constraints"
import { normalizeWebEvidence } from "./normalize-web"

export { ConstraintConfigurationError }

export interface GeometryCheckpointEvidence {
  readonly checkpointId: string
  readonly layout: LayoutEvidencePayload
  readonly styles?: StylesEvidencePayload
}

export interface GeometryFinding {
  readonly constraintId: string
  readonly checkpointId: string
  readonly metricKey: string
  readonly dimension: "geometry"
  readonly severity: "major"
  readonly summary: string
  readonly explanation: string
}

export interface GeometryEvaluation {
  readonly results: ReadonlyArray<ConstraintResult & { checkpointId: string }>
  readonly metrics: Readonly<Record<string, MetricPrimitive>>
  readonly coverage: CoverageCounts
  readonly findings: readonly GeometryFinding[]
}

/**
 * One constraint on one checkpoint is one unit of coverage. Counting nodes
 * instead would let a constraint over a large page outweigh every other
 * dimension in the coverage ratio.
 */
function coverageOf(
  results: readonly ConstraintResult[],
): CoverageCounts {
  const counts = {
    expected: results.length,
    evaluated: 0,
    passed: 0,
    failed: 0,
    unsupported: 0,
    invalid: 0,
  }
  for (const result of results) {
    if (result.status === "passed") {
      counts.evaluated += 1
      counts.passed += 1
    } else if (result.status === "failed") {
      counts.evaluated += 1
      counts.failed += 1
    } else if (result.status === "unsupported") {
      counts.unsupported += 1
    } else {
      counts.invalid += 1
    }
  }
  return counts
}

export function evaluateGeometryEvidence(
  config: GeometryEvaluatorConfig,
  checkpoints: readonly GeometryCheckpointEvidence[],
): GeometryEvaluation {
  const results: Array<ConstraintResult & { checkpointId: string }> = []

  for (const checkpoint of checkpoints) {
    const nodes = normalizeWebEvidence(checkpoint.layout, checkpoint.styles)
    for (const result of evaluateConstraints(
      config.constraints,
      nodes,
      config.tokenSet,
    )) {
      results.push({ ...result, checkpointId: checkpoint.checkpointId })
    }
  }

  const violations = results.reduce(
    (total, result) => total + result.violations.length,
    0,
  )
  const findings: GeometryFinding[] = results.flatMap((result) =>
    result.violations.map((violation) => ({
      constraintId: result.constraintId,
      checkpointId: result.checkpointId,
      metricKey: `geometry.${result.constraintId}`,
      dimension: "geometry" as const,
      severity: "major" as const,
      summary: `Design constraint '${result.constraintId}' violated`,
      explanation: violation.identity
        ? `${violation.identity}: ${violation.detail}`
        : violation.detail,
    })),
  )

  return {
    results,
    metrics: {
      "geometry.violations": violations,
      "geometry.failedConstraints": results.filter(
        (result) => result.status === "failed",
      ).length,
      // Surfaced as its own metric so a policy can refuse to pass on evidence
      // it could not read, instead of that gap disappearing into the total.
      "geometry.indecisiveConstraints": results.filter(
        (result) => result.status === "invalid" || result.status === "unsupported",
      ).length,
    },
    coverage: coverageOf(results),
    findings,
  }
}
