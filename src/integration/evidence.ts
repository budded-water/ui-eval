import { relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { Value } from "@sinclair/typebox/value"
import { canonicalDigest } from "../contracts/canonical-json"
import { validateCaptureBundle, validateEvaluationPlan, validateEvaluationPolicy, validateEvaluationReport, validateSealedRunManifest } from "../contracts/validation"
import { assertCaptureContract } from "../orchestrator/capture-contract"
import { normalizedCandidateEvidenceDigest } from "../orchestrator/evidence-digest"
import type { ArtifactRef } from "../contracts/model"
import { loadProjectConfig, loadScenarioSource } from "../project/config"
import { resolveExecutionProfile } from "../project/execution-profile"
import { compileScenario } from "../manifest-compiler/compiler"
import { LocalArtifactStore, DEFAULT_LOCAL_ARTIFACT_STORE_ID } from "../storage-local/artifact-store"
import { PLAYWRIGHT_CAPTURE_CAPABILITIES, PLAYWRIGHT_CAPTURE_ADAPTER_ID, PLAYWRIGHT_CAPTURE_ADAPTER_VERSION } from "../capture-playwright/adapter"
import { evaluationExitCode } from "../cli/exit-code"
import { reportCapabilities } from "../report-html/capabilities"
import { assertSafeSegment } from "../storage-local/filesystem"
import { IncompleteCleanupError } from "../runtime/cleanup"
import type { EvaluateScenarioResult } from "../orchestrator/evaluate"
import { containedPath, loadWechatProject, loadWechatScenario } from "../wechat-pilot/config"
import { WechatPilotResultSchema } from "../wechat-pilot/report"
import { boundedFile, inspectWechatPng } from "../wechat-pilot/evidence"
import type { evaluateWechatPilot } from "../wechat-pilot/run"
import type { IntegrationSuite } from "./config"
import { readIntegrationJson } from "./config"
import type { IntegrationStage } from "./model"

export const statusForExit = (code: number): IntegrationStage["status"] =>
  ({ 0: "pass", 1: "fail", 3: "needs-review" } as Record<number, IntegrationStage["status"]>)[code] ?? "inconclusive"

async function reportPair(root: string, directory: string, jsonPath: string, htmlPath: string) {
  if (jsonPath !== resolve(directory, "report.json") || htmlPath !== resolve(directory, "report.html")) throw new Error("Adapter report paths are not bound to their execution")
  const html = await containedPath(root, relative(root, htmlPath))
  const metadata = await lstat(html)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > 8 * 1024 * 1024) throw new Error("Required HTML report is unavailable or invalid")
  return { json: await readIntegrationJson(root, relative(root, jsonPath), 8 * 1024 * 1024),
    htmlDigest: `sha256:${createHash("sha256").update(await boundedFile(html, 8 * 1024 * 1024)).digest("hex")}` }
}

