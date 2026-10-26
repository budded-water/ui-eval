import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { runCommand } from "../runtime/command"
import { containedPath } from "../wechat-pilot/config"
import { inspectWechatPng } from "../wechat-pilot/evidence"
import type { NativePilotProject, NativePilotScenario } from "./config"
import { findNativeCommandFile, inspectNativeCommands, readNativeEvidence } from "./evidence"
import { nativeCaptureSegments } from "./flow"
import type { NativePilotResult } from "./report"

const strict = { additionalProperties: false }
const offset = Type.Number({ minimum: 0 })
export const NativeSerialExecutionSchema = Type.Object({
  method: Type.Literal("serial-maestro-simctl"), deviceId: Type.String(),
  segments: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0 }), startedMs: offset, driverFinishedMs: offset,
    exitCode: Type.Union([Type.Literal(0), Type.Literal(1)]),
    capture: Type.Optional(Type.Object({
      checkpointId: Type.String(), method: Type.Literal("simctl"), startedMs: offset, finishedMs: offset,
    }, strict)),
  }, strict), { minItems: 1, maxItems: 100 }),
}, strict)
type SerialExecution = Static<typeof NativeSerialExecutionSchema>
type Reader = (path: string, maximumBytes?: number) => Promise<Buffer>

/** A single monotonic deadline covers every segment, validation gap and supplemental capture. */
export async function runSerialCapture(
  root: string, directory: string, project: NativePilotProject, scenario: NativePilotScenario, deviceId: string,
  command: typeof runCommand = runCommand, signal?: AbortSignal,
) {
  const segments = nativeCaptureSegments(project, scenario)
  if (!segments) throw new Error("Serial capture requires explicit checkpoints")
  const start = performance.now()
  const elapsed = () => performance.now() - start
  const remaining = () => {
    signal?.throwIfAborted()
    const value = Math.floor(project.timeoutMs - elapsed())
    if (value < 1) throw new Error("Native serial capture deadline exceeded")
    return value
  }
  const execution: SerialExecution = { method: "serial-maestro-simctl", deviceId, segments: [] }
  await mkdir(resolve(directory, "segments"))
  await mkdir(resolve(directory, "supplemental"))
  for (let index = 0; index < segments.length; index++) {
    remaining()
    const segment = segments[index]
    const base = resolve(directory, "segments", String(index))
    await mkdir(base)
    await writeFile(resolve(base, "flow.yaml"), segment.flow, { flag: "wx" })
    const entry: SerialExecution["segments"][number] = { index, startedMs: elapsed(), driverFinishedMs: 0, exitCode: 0 }
    const driver = await command("maestro", ["--device", deviceId, "test", resolve(base, "flow.yaml"),
      "--test-output-dir", resolve(base, "driver"), "--debug-output", resolve(base, "debug")],
    { cwd: root, timeoutMs: remaining(), signal })
    entry.driverFinishedMs = elapsed()
    remaining()
    const commandPath = await findNativeCommandFile(resolve(base, "driver"))
    const part = { ...scenario, steps: scenario.steps.slice(segment.startStep, segment.endStep) }
    const evidence = inspectNativeCommands(JSON.parse((await readNativeEvidence(commandPath, 1024 * 1024)).toString("utf8")), project, part, deviceId, index === 0)
    if (driver.exitCode === 1 && evidence.failed > 0) {
      entry.exitCode = 1
      execution.segments.push(entry)
      break
    }
    if (driver.exitCode !== 0 || !evidence.complete || evidence.failed) throw new Error("Incomplete native serial command evidence")
    for (const step of part.steps) {
      if (step.action === "screenshot") inspectWechatPng(await readNativeEvidence(await containedPath(directory,
        relative(directory, resolve(dirname(commandPath), "takeScreenshot", `${step.checkpointId}.png`))), 32 * 1024 * 1024))
    }
    const last = part.steps.at(-1)!
    if (last.action === "screenshot" && last.supplementalCapture) {
      const capture = { checkpointId: last.checkpointId, method: "simctl" as const, startedMs: elapsed(), finishedMs: 0 }
      const shot = await command("xcrun", ["simctl", "io", deviceId, "screenshot", "--type=png", resolve(directory, "supplemental", `${last.checkpointId}.png`)],
        { cwd: root, timeoutMs: remaining(), signal })
      capture.finishedMs = elapsed()
      remaining()
      if (shot.exitCode !== 0) throw new Error("Supplemental native capture failed")
      // Decode before executing any continuation; invalid captures never trigger a fallback.
      inspectWechatPng(await readNativeEvidence(await containedPath(directory, `supplemental/${last.checkpointId}.png`), 32 * 1024 * 1024))
      entry.capture = capture
    }
    execution.segments.push(entry)
  }
  remaining()
  await writeFile(resolve(directory, "serial-execution.json"), JSON.stringify(execution, null, 2) + "\n", { flag: "wx" })
  const observed = await inspectSerialCapture(directory, project, scenario, deviceId)
  remaining()
  return observed
}

