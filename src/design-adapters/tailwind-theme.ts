/**
 * Produces a normalized design token set from a Tailwind v4 stylesheet.
 *
 * This is a reference producer for the design contract described in
 * docs/adr/0002. It reads declarative CSS only: it never imports, executes, or
 * evaluates candidate application code, and it holds no policy knowledge, so
 * severity and tolerance stay in the evaluation policy where they belong.
 *
 * A value the adapter cannot resolve is reported rather than dropped. Silent
 * omission would shrink the allowed value set, which turns a missing token into
 * a false violation later.
 */

import type {
  DesignScale,
  DesignTokenSet,
  DesignValueSet,
  NormalizedColor,
} from "../contracts/model"
import { colorKey, parseColor } from "../normalize/color"
import { DEFAULT_ROOT_FONT_SIZE_PX, parseLengthPx } from "../normalize/length"

export interface TailwindThemeOptions {
  /** Selector whose declarations win over `:root`, e.g. `.dark`. */
  readonly theme?: string
  /** Root font size used to resolve `rem`, in CSS pixels. */
  readonly rootFontSizePx?: number
}

export interface UnresolvedToken {
  readonly name: string
  readonly value: string
  readonly reason:
    | "unsupported-value"
    | "unresolved-reference"
    | "reference-cycle"
    | "unsupported-expression"
}

export interface TailwindThemeImport {
  readonly tokenSet: DesignTokenSet
  readonly unresolved: readonly UnresolvedToken[]
  readonly declarationCount: number
}

const MAX_REFERENCE_DEPTH = 16

interface CssBlock {
  readonly header: string
  readonly body: string
}

/** Extracts top-level `header { body }` pairs, skipping nested at-rule bodies. */
function topLevelBlocks(css: string): CssBlock[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const blocks: CssBlock[] = []
  let depth = 0
  let headerStart = 0
  let bodyStart = 0

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "{") {
      if (depth === 0) bodyStart = index + 1
      depth += 1
    } else if (character === "}") {
      depth -= 1
      if (depth === 0) {
        // A header runs from the end of the previous statement, not from the
        // end of the previous block: top-level `@import`/`@custom-variant`
        // statements sit between blocks and would otherwise be prepended.
        const preceding = source.slice(headerStart, bodyStart - 1)
        const statementEnd = preceding.lastIndexOf(";")
        blocks.push({
          header: preceding.slice(statementEnd + 1).trim(),
          body: source.slice(bodyStart, index),
        })
        headerStart = index + 1
      }
      if (depth < 0) return blocks
    }
  }
  return blocks
}

/** Reads `--name: value` pairs, ignoring nested rules inside the body. */
function customProperties(body: string): Map<string, string> {
  const declarations = new Map<string, string>()
  let depth = 0
  let buffer = ""

  const flush = () => {
    const text = buffer.trim()
    buffer = ""
    if (!text.startsWith("--")) return
    const separator = text.indexOf(":")
    if (separator < 0) return
    const name = text.slice(0, separator).trim()
    const value = text.slice(separator + 1).trim()
    if (name.length > 2 && value.length > 0) declarations.set(name, value)
  }

  for (const character of body) {
    if (character === "{") depth += 1
    else if (character === "}") depth -= 1
    else if (character === ";" && depth === 0) {
      flush()
      continue
    }
    if (depth === 0 && character !== "{" && character !== "}") buffer += character
  }
  flush()
  return declarations
}

function collectDeclarations(
  css: string,
  theme: string | undefined,
): Map<string, string> {
  const base = new Map<string, string>()
  const override = new Map<string, string>()

  for (const block of topLevelBlocks(css)) {
    const isTheme = block.header.startsWith("@theme")
    const isRoot = block.header === ":root"
    const isRequested = theme !== undefined && block.header === theme
    if (!isTheme && !isRoot && !isRequested) continue
    const target = isRequested && !isRoot && !isTheme ? override : base
    for (const [name, value] of customProperties(block.body)) target.set(name, value)
  }

  for (const [name, value] of override) base.set(name, value)
  return base
}

type ResolveFailure = UnresolvedToken["reason"]

