import { mkdtemp, mkdir, writeFile, readlink, symlink, unlink, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCommand } from "../runtime/command"
import { listChangedFiles, snapshotSourceFiles } from "./source-state"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function project() {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-source-state-"))
  roots.push(root)
  expect((await runCommand("git", ["init", "-q"], { cwd: root, timeoutMs: 5000 })).exitCode).toBe(0)
  await mkdir(join(root, "src"))
  return root
}

describe("Agent source identity", () => {
  it("preserves Unicode and whitespace filenames and detects content changes", async () => {
    const root = await project()
    const path = "src/空白 file.ts"
    await writeFile(join(root, path), "before")
    const before = await snapshotSourceFiles(root)
    await writeFile(join(root, path), "after")
    const after = await snapshotSourceFiles(root)
    expect(before.get(path)).toBeDefined()
    expect(before.get(path)).not.toBe(after.get(path))
    expect(await listChangedFiles(root)).toContain(path)
  })

  it.skipIf(process.platform === "win32")("fingerprints symlink targets without reading target bytes", async () => {
    const root = await project()
    const target = await mkdtemp(join(tmpdir(), "ui-eval-link-target-"))
    roots.push(target)
    await writeFile(join(target, "first"), "original")
    const path = "src/link"
    await symlink(join(target, "first"), join(root, path))
    const before = await snapshotSourceFiles(root)
    await writeFile(join(target, "first"), "different target bytes")
    expect((await snapshotSourceFiles(root)).get(path)).toBe(before.get(path))
    expect(await readlink(join(root, path))).toBe(join(target, "first"))
    await unlink(join(root, path))
    await symlink(join(target, "second"), join(root, path))
    expect((await snapshotSourceFiles(root)).get(path)).not.toBe(before.get(path))
  })

  it.skipIf(process.platform === "win32")("detects executable mode changes", async () => {
    const root = await project()
    const path = "src/check.sh"
    await writeFile(join(root, path), "exit 0", { mode: 0o644 })
    const before = await snapshotSourceFiles(root)
    await chmod(join(root, path), 0o755)
    expect((await snapshotSourceFiles(root)).get(path)).not.toBe(before.get(path))
  })
})
