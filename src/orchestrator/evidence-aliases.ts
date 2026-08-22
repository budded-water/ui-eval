import type {
  ArtifactRef,
  CaptureBundleSpec,
  CaptureCapability,
  EvidenceRecord,
  ExecutionError,
} from "../contracts/model"
import type {
  ArtifactRef as LocalArtifactRef,
  LocalArtifactStore,
} from "../storage-local/artifact-store"
import type { RunStore } from "../storage-local/run-store"

export type EvidenceArtifactResolver = Pick<
  LocalArtifactStore,
  "resolveWithMetadata"
>
export type EvidenceRunWriter = Pick<RunStore, "writeBinary">

export interface EvidenceAliases {
  byDigest: Map<string, string>
  byChannel: Map<CaptureCapability, string>
}

export interface EvidenceAliasWarning {
  code: "evidence-alias-write-failed"
  checkpointId: string
  channel: CaptureCapability
  artifactDigest: ArtifactRef["digest"]
  relativePath: string
  message: string
}

export interface EvidenceAliasMaterialization {
  capture: CaptureBundleSpec
  aliases: EvidenceAliases
  warnings: EvidenceAliasWarning[]
}

type ResolveResult =
  | {
      ok: true
      bytes: Buffer
      sensitivity: ArtifactSensitivity
    }
  | { ok: false }

type ArtifactSensitivity = ArtifactRef["sensitivity"]

const SENSITIVITY_RANK: Record<ArtifactSensitivity, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
}

/**
 * Adapter-provided ArtifactRef metadata is untrusted at this boundary. Keep the
 * policy exhaustive so a newly added capture capability cannot silently inherit
 * a permissive alias policy.
 */
const CHANNEL_MINIMUM_SENSITIVITY: Record<
  CaptureCapability,
  ArtifactSensitivity
> = {
  screenshot: "internal",
  "element-screenshots": "internal",
  dom: "internal",
  "computed-styles": "internal",
  "accessibility-tree": "internal",
  "view-hierarchy": "internal",
  "layout-metadata": "internal",
  console: "sensitive",
  network: "sensitive",
  trace: "sensitive",
  video: "sensitive",
  "device-logs": "sensitive",
  crash: "sensitive",
  performance: "sensitive",
}

function stricterSensitivity(
  left: ArtifactSensitivity,
  right: ArtifactSensitivity,
): ArtifactSensitivity {
  return SENSITIVITY_RANK[left] >= SENSITIVITY_RANK[right] ? left : right
}

function effectiveSensitivity(
  record: EvidenceRecord,
): ArtifactSensitivity | undefined {
  if (!record.artifact) return undefined
  return stricterSensitivity(
    record.artifact.sensitivity,
    CHANNEL_MINIMUM_SENSITIVITY[record.channel],
  )
}

function extensionFor(mediaType: string): string {
  if (mediaType === "image/png") return "png"
  if (mediaType === "application/zip") return "zip"
  if (mediaType.includes("json")) return "json"
  return "bin"
}

function localArtifactRef(artifact: ArtifactRef): LocalArtifactRef {
  return artifact as unknown as LocalArtifactRef
}

function resolutionKey(artifact: ArtifactRef): string {
  return [
    artifact.projectId,
    artifact.storeId,
    artifact.id,
    artifact.digest,
    artifact.sizeBytes,
  ].join("\0")
}

function resolutionError(
  checkpointId: string,
  record: EvidenceRecord,
): ExecutionError {
  return {
    origin: "runner",
    phase: "checkpoint",
    code: "artifact-resolution-failed",
    message: `Artifact ${record.artifact?.digest ?? "unknown"} for checkpoint ${checkpointId} channel ${record.channel} could not be verified in the local store.`,
    retryable: true,
  }
}

function corruptRecord(
  record: EvidenceRecord,
  checkpointId: string,
): EvidenceRecord {
  return {
    ...record,
    status: "corrupt",
    error: {
      code: "artifact-resolution-failed",
      message: `Captured ${record.channel} evidence for checkpoint ${checkpointId} could not be verified.`,
    },
  }
}

function withRecomputedCompleteness(
  capture: CaptureBundleSpec,
  checkpoints: CaptureBundleSpec["checkpoints"],
  addedErrors: readonly ExecutionError[],
): CaptureBundleSpec {
  const requiredEvidence = checkpoints.flatMap((checkpoint) =>
    checkpoint.evidence.filter((record) => record.required),
  )
  const capturedRequired = requiredEvidence.filter(
    (record) => record.status === "captured" && record.artifact !== undefined,
  ).length
  const missingRequired = requiredEvidence.length - capturedRequired
  const evidenceStatus: CaptureBundleSpec["status"] =
    missingRequired === 0
      ? "completed"
      : capturedRequired === 0
        ? "failed"
        : "partial"
  const status: CaptureBundleSpec["status"] =
    capture.status === "failed" || evidenceStatus === "failed"
      ? "failed"
      : capture.status === "partial" || evidenceStatus === "partial"
        ? "partial"
        : "completed"
  const executionErrors = [
    ...(capture.executionErrors ?? []),
    ...addedErrors,
  ]

  return {
    ...capture,
    checkpoints,
    status,
    completeness: {
      expectedRequired: requiredEvidence.length,
      capturedRequired,
      missingRequired,
    },
    ...(executionErrors.length > 0 || capture.executionErrors !== undefined
      ? { executionErrors }
      : {}),
  }
}

