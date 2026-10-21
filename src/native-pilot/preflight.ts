import { statfs, access } from "node:fs/promises"
import { constants } from "node:fs"

export const DEFAULT_NATIVE_FREE_BYTES = 1024 ** 3

/** Typed, sanitized recovery guidance; raw driver output never enters reports. */
export class NativePrerequisiteError extends Error {
  constructor(readonly code: string, readonly recovery: string) {
    super(`${code}: ${recovery}`)
    this.name = "NativePrerequisiteError"
  }
}

export async function nativeStorage(root: string, minimumBytes = DEFAULT_NATIVE_FREE_BYTES): Promise<{ availableBytes: number; minimumBytes: number }> {
  let availableBytes: number
  try {
    await access(root, constants.W_OK)
    const stats = await statfs(root)
    availableBytes = stats.bavail * stats.bsize
  } catch {
    throw new NativePrerequisiteError("NATIVE_STORAGE_UNAVAILABLE", "Restore write access to the candidate directory, then rerun doctor. No files were removed.")
  }
  if (availableBytes < minimumBytes) {
    throw new NativePrerequisiteError("NATIVE_DISK_LOW", `Free space on the candidate volume to at least ${minimumBytes} bytes, then rerun doctor. No evidence or personal files were removed.`)
  }
  return { availableBytes, minimumBytes }
}
