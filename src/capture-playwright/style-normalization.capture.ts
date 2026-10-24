import { existsSync } from "node:fs"
import { chromium } from "playwright"
import { describe, expect, it } from "vitest"
import { parseColor } from "../normalize/color"
import { importTailwindTheme } from "../design-adapters/tailwind-theme"

describe.skipIf(!existsSync(chromium.executablePath()))("CSS normalization against Chromium", () => {
  it("preserves stylesheet BOM decoding and comment token boundaries", async () => {
    const css = "\ufeff:root { --color-good: rgb(255/**/0/**/0); --color-bad: rgb(25/**/5 255 255); } #sample { color: var(--color-good); }"
    const imported = importTailwindTheme(css)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(`<link rel="stylesheet" href="data:text/css;base64,${Buffer.from(css).toString("base64")}"><div id="sample">Sample</div>`)
      const observed = await page.evaluate(() => ({
        color: getComputedStyle(document.querySelector("#sample")!).color,
        malformedSupported: CSS.supports("color", "rgb(25/**/5 255 255)"),
      }))
      expect(parseColor(observed.color)).toEqual({ r: 255, g: 0, b: 0, alpha: 1 })
      expect(imported.tokenSet.valueSets).toEqual([{ id: "palette", valueKind: "color", values: [{ r: 255, g: 0, b: 0, alpha: 1 }] }])
      expect(observed.malformedSupported).toBe(false)
      expect(imported.unresolved).toEqual([expect.objectContaining({ name: "--color-bad", reason: "unsupported-value" })])
    } finally {
      await browser.close()
    }
  })

  it("agrees with computed colors for the supported numeric forms", async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const inputs = [
        "rgb(10, 20, 30)", "rgba(10,20,30,50%)", "rgb(10% 20 30% / .4)",
        "rgb(+2.55e2 0 0 / 5e-1)", "oklab(50% 25% -25% / 50%)",
        "lab(50% 20% -20%)", "oklch(60% 25% .5turn)", "oklch(.6 .1 200grad)",
        "oklch(.6 .1 3.141592653589793rad)", "oklch(2 -.1 180)",
      ]
      const observed = await page.evaluate((values) => values.map((value) => {
        const node = document.createElement("div")
        node.style.color = value
        document.body.append(node)
        const computed = getComputedStyle(node).color
        node.remove()
        return { supported: CSS.supports("color", value), computed }
      }), inputs)
      for (const [index, actual] of observed.entries()) {
        expect(actual.supported, inputs[index]).toBe(true)
        const authored = parseColor(inputs[index])
        const computed = parseColor(actual.computed)
        expect(authored, inputs[index]).toBeDefined()
        expect(computed, actual.computed).toBeDefined()
        for (const channel of ["r", "g", "b"] as const) expect(Math.abs(authored![channel] - computed![channel]), inputs[index]).toBeLessThanOrEqual(1)
        expect(authored!.alpha).toBeCloseTo(computed!.alpha, 2)
      }
    } finally {
      await browser.close()
    }
  })

  it("rejects malformed values that Chromium also refuses", async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const inputs = ["rgb(255junk 255 255)", "rgb(255 255 255 1)", "rgb(255,,255,255)", "rgb(100%,255,255)", "rgb(255 255 255 / 1 / 0)", "rgb(255\u00a0255 255)", "rgb(255,\u00a0255,255)", "\u00a0#fff", "oklab(1,0,0)", "oklch(1 0 0%)"]
      const supported = await page.evaluate((values) => values.map((value) => CSS.supports("color", value)), inputs)
      for (const [index, value] of inputs.entries()) {
        expect(supported[index], value).toBe(false)
        expect(parseColor(value)).toBeUndefined()
      }
    } finally {
      await browser.close()
    }
  })
})
