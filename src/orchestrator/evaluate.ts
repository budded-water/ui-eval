import { createHash, randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { LaunchOptions } from "playwright"

import {
  PLAYWRIGHT_CAPTURE_ADAPTER_ID,
  PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
  PLAYWRIGHT_CAPTURE_CAPABILITIES,
  captureWebScenario,
  type CaptureWebScenarioContext,
} from "../capture-playwright/adapter"
import {
  BinaryEvidenceValidationError,
  inspectPngHeader,
  readBoundedEvidenceFile,
} from "../capture-playwright/binary-evidence"
import { sanitizeAssertionMetric } from "../capture-playwright/evidence"
import {
  canonicalDigest,
  DigestExclusionProfiles,
} from "../contracts/canonical-json"
import type {
  ArtifactRef,
  AssertionResult,
  AssertionSpec,
  CaptureBundle,
  CaptureBundleSpec,
  CaptureCapability,
  ContractMetadata,
  EvaluationPlan,
  EvaluationPolicy,
  EvaluationReport,
  EvaluationReportSpec,
  Finding,
  MetricValue,
  SourceRevision,
  SealedRunManifest,
  WebResolvedScenarioPlan,
} from "../contracts/model"
import {
  validateCaptureBundle,
  validateEvaluationPlan,
  validateEvaluationReport,
  validateSealedRunManifest,
} from "../contracts/validation"
import { createFinding, evaluateFunctionalEvidence } from "../evaluators/functional"
import { evaluateGeometryEvidence } from "../evaluators/geometry/evaluator"
import {
  loadPhase0AEvaluatorRegistry,
  type Phase0AEvaluatorId,
  type Phase0AEvaluatorRegistry,
} from "../evaluators/registry"
import { comparePngBuffers, type VisualComparison } from "../evaluators/visual"
import { compileScenario } from "../manifest-compiler/compiler"
import { materializePolicy } from "../manifest-compiler/policy"
import {
  decideRawStatus,
  evaluatePolicyGates,
  type EvaluatedGate,
  type GatePolicy,
  type MetricPrimitive,
} from "../policy-engine/evaluate-policy"
import {
  loadPolicySource,
  loadProjectConfig,
  loadScenarioSource,
} from "../project/config"
import {
  renderEvaluationReportHtml,
  type EvaluationReportView,
  type ReportStatus,
} from "../report-html/render"
import {
  DEFAULT_LOCAL_ARTIFACT_STORE_ID,
  LocalArtifactStore,
} from "../storage-local/artifact-store"
import type { ArtifactRef as LocalArtifactRef } from "../storage-local/artifact-store"
import { RunStore } from "../storage-local/run-store"
import { reportCapabilities } from "../report-html/capabilities"
import { coverageFor } from "./coverage"
import { normalizedCandidateEvidenceDigest } from "./evidence-digest"
export { normalizedCandidateEvidenceDigest } from "./evidence-digest"
import { geometryCheckpointEvidence } from "./geometry-evidence"
import { IncompleteCleanupError, hasIncompleteCleanup } from "../runtime/cleanup"
import { assertCaptureContract } from "./capture-contract"
import { ensureDevServer, type DevServerHandle } from "./dev-server"
import {
  materializeEvidenceAliases,
  type EvidenceAliases,
  type EvidenceAliasWarning,
} from "./evidence-aliases"
import {
  collectSourceRevision,
  createBuildIdentity,
  createIntendedEnvironmentDigest,
} from "./identity"
import { assertReportContract } from "./report-contract"
import {
  MockServerError,
  startMockServerFixtures,
  type MockServerSession,
} from "./mock-server"

const ACTOR = { type: "service", id: "ui-eval-cli" } as const
const ORCHESTRATOR_VERSION = "0.1.0"
const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as const
const CAPTURE_ABORT_GRACE_MS = 15_000

export interface EvaluateScenarioOptions {
  projectRoot: string
  scenario: string
  policy?: string
  browserChannel?: string
  referencePath?: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export interface EvaluationRunResult {
  executionId: string
  variantKey: string
  executionOutcome: EvaluationReportSpec["executionOutcome"]
  rawStatus: EvaluationReportSpec["rawStatus"]
  reportPath: string
  htmlPath: string
  report: EvaluationReport
}

interface EvaluationRunDraft {
  executionId: string
  variantKey: string
  executionOutcome: EvaluationReportSpec["executionOutcome"]
  rawStatus: EvaluationReportSpec["rawStatus"]
  report: EvaluationReport
  view: EvaluationReportView
}

export interface EvaluateScenarioResult {
  projectId: string
  scenarioId: string
  runs: EvaluationRunResult[]
}

export interface EvaluateScenarioDependencies {
  /** Test seam for the bounded capture cleanup wait after cancellation. */
  captureCleanupTimeoutMs?: number
  capture?: (
    plan: WebResolvedScenarioPlan,
    context: CaptureWebScenarioContext,
  ) => Promise<CaptureBundleSpec>
  ensureServer?: typeof ensureDevServer
  startFixtures?: typeof startMockServerFixtures
  sourceRevision?: typeof collectSourceRevision
  createExecutionId?: () => string
  now?: () => Date
}

interface VisualEvidence {
  comparison: VisualComparison | { status: "unknown"; reason: string }
  inputDigest: ArtifactRef["digest"]
  checkpointId: string
  candidateArtifactDigest?: ArtifactRef["digest"]
  finding?: Finding
  metric?: number
  view: NonNullable<EvaluationReportView["visual"]>
}

function throwIfEvaluationAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw Object.assign(new Error("UI evaluation was interrupted."), {
    code: "ABORTED",
  })
}

function awaitWithEvaluationAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  cleanupTimeoutMs: number,
): Promise<T> {
  if (!signal) return operation
  const abortReason = () =>
    signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("UI evaluation was interrupted."), {
          code: "ABORTED",
        })
  const settleAbortGrace = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let cleanupError: unknown
    await Promise.race([
      operation.then(
        () => { settled = true },
        (error: unknown) => { settled = true; cleanupError = error },
      ),
      new Promise<void>((settle) => {
        timer = setTimeout(settle, cleanupTimeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!settled) throw new IncompleteCleanupError("Capture cleanup did not settle after cancellation")
    if (hasIncompleteCleanup(cleanupError)) throw cleanupError
  }
  if (signal.aborted) {
    return settleAbortGrace().then(() => Promise.reject(abortReason()))
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = async () => {
      aborted = true
      signal.removeEventListener("abort", onAbort)
      try {
        await settleAbortGrace()
        reject(abortReason())
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        if (!aborted) resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        if (!aborted) reject(error)
      },
    )
  })
}

function visualCheckpoint(plan: ExecutableWebPlan): OrchestratorCheckpoint {
  const checkpoints = plan.checkpoints.filter((checkpoint) =>
    checkpoint.requiredChannels.includes("screenshot"),
  )
  if (checkpoints.length !== 1) {
    throw Object.assign(
      new Error(
        `--reference requires exactly one screenshot checkpoint; scenario "${plan.scenarioId}" declares ${checkpoints.length}.`,
      ),
      { code: "VISUAL_REFERENCE_CHECKPOINT_AMBIGUOUS" },
    )
  }
  return checkpoints[0]
}

function localReferenceRequestDigest(referencePath: string): ArtifactRef["digest"] {
  return canonicalDigest({
    kind: "local-reference-request",
    path: referencePath,
    trust: "local-unprotected",
  })
}

interface OrchestratorStep {
  id: string
  action: string
  assertion?: { id: string; kind: AssertionSpec["kind"] }
}

interface OrchestratorCheckpoint {
  id: string
  requiredChannels: CaptureCapability[]
  assertions?: Array<{ id: string; kind: AssertionSpec["kind"] }>
}

type ExecutableWebPlan = Omit<
  WebResolvedScenarioPlan,
  "target" | "setup" | "steps" | "cleanup" | "checkpoints"
> & {
  target: {
    platform: "web"
    entrypoint: { baseUrl: string; path: string }
  }
  setup: OrchestratorStep[]
  steps: OrchestratorStep[]
  cleanup: OrchestratorStep[]
  checkpoints: OrchestratorCheckpoint[]
}

function sha256Digest(value: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Expected a SHA-256 digest, received ${value}`)
  }
  return value as `sha256:${string}`
}

function localArtifactRef(value: ArtifactRef): LocalArtifactRef {
  sha256Digest(value.digest)
  return value as unknown as LocalArtifactRef
}

function sourceReference(scenario: string): string {
  return scenario.includes("/") || scenario.endsWith(".json")
    ? scenario
    : `scenarios/${scenario}.json`
}

function policyReference(policy: string | undefined): string {
  if (!policy) return "policies/default.json"
  return policy.includes("/") || policy.endsWith(".json")
    ? policy
    : `policies/${policy}.json`
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function reproductionCommand(options: EvaluateScenarioOptions): string {
  return [
    "ui-eval evaluate",
    shellArgument(options.scenario),
    ...(options.policy ? ["--policy", shellArgument(options.policy)] : []),
    ...(options.referencePath
      ? ["--reference", shellArgument(options.referencePath)]
      : []),
    ...(options.browserChannel
      ? ["--browser-channel", shellArgument(options.browserChannel)]
      : []),
    ...(resolve(options.projectRoot) !== resolve(process.cwd())
      ? ["--project-root", shellArgument(resolve(options.projectRoot))]
      : []),
  ].join(" ")
}

function createMetadata(
  id: string,
  projectId: string,
  spec: unknown,
  createdAt: string,
): ContractMetadata {
  return {
    id,
    projectId,
    revision: 1,
    createdAt,
    createdBy: ACTOR,
    specDigest: canonicalDigest(spec),
  }
}

function declaredAssertions(plan: ExecutableWebPlan): AssertionResult[] {
  const stepAssertions = [...plan.setup, ...plan.steps, ...plan.cleanup]
    .filter((step) => step.action === "assert" && step.assertion !== undefined)
    .map((step) => ({
      assertionId: step.assertion!.id,
      stepId: step.id,
      status: "not-evaluated" as const,
      origin: "runner" as const,
    }))
  const checkpointAssertions = plan.checkpoints.flatMap((checkpoint) =>
    (checkpoint.assertions ?? []).map((assertion) => ({
      assertionId: assertion.id,
      checkpointId: checkpoint.id,
      status: "not-evaluated" as const,
      origin: "runner" as const,
    })),
  )
  return [...stepAssertions, ...checkpointAssertions]
}

function failedCapture(
  plan: ExecutableWebPlan,
  context: Omit<CaptureWebScenarioContext, "artifactStore" | "browserLaunchOptions">,
  error: unknown,
): CaptureBundleSpec {
  const origin = error instanceof MockServerError ? "fixture" : "runner"
  const retryable = error instanceof MockServerError ? error.retryable : true
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code.toLowerCase().replaceAll("_", "-")
      : "dev-server-unavailable"
  const message = error instanceof Error ? error.message : String(error)
  const expectedRequired = plan.checkpoints.reduce(
    (sum, checkpoint) => sum + checkpoint.requiredChannels.length,
    0,
  )
  const environmentBase = {
    os: process.platform,
    architecture: process.arch,
    rendererProfile: plan.device.profileId,
    browserOrDevice: context.browserChannel
      ? `chromium:${context.browserChannel}`
      : "chromium:playwright",
    browserOrOsVersion: "unavailable",
    driverVersion: `${PLAYWRIGHT_CAPTURE_ADAPTER_ID}/${PLAYWRIGHT_CAPTURE_ADAPTER_VERSION}`,
    locale: plan.locale,
    timezone: plan.determinism.timezone,
    fontSetDigest: canonicalDigest([]),
  }

  return {
    executionId: context.executionId,
    runManifestDigest: context.runManifestDigest,
    captureKey: context.captureKey,
    scenarioId: plan.scenarioId,
    variant: plan.variant,
    sourceRevision: context.sourceRevision,
    build: context.build,
    adapter: {
      id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
      version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
      platform: "web",
    },
    environment: {
      ...environmentBase,
      environmentDigest: canonicalDigest(environmentBase),
    },
    capabilities: [...PLAYWRIGHT_CAPTURE_CAPABILITIES],
    status: "failed",
    completeness: {
      expectedRequired,
      capturedRequired: 0,
      missingRequired: expectedRequired,
    },
    stepResults: [...plan.setup, ...plan.steps, ...plan.cleanup].map((step) => ({
      stepId: step.id,
      status: "not-executed",
      origin,
      errorCode: code,
    })),
    assertionResults: declaredAssertions(plan),
    checkpoints: plan.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.id,
      renderSpace: plan.device.renderSpace,
      capturedAt: new Date().toISOString(),
      evidence: checkpoint.requiredChannels.map((channel) => ({
        channel,
        required: true,
        status: "missing",
        error: { code, message },
      })),
    })),
    executionErrors: [
      {
        origin,
        phase: "prepare",
        code,
        message,
        retryable,
      },
    ],
  }
}

function firstArtifact(
  capture: CaptureBundleSpec,
  channel: string,
): ArtifactRef | undefined {
  return capture.checkpoints
    .flatMap((checkpoint) => checkpoint.evidence)
    .find((record) => record.channel === channel && record.status === "captured")
    ?.artifact
}

async function resolveProjectLocalFile(
  projectRoot: string,
  input: string,
): Promise<string> {
  const candidate = resolve(projectRoot, input)
  const relation = relative(projectRoot, candidate)
  if (isAbsolute(input) || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("reference image must be a project-relative path")
  }
  const [canonicalRoot, metadata, canonicalCandidate] = await Promise.all([
    realpath(projectRoot),
    lstat(candidate),
    realpath(candidate),
  ])
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("reference image must be a regular, non-symlink file")
  }
  const canonicalRelation = relative(canonicalRoot, canonicalCandidate)
  if (
    canonicalRelation.startsWith("..") ||
    isAbsolute(canonicalRelation)
  ) {
    throw new Error("reference image resolves outside the project root")
  }
  return canonicalCandidate
}

async function evaluateVisualEvidence(options: {
  referencePath: string
  projectRoot: string
  plan: ExecutableWebPlan
  capture: CaptureBundleSpec
  artifactStore: LocalArtifactStore
  runStore: RunStore
  aliases: EvidenceAliases
}): Promise<VisualEvidence> {
  const checkpoint = visualCheckpoint(options.plan)
  const capturedCheckpoint = options.capture.checkpoints.find(
    (candidate) => candidate.checkpointId === checkpoint.id,
  )
  const candidateRef = capturedCheckpoint?.evidence.find(
    (record) =>
      record.channel === "screenshot" && record.status === "captured",
  )?.artifact
  const unavailableInputDigest = localReferenceRequestDigest(
    options.referencePath,
  )
  let referenceBytes: Buffer
  try {
    const referenceFile = await resolveProjectLocalFile(
      options.projectRoot,
      options.referencePath,
    )
    referenceBytes = await readBoundedEvidenceFile(
      referenceFile,
      "reference-png",
    )
    try {
      inspectPngHeader(referenceBytes, "reference-png")
    } catch (error) {
      if (
        error instanceof BinaryEvidenceValidationError &&
        error.classification.code.endsWith("-exceeded")
      ) {
        throw error
      }
      // Preserve the existing invalid-reference semantics. comparePngBuffers
      // will report a non-budget format error as unknown without decoding it.
    }
  } catch (error) {
    if (
      error instanceof BinaryEvidenceValidationError &&
      error.classification.code.endsWith("-exceeded")
    ) {
      throw error
    }
    const reason = `reference-unavailable: ${error instanceof Error ? error.message : String(error)}`
    return {
      comparison: { status: "unknown", reason },
      inputDigest: unavailableInputDigest,
      checkpointId: checkpoint.id,
      ...(candidateRef
        ? { candidateArtifactDigest: candidateRef.digest }
        : {}),
      view: { status: "unknown", reason },
    }
  }
  const inputDigest = `sha256:${createHash("sha256")
    .update(referenceBytes)
    .digest("hex")}` as const

  if (!candidateRef) {
    return {
      comparison: { status: "unknown", reason: "candidate-screenshot-unavailable" },
      inputDigest,
      checkpointId: checkpoint.id,
      view: {
        status: "unknown",
        reason: "Candidate screenshot evidence is unavailable.",
      },
    }
  }

  let comparison: VisualComparison
  try {
    const candidateBytes = await options.artifactStore.resolve(
      localArtifactRef(candidateRef),
    )
    comparison = comparePngBuffers(referenceBytes, candidateBytes)
  } catch {
    const reason = "candidate-screenshot-corrupt"
    return {
      comparison: { status: "unknown", reason },
      inputDigest,
      checkpointId: checkpoint.id,
      candidateArtifactDigest: candidateRef.digest,
      view: { status: "unknown", reason },
    }
  }
  if (comparison.status === "unknown") {
    return {
      comparison,
      inputDigest,
      checkpointId: checkpoint.id,
      candidateArtifactDigest: candidateRef.digest,
      view: {
        status: "unknown",
        reason: comparison.reason,
        candidateHref: options.aliases.byDigest.get(candidateRef.digest),
      },
    }
  }

  const candidateHref = options.aliases.byDigest.get(candidateRef.digest)
  const referenceRef = (await options.artifactStore.put(referenceBytes, {
    mediaType: "image/png",
    sensitivity: "internal",
  })) as unknown as ArtifactRef
  await options.runStore.writeBinary(
    options.capture.executionId,
    "reference.png",
    referenceBytes,
  )
  if (!options.aliases.byDigest.has(referenceRef.digest)) {
    options.aliases.byDigest.set(referenceRef.digest, "reference.png")
  }

  const diffRef = (await options.artifactStore.put(comparison.diffPng, {
    mediaType: "image/png",
    sensitivity: "internal",
  })) as unknown as ArtifactRef
  await options.runStore.writeBinary(
    options.capture.executionId,
    "diff.png",
    comparison.diffPng,
  )
  options.aliases.byDigest.set(diffRef.digest, "diff.png")
  const fingerprint = canonicalDigest({
    ruleId: "visual.local-reference-change",
    ruleSemanticVersion: "1.0.0",
    metricKey: "visual.changedPixelRatio",
    scenarioId: options.plan.scenarioId,
    checkpointId: checkpoint.id,
    variantKey: options.plan.variant.variantKey,
    contextDigest: sha256Digest(options.plan.variant.contextDigest),
    dimension: "pixel",
    comparison: "local-reference-candidate",
  })
  const finding: Finding | undefined =
    comparison.changedPixels === 0
      ? undefined
      : {
          findingId: canonicalDigest({
            fingerprint,
            executionId: options.capture.executionId,
          }),
          fingerprint,
          ruleId: "visual.local-reference-change",
          ruleSemanticVersion: "1.0.0",
          metricKey: "visual.changedPixelRatio",
          evaluatorId: "visual",
          evaluatorVersion: "0.1.0",
          comparison: "local-reference-candidate",
          dimension: "pixel",
          severity: "info",
          confidence: 1,
          scenarioId: options.plan.scenarioId,
          executionId: options.capture.executionId,
          checkpointId: checkpoint.id,
          variantKey: options.plan.variant.variantKey,
          contextDigest: options.plan.variant.contextDigest,
          measurement: {
            expected: { kind: "ratio", value: 0 },
            actual: {
              kind: "ratio",
              value: comparison.changedPixelRatio,
            },
          },
          summary: "Candidate differs from the local reference image",
          explanation:
            "This is uncalibrated, local-unprotected evidence. Review the candidate, reference and diff images before accepting the change.",
          evidence: [candidateRef, referenceRef, diffRef],
        }

  return {
    comparison,
    inputDigest,
    checkpointId: checkpoint.id,
    candidateArtifactDigest: candidateRef.digest,
    ...(finding ? { finding } : {}),
    metric: comparison.changedPixelRatio,
    view: {
      status: "measured",
      changedPixelRatio: comparison.changedPixelRatio,
      candidateHref,
      referenceHref: "reference.png",
      diffHref: "diff.png",
    },
  }
}

function toEvaluationPlan(
  executionId: string,
  captureDigest: ArtifactRef["digest"],
  normalizedEvidenceDigest: ArtifactRef["digest"],
  policy: EvaluationPolicy,
  visual?: VisualEvidence,
): EvaluationPlan {
  const base = {
    evaluationId: `evaluation-${executionId}`,
    candidate: {
      captureBundleDigest: captureDigest,
      normalizedCandidateEvidenceDigest: normalizedEvidenceDigest,
    },
    policy: {
      policyDigest: policy.metadata.specDigest,
      evaluators: policy.spec.evaluators.map((evaluator) => ({
        id: evaluator.id,
        version: evaluator.version,
        configRef: evaluator.configRef,
        configDigest: evaluator.configDigest,
        required: evaluator.required,
      })),
    },
    ...(visual
      ? {
          localReference: {
            inputDigest: visual.inputDigest,
            trust: "local-unprotected" as const,
            checkpointId: visual.checkpointId,
            ...(visual.candidateArtifactDigest
              ? {
                  candidateArtifactDigest:
                    visual.candidateArtifactDigest,
                }
              : {}),
          },
        }
      : {}),
    evaluationKey: ZERO_DIGEST,
  } satisfies EvaluationPlan
  return validateEvaluationPlan({
    ...base,
    evaluationKey: canonicalDigest(base, {
      exclusions: DigestExclusionProfiles.evaluationPlan,
    }),
  })
}

function metricText(value: MetricValue | undefined): string | undefined {
  if (!value) return undefined
  return typeof value.value === "object"
    ? JSON.stringify(value.value)
    : String(value.value)
}

const WITHHELD_DIAGNOSTIC_MESSAGE =
  "Diagnostic text is withheld from run-visible artifacts; inspect authorized sensitive CAS evidence when available."

function safeDiagnosticCode(value: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
    ? value
    : "unclassified-error"
}

/**
 * Capture adapters can observe arbitrary page text in browser/driver errors.
 * Keep those raw diagnostics in sensitivity-labelled CAS evidence, never in
 * the run directory's JSON/HTML presentation artifacts.
 */
function sanitizeRunVisibleCapture(
  capture: CaptureBundleSpec,
  plan: ExecutableWebPlan,
): CaptureBundleSpec {
  const assertionKinds = new Map<string, AssertionSpec["kind"]>()
  for (const step of [...plan.setup, ...plan.steps, ...plan.cleanup]) {
    if (step.action !== "assert" || !step.assertion) continue
    assertionKinds.set(
      `step\0${step.id}\0${step.assertion.id}`,
      step.assertion.kind,
    )
  }
  for (const checkpoint of plan.checkpoints) {
    for (const assertion of checkpoint.assertions ?? []) {
      assertionKinds.set(
        `checkpoint\0${checkpoint.id}\0${assertion.id}`,
        assertion.kind,
      )
    }
  }

  return {
    ...capture,
    assertionResults: capture.assertionResults.map((result) => {
      const binding = result.stepId
        ? `step\0${result.stepId}\0${result.assertionId}`
        : `checkpoint\0${result.checkpointId ?? ""}\0${result.assertionId}`
      const declaredKind = assertionKinds.get(binding)
      const sanitizeMetric = (
        value: MetricValue | undefined,
      ): MetricValue | undefined => {
        if (!value || !declaredKind) return undefined
        if (
          declaredKind !== "text" &&
          declaredKind !== "url"
        ) {
          return value.kind === "boolean" ? value : undefined
        }
        const primitive =
          typeof value.value === "string" ||
          typeof value.value === "number" ||
          typeof value.value === "boolean"
            ? String(value.value)
            : "[WITHHELD_INVALID_METRIC]"
        return sanitizeAssertionMetric(
          declaredKind === "url" ? "url" : "text",
          primitive,
        )
      }
      const expected = sanitizeMetric(result.expected)
      const actual = sanitizeMetric(result.actual)
      return {
        ...result,
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
      }
    }),
    stepResults: capture.stepResults.map((result) => ({
      ...result,
      ...(result.errorCode
        ? { errorCode: safeDiagnosticCode(result.errorCode) }
        : {}),
    })),
    checkpoints: capture.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      evidence: checkpoint.evidence.map((record) => ({
        ...record,
        ...(record.error
          ? {
              error: {
                code: safeDiagnosticCode(record.error.code),
                message: WITHHELD_DIAGNOSTIC_MESSAGE,
              },
            }
          : {}),
      })),
    })),
    ...(capture.executionErrors
      ? {
          executionErrors: capture.executionErrors.map((error) => ({
            ...error,
            code: safeDiagnosticCode(error.code),
            message: WITHHELD_DIAGNOSTIC_MESSAGE,
          })),
        }
      : {}),
  }
}

function runtimeEntries(
  capture: CaptureBundleSpec,
): EvaluationReportView["runtimeEntries"] {
  const entries: EvaluationReportView["runtimeEntries"] = (
    capture.executionErrors ?? []
  ).map((error) => ({
    level: error.origin,
    message: `${safeDiagnosticCode(error.code)} during ${error.phase}${
      error.stepId ? ` (${error.stepId})` : ""
    }`,
  }))
  if (firstArtifact(capture, "console")) {
    entries.push({
      level: "console",
      message:
        "Console evidence was captured as a sensitive CAS artifact; raw content is intentionally omitted from this report.",
    })
  }
  return entries
}

function statusWithVisual(
  current: ReportStatus,
  executionOutcome: EvaluationReportSpec["executionOutcome"],
  visual: VisualEvidence | undefined,
): ReportStatus {
  if (executionOutcome !== "valid" || current === "fail") return current
  if (!visual) return current
  if (visual.comparison.status === "unknown") return "inconclusive"
  if (visual.comparison.changedPixels > 0 && current === "pass") {
    return "needs-review"
  }
  return current
}

function gateResults(gates: readonly EvaluatedGate[]): EvaluationReportSpec["gates"] {
  return gates.map(({ gateId, hard, status, reason }) => ({
    gateId,
    hard,
    status,
    reason,
  }))
}

async function evaluatePlan(options: {
  rootOptions: EvaluateScenarioOptions
  plan: ExecutableWebPlan
  project: Awaited<ReturnType<typeof loadProjectConfig>>
  policy: EvaluationPolicy
  evaluatorRegistry: Phase0AEvaluatorRegistry
  sourceRevision: SourceRevision
  artifactStore: LocalArtifactStore
  runStore: RunStore
  serverError?: unknown
  fixtureSession?: MockServerSession
  deps: EvaluateScenarioDependencies
}): Promise<EvaluationRunDraft> {
  throwIfEvaluationAborted(options.rootOptions.signal)
  const now = options.deps.now ?? (() => new Date())
  const createdAt = now().toISOString()
  const executionId =
    options.deps.createExecutionId?.() ?? `run-${Date.now()}-${randomUUID()}`
  const build = createBuildIdentity(
    options.project,
    options.plan,
    options.sourceRevision,
  )
  const intendedEnvironmentDigest = createIntendedEnvironmentDigest(
    options.plan,
    options.rootOptions.browserChannel,
  )
  const manifestBase = {
    executionId,
    scenarioPlanDigest: options.plan.planDigest,
    sourceRevision: options.sourceRevision,
    build,
    adapter: {
      id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
      version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
    },
    environmentDigest: intendedEnvironmentDigest,
    captureKey: ZERO_DIGEST,
  }
  const captureKey = sha256Digest(canonicalDigest(manifestBase, {
    exclusions: DigestExclusionProfiles.sealedRunManifest,
  }))
  const runManifest: SealedRunManifest = validateSealedRunManifest({
    ...manifestBase,
    captureKey,
  })
  await options.runStore.writeJson(
    executionId,
    "run-manifest.json",
    runManifest,
  )
  throwIfEvaluationAborted(options.rootOptions.signal)
  const runManifestDigest = sha256Digest(canonicalDigest(runManifest))
  const captureContext: Omit<
    CaptureWebScenarioContext,
    "artifactStore" | "browserLaunchOptions"
  > = {
    executionId,
    runManifestDigest,
    captureKey,
    sourceRevision: options.sourceRevision,
    build,
    ...(options.rootOptions.browserChannel
      ? { browserChannel: options.rootOptions.browserChannel }
      : {}),
    ...(options.rootOptions.signal
      ? { signal: options.rootOptions.signal }
      : {}),
  }

  options.rootOptions.onProgress?.(
    `Capturing ${options.plan.scenarioId} (${options.plan.variant.variantKey})`,
  )
  let captureSpec: CaptureBundleSpec
  if (options.serverError) {
    captureSpec = failedCapture(options.plan, captureContext, options.serverError)
  } else {
    try {
      const browserLaunchOptions: LaunchOptions | undefined = options.rootOptions
        .browserChannel
        ? { channel: options.rootOptions.browserChannel }
        : undefined
      captureSpec = await awaitWithEvaluationAbort(
        (options.deps.capture ?? captureWebScenario)(options.plan, {
          ...captureContext,
          artifactStore: options.artifactStore,
          ...(options.rootOptions.browserChannel
            ? { browserChannel: options.rootOptions.browserChannel }
            : {}),
          ...(browserLaunchOptions ? { browserLaunchOptions } : {}),
        }),
        options.rootOptions.signal,
        options.deps.captureCleanupTimeoutMs ?? CAPTURE_ABORT_GRACE_MS,
      )
      options.fixtureSession?.verify()
      throwIfEvaluationAborted(options.rootOptions.signal)
    } catch (error) {
      if (hasIncompleteCleanup(error)) throw error
      throwIfEvaluationAborted(options.rootOptions.signal)
      captureSpec = failedCapture(options.plan, captureContext, error)
    }
  }

  try {
    const structurallyValid = validateCaptureBundle({
      apiVersion: "uieval.io/v1alpha1",
      kind: "CaptureBundle",
      metadata: createMetadata(
        `capture-${executionId}`,
        options.project.value.projectId,
        captureSpec,
        createdAt,
      ),
      spec: captureSpec,
    }).spec
    captureSpec = assertCaptureContract({
      capture: structurallyValid,
      plan: options.plan,
      context: captureContext,
      expectedAdapter: {
        id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
        version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
        platform: "web",
        capabilities: PLAYWRIGHT_CAPTURE_CAPABILITIES,
        browserOrDevice: options.rootOptions.browserChannel
          ? `chromium:${options.rootOptions.browserChannel}`
          : "chromium:playwright",
      },
    })
  } catch (error) {
    throwIfEvaluationAborted(options.rootOptions.signal)
    captureSpec = failedCapture(options.plan, captureContext, error)
  }

  throwIfEvaluationAborted(options.rootOptions.signal)
  const aliasMaterialization = await materializeEvidenceAliases(
    captureSpec,
    options.artifactStore,
    options.runStore,
  )
  throwIfEvaluationAborted(options.rootOptions.signal)
  captureSpec = sanitizeRunVisibleCapture(aliasMaterialization.capture, options.plan)
  const aliases = aliasMaterialization.aliases
  const captureBundle: CaptureBundle = validateCaptureBundle({
    apiVersion: "uieval.io/v1alpha1",
    kind: "CaptureBundle",
    metadata: createMetadata(
      `capture-${executionId}`,
      options.project.value.projectId,
      captureSpec,
      createdAt,
    ),
    spec: captureSpec,
  })
  const normalizedEvidenceDigest = normalizedCandidateEvidenceDigest(captureSpec, {
    includeScreenshot: options.rootOptions.referencePath !== undefined,
    includeGeometry: options.evaluatorRegistry.get("geometry") !== undefined,
  })
  let visualEvaluationError: string | undefined
  let visual: VisualEvidence | undefined
  if (
    options.rootOptions.referencePath &&
    options.evaluatorRegistry.get("visual")
  ) {
    try {
      visual = await evaluateVisualEvidence({
        referencePath: options.rootOptions.referencePath,
        projectRoot: options.project.projectRoot,
        plan: options.plan,
        capture: captureSpec,
        artifactStore: options.artifactStore,
        runStore: options.runStore,
        aliases,
      })
      throwIfEvaluationAborted(options.rootOptions.signal)
    } catch (error) {
      throwIfEvaluationAborted(options.rootOptions.signal)
      const binaryEvidenceCode =
        error instanceof BinaryEvidenceValidationError
          ? error.classification.code
          : undefined
      visualEvaluationError = binaryEvidenceCode
        ? `${binaryEvidenceCode}: visual reference evidence was rejected by runner safety limits`
        : "visual-evaluator-infrastructure-error: visual artifacts could not be sealed"
      const checkpoint = visualCheckpoint(options.plan)
      const candidateArtifactDigest = captureSpec.checkpoints
        .find((candidate) => candidate.checkpointId === checkpoint.id)
        ?.evidence.find(
          (record) =>
            record.channel === "screenshot" &&
            record.status === "captured",
        )?.artifact?.digest
      visual = {
        comparison: {
          status: "unknown",
          reason:
            binaryEvidenceCode ?? "visual-evaluator-infrastructure-error",
        },
        inputDigest: localReferenceRequestDigest(
          options.rootOptions.referencePath,
        ),
        checkpointId: checkpoint.id,
        ...(candidateArtifactDigest ? { candidateArtifactDigest } : {}),
        view: {
          status: "unknown",
          reason: binaryEvidenceCode
            ? "Visual reference evidence exceeded a runner safety limit."
            : "Visual evaluation infrastructure failed while sealing evidence.",
        },
      }
    }
  }
  const evaluationPlan = toEvaluationPlan(
    executionId,
    captureBundle.metadata.specDigest,
    normalizedEvidenceDigest,
    options.policy,
    visual,
  )
  const geometryEvaluator = options.evaluatorRegistry.get("geometry")
  const geometry = geometryEvaluator
    ? evaluateGeometryEvidence(
        geometryEvaluator.config,
        await geometryCheckpointEvidence(captureSpec, (ref) => options.artifactStore.resolve(localArtifactRef(ref))),
        options.plan.checkpoints.map((checkpoint) => checkpoint.id),
      )
    : undefined
  const checkpointId = options.plan.checkpoints[0]?.id ?? "checkpoint"
  const functional = evaluateFunctionalEvidence(captureSpec, {
    scenarioId: options.plan.scenarioId,
    executionId,
    checkpointId,
    variantKey: options.plan.variant.variantKey,
    contextDigest: sha256Digest(options.plan.variant.contextDigest),
  })
  const executionOutcome = visualEvaluationError
    ? "infra-error"
    : functional.executionOutcome === "valid" && functional.metrics["execution.valid"] === true &&
      geometry && geometry.coverage.invalid + geometry.coverage.unsupported > 0 && geometry.coverage.failed === 0
      ? "invalid-evidence"
      : functional.executionOutcome
  const metrics: Record<string, MetricPrimitive | undefined> = {
    ...functional.metrics,
    ...(geometry?.metrics ?? {}),
    ...(visual?.metric === undefined
      ? {}
      : { "visual.changedPixelRatio": visual.metric }),
  }
  const evaluatedGates = evaluatePolicyGates(
    options.policy.spec.gates as GatePolicy[],
    metrics,
  )
  const policyStatus = decideRawStatus(
    executionOutcome,
    evaluatedGates,
  )
  const rawStatus = statusWithVisual(
    policyStatus,
    executionOutcome,
    visual,
  )
  const findingContext = {
    scenarioId: options.plan.scenarioId,
    executionId,
    checkpointId,
    variantKey: options.plan.variant.variantKey,
    contextDigest: sha256Digest(options.plan.variant.contextDigest),
  }
  const findings = [
    ...functional.findings,
    ...(geometry?.findings ?? []).map((finding) =>
      createFinding({
        context: findingContext,
        ruleId: `geometry.${finding.constraintId}`,
        metricKey: finding.metricKey,
        evaluatorId: "geometry",
        // The expectation came from a design token set, not from a runtime
        // contract, so the comparison names the design side.
        comparison: "design-candidate",
        dimension: finding.dimension,
        severity: finding.severity,
        checkpointId: finding.checkpointId,
        summary: finding.summary,
        explanation: finding.explanation,
      }),
    ),
    ...(visual?.finding ? [visual.finding] : []),
  ]
  const executedEvaluatorIds: Phase0AEvaluatorId[] = [
    "execution",
    "interaction",
    "runtime",
    ...(visual ? (["visual"] as const) : []),
    ...(geometry ? (["geometry"] as const) : []),
  ]
  const evaluatorProvenance =
    options.evaluatorRegistry.provenanceFor(executedEvaluatorIds)
  const measuredMetrics = Object.fromEntries(
    Object.entries(metrics).filter((entry): entry is [string, MetricPrimitive] => entry[1] !== undefined),
  )
  const reportSpec: EvaluationReportSpec = {
    evaluationKey: evaluationPlan.evaluationKey,
    inputs: {
      candidateCaptureDigest: captureBundle.metadata.specDigest,
      normalizedCandidateEvidenceDigest: normalizedEvidenceDigest,
      scenarioDigest: options.plan.scenarioDigest,
      policyDigest: options.policy.metadata.specDigest,
      ...(visual
        ? { localReferenceDigest: visual.inputDigest }
        : {}),
      sourceRevision: options.sourceRevision,
    },
    executionOutcome,
    rawStatus,
    metrics: measuredMetrics,
    coverage: coverageFor(captureSpec, visual, geometry?.coverage),
    gates: gateResults(evaluatedGates),
    findings,
    provenance: {
      orchestratorVersion: ORCHESTRATOR_VERSION,
      evaluators: evaluatorProvenance,
    },
  }
  assertReportContract({
    reportSpec,
    evaluationPlan,
    policy: options.policy,
    captureBundle,
    evaluatedGates,
    expectedExecutionOutcome: executionOutcome,
    expectedMetrics: measuredMetrics,
    visualDecision: !visual
      ? { status: "none" }
      : visual.comparison.status === "unknown"
        ? { status: "unknown" }
        : {
            status: "measured",
            changedPixels: visual.comparison.changedPixels,
          },
    expectedEvaluatorProvenance: evaluatorProvenance,
    expectedScenarioDigest: options.plan.scenarioDigest,
  })
  const report = validateEvaluationReport({
    apiVersion: "uieval.io/v1alpha1",
    kind: "EvaluationReport",
    metadata: createMetadata(
      `report-${executionId}`,
      options.project.value.projectId,
      reportSpec,
      createdAt,
    ),
    spec: reportSpec,
  })

  await options.runStore.writeJson(executionId, "capture.json", captureBundle)
  await options.runStore.writeJson(
    executionId,
    "evaluation-plan.json",
    evaluationPlan,
  )
  await options.runStore.writeJson(executionId, "policy.json", options.policy)
  const view: EvaluationReportView = {
    title: `${options.plan.scenarioId} · ${options.plan.variant.variantKey}`,
    projectId: options.project.value.projectId,
    scenarioId: options.plan.scenarioId,
    executionId,
    generatedAt: createdAt,
    executionOutcome,
    rawStatus,
    reproductionCommand: reproductionCommand(options.rootOptions),
    provenance: [
      {
        label: "Source revision",
        value: `${options.sourceRevision.repository}@${options.sourceRevision.commitSha}${
          options.sourceRevision.dirtyTree ? " (dirty)" : ""
        }`,
      },
      { label: "Build artifact", value: build.artifactDigest },
      {
        label: "Capture adapter",
        value: `${captureSpec.adapter.id}@${captureSpec.adapter.version} · ${captureSpec.environment.browserOrDevice} ${captureSpec.environment.browserOrOsVersion}`,
      },
      { label: "Policy", value: options.policy.metadata.specDigest },
      {
        label: "Evaluators",
        value: reportSpec.provenance.evaluators
          .map((evaluator) => `${evaluator.id}@${evaluator.version}`)
          .join(", "),
      },
      { label: "Run manifest", value: runManifestDigest },
      { label: "Evaluation key", value: evaluationPlan.evaluationKey },
    ],
    capabilities: reportCapabilities(reportSpec),
    gates: gateResults(evaluatedGates),
    findings: findings.map((finding) => ({
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      dimension: finding.dimension,
      summary: finding.summary,
      ...(finding.explanation ? { explanation: finding.explanation } : {}),
      evidence: finding.evidence
        .map((artifact) => ({
          label: artifact.mediaType,
          href: aliases.byDigest.get(artifact.digest) ?? "",
        }))
        .filter((item) => item.href.length > 0),
    })),
    assertions: captureSpec.assertionResults.map((assertion) => ({
      assertionId: assertion.assertionId,
      status: assertion.status,
      ...(metricText(assertion.expected)
        ? { expected: metricText(assertion.expected) }
        : {}),
      ...(metricText(assertion.actual)
        ? { actual: metricText(assertion.actual) }
        : {}),
    })),
    runtimeEntries: [
      ...runtimeEntries(captureSpec),
      ...aliasWarningEntries(aliasMaterialization.warnings),
      ...(visualEvaluationError
        ? [{ level: "runner", message: visualEvaluationError }]
        : []),
    ],
    ...(visual ? { visual: visual.view } : {}),
  }
  throwIfEvaluationAborted(options.rootOptions.signal)

  return {
    executionId,
    variantKey: options.plan.variant.variantKey,
    executionOutcome,
    rawStatus,
    report,
    view,
  }
}

async function finalizeEvaluationRun(
  runStore: RunStore,
  draft: EvaluationRunDraft,
  onProgress: EvaluateScenarioOptions["onProgress"],
): Promise<EvaluationRunResult> {
  const reportPath = await runStore.writeReport(draft.executionId, draft.report)
  const htmlPath = await runStore.writeText(
    draft.executionId,
    "report.html",
    renderEvaluationReportHtml(draft.view),
  )
  onProgress?.(`Finished ${draft.variantKey}: ${draft.rawStatus}`)
  return {
    executionId: draft.executionId,
    variantKey: draft.variantKey,
    executionOutcome: draft.executionOutcome,
    rawStatus: draft.rawStatus,
    reportPath,
    htmlPath,
    report: draft.report,
  }
}

function aliasWarningEntries(
  warnings: readonly EvidenceAliasWarning[],
): EvaluationReportView["runtimeEntries"] {
  return warnings.map((warning) => ({
    level: "presentation",
    message: `${warning.code}: ${warning.message}`,
  }))
}

export async function evaluateScenario(
  options: EvaluateScenarioOptions,
  deps: EvaluateScenarioDependencies = {},
): Promise<EvaluateScenarioResult> {
  throwIfEvaluationAborted(options.signal)
  const project = await loadProjectConfig({ projectRoot: options.projectRoot })
  throwIfEvaluationAborted(options.signal)
  const [scenarioSource, policySource] = await Promise.all([
    loadScenarioSource(project, sourceReference(options.scenario)),
    loadPolicySource(project, policyReference(options.policy)),
  ])
  const artifactRoot = resolve(
    project.projectRoot,
    project.value.artifactRoot ?? ".ui-eval",
  )
  const artifactStore = new LocalArtifactStore({
    root: artifactRoot,
    projectId: project.value.projectId,
    storeId: DEFAULT_LOCAL_ARTIFACT_STORE_ID,
  })
  const runStore = new RunStore(artifactRoot)
  const [plans, policy, sourceRevision] = await Promise.all([
    compileScenario(scenarioSource, project, {
      artifactMaterializer: artifactStore,
      availableCapabilities: PLAYWRIGHT_CAPTURE_CAPABILITIES,
    }),
    materializePolicy(policySource, project, {
      artifactMaterializer: artifactStore,
      createdBy: ACTOR,
    }),
    (deps.sourceRevision ?? collectSourceRevision)(project.projectRoot),
  ])
  throwIfEvaluationAborted(options.signal)
  const evaluatorRegistry = await loadPhase0AEvaluatorRegistry(policy, {
    artifactResolver: {
      resolve: (ref) => artifactStore.resolve(localArtifactRef(ref)),
    },
    visualReferenceAvailable: options.referencePath !== undefined,
  })
  if (options.referencePath && !evaluatorRegistry.get("visual")) {
    throw Object.assign(
      new Error(
        "--reference requires a runnable visual@0.1.0 evaluator in the selected policy.",
      ),
      { code: "VISUAL_EVALUATOR_NOT_CONFIGURED" },
    )
  }
  if (options.referencePath) {
    for (const plan of plans) visualCheckpoint(plan as ExecutableWebPlan)
  }
  throwIfEvaluationAborted(options.signal)

  const runs: EvaluationRunResult[] = []
  for (const plan of plans) {
    throwIfEvaluationAborted(options.signal)
    let server: DevServerHandle | undefined
    let fixtureSession: MockServerSession | undefined
    let serverError: unknown
    let run: EvaluationRunDraft | undefined
    let operationError: unknown
    try {
      try {
        if (plan.fixtures.length > 0) {
          fixtureSession = await (
            deps.startFixtures ?? startMockServerFixtures
          )(
            plan.fixtures,
            {
              resolve: (ref) => artifactStore.resolve(localArtifactRef(ref)),
            },
            {
              ...(options.signal ? { signal: options.signal } : {}),
              onProgress: options.onProgress,
            },
          )
          throwIfEvaluationAborted(options.signal)
        }
        server = await (deps.ensureServer ?? ensureDevServer)(
          project.value.devServer,
          {
            projectRoot: project.projectRoot,
            ...(options.signal ? { signal: options.signal } : {}),
            onProgress: (event) => {
              if (event.type === "stderr") return
              options.onProgress?.(event.message.trim())
            },
          },
        )
        throwIfEvaluationAborted(options.signal)
      } catch (error) {
        throwIfEvaluationAborted(options.signal)
        serverError = error
        options.onProgress?.(
          `Evaluation infrastructure unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      run = await evaluatePlan({
        rootOptions: options,
        plan: plan as ExecutableWebPlan,
        project,
        policy,
        evaluatorRegistry,
        sourceRevision,
        artifactStore,
        runStore,
        ...(serverError ? { serverError } : {}),
        ...(fixtureSession ? { fixtureSession } : {}),
        deps,
      })
      throwIfEvaluationAborted(options.signal)
    } catch (error) {
      operationError = error
    }

    let cleanupError: unknown
    try {
      await server?.stop()
    } catch (error) {
      cleanupError = error
    }
    try {
      await fixtureSession?.stop()
    } catch (error) {
      cleanupError ??= error
    }
    if (operationError && cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Evaluation and owned infrastructure cleanup both failed.",
      )
    }
    if (operationError) throw operationError
    if (cleanupError) throw cleanupError
    if (!run) throw new Error("Evaluation completed without a run result.")
    runs.push(await finalizeEvaluationRun(runStore, run, options.onProgress))
  }
  return {
    projectId: project.value.projectId,
    scenarioId: scenarioSource.value.id,
    runs,
  }
}
