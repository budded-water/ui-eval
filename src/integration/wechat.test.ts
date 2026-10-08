import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PNG } from "pngjs"
import { evaluateWechatPilot } from "../wechat-pilot/run"
import type { CommandRunner } from "../wechat-pilot/driver"
import { runIntegrationSuite } from "./run"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const source = async () => ({ repository: "synthetic", commitSha: "a".repeat(40), dirtyTree: false })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ui-eval-wechat-integration-"))); roots.push(root)
  await mkdir(join(root, "ui-eval/integrations"), { recursive: true })
  await mkdir(join(root, ".ui-eval/runtime/miniprogram"), { recursive: true })
  await writeFile(join(root, "ui-eval/engine.json"), JSON.stringify({ repository: "https://example.invalid/ui-eval.git", revision: "a".repeat(40) }))
  await writeFile(join(root, "ui-eval/integrations/smoke.json"), JSON.stringify({ apiVersion: "uieval.io/integration-v1alpha1", kind: "IntegrationSuite",
    id: "smoke", projectId: "synthetic-app", adapter: "wechat-pilot", checks: [], scenarios: [{ id: "login", timeoutMs: 10000 }] }))
  await writeFile(join(root, "ui-eval/wechat.json"), JSON.stringify({ apiVersion: "uieval.io/wechat-pilot-v1", kind: "WechatPilotProject", projectId: "synthetic-app",
    runtimeProject: ".ui-eval/runtime", appId: "wx0123456789abcdef", driver: { clientName: "Codex", skillVersion: "0.3.9" }, timeoutMs: 30000,
    scenarios: { login: "ui-eval/login.json" } }))
  await writeFile(join(root, "ui-eval/login.json"), JSON.stringify({ apiVersion: "uieval.io/wechat-pilot-v1", kind: "WechatPilotScenario", id: "login",
    storage: [], mocks: [], steps: [{ action: "navigate", url: "/pages/login/index" }, { action: "assertText", selector: ".title", includes: "Sign in" }, { action: "screenshot", checkpointId: "login" }] }))
  await writeFile(join(root, ".ui-eval/runtime/project.config.json"), JSON.stringify({ compileType: "miniprogram", appid: "wx0123456789abcdef", miniprogramRoot: "miniprogram" }))
  await writeFile(join(root, ".ui-eval/runtime/ui-eval-runtime.json"), JSON.stringify({ synthetic: true, projectId: "synthetic-app" }))
  await writeFile(join(root, ".ui-eval/runtime/miniprogram/app.js"), "App({})")
  await writeFile(join(root, ".ui-eval/runtime/miniprogram/app.json"), '{"pages":["pages/login/index"]}')
  return root
}
function driver(text = "Sign in"): CommandRunner {
  return async (_binary, args) => {
    const tool = args[2]
    let result: unknown = { success: true }
    if (tool === "check_wechatide_status") result = { success: true, loginExpired: false, tokenRequired: false, skillVersion: "0.3.9", versionRelation: "equal" }
    if (tool === "automation_element_action") result = text
    if (tool === "simulator_screenshot") {
      const path = args[args.indexOf("--path") + 1]
      await writeFile(path, PNG.sync.write(new PNG({ width: 2, height: 2 })))
      result = { success: true, path, imageWidth: 2, imageHeight: 2 }
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, tool, clientName: args[1], result }), stderr: "" }
  }
}
describe("WeChat integration capabilities", () => {
  it.each(["Sign in", "Wrong page"])("aggregates declared pilot evidence with truthful coverage (%s)", async (text) => {
    const root = await fixture()
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { source, verifyEngine: async () => {},
      wechat: (options) => evaluateWechatPilot(options, { source, command: driver(text) }),
    })
    expect(result.exitCode).toBe(text === "Sign in" ? 0 : 1)
    const reports = result.stages.find((stage) => stage.kind === "scenario")!.reports
    expect(reports[0].capabilities).toContainEqual(expect.objectContaining({ dimension: "Runtime / network / design / real device", status: "unsupported" }))
    expect(await readFile(result.summaryHtmlPath, "utf8")).toContain("Experimental WeChat DevTools evidence only")
  })
  it("stops after incomplete runtime cleanup even when an adapter report was published", async () => {
    const root = await fixture()
    const command = vi.fn()
    const path = join(root, "ui-eval/integrations/smoke.json")
    const suite = JSON.parse(await readFile(path, "utf8"))
    suite.checks = [{ id: "after", phase: "after", dimension: "api", failureOutcome: "candidate", command: "node", args: [], timeoutMs: 1000 }]
    await writeFile(path, JSON.stringify(suite))
    const result = await runIntegrationSuite({ projectRoot: root, suite: "smoke" }, { source, verifyEngine: async () => {}, command,
      wechat: async (options) => {
        const output = await evaluateWechatPilot(options, { source, command: driver() })
        output.result.status = "inconclusive"; output.result.cleanup = "incomplete"
        await writeFile(output.reportPath, JSON.stringify(output.result))
        return output
      },
    })
    expect(result.exitCode).toBe(2); expect(command).not.toHaveBeenCalled()
    expect(result.stages.find((stage) => stage.kind === "scenario")?.cleanupSettled).toBe(false)
  })
})