/**
 * Expands `var()` references and a restricted `calc()` subset. Anything outside
 * that subset fails loudly so the caller can report it rather than emit a token
 * set that silently lost entries.
 */
function resolveValue(
  value: string,
  declarations: ReadonlyMap<string, string>,
  rootFontSizePx: number,
  seen: ReadonlySet<string>,
  depth: number,
): { text: string } | { failure: ResolveFailure } {
  if (depth > MAX_REFERENCE_DEPTH) return { failure: "reference-cycle" }

  const reference = /^var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)$/.exec(value.trim())
  if (reference) {
    const name = reference[1]
    if (seen.has(name)) return { failure: "reference-cycle" }
    const referenced = declarations.get(name) ?? reference[2]
    if (referenced === undefined) return { failure: "unresolved-reference" }
    return resolveValue(
      referenced,
      declarations,
      rootFontSizePx,
      new Set([...seen, name]),
      depth + 1,
    )
  }

  const calc = /^calc\((.+)\)$/.exec(value.trim())
  if (calc) {
    const parts = /^(.+?)\s([+\-*/])\s(.+)$/.exec(calc[1].trim())
    if (!parts) return { failure: "unsupported-expression" }
    const operands = [parts[1], parts[3]].map((operand) =>
      resolveValue(operand, declarations, rootFontSizePx, seen, depth + 1),
    )
    const lengths = operands.map((operand) =>
      "text" in operand ? parseLengthPx(operand.text, rootFontSizePx) : undefined,
    )
    if (lengths.some((length) => length === undefined)) {
      return { failure: "unsupported-expression" }
    }
    const [left, right] = lengths as number[]
    const result =
      parts[2] === "+"
        ? left + right
        : parts[2] === "-"
          ? left - right
          : parts[2] === "*"
            ? left * right
            : right === 0
              ? undefined
              : left / right
    if (result === undefined || !Number.isFinite(result)) {
      return { failure: "unsupported-expression" }
    }
    return { text: `${String(result)}px` }
  }

  return { text: value.trim() }
}

/** Groups `--radius-sm` and `--radius` alike under the scale id `radius`. */
function scaleIdFor(name: string): string {
  return name.replace(/^--/, "").split("-")[0]
}

export function importTailwindTheme(
  css: string,
  options: TailwindThemeOptions = {},
): TailwindThemeImport {
  const rootFontSizePx = options.rootFontSizePx ?? DEFAULT_ROOT_FONT_SIZE_PX
  const declarations = collectDeclarations(css, options.theme)

  const colors = new Map<string, NormalizedColor>()
  const scaleSteps = new Map<string, Set<number>>()
  const unresolved: UnresolvedToken[] = []

  for (const [name, rawValue] of declarations) {
    const resolved = resolveValue(
      rawValue,
      declarations,
      rootFontSizePx,
      new Set([name]),
      0,
    )
    if ("failure" in resolved) {
      unresolved.push({ name, value: rawValue, reason: resolved.failure })
      continue
    }

    const color = parseColor(resolved.text)
    if (color) {
      colors.set(colorKey(color), color)
      continue
    }

    const length = parseLengthPx(resolved.text, rootFontSizePx)
    if (length !== undefined) {
      const id = scaleIdFor(name)
      if (!scaleSteps.has(id)) scaleSteps.set(id, new Set())
      scaleSteps.get(id)?.add(length)
      continue
    }

    unresolved.push({ name, value: rawValue, reason: "unsupported-value" })
  }

  const valueSets: DesignValueSet[] = []
  if (colors.size > 0) {
    valueSets.push({
      id: "palette",
      valueKind: "color",
      values: [...colors.values()].sort((left, right) =>
        colorKey(left).localeCompare(colorKey(right)),
      ),
    })
  }

  const scales: DesignScale[] = [...scaleSteps.entries()]
    .map(([id, steps]) => ({
      id,
      unit: "logical-px" as const,
      steps: [...steps].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  const tokenSet: DesignTokenSet = {}
  if (valueSets.length > 0) tokenSet.valueSets = valueSets
  if (scales.length > 0) tokenSet.scales = scales

  return { tokenSet, unresolved, declarationCount: declarations.size }
}
