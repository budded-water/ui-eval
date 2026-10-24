/** CSS whitespace excludes JavaScript-only whitespace such as NBSP. */
export function trimCssWhitespace(token: string): string {
  return token.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "")
}

/** A complete finite CSS number token; never accept a numeric prefix or JS hex syntax. */
export function parseCssNumber(token: string): number | undefined {
  if (token.trim() !== token || !/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return undefined
  const value = Number(token)
  return Number.isFinite(value) ? value : undefined
}
