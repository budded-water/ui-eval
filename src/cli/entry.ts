import { runCliProcess } from "./main"

process.exitCode = await runCliProcess(process.argv.slice(2))
