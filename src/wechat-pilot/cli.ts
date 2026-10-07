import { parseArgs } from "node:util"
import { doctorWechatPilot, evaluateWechatPilot, type WechatDependencies } from "./run"

export async function runWechatPilotCli(args: string[], io: { cwd: string; stdout: (value: string) => void }, signal?: AbortSignal, deps: WechatDependencies = {}): Promise<number> {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
    "project-root": { type: "string" }, driver: { type: "string" }, format: { type: "string", default: "text" },
  } })
  const [operation, scenario, ...extra] = parsed.positionals
  if (!["text", "json"].includes(parsed.values.format!) || !["doctor", "evaluate"].includes(operation) || extra.length || (operation === "doctor" ? scenario !== undefined : !scenario)) throw new Error("Usage: wechat-pilot doctor|evaluate [scenario] --project-root <root> [--driver <wechatide>] [--format text|json]")
  const options = { projectRoot: parsed.values["project-root"] ?? io.cwd, driver: parsed.values.driver, signal }
  if (operation === "doctor") {
    const result = await doctorWechatPilot(options, deps)
    io.stdout(parsed.values.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `WeChat DevTools pilot ready: ${result.projectId}\n`)
    return 0
  }
  const output = await evaluateWechatPilot({ ...options, scenario: scenario! }, deps)
  io.stdout(parsed.values.format === "json" ? `${JSON.stringify(output, null, 2)}\n` : `${output.result.status}: ${output.htmlPath}\nMachine record: ${output.reportPath}\n`)
  return { passed: 0, failed: 1, inconclusive: 2 }[output.result.status]
}
