import type { ArtifactRef, CaptureBundleSpec } from "../contracts/model"
import { ContractValidationError, validateLayoutEvidencePayload, validateStylesEvidencePayload } from "../contracts/validation"
import type { GeometryCheckpointEvidence } from "../evaluators/geometry/evaluator"

/** Missing/invalid checkpoints remain absent here and are accounted for by the plan. */
export async function geometryCheckpointEvidence(
  capture: CaptureBundleSpec,
  resolve: (ref: ArtifactRef) => Promise<Uint8Array>,
): Promise<GeometryCheckpointEvidence[]> {
  const collected: GeometryCheckpointEvidence[] = []
  for (const checkpoint of capture.checkpoints) {
    const find = (channel: "layout-metadata" | "computed-styles") => checkpoint.evidence.find(
      (record) => record.channel === channel && record.status === "captured",
    )?.artifact
    const layoutRef = find("layout-metadata")
    if (!layoutRef) continue
    const stylesRef = find("computed-styles")
    const layoutBytes = await resolve(layoutRef)
    const stylesBytes = stylesRef ? await resolve(stylesRef) : undefined
    try {
      const read = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
      collected.push({ checkpointId: checkpoint.checkpointId,
        layout: validateLayoutEvidencePayload(read(layoutBytes)),
        ...(stylesBytes ? { styles: validateStylesEvidencePayload(read(stylesBytes)) } : {}),
      })
    } catch (error) {
      if (!(error instanceof ContractValidationError || error instanceof SyntaxError || error instanceof TypeError)) throw error
    }
  }
  return collected
}
