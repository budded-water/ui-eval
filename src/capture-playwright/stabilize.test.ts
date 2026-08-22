import type { Page } from "playwright"
import { describe, expect, it, vi } from "vitest"

import type { WebCheckpointSpec } from "../contracts/model"
import { stabilizePage } from "./stabilize"

describe("stabilizePage", () => {
  it("does not add an unbounded document.fonts.ready wait", async () => {
    const page = {
      emulateMedia: vi.fn(async () => {}),
      addStyleTag: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from("stable-frame")),
      waitForTimeout: vi.fn(async () => {}),
      evaluate: vi.fn(() => new Promise<void>(() => {})),
    } as unknown as Page
    const checkpoint = {
      id: "ready",
      requiredChannels: ["screenshot"],
      captureScope: "viewport",
      stabilize: {
        disableAnimations: true,
        waitForFonts: true,
        stableFrames: 1,
        timeoutMs: 1_000,
      },
    } satisfies WebCheckpointSpec

    const boundedResult = Promise.race([
      stabilizePage(page, checkpoint),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("font stabilization exceeded test bound")),
          200,
        )
      }),
    ])

    await expect(boundedResult).resolves.toMatchObject({ stableFrames: 1 })
    expect(page.evaluate).not.toHaveBeenCalled()
  })
})