export async function webIntegrationEvidence(root: string, suite: IntegrationSuite, scenarioId: string, output: EvaluateScenarioResult, sourceDigest: string): Promise<IntegrationStage["reports"]> {
  if (output.projectId !== suite.projectId || output.scenarioId !== scenarioId || !output.runs.length) throw new Error("Adapter returned empty or foreign scenario results")
  const project = await loadProjectConfig({ projectRoot: root })
  if (project.value.projectId !== suite.projectId) throw new Error("Integration project differs from capture configuration")
  const source = await loadScenarioSource(project, `scenarios/${scenarioId}.json`)
  if (source.value.id !== scenarioId) throw new Error("Scenario file does not match integration scope")
  const artifactRoot = resolve(root, project.value.artifactRoot ?? ".ui-eval")
  const store = new LocalArtifactStore({ root: artifactRoot, projectId: suite.projectId, storeId: DEFAULT_LOCAL_ARTIFACT_STORE_ID })
  const profile = resolveExecutionProfile(project.value, suite.executionProfile)
  const plans = await compileScenario(source, project, {
    availableCapabilities: PLAYWRIGHT_CAPTURE_CAPABILITIES,
    artifactMaterializer: { put: (value, options) => store.referenceExisting(value, options) },
    ...(profile ? { baseUrlOverride: profile.baseUrl } : {}),
  })
  const expected = new Set(plans.map((plan) => plan.variant.variantKey))
  if (output.runs.length !== expected.size || new Set(output.runs.map((run) => run.executionId)).size !== output.runs.length) throw new Error("Adapter returned incomplete or duplicate variants")
  const reports: IntegrationStage["reports"] = []
  for (const run of output.runs) {
    assertSafeSegment(run.executionId, "executionId")
    if (!expected.delete(run.variantKey)) throw new Error("Unexpected or duplicate variant")
    const directory = resolve(artifactRoot, "runs", run.executionId)
    const pair = await reportPair(root, directory, run.reportPath, run.htmlPath)
    const report = validateEvaluationReport(pair.json)
    if (canonicalDigest(report) !== canonicalDigest(run.report) || report.metadata.projectId !== suite.projectId ||
      report.metadata.id !== `report-${run.executionId}` || report.spec.inputs.scenarioDigest !== source.digest ||
      canonicalDigest(report.spec.inputs.sourceRevision) !== sourceDigest ||
      run.executionOutcome !== report.spec.executionOutcome || run.rawStatus !== report.spec.rawStatus) throw new Error("Adapter result contradicts its canonical report or source")
    const json = (name: string) => readIntegrationJson(root, relative(root, resolve(directory, name)), 8 * 1024 * 1024)
    const capture = validateCaptureBundle(await json("capture.json"))
    const manifest = validateSealedRunManifest(await json("run-manifest.json"))
    const evaluation = validateEvaluationPlan(await json("evaluation-plan.json"))
    const policy = validateEvaluationPolicy(await json("policy.json"))
    const plan = plans.find((entry) => entry.variant.variantKey === run.variantKey)!
    if (capture.metadata.projectId !== suite.projectId || capture.metadata.id !== `capture-${run.executionId}` ||
      manifest.executionId !== run.executionId || manifest.scenarioPlanDigest !== plan.planDigest ||
      canonicalDigest(manifest.sourceRevision) !== sourceDigest ||
      capture.metadata.specDigest !== report.spec.inputs.candidateCaptureDigest ||
      policy.metadata.projectId !== suite.projectId || policy.metadata.specDigest !== report.spec.inputs.policyDigest ||
      evaluation.evaluationId !== `evaluation-${run.executionId}` || evaluation.evaluationKey !== report.spec.evaluationKey ||
      evaluation.candidate.captureBundleDigest !== capture.metadata.specDigest ||
      evaluation.candidate.normalizedCandidateEvidenceDigest !== report.spec.inputs.normalizedCandidateEvidenceDigest ||
      evaluation.policy.policyDigest !== policy.metadata.specDigest ||
      normalizedCandidateEvidenceDigest(capture.spec, {
        includeScreenshot: suite.scenarios.find((entry) => entry.id === scenarioId)?.reference !== undefined,
        includeGeometry: report.spec.provenance.evaluators.some((entry) => entry.id === "geometry"),
      }) !== report.spec.inputs.normalizedCandidateEvidenceDigest) throw new Error("Report is not bound to its persisted capture and evaluation inputs")
    assertCaptureContract({ capture: capture.spec, plan, context: {
      executionId: run.executionId, runManifestDigest: canonicalDigest(manifest), captureKey: manifest.captureKey,
      sourceRevision: manifest.sourceRevision, build: manifest.build,
    }, expectedAdapter: { id: PLAYWRIGHT_CAPTURE_ADAPTER_ID, version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
      platform: "web", capabilities: PLAYWRIGHT_CAPTURE_CAPABILITIES,
      browserOrDevice: suite.browserChannel ? `chromium:${suite.browserChannel}` : "chromium:playwright",
    } })
    const artifacts = [
      ...capture.spec.checkpoints.flatMap((checkpoint) => checkpoint.evidence.flatMap((record) => record.artifact ? [record.artifact] : [])),
      ...policy.spec.evaluators.map((entry) => entry.configRef),
      ...report.spec.findings.flatMap((finding) => finding.evidence),
    ]
    for (const ref of artifacts) {
      // Schema validation above verifies the digest shape; the store verifies
      // project/store scope, containment, size, bytes and sensitivity metadata.
      await store.resolve({ ...ref, digest: ref.digest as `sha256:${string}` } satisfies ArtifactRef)
    }
    reports.push({ executionId: run.executionId, variantKey: run.variantKey,
      status: statusForExit(evaluationExitCode(report.spec)), reportPath: relative(root, run.reportPath), htmlPath: relative(root, run.htmlPath),
      reportDigest: canonicalDigest(report), htmlDigest: pair.htmlDigest,
      capabilities: reportCapabilities(report.spec).map((capability) => ({ ...capability, detail: capability.detail ?? "" })),
    })
  }
  return reports
}

