import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { tmpdir } from "node:os"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
)
const cliPath = resolve(repositoryRoot, "dist/cli.js")

await Promise.all([
  access(cliPath),
  access(resolve(repositoryRoot, "dist/index.js")),
  access(resolve(repositoryRoot, "dist/index.d.ts")),
])

const cliSource = await readFile(cliPath, "utf8")
if (!cliSource.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("dist/cli.js is missing its Node shebang")
}

function run(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolveResult({ code, stdout, stderr }))
  })
}

function assertVersion(result, invocation) {
  if (result.code !== 0 || result.stdout.trim() !== packageJson.version) {
    throw new Error(
      `${invocation} version check failed (exit=${result.code}, stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)})`,
    )
  }
}

const directResult = await run(process.execPath, [cliPath, "--version"])
assertVersion(directResult, "direct built CLI")

// Package managers expose bins through a symlink (or equivalent shim). Node
// preserves that path in argv[1], so this catches entrypoints that incorrectly
// compare import.meta.url with the invocation path and then exit silently.
const smokeRoot = await mkdtemp(resolve(tmpdir(), "ui-eval-dist-bin-"))
const linkedCliPath = resolve(smokeRoot, "node_modules", ".bin", "ui-eval")
await mkdir(dirname(linkedCliPath), { recursive: true })

try {
  await symlink(cliPath, linkedCliPath)
  const linkedResult = await run(process.execPath, [linkedCliPath, "--version"])
  assertVersion(linkedResult, "package-manager-style bin symlink")
} finally {
  await rm(smokeRoot, { recursive: true, force: true })
}

process.stdout.write(`Verified direct and symlinked dist CLI ${packageJson.version}.\n`)
