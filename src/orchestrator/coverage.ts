import type { CaptureBundleSpec, CaptureCapability, CoverageCounts, EvaluationReportSpec } from "../contracts/model"
import type { VisualComparison } from "../evaluators/visual"

function emptyCoverageCounts(): CoverageCounts {
  return {
    expected: 0,
    evaluated: 0,
    passed: 0,
    failed: 0,
    unsupported: 0,
    invalid: 0,
  }
}

function addCoverageCounts(
  left: CoverageCounts,
  right: CoverageCounts,
): CoverageCounts {
  return {
    expected: left.expected + right.expected,
    evaluated: left.evaluated + right.evaluated,
    passed: left.passed + right.passed,
    failed: left.failed + right.failed,
    unsupported: left.unsupported + right.unsupported,
    invalid: left.invalid + right.invalid,
  }
}

function evidenceCoverageCounts(
  records: ReturnType<CaptureBundleSpec["checkpoints"][number]["evidence"]["filter"]>,
  mode: "evaluated" | "unsupported" | "visual-measured" | "visual-invalid",
  visualChanged = false,
  failedChannels: ReadonlySet<CaptureCapability> = new Set(),
): CoverageCounts {
  const counts = emptyCoverageCounts()
  for (const [index, record] of records.entries()) {
    counts.expected += 1
    if (record.status === "missing" || record.status === "corrupt") {
      counts.invalid += 1
    } else if (record.status === "not-applicable") {
      counts.unsupported += 1
    } else if (mode === "evaluated") {
      counts.evaluated += 1
      if (failedChannels.has(record.channel)) counts.failed += 1
      else counts.passed += 1
    } else if (mode === "visual-measured" && index === 0) {
      counts.evaluated += 1
      if (visualChanged) counts.failed += 1
      else counts.passed += 1
    } else if (mode === "visual-invalid" && index === 0) {
      counts.invalid += 1
    } else {
      counts.unsupported += 1
    }
  }
  return counts
}

function interactionCoverageCounts(
  capture: CaptureBundleSpec,
): CoverageCounts {
  const statuses = [
    ...capture.stepResults.map(({ status }) => status),
    ...capture.assertionResults.map(({ status }) => status),
  ]
  return {
    expected: statuses.length,
    evaluated: statuses.filter((status) =>
      ["passed", "failed"].includes(status),
    ).length,
    passed: statuses.filter((status) => status === "passed").length,
    failed: statuses.filter((status) => status === "failed").length,
    unsupported: 0,
    invalid: statuses.filter(
      (status) =>
        status === "skipped" ||
        status === "not-executed" ||
        status === "not-evaluated",
    ).length,
  }
}

function failedRuntimeChannels(
  capture: CaptureBundleSpec,
): ReadonlySet<CaptureCapability> {
  const failed = new Set<CaptureCapability>()
  for (const error of capture.executionErrors ?? []) {
    if (error.origin !== "product") continue
    if (
      error.code.startsWith("same-origin-") ||
      error.code.includes("main-document")
    ) {
      failed.add("network")
    }
    if (error.code.includes("page-error") || error.code.includes("page-crash")) {
      failed.add("crash")
    }
  }
  return failed
}

export function coverageFor(
  capture: CaptureBundleSpec,
  visual: { comparison: VisualComparison | { status: "unknown"; reason: string } } | undefined,
  geometryCoverage: CoverageCounts | undefined,
): EvaluationReportSpec["coverage"] {
  const interactionCounts = interactionCoverageCounts(capture)
  const evidence = capture.checkpoints.flatMap((checkpoint) =>
    checkpoint.evidence.filter((record) => record.required),
  )
  const channels = (values: readonly CaptureCapability[]) =>
    evidence.filter((record) => values.includes(record.channel))
  const runtimeCounts = evidenceCoverageCounts(
    channels(["console", "network", "device-logs", "crash"]),
    "evaluated",
    false,
    failedRuntimeChannels(capture),
  )
  const pixelRecords = channels(["screenshot", "element-screenshots", "video"])
  const pixelMode = !visual
    ? "unsupported"
    : visual.comparison.status === "measured"
      ? "visual-measured"
      : "visual-invalid"
  const pixelCounts = evidenceCoverageCounts(
    pixelRecords,
    pixelMode,
    visual?.comparison.status === "measured" &&
      visual.comparison.changedPixels > 0,
  )
  const structuredChannels = channels([
    "dom",
    "computed-styles",
    "accessibility-tree",
    "view-hierarchy",
    "layout-metadata",
  ])
  const geometryCounts =
    geometryCoverage ?? evidenceCoverageCounts(structuredChannels, "unsupported")
  const performanceCounts = evidenceCoverageCounts(
    channels(["trace", "performance"]),
    "unsupported",
  )
  const byDimension = [
    { dimension: "interaction" as const, counts: interactionCounts },
    { dimension: "runtime" as const, counts: runtimeCounts },
    { dimension: "pixel" as const, counts: pixelCounts },
    { dimension: "geometry" as const, counts: geometryCounts },
    { dimension: "performance" as const, counts: performanceCounts },
  ].filter((entry) => entry.counts.expected > 0)
  const total = byDimension.reduce(
    (counts, entry) => addCoverageCounts(counts, entry.counts),
    emptyCoverageCounts(),
  )
  return {
    total,
    byDimension,
  }
}
