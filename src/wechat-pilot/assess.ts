import { randomUUID } from "node:crypto"
import { relative, resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { assertVerificationPlan, type VerificationEvidence } from "../contracts/verification"
import { assessVerification, assertVerificationRecord } from "../verification/assess"
import { readIntegrationJson } from "../integration/config"
import { collectSourceRevision, type GitRunner } from "../orchestrator/identity"
import { atomicWriteFile, ensureContainedDirectory } from "../storage-local/filesystem"
import { verifyWechatReport, verifyWechatReview, WechatReviewResultSchema } from "./review"

export const WechatAssessmentScopeSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/wechat-assessment-v1"), kind: Type.Literal("WechatAssessmentScope"),
  verificationPlan: Type.String({ pattern: "^ui-eval/", maxLength: 512 }),
  reports: Type.Array(Type.String({ pattern: "^\\.ui-eval/wechat-runs/", maxLength: 1024 }), { minItems: 1, maxItems: 100 }),
  reviews: Type.Array(Type.String({ pattern: "^\\.ui-eval/wechat-reviews/", maxLength: 1024 }), { maxItems: 100 }),
}, { additionalProperties: false })
export type WechatAssessmentScope = Static<typeof WechatAssessmentScopeSchema>

export async function assessWechatScope(options: { projectRoot: string; scope: string }, source = collectSourceRevision, git?: GitRunner) {
  const root = resolve(options.projectRoot), sourceDigest = canonicalDigest(await source(root))
  const scope = await readIntegrationJson(root, options.scope)
  if (!Value.Check(WechatAssessmentScopeSchema, scope)) throw new Error("Invalid WeChat assessment scope")
  // The verification plan must participate in the captured source identity.
  const { execFile } = await import("node:child_process")
  const tracked = git ?? ((args: readonly string[], cwd: string) => new Promise<string>((done, reject) => execFile("git", [...args], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : done(stdout))))
  if ((await tracked(["ls-files", "--error-unmatch", "--", scope.verificationPlan], root)).trim() !== scope.verificationPlan) throw new Error("Verification plan must be tracked in captured source")
  const plan = await readIntegrationJson(root, scope.verificationPlan)
  assertVerificationPlan(plan)
  if (new Set(scope.reports).size !== scope.reports.length || new Set(scope.reviews).size !== scope.reviews.length) throw new Error("Duplicate assessment inputs")
  const evidence: VerificationEvidence[] = [], used = new Set<string>()
  const reviewBytes = await Promise.all(scope.reviews.map(async (path) => {
    const value = await readIntegrationJson(root, path)
    if (!Value.Check(WechatReviewResultSchema, value)) throw new Error("Invalid WeChat review receipt")
    return { path, value }
  }))
  for (const path of scope.reports) {
    const { report } = await verifyWechatReport(root, path, sourceDigest)
    if (report.projectId !== plan.projectId) throw new Error("Assessment project differs from captured evidence")
    const visualReviews: NonNullable<VerificationEvidence["visualReviews"]> = []
    const references = [path]
    for (const input of reviewBytes) {
      if (input.value.reportDigest !== canonicalDigest(report)) continue
      const review = await verifyWechatReview(root, input.path, report)
      visualReviews.push({ id: review.reviewId, decision: review.decision, receiptDigest: canonicalDigest(review) })
      used.add(input.path)
      references.push(input.path)
    }
    if (new Set(visualReviews.map((review) => review.id)).size !== visualReviews.length) throw new Error("Conflicting observations for one criterion require an explicit scope choice")
    evidence.push({ id: report.executionId, projectId: report.projectId, sourceDigest, level: "L4",
      environment: { platform: "wechat-devtools", variantKey: "wechat-devtools" }, selector: { kind: "scenario", id: report.scenarioId },
      status: { passed: "pass", failed: "fail", inconclusive: "inconclusive" }[report.status] as VerificationEvidence["status"],
      references, origin: "validated-adapter", ...(visualReviews.length ? { visualReviews } : {}),
    })
  }
  if (used.size !== scope.reviews.length) throw new Error("Assessment contains an unbound or invalid review")
  const record = { plan, evidence, assessment: assessVerification(plan, sourceDigest, evidence) }
  assertVerificationRecord(record)
  if (canonicalDigest(await source(root)) !== sourceDigest) throw new Error("Source changed during assessment")
  const directory = resolve(root, ".ui-eval/wechat-assessments", randomUUID())
  await ensureContainedDirectory(root, directory)
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>WeChat scoped verification</title><h1>${escape(plan.outcome)}</h1><p>Code: ${record.assessment.conclusions.code}; UI: ${record.assessment.conclusions.ui}; release: ${record.assessment.conclusions.release}</p><ul>${record.assessment.requirements.map((item) => `<li>${escape(item.id)}: ${item.status}</li>`).join("")}</ul><p>Declared scope only. No GPS, physical-device, release authority or authenticated reviewer identity is implied.</p><a href="assessment.json">Canonical verification</a></html>\n`
  const reportPath = resolve(directory, "assessment.json"), htmlPath = resolve(directory, "assessment.html")
  await atomicWriteFile(htmlPath, Buffer.from(html)); await atomicWriteFile(reportPath, Buffer.from(JSON.stringify(record, null, 2) + "\n"))
  return { record, reportPath: relative(root, reportPath), htmlPath: relative(root, htmlPath) }
}
