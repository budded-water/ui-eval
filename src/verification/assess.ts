import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { DigestSchema } from "../contracts/schemas"
import { isSchema } from "../contracts/validation"
import {
  assertVerificationPlan, VerificationEvidenceSchema, VerificationRecordSchema,
  type VerificationPlan, type VerificationEvidence, type VerificationAssessment,
  type VerificationRecord, type VerificationEnvironment,
} from "../contracts/verification"

type Status = VerificationAssessment["conclusions"]["ui"]
const precedence: Status[] = ["invalid-evidence", "inconclusive", "not-run", "fail", "needs-review", "pass"]
function combine(statuses: Status[]): Status {
  return statuses.length ? precedence.find((status) => statuses.includes(status))! : "not-assessed"
}
function matches(expected: VerificationEnvironment, actual: VerificationEnvironment): boolean {
  return (Object.keys(expected) as Array<keyof VerificationEnvironment>).every((key) => expected[key] === actual[key])
}

/** Pure assessment of already validated observations. This API does not attest input truth. */
export function assessVerification(plan: VerificationPlan, sourceDigest: string, evidence: readonly VerificationEvidence[]): VerificationAssessment {
  assertVerificationPlan(plan)
  if (!Value.Check(DigestSchema, sourceDigest) || evidence.length > 2000 || evidence.some((item) => !Value.Check(VerificationEvidenceSchema, item))) throw new Error("Invalid verification evidence")
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) throw new Error("Duplicate verification evidence")
  const requirements = plan.requirements.map((requirement) => {
    const selected = evidence.filter((item) => item.selector.kind === requirement.selector.kind && item.selector.id === requirement.selector.id)
    const applicable = selected.filter((item) => item.projectId === plan.projectId && item.sourceDigest === sourceDigest &&
      item.level === requirement.level && matches(requirement.environment, item.environment))
    const reasons: string[] = []
    let status: Status
    if (!selected.length) {
      status = "not-run"; reasons.push("No evidence for the required check/scenario")
    } else if (!applicable.length) {
      status = "invalid-evidence"; reasons.push("Evidence does not match required project, source, level or environment")
    } else {
      status = combine(applicable.map((item) => item.status))
      // A command exit is never runtime UI, real-device or visual acceptance.
      if (applicable.some((item) => item.origin === "declared-command") && ["L4", "L5"].includes(requirement.level)) {
        status = "invalid-evidence"; reasons.push("Command evidence cannot establish runtime UI acceptance")
      }
      if (status === "pass" && requirement.visualReview) {
        status = "needs-review"; reasons.push("Visual inspection is required; driver success alone does not establish it")
      }
      if (status !== "pass" && !reasons.length) reasons.push("Required evidence has not passed")
    }
    return { id: requirement.id, status, evidenceIds: applicable.map((item) => item.id), reasons }
  })
  const conclusion = (category: "code" | "ui" | "release") => combine(requirements.filter((_, index) => plan.requirements[index].category === category).map((item) => item.status))
  const status = combine(requirements.map((item) => item.status))
  const exitCode = ["invalid-evidence", "inconclusive", "not-run"].includes(status) ? 2 : status === "fail" ? 1 : status === "needs-review" ? 3 : 0
  return { planDigest: canonicalDigest(plan), sourceDigest, requirements, conclusions: { code: conclusion("code"), ui: conclusion("ui"), release: conclusion("release") }, exitCode }
}

export function assertVerificationRecord(input: unknown): asserts input is VerificationRecord {
  if (!isSchema(VerificationRecordSchema, input)) throw new Error("Invalid verification record")
  const expected = assessVerification(input.plan, input.assessment.sourceDigest, input.evidence)
  if (canonicalDigest(expected) !== canonicalDigest(input.assessment)) throw new Error("Verification assessment contradicts its plan/evidence")
}
