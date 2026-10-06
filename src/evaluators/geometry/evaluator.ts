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
  evaluateConstraint,
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
 * Local constraints count once per planned checkpoint; equality constraints
 * count once across the checkpoints of this evaluation. Counting nodes
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
  expectedCheckpointIds: readonly string[] = checkpoints.map((checkpoint) => checkpoint.checkpointId),
): GeometryEvaluation {
  const results: Array<ConstraintResult & { checkpointId: string }> = []
  const checkpointIds = expectedCheckpointIds.length > 0 ? expectedCheckpointIds : ["unavailable"]
  const nodesByCheckpoint = new Map(checkpoints.map((checkpoint) => [
    checkpoint.checkpointId,
    normalizeWebEvidence(checkpoint.layout, checkpoint.styles),
  ]))
  const nodeCheckpoints = new Map<string, string>()
  const pooledNodes = checkpointIds.flatMap((checkpointId) =>
    (nodesByCheckpoint.get(checkpointId) ?? []).map((node) => {
      const nodeId = JSON.stringify([checkpointId, node.nodeId])
      nodeCheckpoints.set(nodeId, checkpointId)
      return { ...node, nodeId }
    }),
  )
  const missing = (constraint: GeometryEvaluatorConfig["constraints"][number]): ConstraintResult => ({
    constraintId: constraint.id,
    kind: constraint.kind,
    status: "invalid",
    matchedNodes: 0,
    comparedNodes: 0,
    unnormalizableNodes: 0,
    violations: [],
    invalidReason: "missing-evidence",
  })

  for (const constraint of config.constraints) {
    if (constraint.kind === "cross-node-equal") {
      const complete = checkpointIds.every((id) => nodesByCheckpoint.has(id))
      const compared = evaluateConstraint(constraint, pooledNodes, config.tokenSet)
      // Preserve observed defects, but never accept a partial comparison.
      const result = !complete && compared.status !== "failed" ? missing(constraint) : compared
      results.push({ ...result, checkpointId: checkpointIds[0] })
    } else {
      for (const checkpointId of checkpointIds) {
        const nodes = nodesByCheckpoint.get(checkpointId)
        const result = nodes === undefined
          ? missing(constraint)
          : evaluateConstraint(constraint, nodes, config.tokenSet)
        results.push({ ...result, checkpointId })
      }
    }
  }

  const violations = results.reduce(
    (total, result) => total + result.violations.length,
    0,
  )
  const findings: GeometryFinding[] = results.flatMap((result) =>
    result.violations.map((violation) => ({
      constraintId: result.constraintId,
      checkpointId: nodeCheckpoints.get(violation.nodeId) ?? result.checkpointId,
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
