import { runCliProcess } from "./main"

const exitCode = await runCliProcess(process.argv.slice(2))
// The executable owns this process. Bounded cleanup and report publication
// have completed; do not let an uncooperative third-party handle keep a
// terminal command resident. Programmatic APIs retain process ownership.
process.exit(exitCode)
