/**
 * Offline design-token audit over an already-captured run.
 *
 * This is an analysis tool, not a gate. It composes the reference token
 * producer, the web evidence normalizer, and the constraint kinds from
 * docs/adr/0002 so their combined output can be read against a real page before
 * any of it is wired into policy. Nothing here is on the evaluation path, and a
 * result produced here has no bearing on a run's disposition.
 *
 * Usage:
 *   bun run design:audit --project-root <path> --css <path>
 *                        [--theme <selector>] [--scenario <id>]
 *                        [--tolerance <px>] [--json]
 *
 * Exit codes: 0 no violations, 1 violations found, 2 input problem,
 *             3 evidence was insufficient to decide.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { DesignTokenSet } from "../src/contracts/model"
import { importTailwindTheme } from "../src/design-adapters/tailwind-theme"
import {
  evaluateConstraints,
  type Constraint,
  type ConstraintResult,
} from "../src/evaluators/geometry/constraints"
import { normalizeWebEvidence } from "../src/evaluators/geometry/normalize-web"

interface Options {
  projectRoot: string
  css: string
  theme?: string
  scenario?: string
  tolerance: number
  json: boolean
}

function fail(message: string): never {
  process.stderr.write(`audit-design-tokens: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv: readonly string[]): Options {
  const options: Partial<Options> = { tolerance: 0.5, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--project-root") options.projectRoot = argv[++index]
    else if (arg === "--css") options.css = argv[++index]
    else if (arg === "--theme") options.theme = argv[++index]
    else if (arg === "--scenario") options.scenario = argv[++index]
    else if (arg === "--tolerance") options.tolerance = Number.parseFloat(argv[++index])
    else fail(`unknown argument ${arg}`)
  }
  if (!options.projectRoot) fail("--project-root is required")
  if (!options.css) fail("--css is required")
  if (!Number.isFinite(options.tolerance)) fail("--tolerance must be a number")
  options.projectRoot = resolve(options.projectRoot)
  return options as Options
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

interface ArtifactLike {
  digest: string
  projectId: string
  storeId: string
}

function artifactPath(artifactRoot: string, artifact: ArtifactLike): string {
  const hex = artifact.digest.slice("sha256:".length)
  return join(
    artifactRoot,
    "artifacts",
    "projects",
    artifact.projectId,
    "stores",
    artifact.storeId,
    "sha256",
    hex.slice(0, 2),
    hex,
  )
}

interface CaptureSpec {
  scenarioId: string
  variant?: { variantKey?: string }
  checkpoints?: Array<{
    checkpointId?: string
    evidence?: Array<{ channel: string; status: string; artifact?: ArtifactLike }>
  }>
}

/** Most recently modified run, optionally restricted to one scenario. */
async function latestCapture(
  artifactRoot: string,
  scenario: string | undefined,
): Promise<{ runId: string; spec: CaptureSpec }> {
  const runsRoot = join(artifactRoot, "runs")
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() =>
    fail(`no runs directory at ${runsRoot}; run evaluate first`),
  )

  const candidates: Array<{ runId: string; spec: CaptureSpec; modifiedAt: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runRoot = join(runsRoot, entry.name)
    try {
      const capture = await readJson<{ spec: CaptureSpec }>(join(runRoot, "capture.json"))
      if (scenario && capture.spec.scenarioId !== scenario) continue
      candidates.push({
        runId: entry.name,
        spec: capture.spec,
        modifiedAt: (await stat(runRoot)).mtimeMs,
      })
    } catch {
      continue
    }
  }
  if (candidates.length === 0) fail("no matching capture bundle found")
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return candidates[0]
}

/**
 * The audit compares only what the stylesheet declares, so a constraint is
 * emitted only when its expectation exists. Absent is not unconstrained: a
 * missing scale means the audit stays silent about it rather than passing it.
 */
function constraintsFor(tokenSet: DesignTokenSet, tolerance: number): Constraint[] {
  const constraints: Constraint[] = []
  const has = (collection: readonly { id: string }[] | undefined, id: string) =>
    collection?.some((entry) => entry.id === id) ?? false

  if (has(tokenSet.valueSets, "palette")) {
    for (const property of ["fill.color", "text.color", "stroke.color"] as const) {
      constraints.push({
        id: `${property}-in-palette`,
        kind: "value-in-set",
        property,
        valueSetRef: "palette",
        scope: { visibleOnly: true },
      })
    }
  }
  if (has(tokenSet.scales, "radius")) {
    constraints.push({
      id: "box.radius-on-scale",
      kind: "value-on-scale",
      property: "box.radius",
      scaleRef: "radius",
      tolerance,
      scope: { visibleOnly: true },
    })
  }
  constraints.push({
    id: "box.height-consistent",
    kind: "cross-node-equal",
    property: "box.height",
    tolerance,
    scope: { visibleOnly: true },
  })
  return constraints
}

