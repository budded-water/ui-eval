import { open } from "node:fs/promises"

import type { RenderSpace } from "../contracts/model"
import { CaptureOperationError } from "./classification"

const MEBIBYTE = 1024 * 1024

/**
 * Hard safety ceilings for untrusted binary evidence. These are resource
 * limits, not quality targets: exceeding one makes the evidence unavailable
 * and must never be interpreted as a product pass or failure.
 */
export const BINARY_EVIDENCE_LIMITS = Object.freeze({
  png: Object.freeze({
    maxWidthPx: 8_192,
    maxHeightPx: 16_384,
    maxPixels: 16_777_216,
    maxEncodedBytes: 32 * MEBIBYTE,
  }),
  trace: Object.freeze({
    maxEncodedBytes: 128 * MEBIBYTE,
  }),
})

export type PngEvidenceKind = "screenshot" | "reference-png"
export type BoundedFileKind = PngEvidenceKind | "trace"

export class BinaryEvidenceValidationError extends CaptureOperationError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(
      message,
      { origin: "runner", code, retryable: false },
      options,
    )
    this.name = "BinaryEvidenceValidationError"
  }
}

function encodedByteLimit(kind: BoundedFileKind): number {
  return kind === "trace"
    ? BINARY_EVIDENCE_LIMITS.trace.maxEncodedBytes
    : BINARY_EVIDENCE_LIMITS.png.maxEncodedBytes
}

export function assertEncodedEvidenceSize(
  sizeBytes: number,
  kind: BoundedFileKind,
): void {
  const maximum = encodedByteLimit(kind)
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > maximum
  ) {
    throw new BinaryEvidenceValidationError(
      `${kind} evidence is ${String(sizeBytes)} bytes; the limit is ${maximum} bytes`,
      `${kind}-encoded-bytes-exceeded`,
    )
  }
}

export function assertPngDimensionsWithinBudget(
  width: number,
  height: number,
  kind: PngEvidenceKind,
): void {
  const limits = BINARY_EVIDENCE_LIMITS.png
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new BinaryEvidenceValidationError(
      `${kind} declares invalid PNG dimensions ${String(width)}x${String(height)}`,
      `${kind}-dimensions-invalid`,
    )
  }
  if (width > limits.maxWidthPx || height > limits.maxHeightPx) {
    throw new BinaryEvidenceValidationError(
      `${kind} dimensions ${width}x${height} exceed the ${limits.maxWidthPx}x${limits.maxHeightPx} limit`,
      `${kind}-dimensions-exceeded`,
    )
  }
  if (BigInt(width) * BigInt(height) > BigInt(limits.maxPixels)) {
    throw new BinaryEvidenceValidationError(
      `${kind} dimensions ${width}x${height} exceed the ${limits.maxPixels}-pixel limit`,
      `${kind}-pixels-exceeded`,
    )
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const IHDR = [73, 72, 68, 82] as const

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

export interface PngHeader {
  width: number
  height: number
}

/** Parse only the fixed PNG signature and IHDR prefix before pngjs can decode. */
export function inspectPngHeader(
  bytes: Uint8Array,
  kind: PngEvidenceKind,
): PngHeader {
  // The byte ceiling is checked first so callers can reject a declared large
  // input without touching its contents.
  assertEncodedEvidenceSize(bytes.byteLength, kind)
  if (bytes.byteLength < 24) {
    throw new BinaryEvidenceValidationError(
      `${kind} does not contain a complete PNG IHDR`,
      `${kind}-header-invalid`,
    )
  }
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new BinaryEvidenceValidationError(
      `${kind} does not have a PNG signature`,
      `${kind}-header-invalid`,
    )
  }
  if (
    uint32be(bytes, 8) !== 13 ||
    IHDR.some((value, index) => bytes[12 + index] !== value)
  ) {
    throw new BinaryEvidenceValidationError(
      `${kind} does not begin with a valid PNG IHDR chunk`,
      `${kind}-header-invalid`,
    )
  }

  const width = uint32be(bytes, 16)
  const height = uint32be(bytes, 20)
  assertPngDimensionsWithinBudget(width, height, kind)
  return { width, height }
}

export function assertScreenshotRenderSpaceWithinBudget(
  renderSpace: RenderSpace,
): void {
  assertPngDimensionsWithinBudget(
    renderSpace.screenshotWidthPx,
    renderSpace.screenshotHeightPx,
    "screenshot",
  )
}

/**
 * Read an owned evidence file only after its descriptor reports an acceptable
 * size. The exact-size read prevents a growing file from making this process
 * allocate beyond the configured ceiling.
 */
export async function readBoundedEvidenceFile(
  path: string,
  kind: BoundedFileKind,
): Promise<Buffer> {
  const handle = await open(path, "r")
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new BinaryEvidenceValidationError(
        `${kind} evidence must be a regular file`,
        `${kind}-file-invalid`,
      )
    }
    assertEncodedEvidenceSize(metadata.size, kind)

    const bytes = Buffer.allocUnsafe(metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      )
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }

    if (offset !== bytes.byteLength) {
      throw new BinaryEvidenceValidationError(
        `${kind} evidence changed while it was being read`,
        `${kind}-file-changed`,
      )
    }

    const sentinel = Buffer.allocUnsafe(1)
    const growth = await handle.read(sentinel, 0, 1, offset)
    if (growth.bytesRead > 0) {
      throw new BinaryEvidenceValidationError(
        `${kind} evidence changed while it was being read`,
        `${kind}-file-changed`,
      )
    }
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}
