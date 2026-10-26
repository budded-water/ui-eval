import { randomUUID } from "node:crypto"
import { resolve, relative } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { readIntegrationJson } from "../integration/config"
import { nativeIntegrationEvidence } from "../integration/native-evidence"
import { collectSourceRevision } from "../orchestrator/identity"
import { assertSafeSegment, atomicWriteFile, ensureContainedDirectory } from "../storage-local/filesystem"
import { containedPath } from "../wechat-pilot/config"
import { boundedFile } from "../wechat-pilot/evidence"
import { loadNativePilotProject, loadNativePilotScenario } from "./config"
import { NativePilotResultSchema, type NativePilotResult } from "./report"
import { NativeReviewResultSchema } from "./review"

const strict = { additionalProperties: false }
const id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" })
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
const reference = Type.String({ minLength: 1, maxLength: 1024 })
export const NativeProgressScopeSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/native-progress-v1"), kind: Type.Literal("NativeProgressScope"),
  projectId: id, deviceId: Type.String({ pattern: "^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$" }),
  scenarios: Type.Array(id, { minItems: 1, maxItems: 40, uniqueItems: true }),
  reports: Type.Array(Type.Object({ scenarioId: id, path: reference }, strict), { maxItems: 40 }),
  reviews: Type.Array(Type.Object({ reviewId: id, path: reference }, strict), { maxItems: 40 }),
}, strict)
export type NativeProgressScope = Static<typeof NativeProgressScopeSchema>
const state = Type.Union(["passed", "failed", "inconclusive", "pending", "stale", "invalid"].map((value) => Type.Literal(value)))
export const NativeProgressResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/native-progress-v1"), kind: Type.Literal("NativeProgressResult"),
  executionId: Type.String(), projectId: id, deviceId: Type.String(), scopeDigest: digest, sourceDigest: digest,
  status: Type.Union([Type.Literal("complete"), Type.Literal("pending"), Type.Literal("blocked")]),
  automatic: Type.Array(Type.Object({ id, state, nextAction: Type.String(), reportPath: Type.Optional(reference), evidenceDigest: Type.Optional(digest) }, strict)),
  human: Type.Array(Type.Object({ id, scenarioId: id, state, nextAction: Type.String(), observationDigest: Type.Optional(digest) }, strict)),
  limitations: Type.Array(Type.String()),
}, strict)
export type NativeProgressResult = Static<typeof NativeProgressResultSchema>

