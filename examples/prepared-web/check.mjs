import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

let input = ""
for await (const bytes of process.stdin) input += bytes
const context = JSON.parse(input)
const prepared = JSON.parse(await readFile(resolve(context.integrationDirectory, "prepared.json"), "utf8"))
const page = await readFile(".ui-eval/site/index.html")
if (prepared.pageDigest !== createHash("sha256").update(page).digest("hex")) throw new Error("Prepared page changed")
const scenarios = context.stages.filter((stage) => stage.kind === "scenario")
if (!scenarios.length || scenarios.some((stage) => stage.status !== "pass" || !stage.reports.length)) throw new Error("Scenario floor did not pass")
