import { randomUUID } from "node:crypto"
import { lstat, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { canonicalDigest } from "../contracts/canonical-json"
import { collectSourceRevision } from "../orchestrator/identity"
import { runCommand } from "../runtime/command"
import { loadNativePilotProject, loadNativePilotScenario } from "./config"
import { compileNativePilotFlow } from "./flow"
import { findNativeCommandFile, inspectNativeCommands, nativeScreenshots, readNativeEvidence } from "./evidence"
import { writeNativePilotReport, type NativePilotResult } from "./report"

export interface NativePilotOptions { projectRoot: string; deviceId: string; scenario?: string; signal?: AbortSignal }
export interface NativePilotDependencies { command?: typeof runCommand; sourceRevision?: typeof collectSourceRevision; platform?: NodeJS.Platform }

export async function doctorNativePilot(options: NativePilotOptions, dependencies: NativePilotDependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== "darwin") throw new Error("Native pilot requires macOS and iOS Simulator")
  if (!/^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(options.deviceId)) throw new Error("Native pilot requires an explicit simulator UUID")
  const project = await loadNativePilotProject(options.projectRoot)
  if (project.maestroVersion !== "2.9.0") throw new Error("Native pilot supports the Maestro 2.9.0 evidence format only")
  const command = dependencies.command ?? runCommand
  const run = async (binary: string, args: string[]) => {
    const result = await command(binary, args, { cwd: options.projectRoot, timeoutMs: 30000, signal: options.signal, truncateOutput: false })
    if (result.exitCode !== 0) throw new Error(`Native pilot prerequisite command failed: ${binary} ${args.slice(0, 2).join(" ")}`)
    return result.stdout
  }
  const version = (await run("maestro", ["--version"])).trim()
  if (version !== project.maestroVersion) throw new Error("Native pilot Maestro version differs from project pin")
  const devices: unknown = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "available", "-j"]))
  if (!devices || typeof devices !== "object" || !("devices" in devices) || !devices.devices || typeof devices.devices !== "object") throw new Error("Invalid simulator inventory")
  const matches: Array<{ id: string; name: string; runtime: string; maestroVersion: string }> = []
  for (const [runtime, candidates] of Object.entries(devices.devices)) {
    if (!runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") || !Array.isArray(candidates)) continue
    for (const device of candidates) {
      if (device.udid === options.deviceId && device.state === "Booted" && device.isAvailable === true && typeof device.name === "string") {
        matches.push({ id: device.udid, name: device.name, runtime, maestroVersion: version })
      }
    }
  }
  if (matches.length !== 1) throw new Error("Selected native simulator must be booted and available")
  await run("xcrun", ["simctl", "get_app_container", options.deviceId, project.appId, "app"])
  // Validate the entire configured suite even when doctor has no selected scenario.
  for (const name of Object.keys(project.scenarios)) await loadNativePilotScenario(options.projectRoot, project, name)
  return { project, device: matches[0] }
}

async function outputDirectory(root: string): Promise<string> {
  let directory = resolve(root)
  for (const part of [".ui-eval", "native-runs", randomUUID()]) {
    directory = resolve(directory, part)
    try { await mkdir(directory) } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Native artifact directory must not contain symlinks")
  }
  return directory
}

export async function evaluateNativePilot(options: NativePilotOptions, dependencies: NativePilotDependencies = {}) {
  if (!options.scenario) throw new Error("Native pilot requires a scenario")
  const source = dependencies.sourceRevision ?? collectSourceRevision
  const sourceRevision = await source(options.projectRoot)
  const sourceDigest = canonicalDigest(sourceRevision)
  const { project, device } = await doctorNativePilot(options, dependencies)
  const scenario = await loadNativePilotScenario(options.projectRoot, project, options.scenario)
  if (canonicalDigest(await source(options.projectRoot)) !== sourceDigest) throw new Error("Candidate source changed while loading native inputs")
  const directory = await outputDirectory(options.projectRoot)
  const flow = compileNativePilotFlow(project, scenario)
  await writeFile(resolve(directory, "plan.json"), JSON.stringify({ project, scenario, device, flow }, null, 2) + "\n", { flag: "wx" })
  await writeFile(resolve(directory, "source.json"), JSON.stringify(sourceRevision, null, 2) + "\n", { flag: "wx" })
  await writeFile(resolve(directory, "flow.yaml"), flow, { flag: "wx" })
  const result: NativePilotResult = {
    apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotResult", experimental: true,
    projectId: project.projectId, scenarioId: scenario.scenarioId, executionId: directory.split("/").at(-1)!,
    status: "inconclusive", reason: "Native evidence was not completed.",
    planDigest: canonicalDigest({ project, scenario, device, flow }), sourceDigest, sourceCommit: sourceRevision.commitSha,
    device, appId: project.appId, provenanceAssurance: "observed-source-and-installed-app-only",
    assertions: { passed: 0, failed: 0 }, screenshots: [],
    limitations: [
      "Only declared Maestro interactions and screenshot evidence are assessed; screenshots are for human review.",
      "No native runtime/crash, network, accessibility, geometry, typography or design-conformance gate is implemented.",
      "Source identity and installed app presence are observed; the installed binary and any Metro bundle are not cryptographically bound to this source.",
      "Device language, time, keyboard, permissions, account and backend isolation remain candidate-project responsibilities.",
      "This experimental result does not establish release readiness; Android and Harmony are unsupported.",
    ],
  }
  try {
    const driver = await (dependencies.command ?? runCommand)("maestro", [
      "--device", device.id, "test", resolve(directory, "flow.yaml"),
      "--test-output-dir", resolve(directory, "driver"), "--debug-output", resolve(directory, "debug"),
    ], { cwd: options.projectRoot, timeoutMs: project.timeoutMs, signal: options.signal })
    const commands = await findNativeCommandFile(resolve(directory, "driver"))
    const evidence = inspectNativeCommands(JSON.parse((await readNativeEvidence(commands, 1024 * 1024)).toString("utf8")), project, scenario, device.id)
    result.assertions = { passed: evidence.passed, failed: evidence.failed }
    if (driver.exitCode === 0 && evidence.complete && evidence.failed === 0) {
      const screenshots = await nativeScreenshots(commands, scenario)
      for (const screenshot of screenshots) await writeFile(resolve(directory, screenshot.screenshot.path), screenshot.bytes, { flag: "wx" })
      result.screenshots = screenshots.map((shot) => shot.screenshot)
      result.status = "passed"
      result.reason = "All declared interaction assertions completed and every required screenshot decoded."
    } else if (driver.exitCode === 1 && evidence.failed > 0) {
      result.status = "failed"
      result.reason = "A declared Maestro visibility assertion failed; this is an interaction observation only."
    } else {
      result.reason = "Driver exit and bound command evidence did not establish a complete run."
    }
    if (canonicalDigest(await source(options.projectRoot)) !== sourceDigest) {
      result.status = "inconclusive"
      result.reason = "Candidate source changed during native capture."
    }
  } catch {
    result.status = "inconclusive"
    result.reason = options.signal?.aborted ? "Native capture was interrupted." : "Native capture or required evidence was unavailable or invalid."
  }
  await writeNativePilotReport(directory, result)
  options.signal?.throwIfAborted()
  return { result, reportPath: resolve(directory, "report.json"), htmlPath: resolve(directory, "report.html") }
}
