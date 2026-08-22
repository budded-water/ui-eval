import { describe, expect, it } from "vitest"

import type { GeometryEvaluatorConfig } from "../contracts/model"

import { importTailwindTheme } from "./tailwind-theme"
import { checkTailwindTokenDrift } from "./token-drift"

const css = `
  :root {
    --brand: #007d50;
    --radius-sm: 0.375rem;
  }
`

function geometryConfig(
  source = css,
): GeometryEvaluatorConfig {
  const tokenSet = structuredClone(importTailwindTheme(source).tokenSet)
  tokenSet.ranges = [
    { id: "horizontal-overflow", unit: "logical-px", max: 0 },
  ]
  return {
    tokenSet,
    constraints: [
      {
        id: "box-width-consistent",
        kind: "cross-node-equal",
        property: "box.width",
        tolerance: 0,
        scope: { visibleOnly: true },
      },
    ],
  }
}

describe("Tailwind token drift guard", () => {
  it("passes when producer-owned collections match and preserves policy-owned ranges", () => {
    const result = checkTailwindTokenDrift(css, geometryConfig())

    expect(result).toMatchObject({
      status: "in-sync",
      producerOwnedCollections: ["valueSets", "scales"],
      changedCollections: [],
      unresolved: [],
    })
    expect(result.generatedDigest).toBe(result.sealedDigest)
  })

  it("reports the exact producer-owned collection that drifted", () => {
    const result = checkTailwindTokenDrift(
      css.replace("#007d50", "#2e8b57"),
      geometryConfig(),
    )

    expect(result.status).toBe("drift")
    expect(result.changedCollections).toEqual(["valueSets"])
    expect(result.generatedDigest).not.toBe(result.sealedDigest)
  })

  it("fails closed when declarations are unresolved even if resolved tokens match", () => {
    const result = checkTailwindTokenDrift(
      `${css}\n:root { --unresolved: var(--missing); }`,
      geometryConfig(),
    )

    expect(result.status).toBe("unresolved")
    expect(result.unresolved).toMatchObject([
      { name: "--unresolved", reason: "unresolved-reference" },
    ])
  })

  it("rejects an invalid geometry config rather than comparing partial input", () => {
    expect(() =>
      checkTailwindTokenDrift(css, { tokenSet: geometryConfig().tokenSet }),
    ).toThrow()
  })
})
