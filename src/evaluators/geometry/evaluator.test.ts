import { describe, expect, it } from "vitest"

import type { GeometryEvaluatorConfig } from "../../contracts/model"
import { validateLayoutEvidencePayload, validateStylesEvidencePayload } from "../../contracts/validation"

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
  layout: validateLayoutEvidencePayload({
    schemaVersion: "uieval.layout/v1alpha1" as const,
    renderSpace: {
      logicalWidth: 800,
      logicalHeight: 600,
      logicalUnit: "css-px",
      orientation: "landscape",
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
  }),
  styles: validateStylesEvidencePayload({
    schemaVersion: "uieval.styles/v1alpha1" as const,
    nodes: [{ nodeId: "1", computedStyle: { backgroundColor } }],
  }),
})

describe("geometry evaluator", () => {
  it("reports metrics, coverage, and findings per checkpoint", () => {
    const result = evaluateGeometryEvidence(config, [
      checkpoint("ready", "#ffffff"),
      checkpoint("after-scroll", "rgb(1, 2, 3)"),
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
      checkpoint("ready", "color-mix(in srgb, red, blue)"),
    ])
    expect(result.metrics["geometry.violations"]).toBe(0)
    expect(result.metrics["geometry.indecisiveConstraints"]).toBe(1)
    expect(result.coverage.passed).toBe(0)
    expect(result.coverage.invalid).toBe(1)
  })

  it("retains missing planned checkpoints as invalid coverage", () => {
    const result = evaluateGeometryEvidence(config, [], ["ready", "after-scroll"])
    expect(result.coverage.expected).toBe(2)
    expect(result.coverage.invalid).toBe(2)
    expect(result.metrics["geometry.indecisiveConstraints"]).toBe(2)
    expect(result.findings).toEqual([])
  })

  it("does not report zero indecisive constraints for an empty input", () => {
    expect(evaluateGeometryEvidence(config, []).metrics["geometry.indecisiveConstraints"]).toBe(1)
  })

  it("compares the same identity across checkpoints once and attributes its finding", () => {
    const first = checkpoint("ready", "#ffffff")
    const second = checkpoint("after-scroll", "#ffffff")
    first.layout.nodes[0].testId = second.layout.nodes[0].testId = "button"
    second.layout.nodes[0].rect.width = 20
    const result = evaluateGeometryEvidence({
      tokenSet: {},
      constraints: [{ id: "consistent-width", kind: "cross-node-equal", property: "box.width", tolerance: 0 }],
    }, [first, second])
    expect(result.coverage).toMatchObject({ expected: 1, failed: 1 })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].checkpointId).toBe("ready")
  })

  it("keeps a missing checkpoint unknown during an equality comparison", () => {
    const first = checkpoint("ready", "#ffffff")
    first.layout.nodes[0].testId = "button"
    const result = evaluateGeometryEvidence({
      tokenSet: {},
      constraints: [{ id: "consistent-width", kind: "cross-node-equal", property: "box.width", tolerance: 0 }],
    }, [first], ["ready", "after-scroll"])
    expect(result.coverage).toMatchObject({ expected: 1, invalid: 1, passed: 0 })
  })
})
