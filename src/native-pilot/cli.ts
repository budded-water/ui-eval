import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { doctorNativePilot, evaluateNativePilot } from "./run"
import { recordNativeReview } from "./review"

export async function nativePilotCommand(args: string[], io: { cwd: string; stdout: (text: string) => void }, signal?: AbortSignal): Promise<number> {
  const [command, ...rest] = args
  const parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: {
    "project-root": { type: "string" }, device: { type: "string" }, format: { type: "string", default: "text" },
    report: { type: "string" }, review: { type: "string" }, decision: { type: "string" }, reviewer: { type: "string" }, note: { type: "string" },
  } })
  if (!["text", "json"].includes(parsed.values.format!)) throw new Error("Native pilot format must be text or json")
  if (command === "review") {
    const { report, review, decision, reviewer, note } = parsed.values
    if (parsed.positionals.length || !report || !review || !reviewer || !note || (decision !== "pass" && decision !== "fail")) throw new Error("Usage: native-pilot review --report <project-relative-report> --review <declared-id> --decision pass|fail --reviewer <alias> --note <observation>")
    signal?.throwIfAborted()
    const output = await recordNativeReview({ projectRoot: resolve(parsed.values["project-root"] ?? io.cwd), report, review, decision, reviewer, note })
    io.stdout(parsed.values.format === "json" ? JSON.stringify(output) + "\n" : `HUMAN ${decision.toUpperCase()} ${review}\n  HTML: ${output.htmlPath}\n  JSON: ${output.reportPath}\n`)
    return decision === "pass" ? 0 : 1
  }
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
