import { parseArgs } from "node:util"
import { doctorWechatPilot, evaluateWechatPilot, type WechatDependencies } from "./run"
import { probeWechatPilot } from "./probe"
import { recordWechatReview } from "./review"
import { assessWechatScope } from "./assess"

export async function runWechatPilotCli(args: string[], io: { cwd: string; stdout: (value: string) => void }, signal?: AbortSignal, deps: WechatDependencies = {}): Promise<number> {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
    "project-root": { type: "string" }, driver: { type: "string" }, format: { type: "string", default: "text" },
    report: { type: "string" }, review: { type: "string" }, decision: { type: "string" }, reviewer: { type: "string" }, note: { type: "string" }, scope: { type: "string" },
  } })
  const [operation, scenario, ...extra] = parsed.positionals
  if (!["text", "json"].includes(parsed.values.format!) || !["doctor", "probe", "evaluate", "review", "assess"].includes(operation) || extra.length || (operation === "evaluate" ? !scenario : scenario !== undefined)) throw new Error("Usage: wechat-pilot doctor|probe|evaluate|review|assess [scenario] --project-root <root> [--format text|json]")
  const reviewKeys = ["report", "review", "decision", "reviewer", "note"] as const
  if (operation !== "review" && reviewKeys.some((key) => parsed.values[key] !== undefined) || operation !== "assess" && parsed.values.scope !== undefined || ["review", "assess"].includes(operation) && parsed.values.driver !== undefined) throw new Error("Options do not belong to the selected WeChat operation")
  const options = { projectRoot: parsed.values["project-root"] ?? io.cwd, driver: parsed.values.driver, signal }
  if (operation === "review") {
    if (reviewKeys.some((key) => !parsed.values[key]) || !["pass", "fail", "inconclusive"].includes(parsed.values.decision!)) throw new Error("review requires --report, --review, --decision pass|fail|inconclusive, --reviewer and --note")
    const output = await recordWechatReview({ projectRoot: options.projectRoot, report: parsed.values.report!, review: parsed.values.review!, decision: parsed.values.decision as "pass" | "fail" | "inconclusive", reviewer: parsed.values.reviewer!, note: parsed.values.note! }, deps.source)
    io.stdout(parsed.values.format === "json" ? `${JSON.stringify(output, null, 2)}\n` : `${output.result.decision}: ${output.htmlPath}\nMachine record: ${output.reportPath}\n`)
    return { pass: 0, fail: 1, inconclusive: 2 }[output.result.decision]
  }
  if (operation === "assess") {
    if (!parsed.values.scope) throw new Error("assess requires --scope")
    const output = await assessWechatScope({ projectRoot: options.projectRoot, scope: parsed.values.scope }, deps.source)
    io.stdout(parsed.values.format === "json" ? `${JSON.stringify(output, null, 2)}\n` : `Scoped verification: ${output.htmlPath}\nMachine record: ${output.reportPath}\n`)
    return output.record.assessment.exitCode
  }
  if (operation === "probe") {
    const result = await probeWechatPilot(options, deps)
    io.stdout(parsed.values.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `WeChat isolated runtime: ${result.status}; UI acceptance not assessed\n`)
    return result.status === "ready" && result.cleanup === "completed" ? 0 : 2
  }
  if (operation === "doctor") {
    const result = await doctorWechatPilot(options, deps)
    io.stdout(parsed.values.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `WeChat DevTools pilot ready: ${result.projectId}\n`)
    return 0
  }
  const output = await evaluateWechatPilot({ ...options, scenario: scenario! }, deps)
  io.stdout(parsed.values.format === "json" ? `${JSON.stringify(output, null, 2)}\n` : `${output.result.status}: ${output.htmlPath}\nMachine record: ${output.reportPath}\n`)
  return { passed: 0, failed: 1, inconclusive: 2 }[output.result.status]
}
