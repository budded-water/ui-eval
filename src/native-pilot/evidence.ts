import { lstat, readFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { PNG } from "pngjs"
import { createHash } from "node:crypto"
import { canonicalDigest } from "../contracts/canonical-json"
import { inspectPngHeader } from "../capture-playwright/binary-evidence"
import type { NativePilotProject, NativePilotScenario } from "./config"
import type { NativePilotResult } from "./report"

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native command metadata")
  return value as JsonObject
}

/** Bind Maestro 2.9.0 command evidence to every generated step, in order. */
export function inspectNativeCommands(data: unknown, project: NativePilotProject, scenario: NativePilotScenario, deviceId: string): { passed: number; failed: number; complete: boolean } {
  if (!Array.isArray(data) || data.length > scenario.steps.length + 3 || data.length < 3) throw new Error("Native command coverage mismatch")
  let passed = 0
  let failed = 0
  let stopped = false
  for (let index = 0; index < data.length; index++) {
    const row = object(data[index])
    const metadata = object(row.metadata)
    const command = object(row.command)
    if (canonicalDigest(command) !== canonicalDigest(metadata.evaluatedCommand)) throw new Error("Native evaluated command mismatch")
    if (metadata.sequenceNumber !== index || metadata.depth !== 0 || Object.keys(command).length !== 1) throw new Error("Native command order mismatch")
    const key = Object.keys(command)[0]
    const value = object(command[key])
    if (value.optional !== false) throw new Error("Native optional command is unsupported")
    if (index === 0) {
      const expected = { defineVariablesCommand: { env: { MAESTRO_FILENAME: "flow", MAESTRO_DEVICE_UDID: deviceId, MAESTRO_SHARD_ID: "1", MAESTRO_SHARD_INDEX: "0" }, optional: false } }
      if (canonicalDigest(command) !== canonicalDigest(expected)) throw new Error("Native device binding mismatch")
    } else if (index === 1) {
      const expected = { applyConfigurationCommand: { config: { appId: project.appId, name: scenario.scenarioId }, optional: false } }
      if (canonicalDigest(command) !== canonicalDigest(expected)) throw new Error("Native scenario binding mismatch")
    } else if (index === 2) {
      if (canonicalDigest(command) !== canonicalDigest({ launchAppCommand: { appId: project.appId, stopApp: true, optional: false } })) throw new Error("Native launch binding mismatch")
    } else {
      const step = scenario.steps[index - 3]
      if (step.action === "screenshot") {
        if (canonicalDigest(command) !== canonicalDigest({ takeScreenshotCommand: { path: step.checkpointId, optional: false } })) throw new Error("Native screenshot binding mismatch")
      } else {
        let selector: JsonObject
        if (step.action === "tap") {
          if (key !== "tapOnElement") throw new Error("Native tap binding mismatch")
          selector = object(value.selector)
        } else {
          if (key !== "assertConditionCommand") throw new Error("Native assertion binding mismatch")
          const condition = object(value.condition)
          const expectedKey = step.action === "assert-visible" ? "visible" : "notVisible"
          if (Object.keys(condition).length !== 1) throw new Error("Native assertion condition mismatch")
          selector = object(condition[expectedKey])
        }
        const field = "id" in step.selector ? "idRegex" : "textRegex"
        const expected = "id" in step.selector ? step.selector.id : step.selector.text
        if (selector[field] !== expected || selector.optional !== false) throw new Error("Native selector binding mismatch")
        const expectedSelector = { [field]: expected, optional: false }
        const expectedCommand = step.action === "tap"
          ? { tapOnElement: { selector: expectedSelector, retryIfNoChange: false, waitUntilVisible: false, longPress: false, optional: false } }
          : { assertConditionCommand: { condition: { [step.action === "assert-visible" ? "visible" : "notVisible"]: expectedSelector }, optional: false } }
        if (canonicalDigest(command) !== canonicalDigest(expectedCommand)) throw new Error("Native command semantics mismatch")
        if (step.action !== "tap") {
          if (metadata.status === "COMPLETED") passed++
          // An assertion command failure is reported as failed interaction only;
          // it is never a native runtime/crash or visual-conformance finding.
          if (metadata.status === "FAILED") failed++
        }
      }
    }
    if (metadata.status !== "COMPLETED") {
      if (metadata.status !== "FAILED" || index !== data.length - 1) throw new Error("Incomplete native command evidence")
      stopped = true
    }
  }
  return { passed, failed, complete: !stopped && data.length === scenario.steps.length + 3 }
}

/** Driver output is untrusted: no symlinks, bounded traversal, unique metadata. */
export async function findNativeCommandFile(root: string): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Native driver root must not be a symlink")
  const matches: string[] = []
  let count = 0
  const walk = async (directory: string, depth: number) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (++count > 200) throw new Error("Native evidence directory limit exceeded")
      if (entry.isSymbolicLink()) throw new Error("Native evidence contains a symlink")
      const path = resolve(directory, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1)
      if (entry.isFile() && entry.name === "commands.json") matches.push(path)
    }
  }
  await walk(root, 0)
  if (matches.length !== 1) throw new Error("Missing or ambiguous native command evidence")
  return matches[0]
}

export async function readNativeEvidence(path: string, maximumBytes: number): Promise<Buffer> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error("Invalid native evidence file")
  const bytes = await readFile(path)
  if (bytes.length > maximumBytes) throw new Error("Native evidence exceeded byte limit")
  return bytes
}

export async function nativeScreenshots(commandPath: string, scenario: NativePilotScenario): Promise<Array<{ bytes: Buffer; screenshot: NativePilotResult["screenshots"][number] }>> {
  const output: Array<{ bytes: Buffer; screenshot: NativePilotResult["screenshots"][number] }> = []
  for (const step of scenario.steps) {
    if (step.action !== "screenshot") continue
    const bytes = await readNativeEvidence(resolve(dirname(commandPath), "takeScreenshot", `${step.checkpointId}.png`), 32 * 1024 * 1024)
    const header = inspectPngHeader(bytes, "screenshot")
    const decoded = PNG.sync.read(bytes, { checkCRC: true })
    if (decoded.width !== header.width || decoded.height !== header.height) throw new Error("Native screenshot decode mismatch")
    output.push({ bytes, screenshot: {
      checkpointId: step.checkpointId, path: `${step.checkpointId}.png`,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, widthPx: header.width, heightPx: header.height,
    } })
  }
  return output
}
