import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Static } from "@sinclair/typebox"
import { canonicalDigest } from "../contracts/canonical-json"
import { collectSourceRevision } from "../orchestrator/identity"
import { evaluateScenario } from "../orchestrator/evaluate"
import { evaluateWechatPilot } from "../wechat-pilot/run"
import { evaluateNativePilot } from "../native-pilot/run"
import { runCommand } from "../runtime/command"
import { hasIncompleteCleanup } from "../runtime/cleanup"
import { withOwnedDeadline } from "../runtime/deadline"
import { ensureContainedDirectory, atomicWriteFile } from "../storage-local/filesystem"
import { loadEnginePin, loadIntegrationSuite, type IntegrationCommandSchema } from "./config"
import { verifyEnginePin } from "./engine"
import { statusForExit, webIntegrationEvidence, wechatIntegrationEvidence } from "./evidence"
import { nativeIntegrationEvidence } from "./native-evidence"
import { startIntegrationSession } from "./session"
import { integrationExitCode, type IntegrationResult, type IntegrationStage } from "./model"
import { writeIntegrationArtifacts } from "./report"

export interface IntegrationOptions {
  projectRoot: string
  suite: string
  deviceId?: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}
export interface IntegrationDependencies {
  verifyEngine?: typeof verifyEnginePin
  source?: typeof collectSourceRevision
  evaluate?: typeof evaluateScenario
  wechat?: typeof evaluateWechatPilot
  native?: typeof evaluateNativePilot
  session?: typeof startIntegrationSession
  command?: typeof runCommand
  publish?: typeof writeIntegrationArtifacts
  cleanupTimeoutMs?: number
}

