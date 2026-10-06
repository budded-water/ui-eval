import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { initUiEvalProject } from "../cli/init"
import { runDoctor } from "../cli/doctor"
import { evaluateScenario } from "../orchestrator/evaluate"
import { validateEvaluationReport } from "../contracts/validation"

describe.skipIf(!existsSync(chromium.executablePath()))("real-browser remote profiles", () => {
  let server: Server
  let baseUrl: string
  let revision = "not-ready"
  let driftOnPage = false
  let identityRequests = 0
  const roots: string[] = []
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/version") {
        identityRequests++
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ schemaVersion: "uieval.deployment/v1alpha1", revision }))
      } else {
        if (driftOnPage && request.url === "/home") revision = "changed-during-capture"
        response.setHeader("content-type", "text/html")
        response.end("<!doctype html><html><head><title>Synthetic preview</title></head><body><main><h1>Ready</h1></main></body></html>")
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })
  async function candidate() {
    const root = await mkdtemp(join(tmpdir(), "ui-eval-remote-browser-"))
    roots.push(root)
    await initUiEvalProject({ projectRoot: root, route: "/home", scenarioId: "home" })
    const path = join(root, "ui-eval/project.json")
    const project = JSON.parse(await readFile(path, "utf8"))
    project.baseUrls.preview = baseUrl
    project.executionProfiles = { preview: { mode: "remote", baseUrlRef: "preview", frontend: { identityPath: "/version" }, readinessTimeoutMs: 1000 } }
    // A local server would fail if accidentally launched by remote evaluation.
    project.devServer.command = "does-not-exist-ui-eval-fixture"
    await writeFile(path, JSON.stringify(project))
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["add", "."], { cwd: root })
    execFileSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid", "commit", "-qm", "Synthetic candidate"], { cwd: root })
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    identityRequests = 0
    driftOnPage = false
    return root
  }
  it("checks a clean deployed revision and captures it without acquiring the local server", async () => {
    const projectRoot = await candidate()
    expect((await runDoctor({ projectRoot, executionProfile: "preview" })).ok).toBe(true)
    const result = await evaluateScenario({ projectRoot, scenario: "home", executionProfile: "preview" })
    const run = result.runs[0]
    expect(run.executionOutcome).toBe("valid")
    expect(run.rawStatus).toBe("pass")
    expect(run.report.spec.provenance.deploymentVerification?.frontend?.revision).toBe(revision)
    expect(validateEvaluationReport(JSON.parse(await readFile(run.reportPath, "utf8")))).toEqual(run.report)
    expect(await readFile(run.htmlPath, "utf8")).toContain("Deployment verification")
    expect(identityRequests).toBe(3)
    expect((await fetch(baseUrl)).status).toBe(200)
  })
  it("refuses a post-capture version change and leaves the remote server running", async () => {
    const projectRoot = await candidate()
    driftOnPage = true
    const result = await evaluateScenario({ projectRoot, scenario: "home", executionProfile: "preview" })
    expect(result.runs[0].executionOutcome).toBe("infra-error")
    expect(result.runs[0].rawStatus).toBe("inconclusive")
    expect(result.runs[0].report.spec.provenance.deploymentVerification?.status).toBe("unverified")
    expect(identityRequests).toBe(2)
    expect((await fetch(baseUrl)).status).toBe(200)
  })
})
