import { canonicalDigest } from "../contracts/canonical-json"
import { assertVerificationPlan, type VerificationPlan, type VerificationRecord, type VerificationEvidence } from "../contracts/verification"
import { assessVerification } from "../verification/assess"
import { readIntegrationJson, type IntegrationSuite } from "./config"
import type { IntegrationResult } from "./model"

export async function loadVerificationPlan(root: string, suite: IntegrationSuite): Promise<VerificationPlan | undefined> {
  if (!suite.verificationPlan) return undefined
  const input = await readIntegrationJson(root, suite.verificationPlan)
  assertVerificationPlan(input)
  if (input.projectId !== suite.projectId) throw new Error("Verification plan belongs to another project")
  return input
}

export function integrationVerificationSource(result: IntegrationResult): string {
  return result.sourceDigest ?? canonicalDigest({ sourceUnavailable: true })
}

/** Derive observations only from this invocation's validated stages, never from plan claims. */
export function integrationVerification(suite: IntegrationSuite, result: IntegrationResult, plan: VerificationPlan): VerificationRecord {
  const sourceDigest = integrationVerificationSource(result)
  const evidence: VerificationEvidence[] = []
  const sound = ["engine-before", "source-before", "source-after", "engine-after", "evidence-after"].every((id) =>
    result.stages.some((stage) => stage.id === id && stage.status === "pass")) &&
    result.stages.filter((stage) => !["scenario", "check"].includes(stage.kind)).every((stage) => stage.status === "pass" && stage.cleanupSettled !== false)
  const platform = suite.adapter === "native-pilot" ? "ios-simulator" : suite.adapter === "wechat-pilot" ? "wechat-devtools" : "web"
  if (result.sourceDigest) for (const stage of result.stages) {
    if (stage.kind === "check") {
      const config = suite.checks.find((check) => check.id === stage.id)
      if (!config?.verificationLevel) continue
      evidence.push({ id: `check:${stage.id}`, projectId: result.projectId, sourceDigest,
        level: config.verificationLevel, environment: { platform: "host" }, selector: { kind: "check", id: stage.id },
        status: sound ? stage.status : "inconclusive", references: [result.summaryPath], origin: "declared-command" })
    }
    if (stage.kind === "scenario") for (const report of stage.reports) evidence.push({
      id: `scenario:${stage.id}:${report.variantKey}`, projectId: result.projectId, sourceDigest, level: "L4",
      environment: { platform, variantKey: report.variantKey,
        ...(result.executionProfile ? { profile: result.executionProfile } : {}), ...(result.deviceId ? { deviceId: result.deviceId } : {}) },
      selector: { kind: "scenario", id: stage.id }, status: sound ? report.status : "inconclusive",
      references: [report.reportPath, report.htmlPath], origin: "validated-adapter",
    })
  }
  return { plan, evidence, assessment: assessVerification(plan, sourceDigest, evidence) }
}

/** Retain infrastructure precedence without turning incomplete acceptance into success. */
export function verificationExitCode(execution: 0 | 1 | 2 | 3, assessment: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  if (execution === 2 || assessment === 2) return 2
  if (execution === 1 || assessment === 1) return 1
  if (execution === 3 || assessment === 3) return 3
  return 0
}

/** Check aggregate self-consistency; original evidence validation still belongs to the runner. */
export function assertIntegrationVerification(result: IntegrationResult): void {
  if (!result.verification) return
  const checks: IntegrationSuite["checks"] = result.verification.evidence.filter((item) => item.origin === "declared-command").map((item) => {
    if (!["L1", "L2", "L3"].includes(item.level)) throw new Error("Invalid command evidence level")
    return { id: item.selector.id, phase: "before", dimension: "declared", failureOutcome: "candidate",
      command: "declared", args: [], timeoutMs: 1, verificationLevel: item.level as "L1" | "L2" | "L3" }
  })
  const suite: IntegrationSuite = { apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite", id: result.suiteId,
    projectId: result.projectId, adapter: result.adapter, checks, scenarios: [] }
  const expected = integrationVerification(suite, result, result.verification.plan)
  if (canonicalDigest(expected) !== canonicalDigest(result.verification)) throw new Error("Verification evidence contradicts integration stages")
}
