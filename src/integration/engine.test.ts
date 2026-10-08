import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { runCommand } from "../runtime/command"
import { verifyEnginePin } from "./engine"
import type { EnginePin } from "./config"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function checkout() {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-engine-pin-")); roots.push(root)
  const git = async (...args: string[]) => {
    const result = await runCommand("git", args, { cwd: root, timeoutMs: 10000 })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git("init", "-q")
  const repository = "https://example.invalid/ui-eval.git"
  await git("remote", "add", "origin", repository)
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "ui-eval", repository: { url: repository }, packageManager: "bun@1.3.10" }))
  await git("add", "package.json")
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "synthetic baseline")
  const pin: EnginePin = { repository, revision: await git("rev-parse", "HEAD"), bunVersion: "1.3.10" }
  return { root, pin, git }
}
describe("engine source pin", () => {
  it("verifies an exact clean checkout and rejects wrong revisions, dirty source and repository drift", async () => {
    const { root, pin, git } = await checkout()
    await expect(verifyEnginePin(pin, undefined, root)).resolves.toBeUndefined()
    await expect(verifyEnginePin({ ...pin, revision: "b".repeat(40) }, undefined, root)).rejects.toThrow("revision")
    await expect(verifyEnginePin({ ...pin, bunVersion: "0.0.1" }, undefined, root)).rejects.toThrow("package manager")
    await writeFile(join(root, "untracked.ts"), "changed")
    await expect(verifyEnginePin(pin, undefined, root)).rejects.toThrow("clean")
    await rm(join(root, "untracked.ts"))
    await git("remote", "set-url", "origin", "https://example.invalid/other.git")
    await expect(verifyEnginePin(pin, undefined, root)).rejects.toThrow("repository")
  })
  it("does not accept a package nested inside another Git checkout", async () => {
    const { root, pin } = await checkout()
    const child = join(root, "child"); await mkdir(child)
    await expect(verifyEnginePin(pin, undefined, child)).rejects.toThrow("own Git checkout")
  })
})
