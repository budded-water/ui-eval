import { describe, expect, it } from "vitest"
import { Value } from "@sinclair/typebox/value"
import { NativePilotScenarioSchema, type NativePilotProject, type NativePilotScenario } from "./config"
import { compileNativePilotFlow } from "./flow"
import { inspectNativeCommands } from "./evidence"
import { readFileSync } from "node:fs"

const device = "11111111-1111-1111-1111-111111111111"
const project: NativePilotProject = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotProject", projectId: "probe", platform: "ios-simulator", appId: "test.app", maestroVersion: "2.9.0", timeoutMs: 1000, scenarios: { form: "ui-eval/form.json" } }
const scenario: NativePilotScenario = { apiVersion: "uieval.io/native-pilot-v1", kind: "NativePilotScenario", scenarioId: "form", steps: [
  { action: "input-text", text: "Synthetic form text" },
  { action: "erase-text", characters: 4 },
  { action: "swipe", direction: "UP" },
  { action: "swipe", direction: "LEFT", selector: { id: "paged-grid" } },
  { action: "assert-visible", selector: { id: "form-result" } },
  { action: "screenshot", checkpointId: "form" },
] }
function records() {
  const commands = [
    { defineVariablesCommand: { env: { MAESTRO_FILENAME: "flow", MAESTRO_DEVICE_UDID: device, MAESTRO_SHARD_ID: "1", MAESTRO_SHARD_INDEX: "0" }, optional: false } },
    { applyConfigurationCommand: { config: { appId: "test.app", name: "form" }, optional: false } },
    { launchAppCommand: { appId: "test.app", stopApp: true, optional: false } },
    { inputTextCommand: { text: "Synthetic form text", optional: false } },
    { eraseTextCommand: { charactersToErase: 4, optional: false } },
    { swipeCommand: { direction: "UP", duration: 400, optional: false } },
    { swipeCommand: { direction: "LEFT", duration: 400, elementSelector: { idRegex: "paged-grid", optional: false }, optional: false } },
    { assertConditionCommand: { condition: { visible: { idRegex: "form-result", optional: false } }, optional: false } },
    { takeScreenshotCommand: { path: "form", optional: false } },
  ]
  return commands.map((command, index) => ({ command, metadata: { evaluatedCommand: command, sequenceNumber: index, depth: 0, status: "COMPLETED" } }))
}
describe("native form and navigation commands", () => {
  it("accepts real Maestro 2.9.0 form and swipe records with candidate labels normalized", () => {
    // Observed iOS Simulator command objects; only candidate text labels were
    // normalized. Preserve serialized field names/defaults, not App inputs.
    const observed = JSON.parse(readFileSync(new URL("./fixtures/form-navigation-commands.json", import.meta.url), "utf8")) as Record<string, unknown>[]
    const probe: NativePilotScenario = { ...scenario, steps: [
      { action: "input-text", text: "123" },
      { action: "erase-text", characters: 1 },
      { action: "swipe", direction: "LEFT", selector: { text: "paged-grid" } },
      { action: "swipe", direction: "RIGHT", selector: { text: "paged-grid" } },
      { action: "swipe", direction: "UP" },
      { action: "swipe", direction: "DOWN" },
      ...scenario.steps.slice(4),
    ] }
    const metadata = observed.map((command, index) => ({ command, metadata: { evaluatedCommand: command, sequenceNumber: index + 3, depth: 0, status: "COMPLETED" } }))
    const data = [...records().slice(0, 3), ...metadata, ...records().slice(-2).map((row, index) => ({ ...row, metadata: { ...row.metadata, sequenceNumber: index + 9 } }))]
    expect(inspectNativeCommands(data, project, probe, device)).toEqual({ passed: 1, failed: 0, complete: true })
    const tampered = structuredClone(data)
    Object.assign(tampered[5].command.swipeCommand as object, { startRelative: "50%,50%" })
    expect(() => inspectNativeCommands(tampered, project, probe, device)).toThrow(/binding/)
  })
  it("compiles bounded literal actions and preserves required assertions", () => {
    expect(Value.Check(NativePilotScenarioSchema, scenario)).toBe(true)
    const flow = compileNativePilotFlow(project, scenario)
    expect(flow).toContain('"inputText":"Synthetic form text"')
    expect(flow).toContain('"eraseText":4')
    expect(flow).toContain('"swipe":{"direction":"LEFT","duration":400,"from":{"id":"paged-grid"}}')
    expect(inspectNativeCommands(records(), project, scenario, device)).toEqual({ passed: 1, failed: 0, complete: true })
  })
  it.each([
    { action: "input-text", text: "${SECRET}" },
    { action: "input-text", text: "" },
    { action: "input-text", text: "x".repeat(513) },
    { action: "input-text", text: "line\nbreak" },
    { action: "erase-text", characters: 0 },
    { action: "erase-text", characters: 513 },
    { action: "hide-keyboard" },
    { action: "swipe", direction: "DIAGONAL" },
    { action: "swipe", direction: "UP", start: "50%,50%" },
    { action: "swipe", direction: "UP", selector: { id: "${TARGET}" } },
  ])("rejects unsupported or unbounded authoring %j", (step) => {
    expect(Value.Check(NativePilotScenarioSchema, { ...scenario, steps: [step, ...scenario.steps.slice(4)] })).toBe(false)
  })
  it.each([
    [3, "inputTextCommand", { text: "Different form text" }],
    [4, "eraseTextCommand", { charactersToErase: 5 }],
    [5, "swipeCommand", { direction: "DOWN" }],
    [5, "swipeCommand", { duration: 500 }],
    [6, "swipeCommand", { elementSelector: { idRegex: "another-grid", optional: false } }],
    [6, "swipeCommand", { startRelative: "50%,50%" }],
  ] as const)("rejects divergent command evidence at %s", (index, key, change) => {
    const data = records()
    Object.assign((data[index].command as Record<string, unknown>)[key] as object, change)
    expect(() => inspectNativeCommands(data, project, scenario, device)).toThrow(/binding/)
  })
  it("never counts successful input or gestures as assertions, and requires complete evidence", () => {
    expect(inspectNativeCommands(records().slice(0, 7), project, scenario, device)).toEqual({ passed: 0, failed: 0, complete: false })
  })
})