/** Offline projection over explicitly selected evidence. Never execute, retry or auto-select a passing run. */
export async function summarizeNativeProgress(options: { projectRoot: string; scope: string; signal?: AbortSignal }, source = collectSourceRevision) {
  const root = resolve(options.projectRoot)
  options.signal?.throwIfAborted()
  const input = await readIntegrationJson(root, options.scope)
  if (!Value.Check(NativeProgressScopeSchema, input)) throw new Error("Invalid native progress scope")
  const scope = input
  const project = await loadNativePilotProject(root)
  if (scope.projectId !== project.projectId || scope.scenarios.some((name) => !Object.hasOwn(project.scenarios, name))) throw new Error("Progress scope must select declared project scenarios")
  const criteria = (project.reviews ?? []).filter((review) => scope.scenarios.includes(review.scenarioId))
  if (new Set(scope.reports.map((item) => item.scenarioId)).size !== scope.reports.length || new Set(scope.reviews.map((item) => item.reviewId)).size !== scope.reviews.length ||
    scope.reports.some((item) => !scope.scenarios.includes(item.scenarioId)) || scope.reviews.some((item) => !criteria.some((review) => review.id === item.reviewId))) throw new Error("Progress selections must be unique and belong to the selected scope")
  const definitions = await Promise.all(scope.scenarios.map((name) => loadNativePilotScenario(root, project, name)))
  const scopeDigest = canonicalDigest({ scope, project, definitions })
  const sourceDigest = canonicalDigest(await source(root))
  const result: NativeProgressResult = {
    apiVersion: "uieval.io/native-progress-v1", kind: "NativeProgressResult", executionId: randomUUID(),
    projectId: project.projectId, deviceId: scope.deviceId, scopeDigest, sourceDigest, status: "pending", automatic: [], human: [],
    limitations: ["Covers only the explicitly selected scenarios and all their currently declared human criteria.", "Human observations are self-reported; this does not establish release, installed-binary, backend-state or real-device acceptance.", "No latest-run selection, device commands, retries or changes to original reports are performed."],
  }
  const reports = new Map<string, NativePilotResult>()
  const recheck: Array<() => Promise<void>> = []
  for (const name of scope.scenarios) {
    options.signal?.throwIfAborted()
    const entry: NativeProgressResult["automatic"][number] = { id: name, state: "pending", nextAction: "Run this declared scenario, then select its report in the scope." }
    result.automatic.push(entry)
    const selected = scope.reports.find((item) => item.scenarioId === name)
    if (!selected) continue
    try {
      const report = await readIntegrationJson(root, selected.path, 8 * 1024 * 1024)
      if (!Value.Check(NativePilotResultSchema, report) || report.projectId !== project.projectId || report.scenarioId !== name || report.device.id !== scope.deviceId) throw new Error("Foreign native evidence")
      entry.reportPath = relative(root, resolve(root, selected.path))
      if (report.sourceDigest !== sourceDigest) { entry.state = "stale"; entry.nextAction = "Capture this scenario for the current source; do not reuse the selected old result."; continue }
      const suite = { apiVersion: "uieval.io/integration-v1alpha1" as const, kind: "IntegrationSuite" as const, id: "native-progress", projectId: project.projectId, adapter: "native-pilot" as const, checks: [], scenarios: [{ id: name, timeoutMs: project.timeoutMs }] }
      const output = { result: report, reportPath: resolve(root, selected.path), htmlPath: resolve(root, selected.path, "../report.html") }
      const evidence = await nativeIntegrationEvidence(root, suite, name, output, sourceDigest, scope.deviceId)
      entry.evidenceDigest = canonicalDigest(evidence)
      recheck.push(async () => {
        if (canonicalDigest(await nativeIntegrationEvidence(root, suite, name, output, sourceDigest, scope.deviceId)) !== entry.evidenceDigest) throw new Error("Progress evidence changed during summarization")
      })
      reports.set(name, report)
      entry.state = report.status
      entry.nextAction = report.status === "passed" ? "Automatic evidence is valid; complete the declared human criteria." : report.status === "failed" ? "Inspect the failed assertion and available diagnostic; preserve this failed result." : "Restore prerequisites and capture this scenario again; do not infer a pass."
    } catch {
      entry.state = "invalid"; delete entry.evidenceDigest
      entry.nextAction = "Restore valid original source, plan, report and artifact evidence before using this result."
    }
  }
  for (const criterion of criteria) {
    const entry: NativeProgressResult["human"][number] = { id: criterion.id, scenarioId: criterion.scenarioId, state: "pending", nextAction: "Obtain valid passed automatic evidence, then record a separate human observation." }
    result.human.push(entry)
    const selected = scope.reviews.find((item) => item.reviewId === criterion.id)
    const automatic = result.automatic.find((item) => item.id === criterion.scenarioId)!
    if (!selected) {
      if (automatic.state === "passed") entry.nextAction = "Inspect the declared checkpoint and record an explicit human pass, fail or inconclusive observation."
      continue
    }
    try {
      const review = await readIntegrationJson(root, selected.path)
      if (!Value.Check(NativeReviewResultSchema, review) || review.projectId !== project.projectId || review.reviewId !== criterion.id || review.scenarioId !== criterion.scenarioId || review.checkpointId !== criterion.checkpointId || review.criterion !== criterion.criterion) throw new Error("Foreign human observation")
      assertSafeSegment(review.executionId, "review executionId")
      if (resolve(root, selected.path) !== resolve(root, ".ui-eval/native-reviews", review.executionId, "review.json")) throw new Error("Human observation path mismatch")
      if (review.sourceDigest !== sourceDigest) { entry.state = "stale"; entry.nextAction = "Review a current-source capture and record a new observation."; continue }
      const report = reports.get(criterion.scenarioId)
      const method = criterion.screenshotMethod ?? "maestro-take-screenshot"
      const images = method === "simctl" ? report?.supplementalScreenshots : report?.screenshots
      if (automatic.state !== "passed" || !report || (review.screenshotMethod ?? "maestro-take-screenshot") !== method ||
        review.reportDigest !== canonicalDigest(report) || review.screenshotDigest !== images?.find((shot) => shot.checkpointId === criterion.checkpointId)?.digest || resolve(root, review.reportPath) !== resolve(root, automatic.reportPath!)) throw new Error("Human observation is not bound to the selected passed capture")
      const htmlPath = relative(root, resolve(root, selected.path, "../review.html"))
      const html = await boundedFile(await containedPath(root, htmlPath), 1024 * 1024)
      if (!html.length) throw new Error("Missing human observation projection")
      entry.observationDigest = canonicalDigest(review)
      recheck.push(async () => {
        if (canonicalDigest(await readIntegrationJson(root, selected.path)) !== entry.observationDigest || !(await boundedFile(await containedPath(root, htmlPath), 1024 * 1024)).equals(html)) throw new Error("Human observation changed during summarization")
      })
      entry.state = ({ pass: "passed", fail: "failed", inconclusive: "inconclusive" } as const)[review.decision]
      entry.nextAction = review.decision === "pass" ? "No remaining action for this selected criterion."
        : review.decision === "fail" ? "Address the observed issue, capture again and record a new observation; retain this failure."
        : "Obtain usable checkpoint evidence, then record a new human observation; retain the original capture and this inconclusive observation."
    } catch {
      entry.state = "invalid"; entry.nextAction = "Select an intact human observation bound to this criterion and the selected passed capture."
    }
  }
  const states = [...result.automatic, ...result.human].map((entry) => entry.state)
  result.status = states.some((state) => state === "failed" || state === "invalid") ? "blocked" : states.every((state) => state === "passed") ? "complete" : "pending"
  for (const verify of recheck) { options.signal?.throwIfAborted(); await verify() }
  if (canonicalDigest(await source(root)) !== sourceDigest || canonicalDigest(await readIntegrationJson(root, options.scope)) !== canonicalDigest(scope) || canonicalDigest(await loadNativePilotProject(root)) !== canonicalDigest(project) || canonicalDigest(await Promise.all(scope.scenarios.map((name) => loadNativePilotScenario(root, project, name)))) !== canonicalDigest(definitions)) throw new Error("Native progress inputs changed during summarization")
  if (!Value.Check(NativeProgressResultSchema, result)) throw new Error("Invalid native progress result")
  options.signal?.throwIfAborted()
  const directory = resolve(root, ".ui-eval/native-progress", result.executionId)
  await ensureContainedDirectory(root, directory)
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
  const rows = (items: Array<{ id: string; state: string; nextAction: string }>) => items.map((item) => `<tr><td>${escape(item.id)}</td><td>${escape(item.state)}</td><td>${escape(item.nextAction)}</td></tr>`).join("")
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Native acceptance progress</title><h1>Native acceptance: ${result.status}</h1><p>Scope ${result.scopeDigest}; source ${result.sourceDigest}.</p><h2>Automatic evidence</h2><table><tr><th>Scenario</th><th>State</th><th>Next action</th></tr>${rows(result.automatic)}</table><h2>Human observations</h2><table><tr><th>Criterion</th><th>State</th><th>Next action</th></tr>${rows(result.human)}</table><ul>${result.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><a href="summary.json">Canonical progress JSON</a></html>\n`
  const reportPath = resolve(directory, "summary.json"), htmlPath = resolve(directory, "summary.html")
  await atomicWriteFile(htmlPath, Buffer.from(html))
  await atomicWriteFile(reportPath, Buffer.from(JSON.stringify(result, null, 2) + "\n"))
  options.signal?.throwIfAborted()
  return { result, reportPath, htmlPath }
}
