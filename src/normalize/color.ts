/**
 * Normalizes color notations into sRGB components.
 *
 * Equal colors have unequal serializations, so no comparison in this engine may
 * read a color string. Both design producers and evidence normalizers land here
 * first, which is what lets a design fact and a captured value be compared at
 * all. See docs/adr/0002.
 */

import type { NormalizedColor } from "../contracts/model"

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function toChannel(linear: number): number {
  const gamma =
    linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
  return Math.round(clamp(gamma, 0, 1) * 255)
}

/** OKLCh to sRGB, via OKLab and linear sRGB, clipped to the sRGB gamut. */
export function oklchToSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): { r: number; g: number; b: number } {
  const hue = (hueDegrees * Math.PI) / 180
  return oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue))
}

/** OKLab to sRGB. OKLCh reaches this after its polar conversion. */
function oklabToSrgb(
  lightness: number,
  a: number,
  b: number,
): { r: number; g: number; b: number } {
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b

  const l = lRoot * lRoot * lRoot
  const m = mRoot * mRoot * mRoot
  const s = sRoot * sRoot * sRoot

  return {
    r: toChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

/**
 * CIE Lab to sRGB. CSS `lab()` is D50-referred, so the result is chromatically
 * adapted to D65 before the sRGB matrix. Browsers serialize a computed color in
 * the space it was authored in, so this notation appears in captured evidence
 * wherever a stylesheet declared `oklch()`.
 */
function labToSrgb(
  lightness: number,
  a: number,
  b: number,
): { r: number; g: number; b: number } {
  const kappa = 24389 / 27
  const epsilon = 216 / 24389

  const fy = (lightness + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200

  const fx3 = fx * fx * fx
  const fz3 = fz * fz * fz
  const xr = fx3 > epsilon ? fx3 : (116 * fx - 16) / kappa
  const yr = lightness > kappa * epsilon ? fy * fy * fy : lightness / kappa
  const zr = fz3 > epsilon ? fz3 : (116 * fz - 16) / kappa

  const x50 = xr * 0.9642956764295677
  const y50 = yr
  const z50 = zr * 0.8251046025104602

  // Bradford adaptation, D50 to D65.
  const x =
    0.9554734527042182 * x50 - 0.023098536874261423 * y50 + 0.0632593086610217 * z50
  const y =
    -0.028369706963208136 * x50 + 1.0099954580058226 * y50 + 0.021041398966943008 * z50
  const z =
    0.012314001688319899 * x50 - 0.020507696433477912 * y50 + 1.3303659366080753 * z50

  return {
    r: toChannel(3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z),
    g: toChannel(-0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z),
    b: toChannel(0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z),
  }
}

function parseAlpha(token: string | undefined): number | undefined {
  if (token === undefined) return 1
  const text = token.trim()
  if (text.endsWith("%")) {
    const percent = Number.parseFloat(text.slice(0, -1))
    return Number.isFinite(percent) ? clamp(percent / 100, 0, 1) : undefined
  }
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? clamp(value, 0, 1) : undefined
}

function parseNumberOrPercent(token: string, scale: number): number | undefined {
  const text = token.trim()
  const value = Number.parseFloat(text.endsWith("%") ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) return undefined
  return text.endsWith("%") ? (value / 100) * scale : value
}

function splitColorArguments(body: string): { values: string[]; alpha?: string } {
  const [main, alphaPart] = body.split("/")
  const values = main.trim().split(/[\s,]+/).filter(Boolean)
  return { values, alpha: alphaPart?.trim() }
}

/**
 * Returns undefined rather than guessing when the notation is outside the
 * supported set. A guessed color would silently widen or narrow an allowed
 * value set; an undefined one is reported as unnormalizable by the caller.
 */
export function parseColor(input: string): NormalizedColor | undefined {
  const text = input.trim().toLowerCase()
  if (text === "transparent") return { r: 0, g: 0, b: 0, alpha: 0 }

  const hex = /^#([0-9a-f]{3,8})$/.exec(text)
  if (hex) {
    const digits = hex[1]
    const expand = (value: string) => Number.parseInt(value.repeat(2), 16)
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]),
        g: expand(digits[1]),
        b: expand(digits[2]),
        alpha: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      }
    }
    if (digits.length === 6 || digits.length === 8) {
      const pair = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16)
      return {
        r: pair(0),
        g: pair(2),
        b: pair(4),
        alpha: digits.length === 8 ? pair(6) / 255 : 1,
      }
    }
    return undefined
  }

  const functional = /^(oklch|oklab|lab|rgba?)\(([^)]*)\)$/.exec(text)
  if (!functional) return undefined
  const { values, alpha: alphaToken } = splitColorArguments(functional[2])
  const notation = functional[1]
  const alpha = parseAlpha(
    notation === "rgb" || notation === "rgba"
      ? (alphaToken ?? values[3])
      : alphaToken,
  )
  if (alpha === undefined) return undefined

  if (notation === "oklch" || notation === "oklab" || notation === "lab") {
    if (values.length < 3) return undefined
    // `lab()` lightness is a 0-100 percentage scale; the Ok spaces use 0-1.
    const lightness = parseNumberOrPercent(values[0], notation === "lab" ? 100 : 1)
    const second =
      notation === "oklch"
        ? parseNumberOrPercent(values[1], 0.4)
        : Number.parseFloat(values[1])
    const third = Number.parseFloat(values[2])
    if (
      lightness === undefined ||
      second === undefined ||
      !Number.isFinite(second) ||
      !Number.isFinite(third)
    ) {
      return undefined
    }
    if (notation === "oklch") return { ...oklchToSrgb(lightness, second, third), alpha }
    if (notation === "oklab") return { ...oklabToSrgb(lightness, second, third), alpha }
    return { ...labToSrgb(lightness, second, third), alpha }
  }

  if (values.length < 3) return undefined
  const channels = values.slice(0, 3).map((value) => parseNumberOrPercent(value, 255))
  if (channels.some((channel) => channel === undefined)) return undefined
  const [r, g, b] = channels as number[]
  return {
    r: Math.round(clamp(r, 0, 255)),
    g: Math.round(clamp(g, 0, 255)),
    b: Math.round(clamp(b, 0, 255)),
    alpha,
  }
}

export function colorKey(color: NormalizedColor): string {
  return [color.r, color.g, color.b, color.alpha].join(",")
}

export function colorsEqual(left: NormalizedColor, right: NormalizedColor): boolean {
  return colorKey(left) === colorKey(right)
}