export async function runIntegrationSuite(options: IntegrationOptions, deps: IntegrationDependencies = {}): Promise<IntegrationResult> {
  options.signal?.throwIfAborted()
  const loaded = await loadIntegrationSuite(options.projectRoot, options.suite)
  const root = loaded.projectRoot
  const suite = loaded.value
  if (suite.adapter === "native-pilot") {
    if (!options.deviceId || !/^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(options.deviceId)) {
      throw new Error("Native integration requires an explicit simulator UUID")
    }
  } else if (options.deviceId !== undefined) {
    throw new Error("Only native integration accepts a device")
  }
  const pin = await loadEnginePin(root)
  const executionId = randomUUID()
  const directory = resolve(root, ".ui-eval/integration", executionId)
  await ensureContainedDirectory(root, directory)
  const started = performance.now()
  const stage = (id: string, kind: IntegrationStage["kind"], dimension?: string): IntegrationStage => ({
    id, kind, ...(dimension ? { dimension } : {}), status: "not-run", durationMs: 0, reason: "Required stage has not run", reports: [],
  })
  const engineBefore = stage("engine-before", "engine")
  const sourceBefore = stage("source-before", "source")
  const prepare = suite.prepare ? stage("prepare", "prepare") : undefined
  const sessionStart = suite.session ? stage("session-start", "session") : undefined
  const sessionStop = suite.session ? stage("session-stop", "session") : undefined
  const before = suite.checks.filter((check) => check.phase === "before").map((check) => stage(check.id, "check", check.dimension))
  const scenarios = suite.scenarios.map((scenario) => stage(scenario.id, "scenario"))
  const after = suite.checks.filter((check) => check.phase === "after").map((check) => stage(check.id, "check", check.dimension))
  const sourceAfter = stage("source-after", "source")
  const evidenceAfter = stage("evidence-after", "evidence")
  const engineAfter = stage("engine-after", "engine")
  const result: IntegrationResult = {
    apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationResult", executionId,
    projectId: suite.projectId, suiteId: suite.id, suiteDigest: canonicalDigest(suite), engine: pin,
    adapter: suite.adapter, ...(suite.executionProfile ? { executionProfile: suite.executionProfile } : {}),
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    ...(suite.browserChannel ? { browserChannel: suite.browserChannel } : {}),
    startedAt: new Date().toISOString(), durationMs: 0, exitCode: 2, status: "inconclusive",
    stages: [engineBefore, sourceBefore, ...(prepare ? [prepare] : []), ...(sessionStart ? [sessionStart] : []), ...before, ...scenarios, ...after,
      ...(sessionStop ? [sessionStop] : []), evidenceAfter, sourceAfter, engineAfter],
    summaryPath: resolve(directory, "summary.json"), summaryHtmlPath: resolve(directory, "summary.html"),
    limitations: [
      "Acceptance covers every declared scenario and check in this integration suite only.",
      "Original adapter reports remain authoritative evidence; integration checks add acceptance conditions.",
      "Prepare runs once per invocation. Generated outputs must be ignored by Git; no cross-run build cache or attestation is provided.",
      "Command stdout/stderr are withheld from reports; trusted checks must validate their own business contracts.",
      ...(suite.adapter === "native-pilot" ? [
        "Experimental iOS Simulator interaction and screenshot evidence only; no Android, Harmony or store release acceptance.",
        "Source and installed App presence are observed; the binary and loaded JavaScript are not cryptographically bound to source.",
        "Candidate-owned session readiness and cleanup are protocol assertions, not an OS/network sandbox or device-state attestation.",
      ] : suite.adapter === "wechat-pilot" ? ["WeChat DevTools acceptance does not certify runtime/network, design or actual phone rendering."] : ["A Web pass does not certify unconfigured visual, geometry, accessibility or production API behavior."]),
    ],
  }
  let stopped = false
  let cleanupSettled = true
  let session: Awaited<ReturnType<typeof startIntegrationSession>> | undefined
  let activeSignal = options.signal
  const revalidate: Array<() => Promise<void>> = []
  const execute = async (entry: IntegrationStage, operation: () => Promise<void>, cleanup = false) => {
    options.onProgress?.(`Integration ${suite.id}: ${entry.kind} ${entry.id}`)
    const start = performance.now()
    try {
      if (!cleanup) activeSignal?.throwIfAborted()
      await operation()
      if (!cleanup) activeSignal?.throwIfAborted()
      if (entry.status === "not-run") { entry.status = "pass"; entry.reason = "Required stage completed" }
    } catch (error) {
      entry.status = "inconclusive"
      entry.reason = "Required stage failed, timed out, or returned invalid evidence"
      entry.cleanupSettled = !hasIncompleteCleanup(error)
      cleanupSettled &&= entry.cleanupSettled
      stopped = true
      if (!cleanup && options.signal?.aborted) throw error
    } finally { entry.durationMs = performance.now() - start }
  }
  const command = async (entry: IntegrationStage, config: Static<typeof IntegrationCommandSchema>, failure: "candidate" | "infrastructure") => execute(entry, async () => {
    const output = await (deps.command ?? runCommand)(config.command, config.args, {
      cwd: root, timeoutMs: config.timeoutMs, signal: activeSignal,
      input: `${JSON.stringify({ apiVersion: result.apiVersion, projectId: suite.projectId, integrationDirectory: directory,
        suiteDigest: result.suiteDigest, stages: result.stages })}\n`,
    })
    entry.status = output.exitCode === 0 ? "pass" : output.exitCode === null || failure === "infrastructure" ? "inconclusive" : "fail"
    entry.reason = output.exitCode === 0 ? "Command exited successfully" : output.exitCode === null ? "Command timed out or terminated without an exit code" : `Command exited ${output.exitCode}`
    if (entry.status === "inconclusive") stopped = true
  })
  try {
    await atomicWriteFile(resolve(directory, "suite.json"), Buffer.from(`${JSON.stringify(suite, null, 2)}\n`))
    await execute(engineBefore, () => (deps.verifyEngine ?? verifyEnginePin)(pin, options.signal))
    if (!stopped) await execute(sourceBefore, async () => {
      result.source = await (deps.source ?? collectSourceRevision)(root)
      result.sourceDigest = canonicalDigest(result.source)
    })
    if (!stopped && prepare && suite.prepare) await command(prepare, suite.prepare, "infrastructure")
    try {
      if (!stopped && suite.session && sessionStart) await execute(sessionStart, async () => {
        session = await (deps.session ?? startIntegrationSession)(suite.session!, {
          executionId, projectId: suite.projectId, integrationDirectory: directory, suiteDigest: result.suiteDigest,
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
        }, { cwd: root, signal: options.signal })
        activeSignal = options.signal ? AbortSignal.any([options.signal, session.signal]) : session.signal
        session.assertAlive()
      })
      for (const entry of before) {
        if (stopped) break
        const config = suite.checks.find((check) => check.id === entry.id)!
        await command(entry, config, config.failureOutcome)
      }
      for (const [index, config] of suite.scenarios.entries()) {
        if (stopped) break
        const entry = scenarios[index]
        await execute(entry, async () => {
          const reports = await withOwnedDeadline(async (signal) => {
            let verify: () => Promise<IntegrationStage["reports"]>
            if (suite.adapter === "web") {
              const output = await (deps.evaluate ?? evaluateScenario)({
                projectRoot: root, scenario: config.id, executionProfile: suite.executionProfile,
                policy: config.policy, referencePath: config.reference, browserChannel: suite.browserChannel,
                signal, onProgress: options.onProgress,
              })
              verify = () => webIntegrationEvidence(root, suite, config.id, output, result.sourceDigest!)
            } else if (suite.adapter === "wechat-pilot") {
              const output = await (deps.wechat ?? evaluateWechatPilot)({ projectRoot: root, scenario: config.id, driver: suite.driver, signal })
              verify = () => wechatIntegrationEvidence(root, suite, config.id, output, result.sourceDigest!)
            } else {
              const output = await (deps.native ?? evaluateNativePilot)({ projectRoot: root, scenario: config.id, deviceId: options.deviceId!, signal })
              verify = () => nativeIntegrationEvidence(root, suite, config.id, output, result.sourceDigest!, options.deviceId!)
            }
            const validated = await verify()
            revalidate.push(async () => {
              if (canonicalDigest(await verify()) !== canonicalDigest(validated)) throw new Error("Original adapter evidence changed after acceptance checks")
            })
            return validated
          }, config.timeoutMs, activeSignal, deps.cleanupTimeoutMs)
          entry.reports = reports
          entry.status = statusForExit(integrationExitCode(reports.map((report) => ({ ...entry, status: report.status }))))
          entry.reason = "Derived from validated canonical adapter reports"
          if (entry.status === "inconclusive") stopped = true
        })
      }
      for (const entry of after) {
        if (!cleanupSettled || !result.sourceDigest || session?.signal.aborted) break
        const config = suite.checks.find((check) => check.id === entry.id)!
        await command(entry, config, config.failureOutcome)
      }
    } finally {
      // Resource cleanup gets its own bounded budget, even after caller/session cancellation.
      if (session && sessionStop) await execute(sessionStop, () => session!.stop(), true)
      activeSignal = options.signal
    }
    if (cleanupSettled && revalidate.length === suite.scenarios.length) await execute(evidenceAfter, async () => {
      for (const verify of revalidate) await verify()
    })
    if (cleanupSettled && result.sourceDigest) await execute(sourceAfter, async () => {
      if (canonicalDigest(await (deps.source ?? collectSourceRevision)(root)) !== result.sourceDigest) throw new Error("Candidate source changed during integration")
    })
    if (cleanupSettled) await execute(engineAfter, () => (deps.verifyEngine ?? verifyEnginePin)(pin, options.signal))
  } catch (error) {
    if (!options.signal?.aborted) throw error
  }
  if (options.signal?.aborted) {
    result.exitCode = options.signal.reason?.signal === "SIGTERM" ? 143 : 130
    result.status = "interrupted"
  } else {
    result.exitCode = integrationExitCode(result.stages)
    result.status = statusForExit(result.exitCode) as IntegrationResult["status"]
  }
  result.durationMs = performance.now() - started
  await (deps.publish ?? writeIntegrationArtifacts)(result, root)
  options.signal?.throwIfAborted()
  return result
}
