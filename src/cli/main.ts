import { parseArgs } from "node:util"
import packageJson from "../../package.json" with { type: "json" }

import { runAgentSuite, type AgentRunResult } from "../agent/run"
import { evaluateScenario, type EvaluateScenarioResult } from "../orchestrator/evaluate"
import { runDoctor, type DoctorResult } from "./doctor"
import { evaluationExitCode } from "./exit-code"
import { initUiEvalProject, type InitUiEvalProjectResult } from "./init"

const VERSION = packageJson.version
const SIGNAL_CLEANUP_TIMEOUT_MS = 10_000

export type CliSignal = "SIGINT" | "SIGTERM"

const SIGNAL_EXIT_CODES: Record<CliSignal, 130 | 143> = {
  SIGINT: 130,
  SIGTERM: 143,
}

const HELP = `UI Eval ${VERSION}

Usage:
  ui-eval init --route /page --scenario page-desktop --yes
  ui-eval evaluate <scenario> [--policy default] [--reference path.png]
                              [--execution-profile name] [--browser-channel chrome] [--format text|json]
  ui-eval agent <suite> [--repair] [--browser-channel chrome]
                        [--execution-profile name] [--additional-scenario id] [--full-scope] [--format text|json]
  ui-eval doctor [--execution-profile name] [--browser-channel chrome] [--format text|json]

Exit codes:
  0  pass
  1  candidate fail with valid evidence
  2  config, infrastructure, or inconclusive evidence
  3  evidence requires human review
  130 interrupted by SIGINT
  143 terminated by SIGTERM
`

export interface CliIo {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export interface CliDependencies {
  init?: typeof initUiEvalProject
  evaluate?: typeof evaluateScenario
  agent?: typeof runAgentSuite
  doctor?: typeof runDoctor
}

export interface CliRunOptions {
  signal?: AbortSignal
}

export interface CliSignalRuntime {
  addSignalListener: (signal: CliSignal, listener: () => void) => void
  removeSignalListener: (signal: CliSignal, listener: () => void) => void
  forceExit: (code: number) => void
  schedule: (callback: () => void, timeoutMs: number) => () => void
}

export interface RunCliProcessOptions {
  cleanupTimeoutMs?: number
  runtime?: CliSignalRuntime
}

export class CliInterruptedError extends Error {
  readonly code = "INTERRUPTED"
  readonly signal: CliSignal

