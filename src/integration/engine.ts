import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readFile, realpath } from "node:fs/promises"
import { runCommand } from "../runtime/command"
import type { EnginePin } from "./config"

/** Works from source and the built dist entry; never trusts a caller-selected checkout. */
export async function executingEngineRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url))
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as { name?: string }
      if (pkg.name === "ui-eval") return realpath(directory)
    } catch { /* Continue toward the checkout root. */ }
    const parent = dirname(directory)
    if (parent === directory) throw new Error("The executing engine must belong to a UI Eval source checkout")
    directory = parent
  }
}

const repository = (url: string) => url.replace(/\.git$/, "").replace(/\/$/, "")

export async function verifyEnginePin(pin: EnginePin, signal?: AbortSignal, root?: string): Promise<void> {
  const engineRoot = root ?? await executingEngineRoot()
  const git = async (...args: string[]) => {
    const result = await runCommand("git", args, { cwd: engineRoot, timeoutMs: 10_000, signal, truncateOutput: false })
    if (result.exitCode !== 0) throw new Error("Engine checkout identity could not be verified")
    return result.stdout.trim()
  }
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(engineRoot)) {
    throw new Error("Engine must be the root of its own Git checkout")
  }
  const pkg = JSON.parse(await readFile(resolve(engineRoot, "package.json"), "utf8")) as {
    name?: string; repository?: { url?: string }; packageManager?: string
  }
  if (pkg.name !== "ui-eval" || !pkg.repository?.url || repository(pkg.repository.url) !== repository(pin.repository) ||
    repository(await git("remote", "get-url", "origin")) !== repository(pin.repository)) {
    throw new Error("Executing engine repository differs from the project pin")
  }
  if (await git("rev-parse", "HEAD") !== pin.revision) throw new Error("Executing engine revision differs from the project pin")
  if (await git("status", "--porcelain", "--untracked-files=all")) throw new Error("Executing engine source must be clean")
  if (pin.bunVersion && pkg.packageManager !== `bun@${pin.bunVersion}`) throw new Error("Engine package manager differs from the project pin")
}
