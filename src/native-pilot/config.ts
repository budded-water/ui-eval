import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

const id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" })
const selector = Type.Union([
  Type.Object({ id: Type.String({ minLength: 1, maxLength: 200, pattern: "^(?!.*\\$\\{)[^\\r\\n]+$" }) }, { additionalProperties: false }),
  Type.Object({ text: Type.String({ minLength: 1, maxLength: 200, pattern: "^(?!.*\\$\\{)[^\\r\\n]+$" }) }, { additionalProperties: false }),
])
export const NativePilotScenarioSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/native-pilot-v1"),
  kind: Type.Literal("NativePilotScenario"),
  scenarioId: id,
  steps: Type.Array(Type.Union([
    Type.Object({ action: Type.Literal("tap"), selector }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("assert-visible"), selector }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("assert-hidden"), selector }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("screenshot"), checkpointId: id }, { additionalProperties: false }),
  ]), { minItems: 2, maxItems: 100 }),
}, { additionalProperties: false })

export const NativePilotProjectSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/native-pilot-v1"),
  kind: Type.Literal("NativePilotProject"),
  projectId: id,
  platform: Type.Literal("ios-simulator"),
  appId: Type.String({ pattern: "^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$" }),
  maestroVersion: Type.Literal("2.9.0"),
  restartApp: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
  scenarios: Type.Record(id, Type.String({ pattern: "^[a-zA-Z0-9/_-]+\\.json$" })),
}, { additionalProperties: false })

export type NativePilotProject = Static<typeof NativePilotProjectSchema>
export type NativePilotScenario = Static<typeof NativePilotScenarioSchema>

/** Inputs are reviewed data; escaping and symlinks are rejected before execution. */
export async function containedFile(root: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error("Native pilot input must be project-relative")
  const base = await realpath(root)
  const candidate = resolve(base, path)
  const rel = relative(base, candidate)
  if (!rel || rel === ".." || rel.startsWith("../")) throw new Error("Native pilot path escapes project")
  const info = await lstat(candidate)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Invalid native pilot input file")
  if (await realpath(candidate) !== candidate) throw new Error("Native pilot input traverses a symlink")
  return candidate
}

export async function loadNativePilotProject(root: string): Promise<NativePilotProject> {
  const data: unknown = JSON.parse(await readFile(await containedFile(root, "ui-eval/native.json"), "utf8"))
  if (!Value.Check(NativePilotProjectSchema, data)) throw new Error("Invalid native pilot project")
  if (!Object.keys(data.scenarios).length) throw new Error("Native pilot requires scenarios")
  return data
}

export async function loadNativePilotScenario(root: string, project: NativePilotProject, name: string): Promise<NativePilotScenario> {
  if (!Object.hasOwn(project.scenarios, name)) throw new Error("Unknown native pilot scenario")
  const data: unknown = JSON.parse(await readFile(await containedFile(root, project.scenarios[name]), "utf8"))
  if (!Value.Check(NativePilotScenarioSchema, data) || data.scenarioId !== name) throw new Error("Invalid native pilot scenario")
  const checkpoints = data.steps.filter((step) => step.action === "screenshot").map((step) => step.checkpointId)
  if (!checkpoints.length || new Set(checkpoints).size !== checkpoints.length) throw new Error("Native pilot needs unique screenshot checkpoints")
  if (!data.steps.some((step) => step.action === "assert-visible")) throw new Error("Native pilot needs a visibility assertion")
  for (let index = 0; index < data.steps.length; index++) {
    if (data.steps[index].action === "screenshot" && !["assert-visible", "assert-hidden"].includes(data.steps[index - 1]?.action)) {
      throw new Error("Every native screenshot must immediately follow an assertion")
    }
  }
  return data
}
