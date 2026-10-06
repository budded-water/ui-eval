import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { EvaluateScenarioOptions } from "../orchestrator/evaluate"
import { evaluateScenario } from "../orchestrator/evaluate"
import { hasIncompleteCleanup } from "../runtime/cleanup"
import { runCommand as defaultRunCommand } from "../runtime/command"
import { listChangedFiles as defaultListChangedFiles, snapshotSourceFiles as defaultSnapshotFiles } from "./source-state"
import { assessScenario, assessDimensions, repairProgress } from "./assessment"
import { loadAgentSuite, type AgentSuite } from "./config"
import { selectAgentScenarios } from "./selection"
import { loadProjectConfig } from "../project/config"
import { resolveExecutionProfile } from "../project/execution-profile"
import { writeAgentSummaryArtifacts } from "./report"

import { assertSchema } from "../contracts/validation"
import { AgentRunResultSchema } from "./model"
import type { AgentCheckResult, AgentScenarioResult, AgentIteration, AgentRunResult, AgentStatus } from "./model"
export type { AgentCheckResult, AgentScenarioResult, AgentDimensionResult, AgentIteration, AgentRunResult, AgentStatus } from "./model"

export interface RunAgentOptions {
  executionProfile?: string
  additionalScenarios?: readonly string[]
  fullScope?: boolean
  projectRoot: string
  suite: string
  browserChannel?: string
  repair?: boolean
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export type AgentCommandResult = import("../runtime/command").CommandResult

export interface RunAgentDependencies {
  evaluate?: typeof evaluateScenario
  runCommand?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string
      input?: string
      timeoutMs: number
      signal?: AbortSignal
    },
  ) => Promise<AgentCommandResult>
  listChangedFiles?: (projectRoot: string) => Promise<string[]>
  snapshotFiles?: (projectRoot: string) => Promise<Map<string, string>>
  writeSummaryArtifacts?: (result: AgentRunResult) => Promise<void>
  scenarioCleanupTimeoutMs?: number
  now?: () => Date
}

const MAX_COMMAND_OUTPUT = 24_000

function boundedOutput(value: string): string {
  return value.length <= MAX_COMMAND_OUTPUT
    ? value
    : `${value.slice(0, MAX_COMMAND_OUTPUT)}\n[output truncated]`
}

function changedBetween(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort()
}

function isAllowedPath(path: string, suite: AgentSuite): boolean {
  const normalized = path.replaceAll("\\", "/")
  const matches = (prefix: string) =>
    normalized === prefix.replace(/\/$/, "") ||
    normalized.startsWith(`${prefix.replace(/\/$/, "")}/`)
  return suite.mutation.allowedPathPrefixes.some(matches) &&
    !suite.mutation.protectedPathPrefixes.some(matches)
}