export async function wechatIntegrationEvidence(root: string, suite: IntegrationSuite, scenarioId: string, output: Awaited<ReturnType<typeof evaluateWechatPilot>>, sourceDigest: string): Promise<IntegrationStage["reports"]> {
  const result = output.result
  assertSafeSegment(result.executionId, "executionId")
  const pair = await reportPair(root, resolve(root, ".ui-eval/wechat-runs", result.executionId), output.reportPath, output.htmlPath)
  const persisted = pair.json
  if (!Value.Check(WechatPilotResultSchema, persisted) || canonicalDigest(persisted) !== canonicalDigest(result) ||
    result.projectId !== suite.projectId || result.scenarioId !== scenarioId || result.sourceDigest !== sourceDigest) throw new Error("WeChat result is foreign or contradicts its canonical report")
  if (result.cleanup !== "completed") throw new IncompleteCleanupError("WeChat runtime cleanup is incomplete")
  const project = await loadWechatProject(root)
  const scenario = await loadWechatScenario(root, project, scenarioId)
  if (project.projectId !== suite.projectId || result.planDigest !== canonicalDigest({ project, scenario })) throw new Error("WeChat result does not match the declared plan")
  if (result.status === "passed") {
    const checkpoints = scenario.steps.flatMap((step) => step.action === "screenshot" ? [step.checkpointId] : [])
    if (result.cleanup !== "completed" || result.steps.length !== scenario.steps.length ||
      result.steps.some((step, index) => step.index !== index || step.action !== scenario.steps[index].action || step.status !== "passed") ||
      result.assertions.failed !== 0 || result.assertions.passed !== scenario.steps.filter((step) => ["assertText", "assertPage"].includes(step.action)).length ||
      result.screenshots.length !== checkpoints.length || new Set(result.screenshots.map((shot) => shot.checkpointId)).size !== checkpoints.length) throw new Error("WeChat pass is missing declared evidence")
    for (const shot of result.screenshots) {
      if (!checkpoints.includes(shot.checkpointId)) throw new Error("Unexpected WeChat checkpoint")
      const path = await containedPath(root, relative(root, resolve(root, ".ui-eval/wechat-runs", result.executionId, shot.path)))
      const png = inspectWechatPng(await boundedFile(path))
      if (png.digest !== shot.digest || png.width !== shot.widthPx || png.height !== shot.heightPx) throw new Error("WeChat screenshot does not match its report")
    }
  }
  return [{ executionId: result.executionId, variantKey: "wechat-devtools", status: statusForExit({ passed: 0, failed: 1, inconclusive: 2 }[result.status]),
    reportPath: relative(root, output.reportPath), htmlPath: relative(root, output.htmlPath),
    reportDigest: canonicalDigest(result), htmlDigest: pair.htmlDigest,
    capabilities: [
      { dimension: "Declared interaction / screenshots", status: result.status === "inconclusive" ? "unknown" : "measured", detail: "Experimental WeChat DevTools evidence only." },
      { dimension: "Runtime / network / design / real device", status: "unsupported", detail: "These gates are not executed by this pilot." },
    ],
  }]
}
