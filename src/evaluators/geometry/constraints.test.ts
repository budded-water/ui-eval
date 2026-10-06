import { describe, expect, it } from "vitest"

import type { DesignTokenSet } from "../../contracts/model"

import {
  ConstraintConfigurationError,
  evaluateConstraint,
  type Constraint,
} from "./constraints"
import { normalizeWebEvidence } from "./normalize-web"
import type { NormalizedNode } from "./property-space"

const tokenSet: DesignTokenSet = {
  valueSets: [
    {
      id: "palette",
      valueKind: "color",
      values: [
        { r: 0, g: 125, b: 80, alpha: 1 },
        { r: 255, g: 255, b: 255, alpha: 1 },
      ],
    },
    { id: "families", valueKind: "family", values: ["inter"] },
  ],
  scales: [{ id: "radius", unit: "logical-px", steps: [6, 10, 14] }],
  ranges: [
    { id: "touch-target", unit: "logical-px", min: 44 },
    { id: "line-height", unit: "ratio", min: 1.2, max: 1.8 },
  ],
}

const layout = (
  nodes: Array<{
    nodeId: string
    rect: { x: number; y: number; width: number; height: number }
    visible?: boolean
    uiId?: string
    role?: string
    accessibleName?: string
  }>,
) => ({
  schemaVersion: "uieval.layout/v1alpha1" as const,
  renderSpace: {
    viewportWidthPx: 1440,
    viewportHeightPx: 900,
    deviceScaleFactor: 1,
    screenshotWidthPx: 1440,
    screenshotHeightPx: 900,
  },
  nodes: nodes.map((node) => ({
    nodeId: node.nodeId,
    rect: node.rect,
    visible: node.visible ?? true,
    ...(node.uiId === undefined ? {} : { uiId: node.uiId }),
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.accessibleName === undefined
      ? {}
      : { accessibleName: node.accessibleName }),
  })),
})

const styles = (nodes: Array<{ nodeId: string; computedStyle: Record<string, string> }>) => ({
  schemaVersion: "uieval.styles/v1alpha1" as const,
  nodes,
})

function nodesFrom(
  layoutNodes: Parameters<typeof layout>[0],
  styleNodes: Parameters<typeof styles>[0] = [],
): NormalizedNode[] {
  return normalizeWebEvidence(
    layout(layoutNodes) as never,
    styles(styleNodes) as never,
  )
}

