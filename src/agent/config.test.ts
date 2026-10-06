import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadAgentSuite } from "./config"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("loadAgentSuite", () => {
  it("loads a contained, strictly validated suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-eval-agent-config-"))
    roots.push(root)
    await mkdir(join(root, "ui-eval", "agents"), { recursive: true })
    await writeFile(
      join(root, "ui-eval", "agents", "rentals.json"),
      JSON.stringify({
        apiVersion: "uieval.io/v1alpha1",
        kind: "AgentSuite",
        id: "rentals",
        revision: 1,
        maxIterations: 3,
        plateau: { maxConsecutiveNoImprovement: 2, minScoreImprovement: 0.01 },
        requiredDimensions: ["visual"],
        mutation: {
          allowedPathPrefixes: ["app", "components"],
          protectedPathPrefixes: ["ui-eval"],
          maxChangedFiles: 8,
        },
        scenarios: [{ id: "rentals-list", dimensions: ["visual"], timeoutMs: 60_000 }],
        checks: [],
      }),
    )

    const loaded = await loadAgentSuite(root, "rentals")

    expect(loaded.value.id).toBe("rentals")
    expect(loaded.path).toBe(
      join(await realpath(root), "ui-eval", "agents", "rentals.json"),
    )
  })

  it("rejects paths outside the candidate project", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-eval-agent-config-"))
    roots.push(root)
    await expect(loadAgentSuite(root, "../outside.json")).rejects.toThrow(
      "escapes the project root",
    )
  })
})
