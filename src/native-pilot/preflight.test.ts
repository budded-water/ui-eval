import { describe, expect, it, vi } from "vitest"
import { nativeStorage, NativePrerequisiteError, DEFAULT_NATIVE_FREE_BYTES } from "./preflight"

vi.mock("node:fs/promises", () => ({ access: vi.fn(), statfs: vi.fn() }))
import { access, statfs } from "node:fs/promises"

describe("native storage preflight", () => {
  it("stops low-space runs before capture with actionable sanitized guidance", async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: 116, bsize: 1024 ** 2 } as Awaited<ReturnType<typeof statfs>>)
    await expect(nativeStorage("/synthetic")).rejects.toMatchObject({ code: "NATIVE_DISK_LOW", recovery: expect.stringContaining("Free space") })
  })
  it("uses available rather than reserved blocks and reports the actual threshold", async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: 4096, bsize: 1024 ** 2 } as Awaited<ReturnType<typeof statfs>>)
    expect(await nativeStorage("/synthetic")).toEqual({ availableBytes: 4 * 1024 ** 3, minimumBytes: DEFAULT_NATIVE_FREE_BYTES })
  })
  it("does not leak filesystem errors or delete files", async () => {
    vi.mocked(access).mockRejectedValueOnce(new Error("private diagnostic"))
    await expect(nativeStorage("/synthetic")).rejects.toBeInstanceOf(NativePrerequisiteError)
    await expect(nativeStorage("/synthetic", 8 * 1024 ** 3)).rejects.not.toThrow("private diagnostic")
  })
})
