import {
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  assertEncodedEvidenceSize,
  BINARY_EVIDENCE_LIMITS,
  inspectPngHeader,
  readBoundedEvidenceFile,
} from "./binary-evidence"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12, "ascii")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe("binary evidence budgets", () => {
  it("rejects oversized declared PNG dimensions from the IHDR prefix", () => {
    const bytes = pngHeader(
      BINARY_EVIDENCE_LIMITS.png.maxWidthPx + 1,
      1,
    )

    expect(() => inspectPngHeader(bytes, "reference-png")).toThrowError(
      expect.objectContaining({
        classification: expect.objectContaining({
          origin: "runner",
          code: "reference-png-dimensions-exceeded",
          retryable: false,
        }),
      }),
    )
  })

  it("rejects an oversized encoded screenshot before touching its bytes", () => {
    const declaredOnly = {
      byteLength: BINARY_EVIDENCE_LIMITS.png.maxEncodedBytes + 1,
    } as Uint8Array

    expect(() => inspectPngHeader(declaredOnly, "screenshot")).toThrowError(
      expect.objectContaining({
        classification: expect.objectContaining({
          code: "screenshot-encoded-bytes-exceeded",
        }),
      }),
    )
  })

  it("enforces the aggregate pixel ceiling independently of dimensions", () => {
    const width = 4_096
    const height = Math.floor(BINARY_EVIDENCE_LIMITS.png.maxPixels / width) + 1

    expect(() => inspectPngHeader(pngHeader(width, height), "screenshot"))
      .toThrowError(
        expect.objectContaining({
          classification: expect.objectContaining({
            code: "screenshot-pixels-exceeded",
          }),
        }),
      )
  })

  it("rejects an oversized sparse trace before reading or sealing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-eval-binary-budget-"))
    roots.push(root)
    const tracePath = join(root, "trace.zip")
    await writeFile(tracePath, Buffer.alloc(0))
    await truncate(
      tracePath,
      BINARY_EVIDENCE_LIMITS.trace.maxEncodedBytes + 1,
    )

    await expect(readBoundedEvidenceFile(tracePath, "trace")).rejects.toMatchObject({
      classification: {
        origin: "runner",
        code: "trace-encoded-bytes-exceeded",
        retryable: false,
      },
    })
  })

  it("rejects an oversized reference size without allocating that input", () => {
    expect(() =>
      assertEncodedEvidenceSize(
        BINARY_EVIDENCE_LIMITS.png.maxEncodedBytes + 1,
        "reference-png",
      ),
    ).toThrowError(
      expect.objectContaining({
        classification: expect.objectContaining({
          code: "reference-png-encoded-bytes-exceeded",
        }),
      }),
    )
  })
})
