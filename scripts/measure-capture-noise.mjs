// Measures run-to-run capture noise for geometry and typography evidence.
//
// Tolerances for scale and equality constraints must be derived from an observed
// noise floor rather than chosen by hand (see docs/adr/0002). This script reads
// already-materialized runs, verifies that they are comparable, and reports the
// deviation actually observed. It never drives a browser and never writes to a
// candidate project.
//
// Usage:
//   node scripts/measure-capture-noise.mjs --project-root <path> [options]
//
//   --scenario <id>   restrict to one scenario id
//   --limit <n>       use the n most recent comparable runs (default 10)
//   --json            emit a machine payload on stdout instead of a table
//
// Collect the runs first, from the standalone checkout:
//   for i in $(seq 1 10); do
//     bun run ui-eval evaluate <scenario> --project-root <path> || true
//   done
//
// Exit codes: 0 usable floor, 2 configuration or input problem, 3 needs review.

import { readdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

const NUMERIC_PROPERTIES = ["x", "y", "width", "height"]
const MIN_RUNS = 3

function fail(message) {
  process.stderr.write(["measure-capture-noise:", message].join(" ") + "\n")
  process.exit(2)
}

function parseArgs(argv) {
  const options = { limit: 10, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--project-root") options.projectRoot = argv[++index]
    else if (arg === "--scenario") options.scenario = argv[++index]
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++index], 10)
    else fail(["unknown argument", arg].join(" "))
  }
  if (!options.projectRoot) fail("--project-root is required")
  if (!Number.isInteger(options.limit) || options.limit < MIN_RUNS) {
    fail(["--limit must be an integer >=", String(MIN_RUNS)].join(" "))
  }
  options.projectRoot = resolve(options.projectRoot)
  return options
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

