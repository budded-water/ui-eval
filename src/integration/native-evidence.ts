import { createHash } from "node:crypto"
import { dirname, relative, resolve } from "node:path"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { loadNativePilotProject, loadNativePilotScenario } from "../native-pilot/config"
import { findNativeCommandFile, inspectNativeCommands } from "../native-pilot/evidence"
import { compileNativePilotFlow, nativeCaptureSegments } from "../native-pilot/flow"
import { inspectSerialCapture } from "../native-pilot/serial-capture"
import { NativePilotResultSchema } from "../native-pilot/report"
import { nativeFailureDiagnostic } from "../native-pilot/diagnostics"
import type { evaluateNativePilot } from "../native-pilot/run"
import { assertSafeSegment } from "../storage-local/filesystem"
import { containedPath } from "../wechat-pilot/config"
import { boundedFile, inspectWechatPng } from "../wechat-pilot/evidence"
import type { IntegrationSuite } from "./config"
import { statusForExit } from "./evidence"
import type { IntegrationStage } from "./model"

const byteDigest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/** Recheck original native inputs and bytes; a report alone cannot substantiate a pass. */
export async function nativeIntegrationEvidence(
  root: string,
  suite: IntegrationSuite,
  scenarioId: string,
  output: Awaited<ReturnType<typeof evaluateNativePilot>>,
  sourceDigest: string,
  deviceId: string,
): Promise<IntegrationStage["reports"]> {
  const result = output.result
  if (!Value.Check(NativePilotResultSchema, result)) throw new Error("Invalid native result")
  assertSafeSegment(result.executionId, "executionId")
  const directory = resolve(root, ".ui-eval/native-runs", result.executionId)
  if (output.reportPath !== resolve(directory, "report.json") || output.htmlPath !== resolve(directory, "report.html")) {
    throw new Error("Native report paths are not bound to their execution")
  }
  const files: Array<{ path: string; digest: string }> = []
  const read = async (path: string, limit = 1024 * 1024) => {
    const contained = await containedPath(root, relative(root, path))
    const bytes = await boundedFile(contained, limit)
    files.push({ path: relative(directory, path), digest: byteDigest(bytes) })
    return bytes
  }
  const persisted: unknown = JSON.parse((await read(output.reportPath, 8 * 1024 * 1024)).toString("utf8"))
  const html = await read(output.htmlPath, 8 * 1024 * 1024)
  if (!html.length || !Value.Check(NativePilotResultSchema, persisted) || canonicalDigest(persisted) !== canonicalDigest(result) ||
    result.projectId !== suite.projectId || result.scenarioId !== scenarioId || result.sourceDigest !== sourceDigest ||
    result.device.id !== deviceId) throw new Error("Native result is foreign or contradicts its canonical report")
  const project = await loadNativePilotProject(root)
  const scenario = await loadNativePilotScenario(root, project, scenarioId)
  const flow = compileNativePilotFlow(project, scenario)
  const segments = nativeCaptureSegments(project, scenario)
  const plan = { project, scenario, device: result.device, flow, ...(segments ? { segments } : {}) }
  if (project.projectId !== suite.projectId || result.appId !== project.appId || result.device.maestroVersion !== project.maestroVersion ||
    !result.device.runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") ||
    result.planDigest !== canonicalDigest(plan)) throw new Error("Native result does not match the declared plan")
  const persistedPlan: unknown = JSON.parse((await read(resolve(directory, "plan.json"))).toString("utf8"))
  const source: unknown = JSON.parse((await read(resolve(directory, "source.json"))).toString("utf8"))
  if (canonicalDigest(persistedPlan) !== result.planDigest || canonicalDigest(source) !== sourceDigest ||
    !source || typeof source !== "object" || !("commitSha" in source) || source.commitSha !== result.sourceCommit ||
    (await read(resolve(directory, "flow.yaml"))).toString("utf8") !== flow) {
    throw new Error("Native sealed source or flow does not match its report")
  }

  if (segments) {
    if (result.diagnostic) throw new Error("Legacy failure diagnostics do not describe serial capture")
    if (result.status !== "inconclusive" || result.serialExecutionDigest || result.screenshots.length || result.supplementalScreenshots) {
      const observed = await inspectSerialCapture(directory, project, scenario, deviceId, read)
      if (result.serialExecutionDigest !== observed.executionDigest || canonicalDigest(result.assertions) !== canonicalDigest(observed.assertions) ||
        (result.status !== "inconclusive" && result.status !== observed.status)) throw new Error("Native serial result contradicts its evidence")
      if (result.status === "passed" && (result.screenshotMethod !== "maestro-take-screenshot" ||
        canonicalDigest(result.screenshots) !== canonicalDigest(observed.screenshots.map((shot) => shot.screenshot)) ||
        canonicalDigest(result.supplementalScreenshots) !== canonicalDigest(observed.supplemental))) throw new Error("Native serial pass is missing declared images")
      if (result.status === "failed" && (result.screenshots.length || result.supplementalScreenshots)) throw new Error("Native serial failure cannot publish acceptance images")
      for (const shot of result.screenshots) {
        const expected = observed.screenshots.find((item) => item.screenshot.checkpointId === shot.checkpointId)
        if (!expected || canonicalDigest(shot) !== canonicalDigest(expected.screenshot) ||
          !expected.bytes.equals(await read(resolve(directory, shot.path), 32 * 1024 * 1024))) throw new Error("Native serial original image changed")
      }
      if (result.supplementalScreenshots && canonicalDigest(result.supplementalScreenshots) !== canonicalDigest(observed.supplemental)) throw new Error("Native supplemental images changed")
    } else if (result.assertions.passed || result.assertions.failed) throw new Error("Native serial assertions require execution evidence")
  } else if (result.serialExecutionDigest || result.supplementalScreenshots) {
    throw new Error("Undeclared native serial evidence")
  } else if (result.status !== "inconclusive" || result.screenshots.length || result.diagnostic) {
    const driverRoot = await containedPath(root, relative(root, resolve(directory, "driver")))
    const commandPath = await findNativeCommandFile(driverRoot)
    const commands: unknown = JSON.parse((await read(commandPath)).toString("utf8"))
    const evidence = inspectNativeCommands(commands, project, scenario, deviceId)
    if (evidence.passed !== result.assertions.passed || evidence.failed !== result.assertions.failed) {
      throw new Error("Native assertion counts contradict the original command evidence")
    }
    const checkpoints = scenario.steps.flatMap((step) => step.action === "screenshot" ? [step.checkpointId] : [])
    if (result.status === "passed" && (!evidence.complete || evidence.failed !== 0 ||
      evidence.passed !== scenario.steps.filter((step) => ["assert-visible", "assert-hidden"].includes(step.action)).length ||
      result.screenshots.length !== checkpoints.length)) throw new Error("Native pass is missing declared evidence")
    if (result.status === "failed" && (evidence.failed < 1 || result.screenshots.length !== 0)) {
      throw new Error("Native failure is not a bound visibility assertion failure")
    }
    if (result.diagnostic) {
      if (evidence.failed < 1 || !Array.isArray(commands)) throw new Error("Native diagnostic requires a bound failed assertion")
      const observed = await nativeFailureDiagnostic(directory, commandPath, commands, scenario)
      if (canonicalDigest(observed.diagnostic) !== canonicalDigest(result.diagnostic)) throw new Error("Native diagnostic contradicts its original artifacts")
      for (const file of observed.files) {
        const bytes = await read(resolve(directory, file.path), 32 * 1024 * 1024)
        if (byteDigest(bytes) !== file.digest) throw new Error("Native diagnostic artifact changed")
      }
    }
    const seen = new Set<string>()
    for (const shot of result.screenshots) {
      if (!checkpoints.includes(shot.checkpointId) || seen.has(shot.checkpointId) || shot.path !== `${shot.checkpointId}.png`) {
        throw new Error("Unexpected or duplicate native checkpoint")
      }
      seen.add(shot.checkpointId)
      for (const path of [resolve(directory, shot.path), resolve(dirname(commandPath), "takeScreenshot", shot.path)]) {
        const png = inspectWechatPng(await read(path, 32 * 1024 * 1024))
        if (png.digest !== shot.digest || png.width !== shot.widthPx || png.height !== shot.heightPx) {
          throw new Error("Native screenshot does not match its report")
        }
      }
    }
  }
  if (result.diagnostic && result.status === "passed") throw new Error("Native pass cannot carry a failure diagnostic")
  return [{
    executionId: result.executionId, variantKey: "ios-simulator", status: statusForExit({ passed: 0, failed: 1, inconclusive: 2 }[result.status]),
    reportPath: relative(root, output.reportPath), htmlPath: relative(root, output.htmlPath),
    reportDigest: canonicalDigest(result), htmlDigest: byteDigest(html),
    evidenceDigest: canonicalDigest(files.sort((left, right) => left.path.localeCompare(right.path))),
    capabilities: [
      { dimension: "Declared interaction / screenshots", status: result.status === "inconclusive" ? "unknown" : "measured", detail: "Experimental iOS Simulator evidence only; decoded PNGs do not establish visual completeness and require human review." },
      { dimension: "Runtime / network / design / real device", status: "unsupported", detail: "No native release readiness or build-to-source attestation is established." },
    ],
  }]
}
