import type { ArtifactRef, CaptureBundleSpec } from "../contracts/model"
import { canonicalDigest } from "../contracts/canonical-json"

/**
 * Hash only evidence that the active Phase 0A evaluators can observe. In
 * particular, trace ZIP metadata and CAS operational fields must not invalidate
 * an otherwise identical normalized decision-evidence digest.
 */
export function normalizedCandidateEvidenceDigest(
  capture: CaptureBundleSpec,
  options: { includeScreenshot: boolean; includeGeometry?: boolean },
): ArtifactRef["digest"] {
  return canonicalDigest({
    sourceRevision: capture.sourceRevision,
    build: capture.build,
    variant: capture.variant,
    adapter: capture.adapter,
    environment: capture.environment,
    capabilities: [...capture.capabilities].sort(),
    status: capture.status,
    completeness: capture.completeness,
    stepResults: capture.stepResults.map((result) => ({
      stepId: result.stepId,
      status: result.status,
      origin: result.origin,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    })),
    assertionResults: capture.assertionResults.map((result) => ({
      assertionId: result.assertionId,
      ...(result.stepId ? { stepId: result.stepId } : {}),
      ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}),
      status: result.status,
      origin: result.origin,
      ...(result.expected ? { expected: result.expected } : {}),
      ...(result.actual ? { actual: result.actual } : {}),
    })),
    checkpoints: capture.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      renderSpace: checkpoint.renderSpace,
      evidence: checkpoint.evidence.map((record) => ({
        channel: record.channel,
        required: record.required,
        status: record.status,
        ...(record.error ? { error: record.error } : {}),
        ...(((options.includeScreenshot && record.channel === "screenshot") ||
          (options.includeGeometry && ["layout-metadata", "computed-styles"].includes(record.channel))) &&
        record.artifact
          ? { artifactDigest: record.artifact.digest }
          : {}),
      })),
    })),
    executionErrors: (capture.executionErrors ?? []).map((error) => ({
      origin: error.origin,
      phase: error.phase,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.stepId ? { stepId: error.stepId } : {}),
    })),
  })
}
