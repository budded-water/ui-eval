import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

let input = ""
for await (const bytes of process.stdin) input += bytes
const context = JSON.parse(input)
const page = await readFile("page.html")
await mkdir(".ui-eval/site", { recursive: true })
await writeFile(".ui-eval/site/index.html", page)
await writeFile(resolve(context.integrationDirectory, "prepared.json"), JSON.stringify({
  pageDigest: createHash("sha256").update(page).digest("hex"),
}))
