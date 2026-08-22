import { describe, expect, it } from "vitest"

import type { GeometryEvaluatorConfig } from "../../contracts/model"

import { evaluateGeometryEvidence } from "./evaluator"

const config: GeometryEvaluatorConfig = {
  tokenSet: {
    valueSets: [
      {
        id: "palette",
        valueKind: "color",
        values: [{ r: 255, g: 255, b: 255, alpha: 1 }],
      },
    ],
  },
  constraints: [
    {
      id: "fill-in-palette",
      kind: "value-in-set",
      property: "fill.color",
      valueSetRef: "palette",
    },
  ],
}

const checkpoint = (checkpointId: string, backgroundColor: string) => ({
  checkpointId,
  layout: {
    schemaVersion: "uieval.layout/v1alpha1" as const,
    renderSpace: {
      viewportWidthPx: 800,
      viewportHeightPx: 600,
      deviceScaleFactor: 1,
      screenshotWidthPx: 800,
      screenshotHeightPx: 600,
    },
    nodes: [
      {
        nodeId: "1",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        visible: true,
      },
    ],
  },
  styles: {
    schemaVersion: "uieval.styles/v1alpha1" as const,
    nodes: [{ nodeId: "1", computedStyle: { backgroundColor } }],
  },
})

describe("geometry evaluator", () => {
  it("reports metrics, coverage, and findings per checkpoint", () => {
    const result = evaluateGeometryEvidence(config, [
      checkpoint("ready", "#ffffff") as never,
      checkpoint("after-scroll", "rgb(1, 2, 3)") as never,
    ])

    expect(result.metrics).toEqual({
      "geometry.violations": 1,
      "geometry.failedConstraints": 1,
      "geometry.indecisiveConstraints": 0,
    })
    // One constraint per checkpoint is one unit of coverage.
    expect(result.coverage).toEqual({
      expected: 2,
      evaluated: 2,
      passed: 1,
      failed: 1,
      unsupported: 0,
      invalid: 0,
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].checkpointId).toBe("after-scroll")
  })

  it("counts an undecidable constraint without letting it pass", () => {
    const result = evaluateGeometryEvidence(config, [
      checkpoint("ready", "color-mix(in srgb, red, blue)") as never,
    ])
    expect(result.metrics["geometry.violations"]).toBe(0)
    expect(result.metrics["geometry.indecisiveConstraints"]).toBe(1)
    expect(result.coverage.passed).toBe(0)
    expect(result.coverage.invalid).toBe(1)
  })

  it("evaluates nothing when no checkpoint carried structured evidence", () => {
    const result = evaluateGeometryEvidence(config, [])
    expect(result.coverage.expected).toBe(0)
    expect(result.findings).toEqual([])
  })
})
