import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { doctorNativePilot, evaluateNativePilot } from "./run"

export async function nativePilotCommand(args: string[], io: { cwd: string; stdout: (text: string) => void }, signal?: AbortSignal): Promise<number> {
  const [command, ...rest] = args
  const parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: {
    "project-root": { type: "string" }, device: { type: "string" }, format: { type: "string", default: "text" },
  } })
  if (!["text", "json"].includes(parsed.values.format!)) throw new Error("Native pilot format must be text or json")
  if (!parsed.values.device) throw new Error("Native pilot requires --device simulator-uuid")
  const options = { projectRoot: resolve(parsed.values["project-root"] ?? io.cwd), deviceId: parsed.values.device, signal }
  if (command === "doctor" && parsed.positionals.length === 0) {
    const result = await doctorNativePilot(options)
    io.stdout(parsed.values.format === "json" ? JSON.stringify({ experimental: true, ...result }) + "\n" : `Native pilot prerequisites ready: ${result.device.name}\n`)
    return 0
  }
  if (command !== "evaluate" || parsed.positionals.length !== 1) throw new Error("Usage: native-pilot doctor | evaluate <scenario> --device <uuid>")
  const run = await evaluateNativePilot({ ...options, scenario: parsed.positionals[0] })
  io.stdout(parsed.values.format === "json" ? JSON.stringify(run) + "\n" : `${run.result.status.toUpperCase()} ${run.result.scenarioId}\n  ${run.result.reason}\n  HTML: ${run.htmlPath}\n  JSON: ${run.reportPath}\n`)
  return run.result.status === "passed" ? 0 : run.result.status === "failed" ? 1 : 2
}