/** Reconstruct the complete segment contract from current trusted inputs and original bytes. */
export async function inspectSerialCapture(
  directory: string, project: NativePilotProject, scenario: NativePilotScenario, deviceId: string,
  read: Reader = async (path, limit = 1024 * 1024) => readNativeEvidence(await containedPath(directory, relative(directory, path)), limit),
) {
  const segments = nativeCaptureSegments(project, scenario)
  const execution: unknown = JSON.parse((await read(resolve(directory, "serial-execution.json"))).toString("utf8"))
  if (!segments || !Value.Check(NativeSerialExecutionSchema, execution) || execution.deviceId !== deviceId || execution.segments.length > segments.length) throw new Error("Invalid native serial execution")
  let previousEnd = 0, passed = 0, failed = 0
  const screenshots: Array<{ bytes: Buffer; screenshot: NativePilotResult["screenshots"][number] }> = []
  const supplemental: NonNullable<NativePilotResult["supplementalScreenshots"]> = []
  for (let index = 0; index < execution.segments.length; index++) {
    const entry = execution.segments[index], segment = segments[index]
    if (entry.index !== index || entry.startedMs < previousEnd || entry.driverFinishedMs < entry.startedMs || entry.driverFinishedMs >= project.timeoutMs) throw new Error("Native serial order or deadline mismatch")
    const base = resolve(directory, "segments", String(index))
    if ((await read(resolve(base, "flow.yaml"))).toString("utf8") !== segment.flow) throw new Error("Native segment flow mismatch")
    const commandPath = await findNativeCommandFile(await containedPath(directory, relative(directory, resolve(base, "driver"))))
    const part = { ...scenario, steps: scenario.steps.slice(segment.startStep, segment.endStep) }
    const evidence = inspectNativeCommands(JSON.parse((await read(commandPath)).toString("utf8")), project, part, deviceId, index === 0)
    passed += evidence.passed
    failed += evidence.failed
    previousEnd = entry.driverFinishedMs
    if (entry.exitCode === 1) {
      if (!evidence.failed || entry.capture || index !== execution.segments.length - 1) throw new Error("Invalid native serial failure")
      break
    }
    if (!evidence.complete || evidence.failed) throw new Error("Incomplete native serial segment")
    for (const step of part.steps) {
      if (step.action !== "screenshot") continue
      const bytes = await read(resolve(dirname(commandPath), "takeScreenshot", `${step.checkpointId}.png`), 32 * 1024 * 1024)
      const png = inspectWechatPng(bytes)
      screenshots.push({ bytes, screenshot: { checkpointId: step.checkpointId, path: `${step.checkpointId}.png`, digest: png.digest, widthPx: png.width, heightPx: png.height } })
    }
    const last = part.steps.at(-1)!
    if (last.action === "screenshot" && last.supplementalCapture) {
      const capture = entry.capture
      if (!capture || capture.checkpointId !== last.checkpointId || capture.startedMs < entry.driverFinishedMs || capture.finishedMs < capture.startedMs || capture.finishedMs >= project.timeoutMs) throw new Error("Native supplemental capture order or deadline mismatch")
      const path = `supplemental/${last.checkpointId}.png`
      const png = inspectWechatPng(await read(resolve(directory, path), 32 * 1024 * 1024))
      supplemental.push({ checkpointId: last.checkpointId, method: "simctl", path, digest: png.digest, widthPx: png.width, heightPx: png.height })
      previousEnd = capture.finishedMs
    } else if (entry.capture) throw new Error("Undeclared native supplemental capture")
  }
  if (!failed && execution.segments.length !== segments.length) throw new Error("Missing native serial continuation")
  return { status: failed ? "failed" as const : "passed" as const, assertions: { passed, failed }, screenshots, supplemental,
    executionDigest: canonicalDigest(execution) }
}
