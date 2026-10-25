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
import { NativePrerequisiteError } from "../native-pilot/preflight"
import { loadNativeResume, recoveryContext, revalidateNativeStage } from "./recovery"

import { loadVerificationPlan, integrationVerification, verificationExitCode } from "./verification"

export interface IntegrationOptions {
  projectRoot: string
  suite: string
  deviceId?: string
  resume?: string
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

/** Diagnostic handoff only after both interrupted summary projections publish. */
export class IntegrationInterruptedError extends Error {
  readonly code = "INTERRUPTED"
  constructor(readonly partialIntegration: IntegrationResult, cause: unknown) {
    super("Integration was interrupted", { cause })
    this.name = "IntegrationInterruptedError"
  }
}

export async function runIntegrationSuite(options: IntegrationOptions, deps: IntegrationDependencies = {}): Promise<IntegrationResult> {
  options.signal?.throwIfAborted()
  const loaded = await loadIntegrationSuite(options.projectRoot, options.suite)
  const root = loaded.projectRoot
  const suite = loaded.value
  if (options.resume && (suite.adapter !== "native-pilot" || !suite.recovery)) throw new Error("Resume requires a native suite with a recovery context")

  const verificationPlan = await loadVerificationPlan(root, suite)
  const verifyPlanSnapshot = async () => {
    if (verificationPlan && canonicalDigest(await loadVerificationPlan(root, suite)) !== canonicalDigest(verificationPlan)) {
      throw new Error("Verification plan changed during integration")
    }
  }
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
  const contextBefore = suite.recovery ? stage("recovery-context-before", "check", "fixture-state") : undefined
  const contextAfter = suite.recovery ? stage("recovery-context-after", "check", "fixture-state") : undefined
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
    stages: [engineBefore, sourceBefore, ...(prepare ? [prepare] : []), ...(sessionStart ? [sessionStart] : []), ...before,
      ...(contextBefore ? [contextBefore] : []), ...scenarios, ...after, ...(contextAfter ? [contextAfter] : []),
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
        "Recovery context is a candidate-owned state assertion. Only explicitly replay-safe scenarios may retry or reuse evidence; manual review and device launch remain separate.",
      ] : suite.adapter === "wechat-pilot" ? ["WeChat DevTools acceptance does not certify runtime/network, design or actual phone rendering."] : ["A Web pass does not certify unconfigured visual, geometry, accessibility or production API behavior."]),
    ],
  }
  let stopped = false
  let cleanupSettled = true
  let session: Awaited<ReturnType<typeof startIntegrationSession>> | undefined
  let activeSignal = options.signal
  const revalidate = new Map<string, Array<() => Promise<void>>>()
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
      entry.reason = error instanceof NativePrerequisiteError ? error.message : "Required stage failed, timed out, or returned invalid evidence"
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
    if (verificationPlan) await atomicWriteFile(resolve(directory, "verification-plan.json"), Buffer.from(`${JSON.stringify(verificationPlan, null, 2)}\n`))
    await execute(engineBefore, () => (deps.verifyEngine ?? verifyEnginePin)(pin, options.signal))
    if (!stopped) await execute(sourceBefore, async () => {
      result.source = await (deps.source ?? collectSourceRevision)(root)
      result.sourceDigest = canonicalDigest(result.source)
      await verifyPlanSnapshot()
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
      let previous: IntegrationResult | undefined
      if (!stopped && contextBefore) await execute(contextBefore, async () => {
        result.recoveryContextDigest = await recoveryContext(root, suite, deps.command ?? runCommand, activeSignal, options.deviceId)
        if (options.resume) {
          previous = await loadNativeResume(root, options.resume, result)
          result.resumedFrom = previous.executionId
        }
      })
      for (const [index, config] of suite.scenarios.entries()) {
        if (stopped) break
        const entry = scenarios[index]
        const reusable = config.replaySafe && previous?.stages.find((candidate) => candidate.kind === "scenario" && candidate.id === config.id && candidate.status === "pass")
        if (reusable) {
          await execute(entry, async () => {
            await revalidateNativeStage(root, suite, reusable, result)
            entry.status = "pass"
            entry.reason = "Reused exact verified evidence with matching source, suite, engine, device and candidate state"
            entry.reports = structuredClone(reusable.reports)
            entry.reusedFrom = previous!.executionId
            revalidate.set(entry.id, [() => revalidateNativeStage(root, suite, reusable, result)])
          })
          continue
        }
        const maxAttempts = config.replaySafe ? suite.recovery?.maxAttempts ?? 1 : 1
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          entry.status = "not-run"
          entry.reports = []
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
            revalidate.set(entry.id, [...(revalidate.get(entry.id) ?? []), async () => {
              if (canonicalDigest(await verify()) !== canonicalDigest(validated)) throw new Error("Original adapter evidence changed after acceptance checks")
            }])
            return validated
          }, config.timeoutMs, activeSignal, deps.cleanupTimeoutMs)
          entry.reports = reports
          entry.status = statusForExit(integrationExitCode(reports.map((report) => ({ ...entry, status: report.status }))))
          entry.reason = "Derived from validated canonical adapter reports"
          if (entry.status === "inconclusive") stopped = true
          })
          if (suite.recovery) {
            entry.attempts ??= []
            entry.attempts.push({ status: entry.status, durationMs: entry.durationMs, reason: entry.reason, reports: structuredClone(entry.reports) })
          }
          if (String(entry.status) !== "inconclusive" || !cleanupSettled || entry.reports.length !== 1 || attempt + 1 === maxAttempts) break
          // A timeout/throw/cleanup failure does not authorize another interaction.
          // Only a returned, validated inconclusive report is eligible for retry.
          let safe = false
          await execute(contextBefore!, async () => {
            if (canonicalDigest(await (deps.source ?? collectSourceRevision)(root)) !== result.sourceDigest ||
              await recoveryContext(root, suite, deps.command ?? runCommand, activeSignal, options.deviceId) !== result.recoveryContextDigest) {
              throw new Error("Native retry source or fixture changed")
            }
            safe = true
          })
          if (!safe) break
          stopped = false
          options.onProgress?.(`Native ${config.id}: retry ${attempt + 2}/${maxAttempts} after inconclusive evidence`)
        }
        if (entry.attempts) entry.durationMs = entry.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)
      }
      for (const entry of after) {
        if (!cleanupSettled || !result.sourceDigest || session?.signal.aborted) break
        const config = suite.checks.find((check) => check.id === entry.id)!
        await command(entry, config, config.failureOutcome)
      }
      if (cleanupSettled && contextAfter && result.recoveryContextDigest && !session?.signal.aborted) await execute(contextAfter, async () => {
        if (await recoveryContext(root, suite, deps.command ?? runCommand, activeSignal, options.deviceId) !== result.recoveryContextDigest) throw new Error("Native fixture/App state changed; evidence cannot be reused")
      })
    } finally {
      // Resource cleanup gets its own bounded budget, even after caller/session cancellation.
      if (session && sessionStop) await execute(sessionStop, () => session!.stop(), true)
      activeSignal = options.signal
    }
    if (cleanupSettled && revalidate.size === suite.scenarios.length) await execute(evidenceAfter, async () => {
      for (const attempts of revalidate.values()) for (const verify of attempts) await verify()
    })
    if (cleanupSettled && result.sourceDigest) await execute(sourceAfter, async () => {
      if (canonicalDigest(await (deps.source ?? collectSourceRevision)(root)) !== result.sourceDigest) throw new Error("Candidate source changed during integration")
      await verifyPlanSnapshot()
    })
    if (cleanupSettled) await execute(engineAfter, () => (deps.verifyEngine ?? verifyEnginePin)(pin, options.signal))
  } catch (error) {
    if (!options.signal?.aborted) throw error
  }
  if (verificationPlan) {
    result.verification = integrationVerification(suite, result, verificationPlan)
    result.limitations.push("Verification checks the declared plan only; risk selection and command evidence levels are trusted project decisions.",
      "Visual inspection and physical-device/external evidence ingestion are not implemented; required unsupported evidence remains pending.")
  }
  if (options.signal?.aborted) {
    result.exitCode = options.signal.reason?.signal === "SIGTERM" ? 143 : 130
    result.status = "interrupted"
  } else {
    result.exitCode = verificationExitCode(integrationExitCode(result.stages), result.verification?.assessment.exitCode ?? 0)
    result.status = statusForExit(result.exitCode) as IntegrationResult["status"]
  }
  result.durationMs = performance.now() - started
  await (deps.publish ?? writeIntegrationArtifacts)(result, root)
  if (result.status === "interrupted") throw new IntegrationInterruptedError(result, options.signal?.reason)
  // A signal arriving during publication must not expose a pre-signal success as interrupted evidence.
  options.signal?.throwIfAborted()
  return result
}
