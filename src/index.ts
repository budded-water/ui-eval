export * from "./contracts/index"
// The generic ScenarioSource contract exported above describes the forward
// multi-platform envelope. The explicitly named exports below are the
// authoring formats accepted by the currently implemented web CLI.
export {
  ProjectConfigSchema,
  ProjectConfigError,
  WebScenarioSourceSchema,
  assertProjectConfig,
  assertWebScenarioSource,
  validateProjectConfig,
  validateWebScenarioSource,
  type ProjectConfig,
  type WebScenarioSource,
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
  LocalArtifactStore,
  RunStore,
  type ArtifactRef as LocalArtifactRef,
} from "./storage-local/index"
