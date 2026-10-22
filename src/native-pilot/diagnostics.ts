import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import { PNG } from "pngjs"
import { containedPath } from "../wechat-pilot/config"
import { boundedFile, inspectWechatPng } from "../wechat-pilot/evidence"
import type { NativePilotScenario } from "./config"

const strict = { additionalProperties: false }
const file = Type.Object({ path: Type.String({ pattern: "^driver/(?:[A-Za-z0-9][A-Za-z0-9_-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*$" }), digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }) }, strict)
const image = Type.Object({ ...file.properties, widthPx: Type.Integer({ minimum: 1 }), heightPx: Type.Integer({ minimum: 1 }) }, strict)
export const NativeFailureDiagnosticSchema = Type.Object({
  method: Type.Literal("existing-driver-artifacts"),
  failedStep: Type.Integer({ minimum: 0 }),
  precedingInteraction: Type.Optional(Type.Object({ step: Type.Integer({ minimum: 0 }), action: Type.Union([Type.Literal("tap"), Type.Literal("swipe"), Type.Literal("drag"), Type.Literal("input-text"), Type.Literal("erase-text")]) }, strict)),
  before: Type.Optional(image), after: Type.Optional(image), hierarchy: Type.Optional(file),
  imageComparison: Type.Union([Type.Literal("identical-pixels"), Type.Literal("different-pixels"), Type.Literal("unavailable")]),
  targetBounds: Type.Optional(Type.Object({ x: Type.Integer(), y: Type.Integer(), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, strict)),
  targetBoundsBasis: Type.Literal("unique-exact-selector-in-post-failure-hierarchy-only"),
  cause: Type.Literal("undetermined"),
  nextAction: Type.Literal("Inspect the selected App state, overlays and input delivery; a completed command does not prove the intended UI changed."),
}, strict)
export type NativeFailureDiagnostic = Static<typeof NativeFailureDiagnosticSchema>

/** Supplemental observations only. No new device commands, retries or failure waivers. */
export async function nativeFailureDiagnostic(directory: string, commandPath: string, commands: unknown[], scenario: NativePilotScenario) {
  const failed = commands.length - 1 - 3
  const diagnostic: NativeFailureDiagnostic = {
    method: "existing-driver-artifacts", failedStep: failed, imageComparison: "unavailable",
    targetBoundsBasis: "unique-exact-selector-in-post-failure-hierarchy-only", cause: "undetermined",
    nextAction: "Inspect the selected App state, overlays and input delivery; a completed command does not prove the intended UI changed.",
  }
  const files: Array<{ path: string; digest: string }> = []
  const read = async (path: string, maximum: number) => {
    const name = relative(directory, path)
    const bytes = await boundedFile(await containedPath(directory, name), maximum)
    return { bytes, reference: { path: name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` } }
  }
  const screenshot = async (path: string) => {
    const value = await read(path, 32 * 1024 * 1024)
    const png = inspectWechatPng(value.bytes)
    files.push(value.reference)
    return { bytes: value.bytes, reference: { ...value.reference, widthPx: png.width, heightPx: png.height } }
  }
  // Find the last completed interaction; intervening assertions/screenshots are allowed.
  for (let index = failed - 1; index >= 0; index--) {
    const step = scenario.steps[index]
    if (["tap", "swipe", "drag", "input-text", "erase-text"].includes(step.action)) {
      diagnostic.precedingInteraction = { step: index, action: step.action as NonNullable<NativeFailureDiagnostic["precedingInteraction"]>["action"] }
      break
    }
  }
  let beforeIndex = -1
  for (let index = (diagnostic.precedingInteraction?.step ?? failed) - 1; index >= 0; index--) {
    if (scenario.steps[index].action === "screenshot") { beforeIndex = index; break }
  }
  let before: Awaited<ReturnType<typeof screenshot>> | undefined
  let after: Awaited<ReturnType<typeof screenshot>> | undefined
  if (beforeIndex >= 0) {
    const step = scenario.steps[beforeIndex]
    if (step.action === "screenshot") {
      try { before = await screenshot(resolve(dirname(commandPath), "takeScreenshot", `${step.checkpointId}.png`)); diagnostic.before = before.reference } catch { /* Optional missing/invalid diagnostic evidence is never a pass. */ }
    }
  }
  const artifact = async (folder: string, extension: string) => {
    const base = await containedPath(directory, relative(directory, resolve(dirname(commandPath), folder)))
    const names = await readdir(base)
    if (names.length > 200) throw new Error("Diagnostic artifact budget exceeded")
    const prefix = `step-${String(failed + 4).padStart(3, "0")}-`
    const matches = names.filter((name) => name.startsWith(prefix) && name.endsWith(extension))
    if (matches.length !== 1) throw new Error("Diagnostic artifact is missing or ambiguous")
    return resolve(base, matches[0])
  }
  try { after = await screenshot(await artifact("screenshots", ".png")); diagnostic.after = after.reference } catch { /* Supplemental only. */ }
  if (before && after && before.reference.widthPx === after.reference.widthPx && before.reference.heightPx === after.reference.heightPx) {
    diagnostic.imageComparison = PNG.sync.read(before.bytes).data.equals(PNG.sync.read(after.bytes).data) ? "identical-pixels" : "different-pixels"
  }
  try {
    const value = await read(await artifact("screen-hierarchy", ".json"), 1024 * 1024)
    const tree: unknown = JSON.parse(value.bytes.toString("utf8"))
    const interaction = scenario.steps[diagnostic.precedingInteraction?.step ?? -1]
    const selector = interaction?.action === "tap" ? interaction.selector : undefined
    const matches: string[] = []
    let nodes = 0
    const visit = (node: unknown, depth: number) => {
      if (++nodes > 10000 || depth > 100) throw new Error("Diagnostic hierarchy budget exceeded")
      if (!node || typeof node !== "object" || Array.isArray(node)) return
      const item = node as { attributes?: Record<string, unknown>; children?: unknown[] }
      const attrs = item.attributes
      if (selector && attrs && ("id" in selector ? attrs["resource-id"] === selector.id : attrs.accessibilityText === selector.text || attrs.text === selector.text) && typeof attrs.bounds === "string") matches.push(attrs.bounds)
      if (Array.isArray(item.children)) item.children.forEach((child) => visit(child, depth + 1))
    }
    visit(tree, 0)
    diagnostic.hierarchy = value.reference
    files.push(value.reference)
    const bounds = matches.length === 1 ? /^\[(-?\d{1,6}),(-?\d{1,6})\]\[(-?\d{1,6}),(-?\d{1,6})\]$/.exec(matches[0]) : null
    if (bounds) {
      const [x, y, right, bottom] = bounds.slice(1).map(Number)
      if (right > x && bottom > y) diagnostic.targetBounds = { x, y, width: right - x, height: bottom - y }
    }
  } catch { /* No raw tree/error contents enter shared result fields. */ }
  return { diagnostic, files }
}