describe("web evidence normalization", () => {
  it("maps CSS properties onto abstract names and normalizes their values", () => {
    const [node] = nodesFrom(
      [{ nodeId: "1", rect: { x: 0, y: 0, width: 100, height: 48 } }],
      [
        {
          nodeId: "1",
          computedStyle: {
            backgroundColor: "rgb(0, 125, 80)",
            borderRadius: "10px",
            fontSize: "16px",
            fontWeight: "bold",
            fontFamily: '"Inter", sans-serif',
            lineHeight: "24px",
            boxShadow: "none",
          },
        },
      ],
    )
    expect(node.properties.get("fill.color")).toEqual({
      kind: "color",
      color: { r: 0, g: 125, b: 80, alpha: 1 },
    })
    expect(node.properties.get("box.radius")).toEqual({ kind: "length", px: 10 })
    expect(node.properties.get("text.weight")).toEqual({ kind: "number", value: 700 })
    expect(node.properties.get("text.family")).toEqual({ kind: "family", family: "inter" })
  })

  it("marks values it cannot resolve rather than coercing them", () => {
    const [node] = nodesFrom(
      [{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
      [
        {
          nodeId: "1",
          computedStyle: { lineHeight: "normal", borderRadius: "10px 4px 10px 4px" },
        },
      ],
    )
    expect(node.properties.get("text.lineHeight")).toEqual({
      kind: "unnormalizable",
      raw: "normal",
    })
    expect(node.properties.get("box.radius")).toEqual({
      kind: "unnormalizable",
      raw: "10px 4px 10px 4px",
    })
  })
})

describe("value-in-set", () => {
  const constraint: Constraint = {
    id: "fill-in-palette",
    kind: "value-in-set",
    property: "fill.color",
    valueSetRef: "palette",
  }

  it("passes when every compared value is in the set", () => {
    const nodes = nodesFrom(
      [{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
      [{ nodeId: "1", computedStyle: { backgroundColor: "#007d50" } }],
    )
    expect(evaluateConstraint(constraint, nodes, tokenSet).status).toBe("passed")
  })

  it("reports an off-palette value regardless of its notation", () => {
    const nodes = nodesFrom(
      [{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
      [{ nodeId: "1", computedStyle: { backgroundColor: "rgb(59, 125, 216)" } }],
    )
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.status).toBe("failed")
    expect(result.violations[0].detail).toContain("not in 'palette'")
  })

  it("throws a configuration error for an unknown reference", () => {
    const nodes = nodesFrom([{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }])
    expect(() =>
      evaluateConstraint({ ...constraint, valueSetRef: "nope" }, nodes, tokenSet),
    ).toThrow(ConstraintConfigurationError)
  })
})

describe("value-on-scale", () => {
  const constraint: Constraint = {
    id: "radius-on-scale",
    kind: "value-on-scale",
    property: "box.radius",
    scaleRef: "radius",
    tolerance: 0.5,
  }

  it("accepts a step within tolerance and rejects one beyond it", () => {
    const nodes = nodesFrom(
      [
        { nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { nodeId: "2", rect: { x: 0, y: 0, width: 1, height: 1 } },
      ],
      [
        { nodeId: "1", computedStyle: { borderRadius: "10.4px" } },
        { nodeId: "2", computedStyle: { borderRadius: "12px" } },
      ],
    )
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.status).toBe("failed")
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].nodeId).toBe("2")
  })
})

describe("value-in-range", () => {
  it("flags a control below the minimum target size", () => {
    const constraint: Constraint = {
      id: "touch-target",
      kind: "value-in-range",
      property: "box.height",
      rangeRef: "touch-target",
      scope: { roles: ["button"] },
    }
    const nodes = nodesFrom([
      { nodeId: "1", rect: { x: 0, y: 0, width: 80, height: 32 }, role: "button" },
      { nodeId: "2", rect: { x: 0, y: 0, width: 80, height: 48 }, role: "button" },
      { nodeId: "3", rect: { x: 0, y: 0, width: 80, height: 10 }, role: "img" },
    ])
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.matchedNodes).toBe(2)
    expect(result.violations.map((violation) => violation.nodeId)).toEqual(["1"])
  })
})

describe("cross-node-equal", () => {
  const constraint: Constraint = {
    id: "cta-height-consistent",
    kind: "cross-node-equal",
    property: "box.height",
    tolerance: 0.5,
  }

  it("needs no design source and flags a group that disagrees", () => {
    const nodes = nodesFrom([
      { nodeId: "1", rect: { x: 0, y: 0, width: 80, height: 48 }, uiId: "cta" },
      { nodeId: "2", rect: { x: 0, y: 0, width: 80, height: 44 }, uiId: "cta" },
      { nodeId: "3", rect: { x: 0, y: 0, width: 80, height: 20 }, uiId: "other" },
    ])
    const result = evaluateConstraint(constraint, nodes, {})
    expect(result.status).toBe("failed")
    expect(result.violations[0].detail).toContain("uiId:cta")
  })

  it("passes when every identified group agrees", () => {
    const nodes = nodesFrom([
      { nodeId: "1", rect: { x: 0, y: 0, width: 80, height: 48 }, uiId: "cta" },
      { nodeId: "2", rect: { x: 0, y: 0, width: 80, height: 48 }, uiId: "cta" },
    ])
    expect(evaluateConstraint(constraint, nodes, {}).status).toBe("passed")
  })

  it("requires comparable peers rather than accepting one identified node", () => {
    const nodes = nodesFrom([
      { nodeId: "1", rect: { x: 0, y: 0, width: 80, height: 48 }, uiId: "cta" },
    ])
    expect(evaluateConstraint(constraint, nodes, {})).toMatchObject({
      status: "invalid", invalidReason: "insufficient-peers", comparedNodes: 1,
    })
  })
})

describe("ratio", () => {
  it("compares two properties of the same node against a range", () => {
    const constraint: Constraint = {
      id: "line-height-ratio",
      kind: "ratio",
      numerator: "text.lineHeight",
      denominator: "text.size",
      rangeRef: "line-height",
    }
    const nodes = nodesFrom(
      [
        { nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { nodeId: "2", rect: { x: 0, y: 0, width: 1, height: 1 } },
      ],
      [
        { nodeId: "1", computedStyle: { fontSize: "16px", lineHeight: "24px" } },
        { nodeId: "2", computedStyle: { fontSize: "16px", lineHeight: "40px" } },
      ],
    )
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.status).toBe("failed")
    expect(result.violations.map((violation) => violation.nodeId)).toEqual(["2"])
  })
})

describe("uncertainty never becomes a pass", () => {
  const constraint: Constraint = {
    id: "fill-in-palette",
    kind: "value-in-set",
    property: "fill.color",
    valueSetRef: "palette",
  }

  it("is invalid, not passing, when nothing matched", () => {
    const nodes = nodesFrom([{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }])
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.status).toBe("invalid")
    expect(result.invalidReason).toBe("no-match")
  })

  it("is unsupported when a zero match is explicitly allowed", () => {
    const nodes = nodesFrom([{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }])
    const result = evaluateConstraint(
      { ...constraint, requireMatch: false },
      nodes,
      tokenSet,
    )
    expect(result.status).toBe("unsupported")
  })

  it("is invalid, not passing, when a value cannot be normalized", () => {
    const nodes = nodesFrom(
      [{ nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
      [{ nodeId: "1", computedStyle: { backgroundColor: "color-mix(in srgb, red, blue)" } }],
    )
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.status).toBe("invalid")
    expect(result.invalidReason).toBe("unnormalizable-values")
  })

  it("does not let an unreadable node mask a defect found on readable ones", () => {
    const nodes = nodesFrom(
      [
        { nodeId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { nodeId: "2", rect: { x: 0, y: 0, width: 1, height: 1 } },
      ],
      [
        { nodeId: "1", computedStyle: { backgroundColor: "color-mix(in srgb, red, blue)" } },
        { nodeId: "2", computedStyle: { backgroundColor: "rgb(59, 125, 216)" } },
      ],
    )
    const result = evaluateConstraint(constraint, nodes, tokenSet)
    expect(result.status).toBe("failed")
    expect(result.violations.map((violation) => violation.nodeId)).toEqual(["2"])
    // The coverage gap is still reported, just not as the status.
    expect(result.unnormalizableNodes).toBe(1)
  })
})

describe("box.overflowRight", () => {
  // Parent-relative, so it needs no viewport configuration and is not fooled by
  // a full-page render space that the overflow itself inflated.
  const constraint: Constraint = {
    id: "no-horizontal-overflow",
    kind: "value-in-range",
    property: "box.overflowRight",
    rangeRef: "overflow",
    scope: { visibleOnly: true },
  }
  const tokens: DesignTokenSet = {
    ranges: [{ id: "overflow", unit: "logical-px", max: 0 }],
  }

  const withParents = () =>
    normalizeWebEvidence(
      {
        schemaVersion: "uieval.layout/v1alpha1",
        renderSpace: {
          // Deliberately the inflated full-page width, not the viewport.
          logicalWidth: 735,
          logicalHeight: 3557,
          logicalUnit: "css-px",
          deviceScaleFactor: 2,
          screenshotWidthPx: 1470,
          screenshotHeightPx: 7114,
          orientation: "portrait",
        },
        nodes: [
          { nodeId: "root", rect: { x: 0, y: 0, width: 390, height: 800 }, visible: true },
          {
            nodeId: "container",
            parentNodeId: "root",
            rect: { x: 24, y: 0, width: 342, height: 200 },
            visible: true,
          },
          {
            nodeId: "overflowing",
            parentNodeId: "container",
            rect: { x: 24, y: 0, width: 592, height: 120 },
            visible: true,
          },
        ],
      } as never,
      undefined,
    )

  it("flags the node that breaks out of its container", () => {
    const result = evaluateConstraint(constraint, withParents(), tokens)
    expect(result.status).toBe("failed")
    expect(result.violations.map((violation) => violation.nodeId)).toEqual(["overflowing"])
    expect(result.violations[0].detail).toContain("250")
  })

  it("is absent on a root node rather than compared against nothing", () => {
    const [root] = withParents()
    expect(root.properties.has("box.overflowRight")).toBe(false)
  })

  it("passes for a node contained by its parent", () => {
    const nodes = withParents().filter((node) => node.nodeId !== "overflowing")
    expect(evaluateConstraint(constraint, nodes, tokens).status).toBe("passed")
  })

  it("uses the nearest box-generating ancestor through display: contents", () => {
    const nodes = normalizeWebEvidence(
      {
        schemaVersion: "uieval.layout/v1alpha1",
        renderSpace: {
          logicalWidth: 390,
          logicalHeight: 800,
          logicalUnit: "css-px",
          deviceScaleFactor: 1,
          screenshotWidthPx: 390,
          screenshotHeightPx: 800,
          orientation: "portrait",
        },
        nodes: [
          { nodeId: "root", rect: { x: 0, y: 0, width: 390, height: 800 }, visible: true },
          {
            nodeId: "contents",
            parentNodeId: "root",
            rect: { x: 0, y: 0, width: 0, height: 0 },
            visible: false,
          },
          {
            nodeId: "link",
            parentNodeId: "contents",
            rect: { x: 320, y: 20, width: 40, height: 40 },
            visible: true,
          },
        ],
      } as never,
      {
        schemaVersion: "uieval.styles/v1alpha1",
        nodes: [
          { nodeId: "root", computedStyle: { display: "block" } },
          { nodeId: "contents", computedStyle: { display: "contents" } },
          { nodeId: "link", computedStyle: { display: "flex" } },
        ],
      },
    )

    expect(evaluateConstraint(constraint, nodes, tokens).status).toBe("passed")
    expect(nodes.find((node) => node.nodeId === "link")?.properties.get("box.overflowRight"))
      .toEqual({ kind: "length", px: -30 })
  })

  it("still evaluates a real zero-sized parent as a containing box", () => {
    const nodes = normalizeWebEvidence(
      {
        schemaVersion: "uieval.layout/v1alpha1",
        renderSpace: {
          logicalWidth: 390,
          logicalHeight: 800,
          logicalUnit: "css-px",
          deviceScaleFactor: 1,
          screenshotWidthPx: 390,
          screenshotHeightPx: 800,
          orientation: "portrait",
        },
        nodes: [
          { nodeId: "root", rect: { x: 0, y: 0, width: 390, height: 800 }, visible: true },
          {
            nodeId: "zero-box",
            parentNodeId: "root",
            rect: { x: 20, y: 20, width: 0, height: 0 },
            visible: false,
          },
          {
            nodeId: "child",
            parentNodeId: "zero-box",
            rect: { x: 20, y: 20, width: 40, height: 40 },
            visible: true,
          },
        ],
      } as never,
      {
        schemaVersion: "uieval.styles/v1alpha1",
        nodes: [
          { nodeId: "root", computedStyle: { display: "block" } },
          { nodeId: "zero-box", computedStyle: { display: "block" } },
          { nodeId: "child", computedStyle: { display: "block" } },
        ],
      },
    )

    const result = evaluateConstraint(constraint, nodes, tokens)
    expect(result.status).toBe("failed")
    expect(result.violations.map((violation) => violation.nodeId)).toContain("child")
  })

  it("uses the positioned containing block for an absolute child", () => {
    const nodes = normalizeWebEvidence(
      {
        schemaVersion: "uieval.layout/v1alpha1",
        renderSpace: {
          logicalWidth: 820,
          logicalHeight: 1180,
          logicalUnit: "css-px",
          deviceScaleFactor: 1,
          screenshotWidthPx: 820,
          screenshotHeightPx: 1180,
          orientation: "portrait",
        },
        nodes: [
          { nodeId: "header", rect: { x: 0, y: 0, width: 820, height: 56 }, visible: true },
          {
            nodeId: "padded-row",
            parentNodeId: "header",
            rect: { x: 16, y: 0, width: 788, height: 56 },
            visible: true,
          },
          {
            nodeId: "menu",
            parentNodeId: "padded-row",
            rect: { x: 0, y: 56, width: 820, height: 182 },
            visible: true,
          },
        ],
      } as never,
      {
        schemaVersion: "uieval.styles/v1alpha1",
        nodes: [
          { nodeId: "header", computedStyle: { display: "block", position: "sticky" } },
          { nodeId: "padded-row", computedStyle: { display: "flex", position: "static" } },
          { nodeId: "menu", computedStyle: { display: "block", position: "absolute" } },
        ],
      },
    )

    expect(evaluateConstraint(constraint, nodes, tokens).status).toBe("passed")
    expect(nodes.find((node) => node.nodeId === "menu")?.properties.get("box.overflowRight"))
      .toEqual({ kind: "length", px: 0 })
  })
})
