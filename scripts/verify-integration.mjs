import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import assert from "node:assert/strict"

const exec = promisify(execFile)
const engine = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(engine, "dist/cli.js")
const pkg = JSON.parse(await readFile(resolve(engine, "package.json"), "utf8"))
const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: engine })).stdout.trim()
const root = await realpath(await mkdtemp(resolve(tmpdir(), "ui-eval-prepared-web-")))
const invoke = async (args, expected) => {
  let output
  try { output = await exec(process.execPath, [cli, ...args, "--project-root", root], { cwd: engine, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { if (error.code !== expected) throw error; output = error }
  if (expected === 0) assert.equal(output.code, undefined)
  return output
}
try {
  await cp(resolve(engine, "examples/prepared-web"), root, { recursive: true })
  await invoke(["init", "--route", "/", "--scenario", "home", "--yes"], 0)
  const probe = createServer()
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", done) })
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  const projectPath = resolve(root, "ui-eval/project.json")
  const project = JSON.parse(await readFile(projectPath, "utf8"))
  project.projectId = "prepared-web"
  project.devServer = { command: process.execPath, args: ["server.mjs"], url: `http://127.0.0.1:${port}`, reuseExisting: false, startupTimeoutMs: 15000 }
  project.baseUrls.local = project.devServer.url
  await writeFile(projectPath, JSON.stringify(project))
  const scenarioPath = resolve(root, "ui-eval/scenarios/home.json")
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")); scenario.matrix.locales = ["en", "zh-CN"]
  await writeFile(scenarioPath, JSON.stringify(scenario))
  await writeFile(resolve(root, "ui-eval/engine.json"), JSON.stringify({ repository: pkg.repository.url, revision, bunVersion: pkg.packageManager.slice(4) }))
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "synthetic candidate"], { cwd: root })
  const passed = JSON.parse((await invoke(["integrate", "smoke", "--format", "json"], 0)).stdout)
  assert.equal(passed.exitCode, 0)
  assert.equal(passed.stages.filter((stage) => stage.kind === "prepare").length, 1)
  assert.equal(passed.stages.find((stage) => stage.kind === "scenario").reports.length, 2)
  assert.deepEqual(JSON.parse(await readFile(passed.summaryPath, "utf8")), passed)
  assert.match(await readFile(passed.summaryHtmlPath, "utf8"), /smoke: pass/)
  const suitePath = resolve(root, "ui-eval/integrations/smoke.json")
  const suite = JSON.parse(await readFile(suitePath, "utf8"))
  suite.checks.push({ id: "injected-defect", phase: "after", dimension: "synthetic-contract", failureOutcome: "candidate", command: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 10000 })
  await writeFile(suitePath, JSON.stringify(suite))
  const failed = JSON.parse((await invoke(["integrate", "smoke", "--format", "json"], 1)).stdout)
  assert.equal(failed.exitCode, 1); assert.equal(failed.status, "fail")
  for (const report of failed.stages.find((stage) => stage.kind === "scenario").reports) {
    assert.equal(JSON.parse(await readFile(resolve(root, report.reportPath), "utf8")).spec.rawStatus, "pass")
  }
  assert.match(await readFile(failed.summaryHtmlPath, "utf8"), /injected-defect/)
  process.stdout.write("Verified prepared Web integration, two variants, and post-check rejection.\n")
} finally { await rm(root, { recursive: true, force: true }) }