async function readOptionalJson(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

function artifactPath(artifactRoot, artifact) {
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

/** Collects every capture bundle under the project's artifact root. */
async function loadCaptures(artifactRoot, scenario) {
  const runsRoot = join(artifactRoot, "runs")
  let entries
  try {
    entries = await readdir(runsRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") fail(["no runs directory at", runsRoot].join(" "))
    throw error
  }

  const captures = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runRoot = join(runsRoot, entry.name)
    const capture = await readOptionalJson(join(runRoot, "capture.json"))
    if (!capture?.spec) continue
    if (scenario && capture.spec.scenarioId !== scenario) continue
    captures.push({
      runId: entry.name,
      runRoot,
      spec: capture.spec,
      modifiedAt: (await stat(runRoot)).mtimeMs,
    })
  }
  return captures.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

function variantKey(variant) {
  return variant?.variantKey ?? "default"
}

/**
 * Noise is only meaningful across runs of one scenario variant at one commit. A
 * mixed set would report real source changes as capture noise.
 *
 * The group containing the most recent run wins, not the largest one: an
 * operator who just collected a batch means that batch, and an older, larger,
 * staler group would otherwise silently outvote it.
 */
function selectComparable(captures, limit) {
  const groupKey = (capture) =>
    [
      capture.spec.scenarioId,
      variantKey(capture.spec.variant),
      capture.spec.sourceRevision?.commitSha ?? "unknown",
    ].join(" | ")

  // `captures` is already sorted newest first.
  const newest = groupKey(captures[0])
  const group = captures.filter((capture) => groupKey(capture) === newest)
  return {
    selected: group.slice(0, limit),
    excluded: captures.length - group.length,
    truncated: Math.max(0, group.length - limit),
  }
}

/**
 * A commit pins committed source only. Runs that disagree on the uncommitted
 * diff were captured against different working trees, which inflates measured
 * deviation and would widen a tolerance until the constraint can no longer
 * fail. The measurement stays readable but is downgraded to needs-review rather
 * than reported as a usable floor.
 */
function workingTreeIssue(selected) {
  const states = new Set(
    selected.map((capture) => {
      const revision = capture.spec.sourceRevision
      if (!revision?.dirtyTree) return "clean"
      return revision.diffDigest ?? "dirty-unknown"
    }),
  )
  if (states.size <= 1) return undefined
  return [
    "runs disagree on uncommitted source state, so a difference below may be a real",
    "source change rather than capture noise. Usual causes are edits made between runs",
    "and generated output the candidate does not ignore. Collect a fresh batch without",
    "touching the working tree before deriving any tolerance from these numbers.",
  ].join(" ")
}

async function loadEvidence(artifactRoot, capture) {
  const payloads = { layout: [], styles: [] }
  const skipped = []
  for (const checkpoint of capture.spec.checkpoints ?? []) {
    const checkpointId = checkpoint.checkpointId ?? "unknown"
    for (const record of checkpoint.evidence ?? []) {
      const target =
        record.channel === "layout-metadata"
          ? "layout"
          : record.channel === "computed-styles"
            ? "styles"
            : undefined
      if (!target) continue
      if (record.status !== "captured" || !record.artifact) {
        skipped.push([capture.runId, checkpointId, record.channel, record.status].join("/"))
        continue
      }
      payloads[target].push({
        checkpointId,
        payload: await readJson(artifactPath(artifactRoot, record.artifact)),
      })
    }
  }
  return { payloads, skipped }
}

/**
 * nodeId is only a valid cross-run key while the DOM walk assigns it to the same
 * element every time. That precondition is verified rather than assumed: if it
 * does not hold, the run-to-run differences are structural instability, not the
 * numeric noise floor a tolerance is supposed to absorb.
 */
function nodeIdentityIssues(runs) {
  const issues = []
  const [reference, ...rest] = runs
  const identityOf = (node) =>
    [node.uiId ?? "", node.testId ?? "", node.role ?? "", node.accessibleName ?? ""].join("|")

  const referenceMap = new Map(reference.nodes.map((node) => [node.nodeId, identityOf(node)]))
  for (const run of rest) {
    if (run.nodes.length !== reference.nodes.length) {
      issues.push(
        ["node count differs:", String(reference.nodes.length), "vs", String(run.nodes.length)].join(
          " ",
        ),
      )
      continue
    }
    for (const node of run.nodes) {
      const expected = referenceMap.get(node.nodeId)
      if (expected === undefined) {
        issues.push(["nodeId", String(node.nodeId), "absent from the reference run"].join(" "))
      } else if (expected !== identityOf(node)) {
        issues.push(
          ["nodeId", String(node.nodeId), "maps to a different element between runs"].join(" "),
        )
      }
      if (issues.length >= 5) return issues
    }
  }
  return issues
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

function indexByNodeId(run) {
  return new Map(run.nodes.map((node) => [node.nodeId, node]))
}

function measureNumeric(runs) {
  const indexed = runs.map(indexByNodeId)
  const perProperty = new Map(NUMERIC_PROPERTIES.map((property) => [property, []]))

  for (const nodeId of indexed[0].keys()) {
    for (const property of NUMERIC_PROPERTIES) {
      const values = []
      for (const index of indexed) {
        const value = index.get(nodeId)?.rect?.[property]
        if (typeof value === "number") values.push(value)
      }
      if (values.length < runs.length) continue
      perProperty.get(property).push(Math.max(...values) - Math.min(...values))
    }
  }

  return NUMERIC_PROPERTIES.map((property) => {
    const deviations = perProperty.get(property).sort((left, right) => left - right)
    return {
      property: ["box", property].join("."),
      nodes: deviations.length,
      unstableNodes: deviations.filter((deviation) => deviation > 0).length,
      p50: quantile(deviations, 0.5),
      p95: quantile(deviations, 0.95),
      max: deviations.length === 0 ? 0 : deviations[deviations.length - 1],
    }
  })
}

function measureCategorical(runs) {
  const indexed = runs.map(indexByNodeId)
  const properties = new Set()
  for (const node of runs[0].nodes) {
    for (const key of Object.keys(node.computedStyle ?? {})) properties.add(key)
  }

  return [...properties].sort().map((property) => {
    let measured = 0
    let unstable = 0
    for (const nodeId of indexed[0].keys()) {
      const values = new Set()
      let seen = 0
      for (const index of indexed) {
        const value = index.get(nodeId)?.computedStyle?.[property]
        if (value === undefined) continue
        seen += 1
        values.add(value)
      }
      if (seen < runs.length) continue
      measured += 1
      if (values.size > 1) unstable += 1
    }
    return { property, nodes: measured, unstableNodes: unstable }
  })
}

function renderTable(rows, columns, indent) {
  const header = columns.map((column) => column.label)
  const body = rows.map((row) => columns.map((column) => String(column.value(row))))
  const widths = header.map((label, index) =>
    Math.max(label.length, ...body.map((cells) => cells[index].length)),
  )
  const line = (cells) =>
    indent + cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n")
}

function report(result) {
  const out = []
  out.push(["scenario       ", result.scenarioId].join(" "))
  out.push(["variant        ", result.variant].join(" "))
  out.push(["commit         ", result.commitSha].join(" "))
  out.push(["runs compared  ", String(result.runs)].join(" "))
  if (result.excludedRuns > 0) {
    out.push(
      ["runs excluded  ", String(result.excludedRuns), "(other scenario, variant, or commit)"].join(
        " ",
      ),
    )
  }
  if (result.truncatedRuns > 0) {
    out.push(
      ["runs truncated ", String(result.truncatedRuns), "(comparable, dropped by --limit)"].join(
        " ",
      ),
    )
  }
  if (result.workingTreeIssue) {
    out.push("")
    out.push("NEEDS REVIEW: " + result.workingTreeIssue)
  }

  for (const checkpoint of result.checkpoints) {
    out.push("")
    out.push(["checkpoint:", checkpoint.checkpointId].join(" "))
    if (checkpoint.identityIssues.length > 0) {
      out.push("")
      out.push("  NODE IDENTITY UNSTABLE - no tolerance can be derived from these runs:")
      for (const issue of checkpoint.identityIssues) out.push(["    -", issue].join(" "))
      out.push("  Fix capture determinism before reading the numbers below.")
    }
    out.push("")
    out.push("  geometry (logical px deviation across runs)")
    out.push(
      renderTable(
        checkpoint.numeric,
        [
          { label: "property", value: (row) => row.property },
          { label: "nodes", value: (row) => row.nodes },
          { label: "unstable", value: (row) => row.unstableNodes },
          { label: "p50", value: (row) => row.p50 },
          { label: "p95", value: (row) => row.p95 },
          { label: "max", value: (row) => row.max },
        ],
        "    ",
      ),
    )
    if (checkpoint.categorical.length > 0) {
      out.push("")
      out.push("  computed styles (nodes whose value changed between runs)")
      out.push(
        renderTable(
          checkpoint.categorical,
          [
            { label: "property", value: (row) => row.property },
            { label: "nodes", value: (row) => row.nodes },
            { label: "unstable", value: (row) => row.unstableNodes },
          ],
          "    ",
        ),
      )
    }
  }

  out.push("")
  out.push("Reading this: the observed max is the floor a tolerance must clear, not the")
  out.push("tolerance itself. A tolerance must also stay below the smallest scale step it")
  out.push("has to distinguish. If those two bounds cross, capture is too noisy to gate on")
  out.push("and the fix is determinism, not a wider tolerance (docs/adr/0002).")
  out.push("")
  process.stdout.write(out.join("\n"))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const config = await readOptionalJson(join(options.projectRoot, "ui-eval", "project.json"))
  if (!config) fail(["no ui-eval/project.json under", options.projectRoot].join(" "))
  const artifactRoot = resolve(options.projectRoot, config.artifactRoot ?? ".ui-eval")

  const captures = await loadCaptures(artifactRoot, options.scenario)
  if (captures.length === 0) fail("no capture bundles found; run evaluate first")

  const { selected, excluded, truncated } = selectComparable(captures, options.limit)
  if (selected.length < MIN_RUNS) {
    fail(
      [
        "found",
        String(selected.length),
        "comparable run(s); at least",
        String(MIN_RUNS),
        "at one commit are required",
      ].join(" "),
    )
  }

  const loaded = []
  const skipped = []
  for (const capture of selected) {
    const evidence = await loadEvidence(artifactRoot, capture)
    skipped.push(...evidence.skipped)
    loaded.push({ capture, ...evidence.payloads })
  }

  const checkpointIds = [...new Set(loaded[0].layout.map((entry) => entry.checkpointId))]
  const checkpoints = []
  for (const checkpointId of checkpointIds) {
    const pick = (kind) =>
      loaded
        .map((entry) => entry[kind].find((item) => item.checkpointId === checkpointId)?.payload)
        .filter(Boolean)
    const layoutRuns = pick("layout")
    const styleRuns = pick("styles")
    if (layoutRuns.length < MIN_RUNS) continue

    checkpoints.push({
      checkpointId,
      identityIssues: nodeIdentityIssues(layoutRuns),
      numeric: measureNumeric(layoutRuns),
      categorical: styleRuns.length >= MIN_RUNS ? measureCategorical(styleRuns) : [],
    })
  }

  if (checkpoints.length === 0) {
    fail("no checkpoint carried layout-metadata across every selected run")
  }

  const reference = selected[0].spec
  const result = {
    scenarioId: reference.scenarioId,
    variant: variantKey(reference.variant),
    commitSha: reference.sourceRevision?.commitSha ?? "unknown",
    runs: selected.length,
    excludedRuns: excluded,
    truncatedRuns: truncated,
    workingTreeIssue: workingTreeIssue(selected),
    skippedEvidence: skipped,
    checkpoints,
  }

  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  else report(result)

  const needsReview =
    Boolean(result.workingTreeIssue) ||
    checkpoints.some((checkpoint) => checkpoint.identityIssues.length > 0)
  process.exit(needsReview ? 3 : 0)
}

main().catch((error) => fail(error?.stack ?? String(error)))
