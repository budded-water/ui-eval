import type { AgentSuite } from "./config"

/** Suggestions may add declared scenarios, but never remove or redefine the floor. */
export function selectAgentScenarios(suite: AgentSuite, suggestions: readonly string[] = [], fullScope = false): AgentSuite["scenarios"] {
  const selected = [...suite.scenarios]
  const known = new Map([...suite.scenarios, ...(suite.optionalScenarios ?? [])].map((scenario) => [scenario.id, scenario]))
  const additions = fullScope ? [...known.keys(), ...suggestions] : suggestions
  for (const id of additions) {
    const scenario = known.get(id)
    if (!scenario) throw new Error(`Undeclared scenario suggestion: ${id}`)
    if (!selected.some((entry) => entry.id === id)) selected.push(scenario)
  }
  return selected
}