  constructor(signal: CliSignal) {
    super(`UI Eval was interrupted by ${signal}.`)
    this.name = "CliInterruptedError"
    this.signal = signal
  }
}

const defaultIo: CliIo = {
  cwd: process.cwd(),
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
}

const defaultSignalRuntime: CliSignalRuntime = {
  addSignalListener: (signal, listener) => process.on(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
  forceExit: (code) => process.exit(code),
  schedule: (callback, timeoutMs) => {
    const timer = setTimeout(callback, timeoutMs)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

function line(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`
}

function stringOption(
  value: string | undefined,
  name: string,
  required = false,
): string | undefined {
  if (required && !value) throw new Error(`--${name} is required`)
  return value
}

function formatOption(value: string | undefined): "text" | "json" {
  if (!value || value === "text") return "text"
  if (value === "json") return "json"
  throw new Error("--format must be text or json")
}

function errorPayload(error: unknown): unknown {
  return {
    error: {
      name: error instanceof Error ? error.name : "Error",
      ...(
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? { code: error.code }
          : {}
      ),
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CliInterruptedError
        ? { signal: error.signal }
        : {}),
    },
  }
}

function interruptionFromSignal(signal: AbortSignal | undefined): CliInterruptedError {
  if (signal?.reason instanceof CliInterruptedError) return signal.reason
  return new CliInterruptedError("SIGINT")
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw interruptionFromSignal(signal)
}

function emitJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

function evaluateResultJson(result: EvaluateScenarioResult): unknown {
  return {
    projectId: result.projectId,
    scenarioId: result.scenarioId,
    runs: result.runs.map((run) => ({
      executionId: run.executionId,
      variantKey: run.variantKey,
      executionOutcome: run.executionOutcome,
      rawStatus: run.rawStatus,
      reportPath: run.reportPath,
      htmlPath: run.htmlPath,
      report: run.report,
    })),
  }
}

function aggregateEvaluationExitCode(result: EvaluateScenarioResult): number {
  const codes = result.runs.map(evaluationExitCode)
  if (codes.includes(2)) return 2
  if (codes.includes(1)) return 1
  if (codes.includes(3)) return 3
  return 0
}

async function agentCommand(
  args: string[],
  io: CliIo,
  deps: CliDependencies,
  runOptions: CliRunOptions,
): Promise<number> {
  throwIfInterrupted(runOptions.signal)
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      repair: { type: "boolean", default: false },
      "execution-profile": { type: "string" },
      "additional-scenario": { type: "string", multiple: true },
      "full-scope": { type: "boolean", default: false },
      "browser-channel": { type: "string" },
      "project-root": { type: "string" },
      format: { type: "string", default: "text" },
    },
  })
  if (parsed.positionals.length !== 1) {
    throw new Error("agent requires exactly one suite id or path")
  }
  const format = formatOption(parsed.values.format)
  const result: AgentRunResult = await (deps.agent ?? runAgentSuite)({
    projectRoot: parsed.values["project-root"] ?? io.cwd,
    suite: parsed.positionals[0],
    ...(parsed.values["execution-profile"] ? { executionProfile: parsed.values["execution-profile"] } : {}),
    ...(parsed.values["additional-scenario"] ? { additionalScenarios: parsed.values["additional-scenario"] } : {}),
    ...(parsed.values["full-scope"] ? { fullScope: true } : {}),
    repair: parsed.values.repair,
    ...(parsed.values["browser-channel"]
      ? { browserChannel: parsed.values["browser-channel"] }
      : {}),
    ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    onProgress: (message) => io.stderr(`[ui-eval-agent] ${line(message)}`),
  })
  throwIfInterrupted(runOptions.signal)
  if (format === "json") emitJson(io, result)
  else {
    io.stdout(
      `${result.status.toUpperCase()} ${result.suiteId}\n  ${result.reason}\n  HTML: ${result.summaryHtmlPath}\n  JSON: ${result.summaryPath}\n`,
    )
    for (const iteration of result.iterations) {
      io.stdout(
        `  iteration ${iteration.iteration}: score=${iteration.score.toFixed(6)} accepted=${String(iteration.accepted)}\n`,
      )
    }
  }
  return result.accepted ? 0 : 1
}

async function initCommand(
  args: string[],
  io: CliIo,
  deps: CliDependencies,
  runOptions: CliRunOptions,
): Promise<number> {
  throwIfInterrupted(runOptions.signal)
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      route: { type: "string" },
      scenario: { type: "string" },
      "project-root": { type: "string" },
      yes: { type: "boolean", default: false },
    },
  })
  const route = stringOption(parsed.values.route, "route", true)!
  const scenarioId = stringOption(parsed.values.scenario, "scenario", true)!
  if (!parsed.values.yes) {
    throw new Error(
      "init creates project files; inspect the target and pass --yes to confirm",
    )
  }
  const result: InitUiEvalProjectResult = await (
    deps.init ?? initUiEvalProject
  )({
    projectRoot: parsed.values["project-root"] ?? io.cwd,
    route,
    scenarioId,
  })
  throwIfInterrupted(runOptions.signal)
  io.stdout(
    line(
      result.created.length > 0
        ? `Created ${result.created.length} UI Eval project files.`
        : "No files created; existing authoring files were preserved.",
    ),
  )
  for (const path of result.created) io.stdout(`  + ${path}\n`)
  for (const path of result.updated) io.stdout(`  ~ ${path} (updated safely)\n`)
  for (const path of result.skipped) io.stdout(`  = ${path} (kept)\n`)
  return 0
}

async function evaluateCommand(
  args: string[],
  io: CliIo,
  deps: CliDependencies,
  runOptions: CliRunOptions,
): Promise<number> {
  throwIfInterrupted(runOptions.signal)
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      policy: { type: "string" },
      "execution-profile": { type: "string" },
      reference: { type: "string" },
      "browser-channel": { type: "string" },
      "project-root": { type: "string" },
      format: { type: "string", default: "text" },
    },
  })
  if (parsed.positionals.length !== 1) {
    throw new Error("evaluate requires exactly one scenario id or path")
  }
  const format = formatOption(parsed.values.format)
  const result = await (deps.evaluate ?? evaluateScenario)({
    projectRoot: parsed.values["project-root"] ?? io.cwd,
    scenario: parsed.positionals[0],
    ...(parsed.values["execution-profile"] ? { executionProfile: parsed.values["execution-profile"] } : {}),
    ...(parsed.values.policy ? { policy: parsed.values.policy } : {}),
    ...(parsed.values.reference
      ? { referencePath: parsed.values.reference }
      : {}),
    ...(parsed.values["browser-channel"]
      ? { browserChannel: parsed.values["browser-channel"] }
      : {}),
    ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    onProgress: (message) => io.stderr(`[ui-eval] ${line(message)}`),
  })
  throwIfInterrupted(runOptions.signal)

  if (format === "json") {
    emitJson(io, evaluateResultJson(result))
  } else {
    for (const run of result.runs) {
      io.stdout(
        `${run.rawStatus.toUpperCase()} ${run.variantKey}\n  JSON: ${run.reportPath}\n  HTML: ${run.htmlPath}\n`,
      )
    }
  }
  return aggregateEvaluationExitCode(result)
}

function emitDoctorText(io: CliIo, result: DoctorResult): void {
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status.toUpperCase()
    io.stdout(`${marker.padEnd(4)} ${check.id}: ${check.message}\n`)
  }
}

async function doctorCommand(
  args: string[],
  io: CliIo,
  deps: CliDependencies,
  runOptions: CliRunOptions,
): Promise<number> {
  throwIfInterrupted(runOptions.signal)
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "execution-profile": { type: "string" },
      "browser-channel": { type: "string" },
      "project-root": { type: "string" },
      format: { type: "string", default: "text" },
    },
  })
  const format = formatOption(parsed.values.format)
  const result = await (deps.doctor ?? runDoctor)({
    projectRoot: parsed.values["project-root"] ?? io.cwd,
    ...(parsed.values["execution-profile"] ? { executionProfile: parsed.values["execution-profile"] } : {}),
    ...(parsed.values["browser-channel"]
      ? { browserChannel: parsed.values["browser-channel"] }
      : {}),
  })
  throwIfInterrupted(runOptions.signal)
  if (format === "json") emitJson(io, result)
  else emitDoctorText(io, result)
  return result.ok ? 0 : 2
}

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  deps: CliDependencies = {},
  runOptions: CliRunOptions = {},
): Promise<number> {
  const jsonRequested = argv.some(
    (value, index) =>
      value === "--format=json" ||
      (value === "--format" && argv[index + 1] === "json"),
  )
  try {
    throwIfInterrupted(runOptions.signal)
    const [command, ...args] = argv
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(HELP)
      return 0
    }
    if (command === "--version" || command === "-v") {
      io.stdout(`${VERSION}\n`)
      return 0
    }
    if (command === "init") return await initCommand(args, io, deps, runOptions)
    if (command === "evaluate") {
      return await evaluateCommand(args, io, deps, runOptions)
    }
    if (command === "agent") return await agentCommand(args, io, deps, runOptions)
    if (command === "doctor") return await doctorCommand(args, io, deps, runOptions)
    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    const failure = runOptions.signal?.aborted
      ? interruptionFromSignal(runOptions.signal)
      : error
    if (failure instanceof CliInterruptedError) {
      if (jsonRequested) emitJson(io, errorPayload(failure))
      return SIGNAL_EXIT_CODES[failure.signal]
    }
    if (jsonRequested) emitJson(io, errorPayload(failure))
    else io.stderr(`UI Eval error: ${line(failure instanceof Error ? failure.message : String(failure))}`)
    return 2
  }
}

/**
 * Runs the real CLI with process-signal ownership. The first signal requests
 * cooperative cancellation and allows bounded cleanup. A second signal, or an
 * expired cleanup deadline, forces the conventional signal exit code.
 */
export async function runCliProcess(
  argv: string[],
  io: CliIo = defaultIo,
  deps: CliDependencies = {},
  options: RunCliProcessOptions = {},
): Promise<number> {
  const runtime = options.runtime ?? defaultSignalRuntime
  const cleanupTimeoutMs = Math.max(
    1,
    options.cleanupTimeoutMs ?? SIGNAL_CLEANUP_TIMEOUT_MS,
  )
  const controller = new AbortController()
  let firstSignal: CliSignal | undefined
  let cancelForcedExit: (() => void) | undefined
  let settled = false

  const receive = (signal: CliSignal): void => {
    if (settled) return
    if (firstSignal) {
      runtime.forceExit(SIGNAL_EXIT_CODES[firstSignal])
      return
    }

    firstSignal = signal
    io.stderr(
      `[ui-eval] ${signal} received; cancelling and cleaning up. Send another signal to force exit.\n`,
    )
    cancelForcedExit = runtime.schedule(
      () => runtime.forceExit(SIGNAL_EXIT_CODES[signal]),
      cleanupTimeoutMs,
    )
    controller.abort(new CliInterruptedError(signal))
  }
  const onSigint = () => receive("SIGINT")
  const onSigterm = () => receive("SIGTERM")
  runtime.addSignalListener("SIGINT", onSigint)
  runtime.addSignalListener("SIGTERM", onSigterm)

  try {
    const code = await runCli(argv, io, deps, { signal: controller.signal })
    return firstSignal ? SIGNAL_EXIT_CODES[firstSignal] : code
  } finally {
    settled = true
    cancelForcedExit?.()
    runtime.removeSignalListener("SIGINT", onSigint)
    runtime.removeSignalListener("SIGTERM", onSigterm)
  }
}