function repairPrompt(
  suite: AgentSuite,
  iteration: AgentIteration,
  requestPath: string,
): string {
  return [
    `You are the constrained repair worker for UI Eval suite ${suite.id}.`,
    `Read the immutable repair request at ${requestPath}.`,
    "Inspect the referenced reports, candidate/reference/diff images, and source code.",
    `You may modify only these path prefixes: ${suite.mutation.allowedPathPrefixes.join(", ")}.`,
    `Never modify protected inputs: ${suite.mutation.protectedPathPrefixes.join(", ")}.`,
    "Do not weaken tests, policies, scenarios, references, thresholds, or readiness checks.",
    "Keep real API usage; do not introduce mocks or hard-coded production records.",
    "Make the smallest maintainable product fix, run relevant local checks, then stop.",
    `Current score: ${iteration.score.toFixed(6)}.`,
    `Repair progress: ${(iteration.progressScore ?? iteration.score).toFixed(6)}; acceptance still requires every declared check and scenario.`,
  ].join("\n")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function runAgentSuite(
  options: RunAgentOptions,
  dependencies: RunAgentDependencies = {},
): Promise<AgentRunResult> {
  const loaded = await loadAgentSuite(options.projectRoot, options.suite)
  if (loaded.value.executionProfile && options.executionProfile && loaded.value.executionProfile !== options.executionProfile) {
    throw new Error("Cannot override the suite's declared execution profile")
  }
  const profileId = loaded.value.executionProfile ?? options.executionProfile
  const suite = { ...loaded.value, scenarios: selectAgentScenarios(loaded.value, options.additionalScenarios, options.fullScope) }
  let remote = false
  if (profileId) {
    const project = await loadProjectConfig({ projectRoot: loaded.projectRoot })
    if (resolveExecutionProfile(project.value, profileId)?.config.mode === "remote") {
      remote = true
      if (options.repair === true) throw new Error("Remote evaluation does not authorize product repair")
      options = { ...options, repair: false }
    }
  }
  const evaluate = dependencies.evaluate ?? evaluateScenario
  const runCommand = dependencies.runCommand ?? defaultRunCommand
  const listChangedFiles = dependencies.listChangedFiles ?? defaultListChangedFiles
  const snapshotFiles = dependencies.snapshotFiles ?? defaultSnapshotFiles
  const writeSummaryArtifacts = dependencies.writeSummaryArtifacts ?? writeAgentSummaryArtifacts
  const scenarioCleanupTimeoutMs = dependencies.scenarioCleanupTimeoutMs ?? 15_000
  const now = dependencies.now ?? (() => new Date())
  const runId = `agent-${now().toISOString().replaceAll(/[:.]/g, "-")}`
  const root = resolve(loaded.projectRoot, ".ui-eval", "agent-runs", runId)
  let sourceSnapshot = await snapshotFiles(loaded.projectRoot)
  const iterations: AgentIteration[] = []
  let noImprovement = 0
  let bestProgress = -1
  let status: AgentStatus = "exhausted"
  let reason = `maximum iterations (${suite.maxIterations}) reached`
  let reusableScenarios = new Map<string, AgentScenarioResult>()

  for (let number = 1; number <= suite.maxIterations; number += 1) {
    options.onProgress?.(`Agent iteration ${number}/${suite.maxIterations}: checks`)
    const checks: AgentCheckResult[] = []
    for (const check of suite.checks) {
      const started = Date.now()
      const command = await runCommand(check.command, check.args, {
        cwd: loaded.projectRoot,
        timeoutMs: check.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      checks.push({
        id: check.id,
        passed: command.exitCode === 0,
        onFailure: check.onFailure ?? "repair",
        exitCode: command.exitCode,
        durationMs: Date.now() - started,
        output: boundedOutput(`${command.stdout}\n${command.stderr}`.trim()),
      })
    }

    const checksPassed = checks.every((check) => check.passed)
    const checkedSnapshot = await snapshotFiles(loaded.projectRoot)
    if (changedBetween(sourceSnapshot, checkedSnapshot).length > 0) reusableScenarios.clear()
    sourceSnapshot = checkedSnapshot
    const scenarios: AgentScenarioResult[] = []
    if (checksPassed) {
      options.onProgress?.(`Agent iteration ${number}/${suite.maxIterations}: scenarios`)
      for (const scenario of suite.scenarios) {
        const reusable = reusableScenarios.get(scenario.id)
        if (reusable) {
          scenarios.push(reusable)
          options.onProgress?.(
            `Agent iteration ${number}/${suite.maxIterations}: reusing ${scenario.id} evidence from iteration ${reusable.reusedFromIteration ?? number - 1}`,
          )
          continue
        }
        const deadline = AbortSignal.timeout(scenario.timeoutMs)
        const signal = options.signal
          ? AbortSignal.any([options.signal, deadline])
          : deadline
        const evaluateOptions: EvaluateScenarioOptions = {
          projectRoot: loaded.projectRoot,
          scenario: scenario.id,
          ...(profileId ? { executionProfile: profileId } : {}),
          ...(scenario.policy ? { policy: scenario.policy } : {}),
          ...(scenario.reference ? { referencePath: scenario.reference } : {}),
          ...(options.browserChannel ? { browserChannel: options.browserChannel } : {}),
          signal,
          onProgress: options.onProgress,
        }
        let timedOut = false
        const onDeadline = () => {
          timedOut = true
        }
        deadline.addEventListener("abort", onDeadline, { once: true })
        const deadlineFailure = new Promise<never>((_, reject) => {
          deadline.addEventListener(
            "abort",
            () => reject(new Error(`scenario deadline ${scenario.timeoutMs}ms`)),
            { once: true },
          )
        })
        const evaluation = evaluate(evaluateOptions)
        try {
          const result = await Promise.race([evaluation, deadlineFailure])
          scenarios.push(assessScenario(scenario, result.runs))
        } catch (error) {
          if (options.signal?.aborted) throw error
          let cleanupFailed = hasIncompleteCleanup(error)
          let cleanupSettled = !cleanupFailed
          if (timedOut) {
            cleanupSettled = false
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([
              evaluation.then(
                () => {
                  cleanupSettled = true
                },
                (cleanupError: unknown) => {
                  cleanupFailed = hasIncompleteCleanup(cleanupError)
                  cleanupSettled = !cleanupFailed
                },
              ),
              new Promise<void>((resolve) => {
                cleanupTimer = setTimeout(resolve, scenarioCleanupTimeoutMs)
              }),
            ])
            if (cleanupTimer) clearTimeout(cleanupTimer)
          }
          scenarios.push({
            id: scenario.id,
            accepted: false,
            score: 0,
            reports: [],
            cleanupSettled,
            reasons: [
              timedOut
                ? `evaluation deadline exceeded after ${scenario.timeoutMs}ms${cleanupSettled ? "; evaluator cleanup settled" : cleanupFailed ? "; evaluator cleanup incomplete" : `; evaluator cleanup exceeded ${scenarioCleanupTimeoutMs}ms`}`
                : `evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
          })
        } finally {
          deadline.removeEventListener("abort", onDeadline)
        }
        if (timedOut) break
      }
    } else {
      options.onProgress?.(
        `Agent iteration ${number}/${suite.maxIterations}: scenarios skipped because checks failed`,
      )
    }

    const dimensions = assessDimensions(suite, checks, scenarios)
    const score = Number(
      (
        dimensions.reduce((sum, dimension) => sum + dimension.score, 0) /
        dimensions.length
      ).toFixed(6),
    )
    const accepted =
      checksPassed &&
      scenarios.length === suite.scenarios.length &&
      scenarios.every((scenario) => scenario.accepted) &&
      dimensions.every((dimension) => dimension.status === "pass")
    const progressScore = repairProgress(suite, checks, scenarios)
    const currentFiles = await listChangedFiles(loaded.projectRoot)
    const iteration: AgentIteration = {
      iteration: number,
      score,
      progressScore,
      accepted,
      checks,
      scenarios,
      dimensions,
      changedFiles: currentFiles,
    }
    iterations.push(iteration)
    await writeJson(resolve(root, `iteration-${number}.json`), iteration)

    const blockingChecks = checks.filter(
      (check) => !check.passed && check.onFailure === "block",
    )
    if (blockingChecks.length > 0) {
      status = "blocked"
      reason = `non-repairable checks failed: ${blockingChecks.map((check) => check.id).join(", ")}`
      break
    }

    const unsettledCleanup = scenarios.filter((scenario) =>
      scenario.cleanupSettled === false,
    )
    if (unsettledCleanup.length > 0) {
      status = "blocked"
      reason = `evaluator cleanup did not settle: ${unsettledCleanup.map((scenario) => scenario.id).join(", ")}`
      break
    }

    const infrastructureFailure = scenarios.some(
      (scenario) =>
        !scenario.accepted &&
        (
          scenario.reports.length === 0 ||
          scenario.reports.some((report) => report.executionOutcome !== "valid" || report.rawStatus === "inconclusive")
        ),
    )

    if (accepted) {
      status = "accepted"
      reason = "all checks, hard gates, and predeclared thresholds passed"
      break
    }

    if (infrastructureFailure) {
      reusableScenarios = new Map(
        (remote ? [] : scenarios)
          .filter((scenario) => scenario.accepted)
          .map((scenario) => [
            scenario.id,
            {
              ...scenario,
              reusedFromIteration: scenario.reusedFromIteration ?? number,
            },
          ]),
      )
      if (number < suite.maxIterations) {
        options.onProgress?.(
          `Agent iteration ${number}/${suite.maxIterations}: infrastructure failure; retrying without product repair`,
        )
      }
      continue
    }

    reusableScenarios = new Map()

    const improvement = progressScore - bestProgress
    if (bestProgress >= 0 && (improvement <= 0 || improvement < suite.plateau.minScoreImprovement)) {
      noImprovement += 1
    } else {
      noImprovement = 0
      bestProgress = Math.max(bestProgress, progressScore)
    }
    if (noImprovement >= suite.plateau.maxConsecutiveNoImprovement) {
      status = "plateau"
      reason = `repair progress failed to improve by ${suite.plateau.minScoreImprovement} for ${noImprovement} iterations`
      break
    }
    if (number === suite.maxIterations) break
    if (options.repair === false || !suite.repair) {
      status = "blocked"
      reason = "repair is disabled or no repair adapter is configured"
      break
    }

    const requestPath = resolve(root, `repair-request-${number}.json`)
    iteration.repairRequestPath = requestPath
    await writeJson(requestPath, {
      apiVersion: "uieval.io/v1alpha1",
      kind: "RepairRequest",
      suite: suite.id,
      iteration: number,
      score,
      progressScore,
      checks,
      scenarios,
      mutation: suite.mutation,
      sourceStateDigest: createHash("sha256")
        .update(JSON.stringify([...sourceSnapshot].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)))
        .digest("hex"),
    })
    options.onProgress?.(`Agent iteration ${number}/${suite.maxIterations}: repair`)
    const repair = await runCommand(suite.repair.command, suite.repair.args, {
      cwd: loaded.projectRoot,
      input: repairPrompt(suite, iteration, requestPath),
      timeoutMs: suite.repair.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (repair.exitCode !== 0) {
      status = "blocked"
      reason = `repair adapter exited ${String(repair.exitCode)}: ${boundedOutput(repair.stderr)}`
      break
    }
    const afterRepairSnapshot = await snapshotFiles(loaded.projectRoot)
    const repairChanged = changedBetween(sourceSnapshot, afterRepairSnapshot)
    sourceSnapshot = afterRepairSnapshot
    const outOfScope = repairChanged.filter((path) => !isAllowedPath(path, suite))
    if (outOfScope.length > 0) {
      status = "blocked"
      reason = `repair modified protected or out-of-scope paths: ${outOfScope.join(", ")}`
      break
    }
    if (repairChanged.length > suite.mutation.maxChangedFiles) {
      status = "blocked"
      reason = `repair changed ${repairChanged.length} files; limit is ${suite.mutation.maxChangedFiles}`
      break
    }
  }

  const result: AgentRunResult = {
    suiteId: suite.id,
    scope: { requiredScenarioIds: loaded.value.scenarios.map(({ id }) => id), selectedScenarioIds: suite.scenarios.map(({ id }) => id),
      ...(profileId ? { executionProfile: profileId } : {}) },
    status,
    accepted: status === "accepted",
    iterations,
    summaryPath: resolve(root, "summary.json"),
    summaryHtmlPath: resolve(root, "summary.html"),
    generatedAt: now().toISOString(),
    reason,
  }
  assertSchema(AgentRunResultSchema, result)
  await writeSummaryArtifacts(result)
  return result
}
