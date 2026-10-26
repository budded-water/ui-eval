import type { NativePilotProject, NativePilotScenario } from "./config"

/** JSON quoted scalars are valid YAML scalars. No scripts, credentials or writes. */
export function compileNativePilotFlow(project: NativePilotProject, scenario: NativePilotScenario, launchApp = true): string {
  const commands: unknown[] = launchApp ? [{ launchApp: { appId: project.appId, stopApp: project.restartApp ?? true } }] : []
  for (const step of scenario.steps) {
    if (step.action === "screenshot") commands.push({ takeScreenshot: step.checkpointId })
    else if (step.action === "input-text") commands.push({ inputText: step.text })
    else if (step.action === "erase-text") commands.push({ eraseText: step.characters })
    else if (step.action === "swipe") commands.push({ swipe: { direction: step.direction, duration: 400, ...(step.selector ? { from: step.selector } : {}) } })
    else if (step.action === "drag") commands.push({ swipe: { start: `${step.start.x}%,${step.start.y}%`, end: `${step.end.x}%,${step.end.y}%`, duration: step.durationMs } })
    else {
      const command = { tap: "tapOn", "assert-visible": "assertVisible", "assert-hidden": "assertNotVisible" }[step.action]
      commands.push({ [command]: step.selector })
    }
  }
  return `appId: ${JSON.stringify(project.appId)}\nname: ${JSON.stringify(scenario.scenarioId)}\n---\n${commands.map((command) => `- ${JSON.stringify(command)}`).join("\n")}\n`
}

/** Partition only at trusted opt-in checkpoints; continuations never relaunch the App. */
export function nativeCaptureSegments(project: NativePilotProject, scenario: NativePilotScenario) {
  if (!scenario.steps.some((step) => step.action === "screenshot" && step.supplementalCapture)) return undefined
  const segments: Array<{ startStep: number; endStep: number; flow: string }> = []
  let startStep = 0
  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index]
    if (index !== scenario.steps.length - 1 && !(step.action === "screenshot" && step.supplementalCapture)) continue
    const endStep = index + 1
    segments.push({ startStep, endStep, flow: compileNativePilotFlow(project, { ...scenario, steps: scenario.steps.slice(startStep, endStep) }, startStep === 0) })
    startStep = endStep
  }
  return segments
}
