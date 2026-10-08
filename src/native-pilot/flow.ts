import type { NativePilotProject, NativePilotScenario } from "./config"

/** JSON quoted scalars are valid YAML scalars. No scripts, credentials or writes. */
export function compileNativePilotFlow(project: NativePilotProject, scenario: NativePilotScenario): string {
  const commands: unknown[] = [{ launchApp: { appId: project.appId, stopApp: project.restartApp ?? true } }]
  for (const step of scenario.steps) {
    if (step.action === "screenshot") commands.push({ takeScreenshot: step.checkpointId })
    else {
      const command = { tap: "tapOn", "assert-visible": "assertVisible", "assert-hidden": "assertNotVisible" }[step.action]
      commands.push({ [command]: step.selector })
    }
  }
  return `appId: ${JSON.stringify(project.appId)}\nname: ${JSON.stringify(scenario.scenarioId)}\n---\n${commands.map((command) => `- ${JSON.stringify(command)}`).join("\n")}\n`
}
