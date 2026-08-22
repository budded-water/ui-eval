/**
 * Translates web capture evidence into the normalized property space.
 *
 * This is the evidence-side counterpart to a design producer. It is the only
 * place in the geometry path that knows a CSS property name exists; everything
 * downstream reads abstract properties. A native adapter would add a sibling
 * module and change nothing else. See docs/adr/0002.
 */

import type {
  LayoutEvidencePayload,
  StylesEvidencePayload,
} from "../../contracts/model"
import { parseColor } from "../../normalize/color"
import {
  DEFAULT_ROOT_FONT_SIZE_PX,
  parseLengthPx,
  parseUniformLengthPx,
} from "../../normalize/length"

import type {
  AbstractProperty,
  NormalizedNode,
  NormalizedValue,
} from "./property-space"

export interface WebNormalizeOptions {
  readonly rootFontSizePx?: number
}

type StyleNode = StylesEvidencePayload["nodes"][number]
type ComputedStyle = StyleNode["computedStyle"]

function colorValue(raw: string | undefined): NormalizedValue | undefined {
  if (raw === undefined) return undefined
  const color = parseColor(raw)
  return color ? { kind: "color", color } : { kind: "unnormalizable", raw }
}

function lengthValue(
  raw: string | undefined,
  rootFontSizePx: number,
  uniform = false,
): NormalizedValue | undefined {
  if (raw === undefined) return undefined
  const px = uniform
    ? parseUniformLengthPx(raw, rootFontSizePx)
    : parseLengthPx(raw, rootFontSizePx)
  return px === undefined ? { kind: "unnormalizable", raw } : { kind: "length", px }
}

/**
 * `font-weight` is a keyword or a number depending on the declaration, and
 * `line-height: normal` has no value until layout resolves it. Neither is
 * coerced: an unresolved value stays unnormalizable so a constraint reports it
 * as invalid evidence rather than comparing a guess.
 */
function weightValue(raw: string | undefined): NormalizedValue | undefined {
  if (raw === undefined) return undefined
  const numeric = Number.parseFloat(raw)
  if (Number.isFinite(numeric)) return { kind: "number", value: numeric }
  const named: Record<string, number> = { normal: 400, bold: 700 }
  const resolved = named[raw.trim().toLowerCase()]
  return resolved === undefined
    ? { kind: "unnormalizable", raw }
    : { kind: "number", value: resolved }
}

/** Takes the first declared family, unquoted and case-folded, ignoring fallbacks. */
function familyValue(raw: string | undefined): NormalizedValue | undefined {
  if (raw === undefined) return undefined
  const first = raw.split(",")[0]?.trim().replace(/^["']|["']$/g, "")
  return first
    ? { kind: "family", family: first.toLowerCase() }
    : { kind: "unnormalizable", raw }
}

function shadowValue(raw: string | undefined): NormalizedValue | undefined {
  if (raw === undefined) return undefined
  const text = raw.trim().toLowerCase()
  return text === "none"
    ? { kind: "keyword", keyword: "none" }
    : { kind: "unnormalizable", raw }
}

function styleProperties(
  style: ComputedStyle | undefined,
  rootFontSizePx: number,
): Array<[AbstractProperty, NormalizedValue]> {
  if (!style) return []
  const read = (key: string): string | undefined =>
    (style as Record<string, string | undefined>)[key]

  const entries: Array<[AbstractProperty, NormalizedValue | undefined]> = [
    ["box.radius", lengthValue(read("borderRadius"), rootFontSizePx, true)],
    ["fill.color", colorValue(read("backgroundColor"))],
    ["text.color", colorValue(read("color"))],
    ["stroke.color", colorValue(read("borderColor"))],
    ["text.size", lengthValue(read("fontSize"), rootFontSizePx)],
    ["text.weight", weightValue(read("fontWeight"))],
    ["text.lineHeight", lengthValue(read("lineHeight"), rootFontSizePx)],
    ["text.family", familyValue(read("fontFamily"))],
    ["effect.shadow", shadowValue(read("boxShadow"))],
  ]

  return entries.filter(
    (entry): entry is [AbstractProperty, NormalizedValue] => entry[1] !== undefined,
  )
}

export function normalizeWebEvidence(
  layout: LayoutEvidencePayload,
  styles: StylesEvidencePayload | undefined,
  options: WebNormalizeOptions = {},
): NormalizedNode[] {
  const rootFontSizePx = options.rootFontSizePx ?? DEFAULT_ROOT_FONT_SIZE_PX
  const styleByNodeId = new Map<string, StyleNode>(
    (styles?.nodes ?? []).map((node) => [node.nodeId, node]),
  )
  const rectByNodeId = new Map(layout.nodes.map((node) => [node.nodeId, node.rect]))

  return layout.nodes.map((node) => {
    // Absent on a root node, which has no containing element to overflow.
    const parentRect =
      node.parentNodeId === undefined
        ? undefined
        : rectByNodeId.get(node.parentNodeId)
    const overflowRight =
      parentRect === undefined
        ? undefined
        : node.rect.x + node.rect.width - (parentRect.x + parentRect.width)

    const properties = new Map<AbstractProperty, NormalizedValue>([
      ["box.x", { kind: "length", px: node.rect.x }],
      ["box.y", { kind: "length", px: node.rect.y }],
      ["box.width", { kind: "length", px: node.rect.width }],
      ["box.height", { kind: "length", px: node.rect.height }],
      ...(overflowRight === undefined
        ? []
        : ([["box.overflowRight", { kind: "length", px: overflowRight }]] as Array<
            [AbstractProperty, NormalizedValue]
          >)),
      ...styleProperties(styleByNodeId.get(node.nodeId)?.computedStyle, rootFontSizePx),
    ])

    return {
      nodeId: node.nodeId,
      ...(node.uiId === undefined ? {} : { uiId: node.uiId }),
      ...(node.testId === undefined ? {} : { testId: node.testId }),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.accessibleName === undefined
        ? {}
        : { accessibleName: node.accessibleName }),
      visible: node.visible,
      properties,
    }
  })
}
