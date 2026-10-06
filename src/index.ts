// Default imports describe executable web behavior. Forward multi-platform,
// design-binding and governance contracts require an explicit namespace.
export * as forwardContracts from "./contracts/index"
export { canonicalJson, canonicalDigest, canonicalSpecDigest, DigestExclusionProfiles } from "./contracts/canonical-json"
export {
  ArtifactRefSchema, CaptureBundleSchema, EvaluationPlanSchema,
  DeploymentIdentitySchema, DeploymentVerificationSchema, ExecutionTargetSchema,
  EvaluationPolicySchema, EvaluationReportSchema, GeometryEvaluatorConfigSchema,
  SealedRunManifestSchema, WebResolvedScenarioPlanSchema,
} from "./contracts/schemas"
export {
  ContractValidationError, validateArtifactRef, validateCaptureBundle,
  validateEvaluationPlan, validateEvaluationPolicy, validateEvaluationReport,
  validateGeometryEvaluatorConfig, validateSealedRunManifest,
  validateLayoutEvidencePayload, validateStylesEvidencePayload,
} from "./contracts/validation"
export type {
  ArtifactRef, CaptureBundle, CaptureBundleSpec, CaptureCapability,
  Digest, CoverageCounts, EvaluationPlan, EvaluationPolicy, EvaluationPolicySpec,
  EvaluationReport, EvaluationReportSpec, Finding, GateExpression,
  GeometryEvaluatorConfig, DesignTokenSet, LayoutEvidencePayload, StylesEvidencePayload,
  PolicySource, SealedRunManifest, SourceRevision, WebResolvedScenarioPlan,
  WebRuntimeLocator, WebScenarioStep, WebCheckpointSpec,
  DeploymentIdentity, DeploymentVerification, ExecutionTarget,
} from "./contracts/model"
export {
  ProjectConfigSchema,
  ProjectConfigError,
  WebScenarioSourceSchema,
  WebPolicySourceSchema,
  assertProjectConfig,
  assertWebScenarioSource,
  assertWebPolicySource,
  validateProjectConfig,
  validateWebScenarioSource,
  validateWebPolicySource,
  type ProjectConfig,
  type WebScenarioSource,
  type WebPolicySource,
} from "./project/config"
export {
  evaluateScenario,
  type EvaluateScenarioOptions,
  type EvaluateScenarioResult,
  type EvaluationRunResult,
} from "./orchestrator/evaluate"
export {
  initUiEvalProject,
  type InitUiEvalProjectOptions,
  type InitUiEvalProjectResult,
} from "./cli/init"
export { runDoctor, type DoctorOptions, type DoctorResult } from "./cli/doctor"
export {
  runAgentSuite,
  type AgentRunResult,
  type RunAgentOptions,
} from "./agent/run"
export {
  renderAgentSummaryHtml,
  writeAgentSummaryArtifacts,
} from "./agent/report"
export { AgentSuiteSchema, type AgentSuite } from "./agent/config"
export { AgentRunResultSchema } from "./agent/model"
export { IncompleteCleanupError } from "./runtime/cleanup"
export { ExecutionProfileSchema, resolveExecutionProfile, type ExecutionProfile } from "./project/execution-profile"
export { selectAgentScenarios } from "./agent/selection"
export {
  LocalArtifactStore,
  RunStore,
  type ArtifactRef as LocalArtifactRef,
} from "./storage-local/index"
