import { describe, expect, it } from "vitest"
import { PNG } from "pngjs"

import { BINARY_EVIDENCE_LIMITS } from "../capture-playwright/binary-evidence"
import { comparePngBuffers } from "./visual"

function png(width: number, height: number, pixels: Array<[number, number, number, number]>) {
  const image = new PNG({ width, height })
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4
    const [red, green, blue, alpha] = pixels[index]
    image.data[offset] = red
    image.data[offset + 1] = green
    image.data[offset + 2] = blue
    image.data[offset + 3] = alpha
  }
  return PNG.sync.write(image)
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12, "ascii")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe("comparePngBuffers", () => {
  it("reports a raw changed-pixel ratio and diff without inventing a score", () => {
    const reference = png(2, 1, [
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ])
    const candidate = png(2, 1, [
      [255, 255, 255, 255],
      [255, 0, 0, 255],
    ])

    const result = comparePngBuffers(reference, candidate)

    expect(result.status).toBe("measured")
    if (result.status !== "measured") throw new Error("expected measurement")
    expect(result.changedPixels).toBe(1)
    expect(result.totalPixels).toBe(2)
    expect(result.changedPixelRatio).toBe(0.5)
    expect(result.diffPng.length).toBeGreaterThan(0)
    expect(result).not.toHaveProperty("score")
  })

  it("returns unknown rather than resizing mismatched images", () => {
    const reference = png(1, 1, [[255, 255, 255, 255]])
    const candidate = png(2, 1, [
      [255, 255, 255, 255],
      [255, 255, 255, 255],
    ])

    expect(comparePngBuffers(reference, candidate)).toEqual({
      status: "unknown",
      reason: "image-dimensions-mismatch",
      reference: { width: 1, height: 1 },
      candidate: { width: 2, height: 1 },
    })
  })

  it("returns unknown for a corrupt image", () => {
    const valid = png(1, 1, [[255, 255, 255, 255]])

    expect(comparePngBuffers(Buffer.from("not-a-png"), valid)).toEqual({
      status: "unknown",
      reason: "invalid-reference-image",
    })
  })

  it("rejects oversized IHDR dimensions before decoding pixel data", () => {
    const valid = png(1, 1, [[255, 255, 255, 255]])
    const oversized = pngHeader(
      BINARY_EVIDENCE_LIMITS.png.maxWidthPx + 1,
      1,
    )

    expect(comparePngBuffers(oversized, valid)).toEqual({
      status: "unknown",
      reason: "reference-image-budget-exceeded",
    })
    expect(comparePngBuffers(valid, oversized)).toEqual({
      status: "unknown",
      reason: "candidate-image-budget-exceeded",
    })
  })
})
