/**
 * Thin file-system wrapper around the reference design-token producers.
 *
 * It emits a normalized token set, not a sealed `DesignContract`: sealing needs
 * a content-addressed artifact for the source input, which belongs to the store
 * rather than to a producer. Nothing here is imported by an evaluator.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { importTailwindTheme, type TailwindThemeImport } from "./tailwind-theme"

interface Options {
  css: string
  theme?: string
  rootFontSizePx: number
  json: boolean
}

function usage(message: string): never {
  process.stderr.write(
    [
      `design-adapters: ${message}`,
      "",
      "Usage:",
      "  bun run design:import --css <path> [--theme <selector>]",
      "                       [--root-font-size <px>] [--json]",
      "",
    ].join("\n"),
  )
  process.exit(2)
}

function parseArgs(argv: readonly string[]): Options {
  const options: Partial<Options> = { rootFontSizePx: 16, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--css") options.css = argv[++index]
    else if (arg === "--theme") options.theme = argv[++index]
    else if (arg === "--root-font-size") {
      options.rootFontSizePx = Number.parseFloat(argv[++index])
    } else usage(`unknown argument ${arg}`)
  }
  if (!options.css) usage("--css is required")
  if (!Number.isFinite(options.rootFontSizePx) || (options.rootFontSizePx ?? 0) <= 0) {
    usage("--root-font-size must be a positive number")
  }
  return options as Options
}

function report(options: Options, result: TailwindThemeImport): void {
  const lines: string[] = []
  lines.push(`source          ${options.css}`)
  lines.push(`theme           ${options.theme ?? ":root"}`)
  lines.push(`declarations    ${String(result.declarationCount)}`)

  const palette = result.tokenSet.valueSets?.find((set) => set.id === "palette")
  lines.push(`palette colors  ${String(palette?.values.length ?? 0)}`)
  for (const scale of result.tokenSet.scales ?? []) {
    lines.push(`scale ${scale.id.padEnd(10)}${scale.steps.join(", ")} (${scale.unit})`)
  }

  if (result.unresolved.length > 0) {
    lines.push("")
    lines.push(`unresolved      ${String(result.unresolved.length)}`)
    for (const token of result.unresolved) {
      lines.push(`  ${token.name}  ${token.reason}  ${token.value}`)
    }
  }

  lines.push("")
  lines.push("A token set covers only what this stylesheet declares. Scales that come")
  lines.push("from framework defaults rather than project CSS are absent, and absent is")
  lines.push("not the same as unconstrained: a constraint may only reference a scale")
  lines.push("that is actually present here.")
  lines.push("")
  process.stdout.write(lines.join("\n"))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const cssPath = resolve(options.css)
  let css: string
  try {
    css = await readFile(cssPath, "utf8")
  } catch (error) {
    usage(`cannot read ${cssPath}: ${(error as Error).message}`)
  }

  const result = importTailwindTheme(css, {
    theme: options.theme,
    rootFontSizePx: options.rootFontSizePx,
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  report(options, result)
}

await main()
