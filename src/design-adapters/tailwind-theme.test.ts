import { describe, expect, it } from "vitest"

import { validateDesignContract } from "../contracts/validation"
import { canonicalDigest } from "../contracts/canonical-json"

import { parseColor } from "../normalize/color"
import { parseLengthPx } from "../normalize/length"

import { importTailwindTheme } from "./tailwind-theme"

describe("color normalization", () => {
  it("converts OKLCh to sRGB at the gamut extremes", () => {
    expect(parseColor("oklch(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, alpha: 1 })
    expect(parseColor("oklch(0 0 0)")).toEqual({ r: 0, g: 0, b: 0, alpha: 1 })
  })

  it("reads slash alpha as a percentage or a number", () => {
    expect(parseColor("oklch(1 0 0 / 10%)")?.alpha).toBeCloseTo(0.1)
    expect(parseColor("rgb(0 0 0 / 0.25)")?.alpha).toBeCloseTo(0.25)
  })

  it("treats equal colors written differently as one value", () => {
    expect(parseColor("#2e8b57")).toEqual(parseColor("rgb(46, 139, 87)"))
    expect(parseColor("#FFF")).toEqual(parseColor("#ffffff"))
  })

  it("returns undefined rather than guessing at an unsupported notation", () => {
    expect(parseColor("currentColor")).toBeUndefined()
    expect(parseColor("color-mix(in srgb, red, blue)")).toBeUndefined()
  })
})

describe("length normalization", () => {
  it("resolves rem against the configured root font size", () => {
    expect(parseLengthPx("0.625rem", 16)).toBe(10)
    expect(parseLengthPx("16px", 16)).toBe(16)
    expect(parseLengthPx("0", 16)).toBe(0)
  })

  it("rejects units it cannot normalize", () => {
    expect(parseLengthPx("2em", 16)).toBeUndefined()
    expect(parseLengthPx("50%", 16)).toBeUndefined()
  })
})

describe("tailwind theme import", () => {
  const css = `
    @theme inline {
      --color-brand: var(--brand);
      --radius-sm: calc(var(--radius) - 4px);
      --radius-lg: var(--radius);
    }
    :root {
      --radius: 0.625rem;
      --brand: oklch(0.52 0.12 160);
      --background: oklch(1 0 0);
    }
    .dark {
      --brand: oklch(0.58 0.11 160);
    }
    @layer base {
      body { color: red; }
    }
  `

  it("resolves references and calc into normalized tokens", () => {
    const result = importTailwindTheme(css)
    expect(result.unresolved).toEqual([])
    expect(result.tokenSet.scales).toEqual([
      { id: "radius", unit: "logical-px", steps: [6, 10] },
    ])
    expect(result.tokenSet.valueSets?.[0].values).toHaveLength(2)
  })

  it("lets the requested theme override the base declarations", () => {
    const light = importTailwindTheme(css)
    const dark = importTailwindTheme(css, { theme: ".dark" })
    expect(light.tokenSet.valueSets).not.toEqual(dark.tokenSet.valueSets)
  })

  it("ignores declarations nested inside unrelated at-rules", () => {
    const result = importTailwindTheme(css)
    expect(result.declarationCount).toBe(6)
  })

  it("reports what it could not resolve instead of dropping it", () => {
    const result = importTailwindTheme(`
      :root {
        --ok: #fff;
        --missing: var(--nope);
        --exotic: color-mix(in srgb, red, blue);
        --loop: var(--loop);
      }
    `)
    expect(result.unresolved.map((token) => [token.name, token.reason])).toEqual([
      ["--missing", "unresolved-reference"],
      ["--exotic", "unsupported-value"],
      ["--loop", "reference-cycle"],
    ])
  })

  it("produces a token set that validates inside a sealed design contract", () => {
    const artifact = {
      id: "globals-css",
      projectId: "project-1",
      storeId: "local",
      digest: `sha256:${"a".repeat(64)}`,
      mediaType: "text/css",
      sizeBytes: 1024,
      sensitivity: "internal" as const,
    }
    const spec = {
      capabilities: ["tokens"],
      source: {
        kind: "structured",
        producer: { id: "tailwind-theme", version: "0.1.0" },
        artifacts: [artifact],
      },
      tokenSet: importTailwindTheme(css).tokenSet,
    }
    const contract = {
      apiVersion: "uieval.io/v1alpha1",
      kind: "DesignContract",
      metadata: {
        id: "synthetic-tailwind-light",
        projectId: "project-1",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: { type: "agent", id: "tailwind-theme" },
        specDigest: canonicalDigest(spec),
      },
      spec,
    }
    expect(validateDesignContract(contract)).toEqual(contract)
  })
})

describe("browser-serialized color spaces", () => {
  it("reads the Lab and OKLab notations Chromium emits for oklch declarations", () => {
    // Chromium serializes a computed color in the space it was authored in, so
    // a stylesheet using oklch() yields lab() in captured evidence.
    expect(parseColor("lab(100 0 0)")).toEqual({ r: 255, g: 255, b: 255, alpha: 1 })
    expect(parseColor("lab(0 0 0)")).toEqual({ r: 0, g: 0, b: 0, alpha: 1 })
    expect(parseColor("oklab(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, alpha: 1 })
  })

  it("agrees with the equivalent oklch declaration", () => {
    // globals.css declares the brand as oklch(0.52 0.12 160); Chromium reports
    // it as lab(45.8967 -40.2546 15.7855). Both must normalize to one value.
    const declared = parseColor("oklch(0.52 0.12 160)")
    const captured = parseColor("lab(45.8967 -40.2546 15.7855)")
    expect(captured).toBeDefined()
    expect(Math.abs(captured!.r - declared!.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(captured!.g - declared!.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(captured!.b - declared!.b)).toBeLessThanOrEqual(1)
  })

  it("reads slash alpha on an oklab value", () => {
    expect(parseColor("oklab(0.52 -0.11 0.04 / 0.3)")?.alpha).toBeCloseTo(0.3)
  })
})
