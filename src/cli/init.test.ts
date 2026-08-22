import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadProjectConfig, loadScenarioSource } from "../project/config"
import { initUiEvalProject } from "./init"

const tempRoots: string[] = []

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-init-"))
  tempRoots.push(root)
  return root
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("initUiEvalProject", () => {
  it("creates a valid minimal project and scenario without hidden scoring claims", async () => {
    const projectRoot = await tempProject()

    const result = await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })

    expect(result.created).toEqual([
      ".gitignore",
      "ui-eval/project.json",
      "ui-eval/policies/default.json",
      "ui-eval/scenarios/privacy-desktop.json",
    ])
    const project = await loadProjectConfig({ projectRoot })
    const scenario = await loadScenarioSource(
      project,
      "scenarios/privacy-desktop.json",
    )
    expect(scenario.value.target.entrypoint.path).toBe("/privacy")
    expect(scenario.value.auth).toBeUndefined()
    expect(scenario.value.checkpoints[0].designTargetRef).toBeUndefined()
    expect(project.value.devServer).toMatchObject({
      command: "npm",
      args: ["run", "dev"],
    })

    const projectSource = await readJson(join(projectRoot, "ui-eval/project.json"))
    const policySource = await readJson(
      join(projectRoot, "ui-eval/policies/default.json"),
    )
    const scenarioSource = await readJson(
      join(projectRoot, "ui-eval/scenarios/privacy-desktop.json"),
    )
    expect(projectSource).not.toHaveProperty("$schema")
    expect(policySource).not.toHaveProperty("$schema")
    expect(scenarioSource).not.toHaveProperty("$schema")
    expect(
      (policySource.agentMutation as { protectedPathGlobs: string[] })
        .protectedPathGlobs,
    ).toEqual([
      "ui-eval/policies/**",
      "ui-eval/baselines/**",
      ".ui-eval/**",
    ])
  })

  it.each(["bun", "npm", "pnpm", "yarn"] as const)(
    "uses the declared %s package manager for the dev command",
    async (packageManager) => {
      const projectRoot = await tempProject()
      await writeFile(
        join(projectRoot, "package.json"),
        JSON.stringify({ packageManager: `${packageManager}@1.0.0` }),
        "utf8",
      )

      await initUiEvalProject({
        projectRoot,
        route: "/privacy",
        scenarioId: "privacy-desktop",
      })

      const project = await loadProjectConfig({ projectRoot })
      expect(project.value.devServer).toMatchObject({
        command: packageManager,
        args: ["run", "dev"],
      })
    },
  )

  it.each([
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const)(
    "detects %s when package.json does not declare a package manager",
    async (lockfile, packageManager) => {
      const projectRoot = await tempProject()
      await writeFile(join(projectRoot, lockfile), "", "utf8")

      await initUiEvalProject({
        projectRoot,
        route: "/privacy",
        scenarioId: "privacy-desktop",
      })

      const project = await loadProjectConfig({ projectRoot })
      expect(project.value.devServer).toMatchObject({
        command: packageManager,
        args: ["run", "dev"],
      })
    },
  )

  it("falls back to npm when lockfiles conflict", async () => {
    const projectRoot = await tempProject()
    await Promise.all([
      writeFile(join(projectRoot, "bun.lock"), "", "utf8"),
      writeFile(join(projectRoot, "yarn.lock"), "", "utf8"),
    ])

    await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })

    const project = await loadProjectConfig({ projectRoot })
    expect(project.value.devServer).toMatchObject({
      command: "npm",
      args: ["run", "dev"],
    })
  })

  it("never overwrites existing authoring files", async () => {
    const projectRoot = await tempProject()
    await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })
    const scenarioPath = join(
      projectRoot,
      "ui-eval/scenarios/privacy-desktop.json",
    )
    await writeFile(scenarioPath, "owner content", "utf8")

    const result = await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })

    expect(result.created).toEqual([])
    expect(result.skipped).toContain("ui-eval/scenarios/privacy-desktop.json")
    expect(await readFile(scenarioPath, "utf8")).toBe("owner content")
  })

  it("adds the generated artifact root to an existing gitignore", async () => {
    const projectRoot = await tempProject()
    const gitignorePath = join(projectRoot, ".gitignore")
    await writeFile(gitignorePath, "node_modules/\n", "utf8")

    const result = await initUiEvalProject({
      projectRoot,
      route: "/privacy",
      scenarioId: "privacy-desktop",
    })

    expect(result.updated).toEqual([".gitignore"])
    expect(await readFile(gitignorePath, "utf8")).toBe(
      "node_modules/\n.ui-eval/\n",
    )
  })

  it("rejects unsafe routes and scenario identifiers", async () => {
    const projectRoot = await tempProject()

    await expect(
      initUiEvalProject({
        projectRoot,
        route: "https://example.com/privacy",
        scenarioId: "privacy-desktop",
      }),
    ).rejects.toThrow("route")
    await expect(
      initUiEvalProject({
        projectRoot,
        route: "/privacy",
        scenarioId: "../escape",
      }),
    ).rejects.toThrow("scenario")
  })
})
