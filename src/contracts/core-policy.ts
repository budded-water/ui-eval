/** Executable core invariants shared by authoring expansion and the registry. */
export const CORE_EVALUATOR_VERSION = "0.1.0" as const
export const CORE_EVALUATOR_CONFIGS = {
  execution: {},
  interaction: {},
  runtime: { sameOrigin5xxIsCritical: true, consoleErrorIsAdvisory: true },
} as const
export const CORE_GATE_REQUIREMENTS = [
  { id: "execution-valid", metric: "execution.valid", value: true },
  { id: "interaction-assertions", metric: "interaction.failedAssertions", value: 0 },
  { id: "runtime-critical-errors", metric: "runtime.criticalErrors", value: 0 },
] as const
