import { describe, expect, it } from "vitest"
import { canonicalDigest } from "../contracts/canonical-json"
import { assertVerificationPlan, type VerificationPlan, type VerificationEvidence } from "../contracts/verification"
import { assessVerification, assertVerificationRecord } from "./assess"

const source = canonicalDigest("candidate")
function fixture(platform: "web" | "ios-simulator" = "web") {
  const plan: VerificationPlan = {
    apiVersion: "uieval.io/verification-v1alpha1", kind: "VerificationPlan", id: "change", projectId: `${platform}-consumer`,
    outcome: "The user can select and preserve a preference", plannedAt: "2026-10-22T00:00:00.000Z", planningContext: "Before implementation",
    requirements: [{ id: "selection", category: "ui", rationale: "Reported interaction regression", expectedOutcome: "Selection persists after navigation",
      level: "L4", environment: { platform }, selector: { kind: "scenario", id: "selection" }, visualReview: false }],
    omissions: [{ scope: "Real external services", reason: "This scenario covers local state only" }],
  }
  const evidence: VerificationEvidence = { id: "run", projectId: plan.projectId, sourceDigest: source, level: "L4", environment: { platform },
    selector: { kind: "scenario", id: "selection" }, status: "pass", references: ["original-report"], origin: "validated-adapter" }
  return { plan, evidence }
}
describe("verification reconciliation", () => {
  it.each(["web", "ios-simulator"] as const)("reuses the same rules for a %s consumer", (platform) => {
    const { plan, evidence } = fixture(platform)
    expect(assessVerification(plan, source, [evidence])).toMatchObject({ exitCode: 0, conclusions: { ui: "pass", code: "not-assessed", release: "not-assessed" } })
  })
  it("retains an unmet real-device requirement despite a passing simulator flow", () => {
    const { plan, evidence } = fixture("ios-simulator")
    plan.requirements.push({ ...plan.requirements[0], id: "phone-network", level: "L5", environment: { platform: "physical-device" }, selector: { kind: "external", id: "phone-network" } })
    expect(assessVerification(plan, source, [evidence])).toMatchObject({ exitCode: 2, conclusions: { ui: "not-run" }, requirements: [{ status: "pass" }, { status: "not-run" }] })
  })
  it.each(["source", "project", "platform", "profile", "device", "variant", "level"])("does not accept %s mismatches", (defect) => {
    const { plan, evidence } = fixture()
    if (defect === "source") evidence.sourceDigest = canonicalDigest("older")
    if (defect === "project") evidence.projectId = "another"
    if (defect === "platform") evidence.environment.platform = "ios-simulator"
    if (defect === "profile") plan.requirements[0].environment.profile = "staging"
    if (defect === "device") plan.requirements[0].environment.deviceId = "device-a"
    if (defect === "variant") plan.requirements[0].environment.variantKey = "fr"
    if (defect === "level") evidence.level = "L2"
    expect(assessVerification(plan, source, [evidence])).toMatchObject({ exitCode: 2, requirements: [{ status: "invalid-evidence" }] })
  })
  it("preserves a failed observation when another matching run passed", () => {
    const { plan, evidence } = fixture()
    expect(assessVerification(plan, source, [evidence, { ...evidence, id: "failed", status: "fail" }])).toMatchObject({ exitCode: 1, conclusions: { ui: "fail" } })
  })
  it("requires visual review rather than inferring geometry from a driver pass", () => {
    const { plan, evidence } = fixture(); plan.requirements[0].visualReview = true
    expect(assessVerification(plan, source, [evidence])).toMatchObject({ exitCode: 3, conclusions: { ui: "needs-review" } })
  })
  it("does not let command success become runtime acceptance", () => {
    const { plan, evidence } = fixture(); evidence.origin = "declared-command"
    expect(assessVerification(plan, source, [evidence]).exitCode).toBe(2)
  })
  it("rejects duplicate requirements/evidence and malformed wire values", () => {
    const { plan, evidence } = fixture()
    expect(() => assessVerification(plan, source, [evidence, evidence])).toThrow("Duplicate")
    plan.requirements.push(plan.requirements[0]); expect(() => assertVerificationPlan(plan)).toThrow("Duplicate")
    expect(() => assertVerificationPlan({ ...plan, surprise: true })).toThrow()
  })
  it("round-trips canonical results and rejects a forged conclusion/digest", () => {
    const { plan, evidence } = fixture()
    const record = JSON.parse(JSON.stringify({ plan, evidence: [evidence], assessment: assessVerification(plan, source, [evidence]) }))
    assertVerificationRecord(record)
    record.assessment.conclusions.release = "pass"
    expect(() => assertVerificationRecord(record)).toThrow("contradicts")
    record.assessment = assessVerification(plan, source, [evidence]); record.plan.outcome = "changed"
    expect(() => assertVerificationRecord(record)).toThrow("contradicts")
  })
})
