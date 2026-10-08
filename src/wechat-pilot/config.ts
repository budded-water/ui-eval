import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const strict = { additionalProperties: false }
const id = Type.String({ pattern: "^[a-z][a-z0-9-]{0,79}$" })
const text = Type.String({ minLength: 1, maxLength: 2048 })
const selector = Type.String({ minLength: 1, maxLength: 512 })
const path = Type.String({ minLength: 1, maxLength: 512, pattern: "^(?!/)(?!.*\\.\\.)" })
const value = Type.Unknown()
export const WechatPilotProjectSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/wechat-pilot-v1"),
  kind: Type.Literal("WechatPilotProject"),
  projectId: id,
  runtimeProject: Type.String({ pattern: "^\\.ui-eval/", maxLength: 512 }),
  appId: Type.String({ pattern: "^wx[a-f0-9]{16}$" }),
  driver: Type.Object({ clientName: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{0,39}$" }), skillVersion: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }) }, strict),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 300000 }),
  scenarios: Type.Record(id, path),
}, strict)
export const WechatPilotStepSchema = Type.Union([
  Type.Object({ action: Type.Literal("navigate"), url: Type.String({ pattern: "^/pages/", maxLength: 512 }) }, strict),
  Type.Object({ action: Type.Literal("tap"), selector }, strict),
  Type.Object({ action: Type.Literal("input"), selector, value: Type.String({ maxLength: 2048 }) }, strict),
  Type.Object({ action: Type.Literal("assertText"), selector, includes: text }, strict),
  Type.Object({ action: Type.Literal("assertPage"), path: Type.String({ pattern: "^pages/", maxLength: 512 }) }, strict),
  Type.Object({ action: Type.Literal("screenshot"), checkpointId: id }, strict),
])
export const WechatPilotScenarioSchema = Type.Object({
  apiVersion: Type.Literal("uieval.io/wechat-pilot-v1"),
  kind: Type.Literal("WechatPilotScenario"),
  id,
  storage: Type.Array(Type.Object({ key: Type.String({ minLength: 1, maxLength: 128 }), value: Type.Optional(value) }, strict), { maxItems: 20 }),
  mocks: Type.Array(Type.Object({ method: Type.Literal("getLocation"), result: Type.Object({ latitude: Type.Number(), longitude: Type.Number() }, strict) }, strict), { maxItems: 1 }),
  steps: Type.Array(WechatPilotStepSchema, { minItems: 3, maxItems: 100 }),
}, strict)
export type WechatPilotProject = Static<typeof WechatPilotProjectSchema>
export type WechatPilotScenario = Static<typeof WechatPilotScenarioSchema>
export type WechatPilotStep = Static<typeof WechatPilotStepSchema>

/** Refuse escapes and every symlink below the caller's explicitly selected root. */
export async function containedPath(root: string, name: string, create = false): Promise<string> {
  const target = resolve(root, name)
  const part = relative(resolve(root), target)
  if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Pilot path must stay below its project root")
  let current = resolve(root)
  for (const component of part.split(sep)) {
    current = resolve(current, component)
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error("Pilot paths must not traverse symlinks")
    if (current !== target && !stat.isDirectory()) throw new Error("Pilot path ancestor is not a directory")
  }
  return target
}

async function json(root: string, name: string): Promise<unknown> {
  const file = await containedPath(root, name)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Pilot input must be a bounded regular JSON file")
  return JSON.parse(await readFile(file, "utf8"))
}
export async function loadWechatProject(root: string): Promise<WechatPilotProject> {
  const input = await json(root, "ui-eval/wechat.json")
  if (!Value.Check(WechatPilotProjectSchema, input) || !Object.keys(input.scenarios).length) throw new Error("Invalid WeChat pilot project")
  const runtime = await containedPath(root, input.runtimeProject)
  try {
    await lstat(resolve(runtime, "project.private.config.json"))
    throw new Error("Dedicated pilot runtime must not contain private configuration overrides")
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const config = await json(root, `${input.runtimeProject}/project.config.json`) as Record<string, unknown>
  const marker = await json(root, `${input.runtimeProject}/ui-eval-runtime.json`) as Record<string, unknown>
  if (config.compileType !== "miniprogram" || config.appid !== input.appId || marker.projectId !== input.projectId || marker.synthetic !== true) throw new Error("WeChat pilot requires a matching dedicated synthetic runtime project")
  if (typeof config.miniprogramRoot !== "string") throw new Error("Missing compiled mini-program root")
  await containedPath(runtime, config.miniprogramRoot)
  return input
}
export async function loadWechatScenario(root: string, project: WechatPilotProject, name: string): Promise<WechatPilotScenario> {
  if (!Object.hasOwn(project.scenarios, name)) throw new Error("Unknown WeChat pilot scenario")
  const input = await json(root, project.scenarios[name])
  if (!Value.Check(WechatPilotScenarioSchema, input) || input.id !== name) throw new Error("Invalid WeChat pilot scenario")
  const keys = input.storage.map((entry) => entry.key)
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate pilot storage key")
  const shots = new Set<string>()
  let assertions = 0
  input.steps.forEach((step, index) => {
    if (step.action === "assertText" || step.action === "assertPage") assertions++
    if (step.action !== "screenshot") return
    const previous = input.steps[index - 1]
    if (!previous || !["assertText", "assertPage"].includes(previous.action) || shots.has(step.checkpointId)) throw new Error("Each unique screenshot must immediately follow an assertion")
    shots.add(step.checkpointId)
  })
  if (!assertions || !shots.size) throw new Error("WeChat pilot requires assertions and screenshots")
  return input
}
