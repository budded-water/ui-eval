import { resolve } from "node:path"
import { canonicalDigest } from "../contracts/canonical-json"
import { assertSafeSegment } from "../storage-local/filesystem"
import { runCommand } from "../runtime/command"
import { readIntegrationJson, type IntegrationSuite } from "./config"
import { assertIntegrationResult, type IntegrationResult, type IntegrationStage } from "./model"
import { nativeIntegrationEvidence } from "./native-evidence"
import { NativePilotResultSchema } from "../native-pilot/report"
import { Value } from "@sinclair/typebox/value"

/** Candidate-owned, read-only state witness. No raw context output is retained. */
export async function recoveryContext(root: string, suite: IntegrationSuite, command: typeof runCommand, signal?: AbortSignal, deviceId?: string): Promise<string> {
  if (!suite.recovery) throw new Error("Native recovery is not configured")
  const config = suite.recovery.context
  const output = await command(config.command, config.args, { cwd: root, timeoutMs: config.timeoutMs, signal, truncateOutput: false,
    input: `${JSON.stringify({ apiVersion: "uieval.io/native-recovery-v1", projectId: suite.projectId, deviceId })}\n`,
  })
  const digest = output.stdout.trim()
  if (output.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Native recovery context is unavailable or invalid; restore the declared fixture/App state")
  return digest
}

export async function loadNativeResume(root: string, executionId: string, current: IntegrationResult): Promise<IntegrationResult> {
  assertSafeSegment(executionId, "resume executionId")
  const previous = await readIntegrationJson(root, `.ui-eval/integration/${executionId}/summary.json`, 8 * 1024 * 1024)
  assertIntegrationResult(previous)
  // Require both projections and a settled previous session before reusing any byte.
  const { boundedFile } = await import("../wechat-pilot/evidence")
  const { containedPath } = await import("../wechat-pilot/config")
  const html = await boundedFile(await containedPath(root, `.ui-eval/integration/${executionId}/summary.html`), 8 * 1024 * 1024)
  const validationPassed = ([
    ["engine", "engine-before"], ["source", "source-before"],
    ["engine", "engine-after"], ["source", "source-after"],
    ["check", "recovery-context-before"], ["check", "recovery-context-after"],
  ] as const).every(([kind, id]) => previous.stages.some((stage) => stage.kind === kind && stage.id === id && stage.status === "pass"))
  const evidenceAfter = previous.stages.find((stage) => stage.kind === "evidence" && stage.id === "evidence-after")
  // Partial runs may not reach the aggregate evidence check. Each reused
  // scenario is still revalidated below; a failed aggregate check is different
  // and invalidates reuse even if the original bytes have since been restored.
  const evidenceSound = evidenceAfter?.status === "pass" || evidenceAfter?.status === "not-run"
  if (!html.length || previous.executionId !== executionId || previous.projectId !== current.projectId ||
    previous.adapter !== "native-pilot" || previous.deviceId !== current.deviceId || previous.suiteDigest !== current.suiteDigest ||
    previous.sourceDigest !== current.sourceDigest || canonicalDigest(previous.engine) !== canonicalDigest(current.engine) ||
    previous.recoveryContextDigest !== current.recoveryContextDigest || !current.recoveryContextDigest || !validationPassed || !evidenceSound ||
    previous.stages.some((stage) => stage.cleanupSettled === false || (stage.kind === "session" && stage.id === "session-stop" && stage.status !== "pass"))) {
    throw new Error("Native resume identity/state differs, previous validation failed or cleanup is incomplete; start a fresh run")
  }
  return previous
}

export async function revalidateNativeStage(root: string, suite: IntegrationSuite, stage: IntegrationStage, current: IntegrationResult): Promise<void> {
  if (stage.status !== "pass" || stage.reports.length !== 1) throw new Error("Only complete passed native evidence may be reused")
  const stored = stage.reports[0]
  const result = await readIntegrationJson(root, stored.reportPath, 8 * 1024 * 1024)
  if (!Value.Check(NativePilotResultSchema, result)) throw new Error("Invalid native resume report")
  const reports = await nativeIntegrationEvidence(root, suite, stage.id, {
    result, reportPath: resolve(root, stored.reportPath), htmlPath: resolve(root, stored.htmlPath),
  }, current.sourceDigest!, current.deviceId!)
  if (canonicalDigest(reports) !== canonicalDigest(stage.reports)) throw new Error("Native resume evidence changed; start a fresh run")
}
