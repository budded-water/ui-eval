import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { checkTailwindTokenDrift } from "./token-drift"

interface Options {
  css: string
  config: string
  theme?: string
  rootFontSizePx: number
  json: boolean
}

function fail(message: string): never {
  process.stderr.write(`design-token-check: ${message}\n`)
  process.exit(2)
}

function nextValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) fail(`${option} requires a value`)
  return value
}

function parseArgs(argv: readonly string[]): Options {
  const options: Partial<Options> = { rootFontSizePx: 16, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--css") {
      options.css = nextValue(argv, index, arg)
      index += 1
    } else if (arg === "--config") {
      options.config = nextValue(argv, index, arg)
      index += 1
    } else if (arg === "--theme") {
      options.theme = nextValue(argv, index, arg)
      index += 1
    } else if (arg === "--root-font-size") {
      options.rootFontSizePx = Number.parseFloat(nextValue(argv, index, arg))
      index += 1
    } else fail(`unknown argument ${arg}`)
  }
  if (!options.css) fail("--css is required")
  if (!options.config) fail("--config is required")
  if (!Number.isFinite(options.rootFontSizePx) || (options.rootFontSizePx ?? 0) <= 0) {
    fail("--root-font-size must be a positive number")
  }
  return options as Options
}

async function readText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    fail(`cannot read ${label} ${path}: ${(error as Error).message}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const cssPath = resolve(options.css)
  const configPath = resolve(options.config)
  const css = await readText(cssPath, "CSS source")
  const configSource = await readText(configPath, "geometry config")

  let config: unknown
  try {
    config = JSON.parse(configSource)
  } catch (error) {
    fail(`invalid JSON in ${configPath}: ${(error as Error).message}`)
  }

  let result
  try {
    result = checkTailwindTokenDrift(css, config, {
      rootFontSizePx: options.rootFontSizePx,
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    })
  } catch (error) {
    fail(`invalid geometry config ${configPath}: ${(error as Error).message}`)
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ cssPath, configPath, ...result }, null, 2)}\n`,
    )
  } else {
    const lines = [
      `status          ${result.status}`,
      `css             ${cssPath}`,
      `config          ${configPath}`,
      `declarations    ${String(result.declarationCount)}`,
      `producer owns   ${result.producerOwnedCollections.join(", ")}`,
      "policy owns     ranges (preserved, not compared)",
      `generated       ${result.generatedDigest}`,
      `sealed          ${result.sealedDigest}`,
      `changed         ${result.changedCollections.join(", ") || "nothing"}`,
    ]
    if (result.unresolved.length > 0) {
      lines.push(`unresolved      ${String(result.unresolved.length)}`)
      for (const token of result.unresolved) {
        lines.push(`  ${token.name}  ${token.reason}`)
      }
    }
    lines.push("")
    process.stdout.write(lines.join("\n"))
  }

  process.exitCode = result.status === "in-sync" ? 0 : result.status === "drift" ? 1 : 2
}

await main()
