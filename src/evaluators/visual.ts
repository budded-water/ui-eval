import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

import {
  BinaryEvidenceValidationError,
  inspectPngHeader,
  type PngEvidenceKind,
} from "../capture-playwright/binary-evidence"

export type VisualComparison =
  | {
      status: "measured"
      width: number
      height: number
      changedPixels: number
      totalPixels: number
      changedPixelRatio: number
      diffPng: Buffer
    }
  | {
      status: "unknown"
      reason:
        | "invalid-reference-image"
        | "invalid-candidate-image"
        | "reference-image-budget-exceeded"
        | "candidate-image-budget-exceeded"
        | "diff-image-budget-exceeded"
        | "image-dimensions-mismatch"
      reference?: { width: number; height: number }
      candidate?: { width: number; height: number }
    }

type VisualImageSide = "reference" | "candidate"

function readPng(
  bytes: Uint8Array,
  side: VisualImageSide,
): { status: "decoded"; image: PNG } | VisualComparison {
  const evidenceKind: PngEvidenceKind =
    side === "reference" ? "reference-png" : "screenshot"
  try {
    inspectPngHeader(bytes, evidenceKind)
    return { status: "decoded", image: PNG.sync.read(Buffer.from(bytes)) }
  } catch (error) {
    const budgetExceeded =
      error instanceof BinaryEvidenceValidationError &&
      error.classification.code.endsWith("-exceeded")
    return {
      status: "unknown",
      reason: budgetExceeded
        ? `${side}-image-budget-exceeded`
        : `invalid-${side}-image`,
    }
  }
}

export function comparePngBuffers(
  referenceBytes: Uint8Array,
  candidateBytes: Uint8Array,
): VisualComparison {
  const reference = readPng(referenceBytes, "reference")
  if (reference.status !== "decoded") return reference

  const candidate = readPng(candidateBytes, "candidate")
  if (candidate.status !== "decoded") return candidate

  const referenceImage = reference.image
  const candidateImage = candidate.image

  if (
    referenceImage.width !== candidateImage.width ||
    referenceImage.height !== candidateImage.height
  ) {
    return {
      status: "unknown",
      reason: "image-dimensions-mismatch",
      reference: {
        width: referenceImage.width,
        height: referenceImage.height,
      },
      candidate: {
        width: candidateImage.width,
        height: candidateImage.height,
      },
    }
  }

  const diff = new PNG({
    width: referenceImage.width,
    height: referenceImage.height,
  })
  const changedPixels = pixelmatch(
    referenceImage.data,
    candidateImage.data,
    diff.data,
    referenceImage.width,
    referenceImage.height,
    {
      alpha: 0.45,
      diffColor: [220, 61, 69],
      threshold: 0.1,
    },
  )
  const totalPixels = referenceImage.width * referenceImage.height

  const diffPng = PNG.sync.write(diff)
  try {
    inspectPngHeader(diffPng, "screenshot")
  } catch (error) {
    if (
      error instanceof BinaryEvidenceValidationError &&
      error.classification.code.endsWith("-exceeded")
    ) {
      return { status: "unknown", reason: "diff-image-budget-exceeded" }
    }
    throw error
  }

  return {
    status: "measured",
    width: referenceImage.width,
    height: referenceImage.height,
    changedPixels,
    totalPixels,
    changedPixelRatio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    diffPng,
  }
}
