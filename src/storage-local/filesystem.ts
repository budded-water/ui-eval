import { randomBytes } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path"

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertSafeSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    !SAFE_SEGMENT.test(value)
  ) {
    throw new Error(`${label} must be a portable path-safe identifier`)
  }
}

export function assertSafeRelativePath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new Error("relativePath must be a safe relative path")
  }

  const segments = value.split("/")
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 255 ||
        segment === "." ||
        segment === ".." ||
        !SAFE_SEGMENT.test(segment),
    )
  ) {
    throw new Error("relativePath must be a safe relative path")
  }
}

export function assertPathContained(root: string, candidate: string): void {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const fromRoot = relative(resolvedRoot, resolvedCandidate)

  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("resolved path escapes the configured storage root")
  }
}

export async function ensureContainedDirectory(
  root: string,
  directory: string,
): Promise<void> {
  const resolvedRoot = resolve(root)
  const resolvedDirectory = resolve(directory)
  assertPathContained(resolvedRoot, resolvedDirectory)
  await mkdir(resolvedRoot, { recursive: true })

  const realRoot = await realpath(resolvedRoot)
  const pathFromRoot = relative(resolvedRoot, resolvedDirectory)
  let current = resolvedRoot

  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      await mkdir(current)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error
      }
    }

    const currentStat = await lstat(current)
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw new Error("storage directory contains an unsafe filesystem entry")
    }
    assertPathContained(realRoot, await realpath(current))
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, "r")
    await handle.sync()
  } catch (error) {
    // Directory fsync is unsupported on a few platforms. File fsync and rename
    // still guarantee that readers never observe a partially written payload.
    if (process.platform !== "win32") throw error
  } finally {
    await handle?.close()
  }
}

export async function atomicWriteFile(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const directory = dirname(target)
  const temp = resolve(
    directory,
    `.${target.slice(target.lastIndexOf(sep) + 1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  )
  assertPathContained(directory, temp)

  let handle
  try {
    handle = await open(temp, "wx", 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined

    await rename(temp, target)
    await syncDirectory(directory)
  } finally {
    await handle?.close()
    await rm(temp, { force: true })
  }
}
