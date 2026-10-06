import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readlink } from "node:fs/promises"
import { resolve } from "node:path"
import { runCommand } from "../runtime/command"

async function git(projectRoot: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd: projectRoot, timeoutMs: 30_000, truncateOutput: false })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout
}

export async function listChangedFiles(projectRoot: string): Promise<string[]> {
  const records = (await git(projectRoot, ["status", "--porcelain=v1", "-z", "-uall"])).split("\0")
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    paths.push(record.slice(3))
    // NUL porcelain puts the destination first and the rename/copy source next.
    if (/[RC]/.test(record.slice(0, 2))) index += 1
  }
  return paths.sort()
}

export async function snapshotSourceFiles(projectRoot: string): Promise<Map<string, string>> {
  const paths = (await git(projectRoot, ["ls-files", "-z", "-co", "--exclude-standard"])).split("\0").filter(Boolean)
  const snapshot = new Map<string, string>()
  for (const path of new Set(paths)) {
    const candidate = resolve(projectRoot, path)
    let metadata
    try {
      metadata = await lstat(candidate)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    const hash = createHash("sha256")
    if (metadata.isSymbolicLink()) {
      hash.update(`link\0${await readlink(candidate)}`)
    } else if (metadata.isFile()) {
      hash.update(`file\0${metadata.mode & 0o111}\0`)
      for await (const chunk of createReadStream(candidate)) hash.update(chunk)
    } else {
      throw new Error("Cannot fingerprint a non-file source entry")
    }
    snapshot.set(path, hash.digest("hex"))
  }
  return snapshot
}
