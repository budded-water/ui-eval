import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { initUiEvalProject } from "../cli/init"
import { canonicalDigest } from "../contracts/canonical-json"
import { materializePolicy } from "../manifest-compiler/policy"
import { LocalArtifactStore } from "../storage-local/artifact-store"
import { loadProjectConfig, loadPolicySource, validateWebPolicySource } from "./config"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const profile = { apiVersion: "uieval.io/v1alpha1", kind: "PolicySource", id: "default", revision: 1, profile: "web-default" }

async function project() {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-profile-"))
  roots.push(root)
  await initUiEvalProject({ projectRoot: root, route: "/", scenarioId: "home" })
  return { root, project: await loadProjectConfig({ projectRoot: root }), path: join(root, "ui-eval/policies/default.json") }
}

describe("compact web policy authoring", () => {
  it("expands and seals auditable core invariants without rewriting authoring", async () => {
    const fixture = await project()
    const authored = await readFile(fixture.path, "utf8")
    const loaded = await loadPolicySource(fixture.project, "policies/default.json")
    expect(loaded.value.evaluators.filter((evaluator) => evaluator.required).map(({ id }) => id)).toEqual(["execution", "interaction", "runtime"])
    expect(loaded.value.gates.filter((gate) => gate.hard)).toHaveLength(4)
    expect(loaded.digest).toBe(canonicalDigest(loaded.value))
    const sealed = await materializePolicy(loaded, fixture.project, {
      artifactMaterializer: new LocalArtifactStore({ root: join(fixture.root, ".ui-eval"), projectId: fixture.project.value.projectId, storeId: "test" }),
    })
    expect(sealed.spec.gates).toEqual(loaded.value.gates)
    expect(sealed.spec.evaluators.every((evaluator) => evaluator.configRef.digest === evaluator.configDigest)).toBe(true)
    expect(await readFile(fixture.path, "utf8")).toBe(authored)
  })

  it("allows additional constraints but cannot replace a core declaration", async () => {
    const fixture = await project()
    await writeFile(fixture.path, JSON.stringify({ ...profile, evaluators: [
      { id: "execution", version: "0.1.0", required: false, config: {}, weight: 0 },
    ] }))
    await expect(loadPolicySource(fixture.project, "policies/default.json")).rejects.toThrow("duplicate evaluator")
  })

  it("rejects forward or misspelled profile options and preserves full policies", async () => {
    expect(validateWebPolicySource(profile)).toBe(true)
    expect(validateWebPolicySource({ ...profile, profile: "unknown" })).toBe(false)
    expect(validateWebPolicySource({ ...profile, dynamicRegions: [] })).toBe(false)
    const fixture = await project()
    const full = (await loadPolicySource(fixture.project, "policies/default.json")).value
    await writeFile(fixture.path, JSON.stringify(full))
    expect((await loadPolicySource(fixture.project, "policies/default.json")).value).toEqual(full)
  })
})
