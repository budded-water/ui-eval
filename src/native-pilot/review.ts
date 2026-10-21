import { randomUUID } from "node:crypto"
import { relative, resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { collectSourceRevision } from "../orchestrator/identity"
import { readIntegrationJson } from "../integration/config"
import { nativeIntegrationEvidence } from "../integration/native-evidence"
import { atomicWriteFile, ensureContainedDirectory } from "../storage-local/filesystem"
import { loadNativePilotProject } from "./config"
import { NativePilotResultSchema } from "./report"

const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
export const NativeReviewResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/native-review-v1"), kind: Type.Literal("NativeReviewResult"),
  executionId: Type.String(), projectId: Type.String(), reviewId: Type.String(), scenarioId: Type.String(),
  checkpointId: Type.String(), criterion: Type.String(),
  method: Type.Literal("human-observation"),
  decision: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  reviewerAlias: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
  note: Type.String({ minLength: 1, maxLength: 1000 }),
  sourceDigest: digest, reportDigest: digest, screenshotDigest: digest,
  reportPath: Type.String(), recordedAt: Type.String(),
}, { additionalProperties: false })
export type NativeReviewResult = Static<typeof NativeReviewResultSchema>
export interface NativeReviewOptions {
  projectRoot: string; report: string; review: string; decision: "pass" | "fail"; reviewer: string; note: string
}

/** Add a human observation without rewriting or waiving the automated result. */
export async function recordNativeReview(options: NativeReviewOptions, source = collectSourceRevision) {
  const root = resolve(options.projectRoot)
  const project = await loadNativePilotProject(root)
  const report = await readIntegrationJson(root, options.report, 8 * 1024 * 1024)
  if (!Value.Check(NativePilotResultSchema, report) || report.status !== "passed") throw new Error("Human review requires complete original native evidence; it cannot waive a failed or inconclusive run")
  const review = project.reviews?.find((review) => review.id === options.review && review.scenarioId === report.scenarioId)
  if (!review) throw new Error("Human review must be declared in the native project")
  const sourceDigest = canonicalDigest(await source(root))
  if (sourceDigest !== report.sourceDigest) throw new Error("Human review source differs from captured evidence")
  await nativeIntegrationEvidence(root, {
    apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: "human-review-evidence",
    projectId: project.projectId, adapter: "native-pilot", scenarios: [{ id: report.scenarioId, timeoutMs: project.timeoutMs }], checks: [],
  }, report.scenarioId, { result: report, reportPath: resolve(root, options.report), htmlPath: resolve(root, options.report, "../report.html") }, sourceDigest, report.device.id)
  const screenshot = report.screenshots.find((shot) => shot.checkpointId === review.checkpointId)
  if (!screenshot) throw new Error("Human review checkpoint evidence is missing")
  const result: NativeReviewResult = {
    apiVersion: "uieval.io/native-review-v1", kind: "NativeReviewResult", executionId: randomUUID(),
    projectId: project.projectId, reviewId: review.id, scenarioId: report.scenarioId, checkpointId: review.checkpointId,
    criterion: review.criterion, method: "human-observation", decision: options.decision,
    reviewerAlias: options.reviewer, note: options.note, sourceDigest, reportDigest: canonicalDigest(report),
    screenshotDigest: screenshot.digest, reportPath: relative(root, resolve(root, options.report)), recordedAt: new Date().toISOString(),
  }
  if (!Value.Check(NativeReviewResultSchema, result)) throw new Error("Invalid human review; use a local alias and a bounded synthetic-data note")
  if (canonicalDigest(await source(root)) !== sourceDigest) throw new Error("Candidate source changed during human review evidence validation")
  const directory = resolve(root, ".ui-eval/native-reviews", result.executionId)
  await ensureContainedDirectory(root, directory)
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Native human review</title><h1>${escape(result.reviewId)}: ${result.decision}</h1><p>Human observation by ${escape(result.reviewerAlias)}. This does not change automated acceptance or establish release readiness.</p><p>${escape(result.criterion)}</p><p>${escape(result.note)}</p><p>Evidence: ${escape(result.reportDigest)} / ${escape(result.screenshotDigest)}</p><a href="review.json">Canonical human observation</a></html>\n`
  const htmlPath = resolve(directory, "review.html"), reportPath = resolve(directory, "review.json")
  await atomicWriteFile(htmlPath, Buffer.from(html))
  await atomicWriteFile(reportPath, Buffer.from(`${JSON.stringify(result, null, 2)}\n`))
  return { result, reportPath, htmlPath }
}
