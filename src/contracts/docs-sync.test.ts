import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("standalone architecture documentation", () => {
  it("keeps the repository README linked to its architecture source", async () => {
    const [architecture, readme] = await Promise.all([
      readFile(
        fileURLToPath(new URL("../../docs/architecture.md", import.meta.url)),
        "utf8",
      ),
      readFile(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8"),
    ])

    expect(architecture).toMatch(/^# Architecture/m)
    expect(readme).toContain("[Architecture](docs/architecture.md)")
  })
})
