import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { initUiEvalProject } from "./init"
import { runDoctor } from "./doctor"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("runDoctor", () => {
  it("fails a remote prerequisite rather than claiming it will start a local server", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-doctor-remote-"))
    roots.push(projectRoot)
    await initUiEvalProject({ projectRoot, route: "/", scenarioId: "home" })
    const path = join(projectRoot, "ui-eval/project.json")
    const project = JSON.parse(await readFile(path, "utf8"))
    project.baseUrls.preview = "https://preview.example.invalid"
    project.executionProfiles = { preview: { mode: "remote", baseUrlRef: "preview", frontend: { identityPath: "/version" }, readinessTimeoutMs: 10 } }
    await writeFile(path, JSON.stringify(project))
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("offline") })
    const result = await runDoctor({ projectRoot, executionProfile: "preview", checkBrowser: async () => "test", fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "deployment", status: "fail" }))
    expect(result.checks.some((check) => check.id === "dev-server")).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("does not probe a local server for an unknown profile", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-doctor-profile-"))
    roots.push(projectRoot)
    await initUiEvalProject({ projectRoot, route: "/", scenarioId: "home" })
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await runDoctor({ projectRoot, executionProfile: "missing", checkBrowser: async () => "test", fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "config", status: "fail" }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("reports machine-readable checks and treats an offline server as a warning", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-doctor-"))
    roots.push(projectRoot)
    await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })

    const result = await runDoctor({
      projectRoot,
      checkBrowser: async () => "123.0.0",
      fetchImpl: async () => {
        throw new Error("offline")
      },
    })

    expect(result.ok).toBe(true)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config", status: "pass" }),
        expect.objectContaining({ id: "browser", status: "pass" }),
        expect.objectContaining({ id: "dev-server", status: "warn" }),
      ]),
    )
  })

  it("fails truthfully when config and browser are unavailable", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-doctor-"))
    roots.push(projectRoot)
    await writeFile(join(projectRoot, "placeholder"), "", "utf8")

    const result = await runDoctor({
      projectRoot,
      checkBrowser: async () => {
        throw new Error("browser missing")
      },
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config", status: "fail" }),
        expect.objectContaining({ id: "browser", status: "fail" }),
      ]),
    )
  })

  it("fails for an occupied unowned server because evaluate cannot proceed", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-doctor-"))
    roots.push(projectRoot)
    await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })

    const result = await runDoctor({
      projectRoot,
      checkBrowser: async () => "123.0.0",
      fetchImpl: async (_input, init) => {
        expect(init?.redirect).toBe("manual")
        return new Response("another app", { status: 200 })
      },
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dev-server", status: "fail" }),
      ]),
    )
  })

  it("fails when a reusable server does not prove the configured identity", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-doctor-"))
    roots.push(projectRoot)
    await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })
    const projectPath = join(projectRoot, "ui-eval/project.json")
    const config = JSON.parse(await readFile(projectPath, "utf8")) as {
      devServer: Record<string, unknown>
    }
    config.devServer.reuseExisting = true
    config.devServer.readiness = {
      path: "/health",
      bodyIncludes: "expected-project-marker",
    }
    await writeFile(projectPath, `${JSON.stringify(config, null, 2)}\n`)

    const result = await runDoctor({
      projectRoot,
      checkBrowser: async () => "123.0.0",
      fetchImpl: async () => new Response("different app", { status: 200 }),
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dev-server", status: "fail" }),
      ]),
    )
  })
})