/**
 * Verifies captured CAS evidence and materializes optional human-friendly run
 * aliases. CAS integrity affects evidence truth; alias writes affect only the
 * presentation layer. Adapter sensitivity labels are untrusted: each channel
 * has a minimum and every occurrence of a digest is upgraded to the strictest
 * effective sensitivity observed for that digest. The CAS resolver then
 * supplies the authoritative historical sensitivity for the digest; caller
 * refs can strengthen it but cannot lower it. Sensitive digests remain CAS-only
 * regardless of record ordering, conflicting labels, or later forged refs.
 */
export async function materializeEvidenceAliases(
  capture: CaptureBundleSpec,
  artifactStore: EvidenceArtifactResolver,
  runStore: EvidenceRunWriter,
): Promise<EvidenceAliasMaterialization> {
  const aliases: EvidenceAliases = {
    byDigest: new Map(),
    byChannel: new Map(),
  }
  const warnings: EvidenceAliasWarning[] = []
  const addedErrors: ExecutionError[] = []
  const sensitivityByDigest = new Map<
    ArtifactRef["digest"],
    ArtifactSensitivity
  >()
  for (const record of capture.checkpoints.flatMap(
    (checkpoint) => checkpoint.evidence,
  )) {
    const sensitivity = effectiveSensitivity(record)
    if (!record.artifact || !sensitivity) continue
    const existing = sensitivityByDigest.get(record.artifact.digest)
    sensitivityByDigest.set(
      record.artifact.digest,
      existing ? stricterSensitivity(existing, sensitivity) : sensitivity,
    )
  }
  const resolutions = new Map<string, Promise<ResolveResult>>()
  const aliasAttempts = new Set<string>()
  let nestedAliasIndex = 0

  const resolveArtifact = (artifact: ArtifactRef): Promise<ResolveResult> => {
    const key = resolutionKey(artifact)
    const existing = resolutions.get(key)
    if (existing) return existing
    const pending = artifactStore
      .resolveWithMetadata(localArtifactRef(artifact))
      .then(({ bytes, sensitivity }) => ({
        ok: true as const,
        bytes,
        sensitivity,
      }))
      .catch(() => ({ ok: false as const }))
    resolutions.set(key, pending)
    return pending
  }

  const checkpoints: CaptureBundleSpec["checkpoints"] = []
  for (const checkpoint of capture.checkpoints) {
    const evidence: EvidenceRecord[] = []
    for (const sourceRecord of checkpoint.evidence) {
      const artifactSensitivity = sourceRecord.artifact
        ? sensitivityByDigest.get(sourceRecord.artifact.digest)
        : undefined
      let record: EvidenceRecord = {
        ...sourceRecord,
        ...(sourceRecord.artifact && artifactSensitivity
          ? {
              artifact: {
                ...sourceRecord.artifact,
                sensitivity: artifactSensitivity,
              },
            }
          : {}),
      }
      const artifact = record.artifact
      if (record.status !== "captured" || !artifact) {
        evidence.push(record)
        continue
      }

      const resolution = await resolveArtifact(artifact)
      if (!resolution.ok) {
        evidence.push(corruptRecord(record, checkpoint.checkpointId))
        addedErrors.push(resolutionError(checkpoint.checkpointId, record))
        continue
      }

      const trustedSensitivity = stricterSensitivity(
        artifact.sensitivity,
        resolution.sensitivity,
      )
      sensitivityByDigest.set(artifact.digest, trustedSensitivity)
      if (trustedSensitivity !== artifact.sensitivity) {
        record = {
          ...record,
          artifact: { ...artifact, sensitivity: trustedSensitivity },
        }
      }

      if (record.artifact?.sensitivity === "sensitive") {
        evidence.push(record)
        continue
      }

      const existingAlias = aliases.byDigest.get(artifact.digest)
      if (existingAlias) {
        if (!aliases.byChannel.has(record.channel)) {
          aliases.byChannel.set(record.channel, existingAlias)
        }
        evidence.push(record)
        continue
      }
      if (aliasAttempts.has(artifact.digest)) {
        evidence.push(record)
        continue
      }
      aliasAttempts.add(artifact.digest)

      const extension = extensionFor(artifact.mediaType)
      const friendly =
        record.channel === "screenshot"
          ? "candidate.png"
          : `${record.channel}.${extension}`
      const relativePath = aliases.byChannel.has(record.channel)
        ? `evidence/${nestedAliasIndex++}-${record.channel}.${extension}`
        : friendly

      try {
        await runStore.writeBinary(
          capture.executionId,
          relativePath,
          resolution.bytes,
        )
        aliases.byDigest.set(artifact.digest, relativePath)
        if (!aliases.byChannel.has(record.channel)) {
          aliases.byChannel.set(record.channel, relativePath)
        }
      } catch {
        warnings.push({
          code: "evidence-alias-write-failed",
          checkpointId: checkpoint.checkpointId,
          channel: record.channel,
          artifactDigest: artifact.digest,
          relativePath,
          message: `Verified ${record.channel} evidence remains available in CAS, but presentation alias ${relativePath} could not be written.`,
        })
      }
      evidence.push(record)
    }
    checkpoints.push({ ...checkpoint, evidence })
  }

  return {
    capture: withRecomputedCompleteness(capture, checkpoints, addedErrors),
    aliases,
    warnings,
  }
}