function summarize(results: readonly ConstraintResult[]): string[] {
  const lines: string[] = []
  const width = Math.max(...results.map((result) => result.constraintId.length))
  for (const result of results) {
    lines.push(
      [
        `  ${result.constraintId.padEnd(width)}`,
        result.status.padEnd(11),
        `compared ${String(result.comparedNodes).padStart(4)}`,
        `unreadable ${String(result.unnormalizableNodes).padStart(3)}`,
        `violations ${String(result.violations.length).padStart(4)}`,
        result.invalidReason ? `(${result.invalidReason})` : "",
      ]
        .join("  ")
        .trimEnd(),
    )
  }
  return lines
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const config = await readJson<{ artifactRoot?: string }>(
    join(options.projectRoot, "ui-eval", "project.json"),
  ).catch(() => fail(`no ui-eval/project.json under ${options.projectRoot}`))
  const artifactRoot = resolve(options.projectRoot, config.artifactRoot ?? ".ui-eval")

  const css = await readFile(resolve(options.css), "utf8").catch(() =>
    fail(`cannot read ${options.css}`),
  )
  const imported = importTailwindTheme(css, { theme: options.theme })

  // Absence of a value is a design decision, not a violation: no fill and no
  // rounding are legitimate everywhere and are declared by no stylesheet. They
  // are injected explicitly and reported, so an audit assumption is never
  // mistaken for a declared design fact.
  const tokenSet: DesignTokenSet = structuredClone(imported.tokenSet)
  const injected: string[] = []
  const palette = tokenSet.valueSets?.find((valueSet) => valueSet.id === "palette")
  if (palette?.valueKind === "color") {
    palette.values = [...palette.values, { r: 0, g: 0, b: 0, alpha: 0 }]
    injected.push("palette: transparent")
  }
  const radius = tokenSet.scales?.find((scale) => scale.id === "radius")
  if (radius && !radius.steps.includes(0)) {
    radius.steps = [0, ...radius.steps]
    injected.push("radius: 0")
  }

  const { runId, spec } = await latestCapture(artifactRoot, options.scenario)
  const results: Array<{ checkpointId: string; results: ConstraintResult[] }> = []

  for (const checkpoint of spec.checkpoints ?? []) {
    const find = (channel: string) =>
      checkpoint.evidence?.find(
        (record) => record.channel === channel && record.status === "captured",
      )?.artifact
    const layoutRef = find("layout-metadata")
    if (!layoutRef) continue
    const stylesRef = find("computed-styles")

    const nodes = normalizeWebEvidence(
      await readJson(artifactPath(artifactRoot, layoutRef)),
      stylesRef ? await readJson(artifactPath(artifactRoot, stylesRef)) : undefined,
    )
    results.push({
      checkpointId: checkpoint.checkpointId ?? "unknown",
      results: evaluateConstraints(constraintsFor(tokenSet, options.tolerance), nodes, tokenSet),
    })
  }

  if (results.length === 0) {
    process.stderr.write("no checkpoint carried layout-metadata evidence\n")
    process.exit(3)
  }

  const flat = results.flatMap((entry) => entry.results)
  const violations = flat.reduce((total, result) => total + result.violations.length, 0)
  const indecisive = flat.some(
    (result) => result.status === "invalid" || result.status === "unsupported",
  )

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ runId, scenarioId: spec.scenarioId, checkpoints: results }, null, 2)}\n`,
    )
  } else {
    const lines: string[] = []
    lines.push(`run             ${runId}`)
    lines.push(`scenario        ${spec.scenarioId}`)
    lines.push(`theme           ${options.theme ?? ":root"}`)
    lines.push(`token source    ${options.css}`)
    lines.push(`palette         ${String(palette?.values.length ?? 0)} colors`)
    lines.push(`audit injected  ${injected.length > 0 ? injected.join("; ") : "nothing"}`)
    if (imported.unresolved.length > 0) {
      lines.push(`unresolved      ${String(imported.unresolved.length)} declarations`)
    }
    for (const entry of results) {
      lines.push("")
      lines.push(`checkpoint: ${entry.checkpointId}`)
      lines.push(...summarize(entry.results))
      for (const result of entry.results) {
        for (const violation of result.violations.slice(0, 5)) {
          lines.push(`    ${result.constraintId}: ${violation.detail}`)
        }
        if (result.violations.length > 5) {
          lines.push(`    ${result.constraintId}: ... ${String(result.violations.length - 5)} more`)
        }
      }
    }
    lines.push("")
    lines.push("This is an analysis tool, not a gate. A constraint is emitted only where")
    lines.push("the stylesheet declares its expectation, so silence about spacing or type")
    lines.push("means those scales were never declared, not that they are compliant.")
    lines.push("")
    process.stdout.write(lines.join("\n"))
  }

  process.exit(violations > 0 ? 1 : indecisive ? 3 : 0)
}

await main()
