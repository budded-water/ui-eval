import { describe, expect, it } from "vitest"
import { parseColor } from "./color"

describe("complete CSS color values", () => {
  it.each([
    "rgb(255px 255 255)", "rgb(255oops 255 255)", "rgb(255 255 255 / 1oops)",
    "rgb(255 255 255 / 50%%)", "rgb(255 255 255 1)", "rgb(255,255,255,1,0)",
    "rgb(255,,255,255)", "rgb(255,255 255)", "rgb(255,255,255 / 1)",
    "rgb(100%,255,255)", "rgb(255 255 255 / 1 / 0)", "rgb(255 255 255 /)",
    "rgb(100 %, 100%, 100%)", "rgb(100\n%,100%,100%)", "rgb(255 255 255 / 50 %)",
    "rgb(255\u00a0255 255)", "rgb(255,\u00a0255,255)", "\u00a0#fff",
    "oklab(1 0 0 0)", "oklab(1,0,0)", "lab(100 0px 0)",
    "oklch(1 0 0%)", "oklch(1 0 0bogus)", "oklch(1 0 0 / 1 / 0)",
    "oklab(1 1e308 -1e308)", "rgb(1e999 0 0)",
  ])("rejects unusable color %s instead of comparing a guessed value", (input) => {
    expect(parseColor(input)).toBeUndefined()
  })

  it.each([
    ["rgba(255, 0, 0, 50%)", "rgb(100% 0% 0% / .5)"],
    ["rgb(+2.55e2 0 0 / 5e-1)", "#ff000080"],
    ["oklab(50% 25% -25%)", "oklab(.5 .1 -.1)"],
    ["lab(50% 20% -20%)", "lab(50 25 -25)"],
    ["oklch(60% 25% .5turn)", "oklch(.6 .1 180)"],
    ["oklch(.6 .1 200grad)", "oklch(.6 .1 180deg)"],
    ["oklch(.6 .1 3.141592653589793rad)", "oklch(.6 .1 180)"],
  ])("normalizes equivalent supported forms: %s", (input, equivalent) => {
    const actual = parseColor(input)
    const expected = parseColor(equivalent)
    expect(actual).toBeDefined()
    expect(expected).toBeDefined()
    expect(actual).toMatchObject({ r: expected!.r, g: expected!.g, b: expected!.b })
    expect(actual!.alpha).toBeCloseTo(expected!.alpha, 2)
  })

  it("keeps CSS channel, alpha, lightness and chroma clamping", () => {
    expect(parseColor("rgb(300 -10 0 / 2)")).toEqual({ r: 255, g: 0, b: 0, alpha: 1 })
    expect(parseColor("oklch(2 -.1 180)")).toEqual(parseColor("oklch(1 0 180)"))
    expect(parseColor("lab(-1 0 0)")).toEqual(parseColor("lab(0 0 0)"))
  })
})
