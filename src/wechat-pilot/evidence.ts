import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { lstat, open, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { PNG } from "pngjs"
import { canonicalDigest } from "../contracts/canonical-json"
import { inspectPngHeader } from "../capture-playwright/binary-evidence"
import { containedPath, loadWechatProject, type WechatPilotProject } from "./config"

export async function boundedFile(path: string, maximum = 32 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error("WeChat evidence must be a bounded regular file")
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!chunk.bytesRead) throw new Error("WeChat evidence was truncated")
      offset += chunk.bytesRead
    }
    if ((await handle.stat()).size !== stat.size) throw new Error("WeChat evidence changed during read")
    return bytes
  } finally { await handle.close() }
}
export function inspectWechatPng(bytes: Buffer): { width: number; height: number; digest: string } {
  const header = inspectPngHeader(bytes, "screenshot")
  const decoded = PNG.sync.read(bytes, { checkCRC: true })
  if (decoded.width !== header.width || decoded.height !== header.height) throw new Error("WeChat PNG dimension mismatch")
  return { ...header, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }
}
export async function fingerprintRuntime(root: string, project: WechatPilotProject): Promise<string> {
  await loadWechatProject(root)
  const runtime = await containedPath(root, project.runtimeProject)
  const config = JSON.parse((await boundedFile(resolve(runtime, "project.config.json"), 1024 * 1024)).toString("utf8"))
  const files: Array<{ path: string; digest: string }> = []
  let count = 0
  let totalBytes = 0
  async function add(path: string, name: string) {
    const bytes = await boundedFile(path)
    totalBytes += bytes.length
    if (++count > 10000 || totalBytes > 128 * 1024 * 1024) throw new Error("Compiled WeChat runtime exceeded its fingerprint budget")
    files.push({ path: name, digest: createHash("sha256").update(bytes).digest("hex") })
  }
  async function walk(directory: string, prefix: string, depth = 0) {
    if (depth > 20) throw new Error("Compiled WeChat runtime nesting exceeded its budget")
    for (const name of (await readdir(directory)).sort()) {
      const path = await containedPath(runtime, `${prefix}/${name}`)
      const stat = await lstat(path)
      if (stat.isDirectory()) await walk(path, `${prefix}/${name}`, depth + 1)
      else if (stat.isFile()) await add(path, `${prefix}/${name}`)
      else throw new Error("Unsupported compiled WeChat runtime entry")
    }
  }
  await add(resolve(runtime, "project.config.json"), "project.config.json")
  await add(resolve(runtime, "ui-eval-runtime.json"), "ui-eval-runtime.json")
  const compiled = await containedPath(runtime, config.miniprogramRoot)
  await walk(compiled, config.miniprogramRoot)
  if (!files.some((file) => file.path.endsWith("/app.js")) || !files.some((file) => file.path.endsWith("/app.json"))) throw new Error("Missing compiled WeChat application")
  return canonicalDigest(files)
}
