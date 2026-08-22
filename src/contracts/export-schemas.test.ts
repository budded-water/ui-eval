import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { exportContractSchemas } from "./export-schemas"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("checked-in JSON Schemas", () => {
  it("stay byte-for-byte synchronized with the TypeBox source", async () => {
    const output = await mkdtemp(resolve(tmpdir(), "ui-eval-schemas-"))
    roots.push(output)
    await exportContractSchemas(output)
    const checkedIn = fileURLToPath(new URL("../../schemas", import.meta.url))
    const names = (await readdir(output)).sort()

    expect(names).toEqual((await readdir(checkedIn)).sort())
    for (const name of names) {
      const [generated, committed] = await Promise.all([
        readFile(resolve(output, name), "utf8"),
        readFile(resolve(checkedIn, name), "utf8"),
      ])
      expect(generated, `${name} is stale; run the schema:generate script`).toBe(
        committed,
      )
    }
  })
})
