/**
 * Normalizes lengths into logical pixels.
 *
 * The engine never compares a length string, and never sees a unit suffix: a
 * platform adapter resolves its own units here so the same constraint can run
 * against CSS pixels today and against points or density-independent pixels
 * when a native adapter exists. See docs/adr/0002.
 */

export const DEFAULT_ROOT_FONT_SIZE_PX = 16

/**
 * Returns undefined for units this engine cannot resolve without layout
 * context, such as percentages and `em`. An unresolved length is reported as
 * unnormalizable rather than coerced.
 */
export function parseLengthPx(
  input: string,
  rootFontSizePx: number = DEFAULT_ROOT_FONT_SIZE_PX,
): number | undefined {
  const text = input.trim().toLowerCase()
  const match = /^(-?\d*\.?\d+)(px|rem)?$/.exec(text)
  if (!match) return undefined
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return undefined
  if (match[2] === "rem") return value * rootFontSizePx
  if (match[2] === "px" || value === 0) return value
  return undefined
}

/**
 * Parses a shorthand whose components must agree, such as `border-radius`.
 * Differing components describe a shape a single scalar cannot represent, so
 * the result is undefined rather than an arbitrarily chosen corner.
 */
export function parseUniformLengthPx(
  input: string,
  rootFontSizePx: number = DEFAULT_ROOT_FONT_SIZE_PX,
): number | undefined {
  const parts = input.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return undefined
  const lengths = parts.map((part) => parseLengthPx(part, rootFontSizePx))
  if (lengths.some((length) => length === undefined)) return undefined
  const [first, ...rest] = lengths as number[]
  return rest.every((length) => length === first) ? first : undefined
}

/** Nearest step on a scale, and the distance to it. */
export function nearestStep(
  value: number,
  steps: readonly number[],
): { step: number; distance: number } | undefined {
  if (steps.length === 0) return undefined
  let best = steps[0]
  let bestDistance = Math.abs(value - steps[0])
  for (const step of steps.slice(1)) {
    const distance = Math.abs(value - step)
    if (distance < bestDistance) {
      best = step
      bestDistance = distance
    }
  }
  return { step: best, distance: bestDistance }
}
