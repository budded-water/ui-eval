import { randomUUID } from "node:crypto"
import { relative, resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { collectSourceRevision } from "../orchestrator/identity"
import { readIntegrationJson } from "../integration/config"
import { wechatIntegrationEvidence } from "../integration/evidence"
import { atomicWriteFile, ensureContainedDirectory } from "../storage-local/filesystem"
import { CheckpointReviewFields } from "../verification/checkpoint-review"
import { containedPath, loadWechatProject } from "./config"
import { boundedFile } from "./evidence"
import { renderWechatReport, WechatPilotResultSchema, type WechatPilotResult } from "./report"

export const WechatReviewResultSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/wechat-review-v1"), kind: Type.Literal("WechatReviewResult"), ...CheckpointReviewFields,
}, { additionalProperties: false })
export type WechatReviewResult = Static<typeof WechatReviewResultSchema>
export interface WechatReviewOptions {
  projectRoot: string; report: string; review: string; decision: WechatReviewResult["decision"]; reviewer: string; note: string
}

function renderReview(result: WechatReviewResult) {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>WeChat visual observation</title><h1>${escape(result.reviewId)}: ${result.decision}</h1><p>${escape(result.criterion)}</p><p>${escape(result.note)}</p><p>Human observation by ${escape(result.reviewerAlias)}. Original automated result is unchanged. This is not physical GPS, permission, tile-coverage or release acceptance.</p><p>Captured image: ${escape(result.screenshotDigest)}</p><a href="review.json">Canonical observation</a></html>\n`
}

export async function verifyWechatReport(root: string, reference: string, sourceDigest: string) {
  const project = await loadWechatProject(root)
  const report = await readIntegrationJson(root, reference, 8 * 1024 * 1024)
  if (!Value.Check(WechatPilotResultSchema, report)) throw new Error("Invalid original WeChat report")
  await wechatIntegrationEvidence(root, {
    apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: "wechat-review-evidence", projectId: project.projectId,
    adapter: "wechat-pilot", scenarios: [{ id: report.scenarioId, timeoutMs: project.timeoutMs }], checks: [],
  }, report.scenarioId, { result: report, reportPath: resolve(root, reference), htmlPath: resolve(root, reference, "../report.html") }, sourceDigest)
  const html = await boundedFile(await containedPath(root, relative(root, resolve(root, reference, "../report.html"))), 8 * 1024 * 1024)
  if (html.toString("utf8") !== renderWechatReport(report)) throw new Error("Original WeChat JSON/HTML pair differs")
  return { project, report }
}

export async function recordWechatReview(options: WechatReviewOptions, source = collectSourceRevision) {
  const root = resolve(options.projectRoot), sourceDigest = canonicalDigest(await source(root))
  const { project, report } = await verifyWechatReport(root, options.report, sourceDigest)
  if (report.status !== "passed") throw new Error("Human observation cannot waive failed or inconclusive WeChat execution")
  const criterion = project.reviews?.find((review) => review.id === options.review && review.scenarioId === report.scenarioId)
  const screenshot = report.screenshots.find((shot) => shot.checkpointId === criterion?.checkpointId)
  if (!criterion || !screenshot) throw new Error("Review must identify a declared criterion and captured checkpoint")
  const result: WechatReviewResult = {
    apiVersion: "uieval.io/wechat-review-v1", kind: "WechatReviewResult", executionId: randomUUID(), projectId: project.projectId,
    reviewId: criterion.id, scenarioId: report.scenarioId, checkpointId: criterion.checkpointId, criterion: criterion.criterion,
    method: "human-observation", decision: options.decision, reviewerAlias: options.reviewer, note: options.note,
    sourceDigest, reportDigest: canonicalDigest(report), screenshotDigest: screenshot.digest,
    reportPath: relative(root, resolve(root, options.report)), recordedAt: new Date().toISOString(),
  }
  if (!Value.Check(WechatReviewResultSchema, result)) throw new Error("Invalid bounded human observation")
  if (canonicalDigest(await source(root)) !== sourceDigest) throw new Error("Source changed during review validation")
  const directory = resolve(root, ".ui-eval/wechat-reviews", result.executionId)
  await ensureContainedDirectory(root, directory)
  const reportPath = resolve(directory, "review.json"), htmlPath = resolve(directory, "review.html")
  await atomicWriteFile(htmlPath, Buffer.from(renderReview(result))); await atomicWriteFile(reportPath, Buffer.from(JSON.stringify(result, null, 2) + "\n"))
  return { result, reportPath, htmlPath }
}

/** Called only after the original report/PNG pair has been independently revalidated. */
export async function verifyWechatReview(root: string, reference: string, report: WechatPilotResult) {
  const review = await readIntegrationJson(root, reference)
  if (!Value.Check(WechatReviewResultSchema, review)) throw new Error("Invalid WeChat review receipt")
  if (!/^[a-f0-9-]{36}$/.test(review.executionId) || resolve(root, reference) !== resolve(root, ".ui-eval/wechat-reviews", review.executionId, "review.json")) throw new Error("Review path differs from its execution identity")
  const project = await loadWechatProject(root)
  const criterion = project.reviews?.find((item) => item.id === review.reviewId && item.scenarioId === report.scenarioId)
  const image = report.screenshots.find((shot) => shot.checkpointId === criterion?.checkpointId)
  const expectedReport = relative(root, resolve(root, ".ui-eval/wechat-runs", report.executionId, "report.json"))
  if (report.status !== "passed" || review.projectId !== report.projectId || review.scenarioId !== report.scenarioId ||
    review.sourceDigest !== report.sourceDigest || review.reportDigest !== canonicalDigest(report) || review.reportPath !== expectedReport ||
    !criterion || review.criterion !== criterion.criterion || review.checkpointId !== criterion.checkpointId || image?.digest !== review.screenshotDigest) throw new Error("Human observation differs from its declared source/report/image/criterion")
  const html = await boundedFile(await containedPath(root, relative(root, resolve(root, reference, "../review.html"))), 1024 * 1024)
  if (html.toString("utf8") !== renderReview(review)) throw new Error("Review JSON/HTML pair differs")
  return review
}
