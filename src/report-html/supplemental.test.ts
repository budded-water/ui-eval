import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { runCli } from "../cli/main"

const record = {
  title: "Order <script>list",
  method: "iOS Simulator / Maestro",
  scope: "Initial list only",
  source: "candidate-revision",
  status: "inconclusive",
  observations: ["Image < unavailable"],
  screenshots: [],
}

it("renders the supplied outcome and scope without changing the machine record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ui-eval-supplemental-"))
  try {
    const input = JSON.stringify(record)
    await writeFile(join(cwd, "run.json"), input)
    const io = { cwd, stdout: () => {}, stderr: () => {} }
    expect(await runCli(["supplemental-report", "run.json"], io)).toBe(0)
    const html = await readFile(join(cwd, "run.html"), "utf8")
    expect(html).toContain("<strong>inconclusive</strong>")
    expect(html).toContain("Initial list only")
    expect(html).toContain("Order &lt;script&gt;list")
    expect(html).toContain("Image &lt; unavailable")
    expect(await readFile(join(cwd, "run.json"), "utf8")).toBe(input)
    expect(await runCli(["supplemental-report", "run.json"], io)).toBe(2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

it("rejects traversal and symlinks before rendering screenshots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ui-eval-supplemental-"))
  try {
    await symlink("run.json", join(cwd, "alias.png"))
    const io = { cwd, stdout: () => {}, stderr: () => {} }
    for (const image of ["../other.png", "alias.png"]) {
      await writeFile(join(cwd, "run.json"), JSON.stringify({ ...record, screenshots: [image] }))
      expect(await runCli(["supplemental-report", "run.json"], io)).toBe(2)
      await expect(readFile(join(cwd, "run.html"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
