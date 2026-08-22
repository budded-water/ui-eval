import { createHash } from "node:crypto"
import type { Locator, Page } from "playwright"

import type { WebCheckpointSpec } from "../contracts/model"
import { CaptureOperationError } from "./classification"

export const DISABLE_MOTION_CSS = `
*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}
`

export interface StabilizationResult {
  frameDigest: `sha256:${string}`
  stableFrames: number
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new CaptureOperationError("Page did not stabilize before timeout", {
      origin: "driver",
      code: "stabilization-timeout",
      retryable: true,
    })
  }
  return remaining
}

async function waitForFonts(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => !document.fonts || document.fonts.status === "loaded",
    undefined,
    { timeout },
  )
}

async function waitForImages(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () =>
      Array.from(document.images).every((image) => image.complete),
    undefined,
    { timeout },
  )
}

async function waitForApplicationReady(
  page: Page,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    async () => {
      const candidateWindow = window as typeof window & {
        __UI_EVAL_READY__?: boolean | Promise<boolean> | (() => boolean | Promise<boolean>)
      }
      const hook = candidateWindow.__UI_EVAL_READY__
      if (hook === undefined) return document.readyState === "complete"
      const result = typeof hook === "function" ? hook() : hook
      return Boolean(await result)
    },
    undefined,
    { timeout },
  )
}

async function screenshotForStability(
  page: Page,
  checkpoint: WebCheckpointSpec,
  target: Locator | undefined,
  timeout: number,
): Promise<Buffer> {
  if (checkpoint.captureScope === "element") {
    if (!target) {
      throw new CaptureOperationError(
        "Element checkpoint requires a target locator",
        {
          origin: "runner",
          code: "checkpoint-target-missing",
          retryable: false,
        },
      )
    }
    return target.screenshot({
      animations: "disabled",
      caret: "hide",
      timeout,
    })
  }

  return page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: checkpoint.captureScope === "full-page",
    timeout,
  })
}

export async function stabilizePage(
  page: Page,
  checkpoint: WebCheckpointSpec,
  target?: Locator,
): Promise<StabilizationResult> {
  const deadline = Date.now() + checkpoint.stabilize.timeoutMs

  if (checkpoint.stabilize.disableAnimations) {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addStyleTag({ content: DISABLE_MOTION_CSS })
  }

  if (checkpoint.stabilize.waitForFonts) {
    await waitForFonts(page, remainingTimeout(deadline))
  }
  await waitForImages(page, remainingTimeout(deadline))
  await waitForApplicationReady(page, remainingTimeout(deadline))

  let previousDigest: `sha256:${string}` | undefined
  let consecutiveFrames = 0

  while (Date.now() < deadline) {
    const frame = await screenshotForStability(
      page,
      checkpoint,
      target,
      remainingTimeout(deadline),
    )
    const frameDigest = digest(frame)
    consecutiveFrames = frameDigest === previousDigest ? consecutiveFrames + 1 : 1
    previousDigest = frameDigest

    if (consecutiveFrames >= checkpoint.stabilize.stableFrames) {
      return {
        frameDigest,
        stableFrames: consecutiveFrames,
      }
    }
    await page.waitForTimeout(32)
  }

  throw new CaptureOperationError("Page frames remained unstable", {
    origin: "driver",
    code: "stabilization-timeout",
    retryable: true,
  })
}
