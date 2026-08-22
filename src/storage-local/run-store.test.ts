import { mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { RunStore } from "./run-store"

describe("RunStore", () => {
  let root: string
  let outsideRoot: string
  let store: RunStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ui-eval-runs-"))
    outsideRoot = await mkdtemp(join(tmpdir(), "ui-eval-runs-outside-"))
    store = new RunStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it("writes report JSON, nested text, and binary outputs", async () => {
    const reportPath = await store.writeReport("run-01", { status: "pass" })
    const logPath = await store.writeText(
      "run-01",
      "evidence/browser.log",
      "ready\n",
    )
    const imagePath = await store.writeBinary(
      "run-01",
      "evidence/image.bin",
      new Uint8Array([0, 1, 2, 255]),
    )

    expect(reportPath).toBe(join(root, "runs", "run-01", "report.json"))
    expect(logPath).toBe(join(root, "runs", "run-01", "evidence", "browser.log"))
    expect(imagePath).toBe(join(root, "runs", "run-01", "evidence", "image.bin"))
    await expect(store.read("run-01", "report.json")).resolves.toEqual(
      Buffer.from('{\n  "status": "pass"\n}\n'),
    )
    await expect(store.read("run-01", "evidence/browser.log")).resolves.toEqual(
      Buffer.from("ready\n"),
    )
    await expect(store.read("run-01", "evidence/image.bin")).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    )
  })

  it("rejects unsafe run ids before writing", async () => {
    for (const runId of ["../other-run", "nested/run", ".", "run\\outside"]) {
      await expect(
        store.writeText(runId, "report.txt", "nope"),
      ).rejects.toMatchObject({
        code: "invalid-run-id",
      })
    }

    await expect(readdir(join(root, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects absolute, traversal, ambiguous, and Windows-style output paths", async () => {
    for (const relativePath of [
      "../outside.txt",
      "evidence/../../outside.txt",
      "/tmp/outside.txt",
      "C:\\outside.txt",
      "evidence\\outside.txt",
      "evidence//outside.txt",
      ".hidden",
    ]) {
      await expect(
        store.writeText("run-01", relativePath, "nope"),
      ).rejects.toMatchObject({
        code: "invalid-relative-path",
      })
    }
  })

  it("atomically replaces an output without exposing partial or temp files", async () => {
    const payloads = Array.from(
      { length: 12 },
      (_, index) => `${index}:` + String(index).repeat(32_768),
    )

    await Promise.all(
      payloads.map((payload) =>
        store.writeText("run-atomic", "report.txt", payload),
      ),
    )

    const result = await store.read("run-atomic", "report.txt")
    expect(payloads).toContain(result.toString("utf8"))
    expect(await readdir(join(root, "runs", "run-atomic"))).toEqual([
      "report.txt",
    ])
  })

  it("does not follow a runs-directory symlink outside the configured root", async () => {
    await symlink(outsideRoot, join(root, "runs"))

    await expect(
      store.writeText("run-01", "report.txt", "must stay contained"),
    ).rejects.toMatchObject({ code: "containment-violation" })
    expect(await readdir(outsideRoot)).toEqual([])
  })
})
