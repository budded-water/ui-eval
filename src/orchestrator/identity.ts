import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { lstat, readlink } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import { canonicalDigest } from "../contracts/canonical-json"
import type {
  BuildIdentity,
  Digest,
  SourceRevision,
  WebResolvedScenarioPlan,
} from "../contracts/model"
import type { LoadedProjectConfig } from "../project/config"

export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<string>

export class SourceIdentityError extends Error {
  readonly code = "SOURCE_IDENTITY_UNAVAILABLE"
  readonly operation: string

  constructor(operation: string, reason: string) {
    super(`Source identity is unavailable: ${operation} ${reason}`)
    this.name = "SourceIdentityError"
    this.operation = operation
  }
}

const MAX_GIT_METADATA_BYTES = 4 * 1024 * 1024

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })

async function requiredGitOutput(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    return await runner(args, cwd)
  } catch {
    throw new SourceIdentityError(args.slice(0, 2).join(" "), "could not be read")
  }
}

async function optionalRemote(
  runner: GitRunner,
  cwd: string,
): Promise<string> {
  try {
    return await runner(["config", "--get", "remote.origin.url"], cwd)
  } catch {
    return ""
  }
}

async function streamDefaultGitDiffDigest(cwd: string): Promise<Digest> {
  return new Promise((resolveDigest, rejectDigest) => {
    const child = spawn(
      "git",
      ["diff", "--binary", "--no-ext-diff", "HEAD"],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    )
    const hash = createHash("sha256")
    let settled = false

    const rejectSafely = () => {
      if (settled) return
      settled = true
      rejectDigest(
        new SourceIdentityError("diff", "could not be fingerprinted"),
      )
    }

    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk))
    child.stdout.once("error", rejectSafely)
    child.once("error", rejectSafely)
    child.once("close", (code) => {
      if (settled) return
      if (code !== 0) {
        rejectSafely()
        return
      }
      settled = true
      resolveDigest(`sha256:${hash.digest("hex")}`)
    })
  })
}

async function collectDiffDigest(
  runner: GitRunner,
  cwd: string,
): Promise<Digest> {
  if (runner === defaultGitRunner) return streamDefaultGitDiffDigest(cwd)
  const diff = await requiredGitOutput(
    runner,
    ["diff", "--binary", "--no-ext-diff", "HEAD"],
    cwd,
  )
  return `sha256:${createHash("sha256").update(diff).digest("hex")}`
}

const SCP_STYLE_REMOTE =
  /^(?:[^\s@]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/

const SAFE_REMOTE_PROTOCOLS = new Set([
  "git:",
  "git+ssh:",
  "http:",
  "https:",
  "ssh:",
  "ssh+git:",
])
const SAFE_REMOTE_HELPERS = new Set(["bzr", "hg", "svn"])

function safeRepositoryIdentifier(
  remote: string,
  fallback: string,
  depth = 0,
): string {
  const candidate = remote.trim()
  if (!candidate) return fallback

  const helper = /^([A-Za-z][A-Za-z0-9+.-]*)::(.+)$/.exec(candidate)
  if (helper) {
    const helperName = helper[1].toLowerCase()
    if (!SAFE_REMOTE_HELPERS.has(helperName) || depth >= 2) return fallback
    const nested = safeRepositoryIdentifier(helper[2], fallback, depth + 1)
    return nested === fallback ? fallback : `${helperName}::${nested}`
  }

  try {
    const parsed = new URL(candidate)
    if (!SAFE_REMOTE_PROTOCOLS.has(parsed.protocol.toLowerCase())) return fallback
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString()
  } catch {
    // Only the explicit safe formats below may enter provenance. In
    // particular, never echo malformed URLs or arbitrary helper commands.
  }

  const scp = SCP_STYLE_REMOTE.exec(candidate)
  if (scp) {
    return `${scp[1].toLowerCase()}:${scp[2]}`
  }
  return fallback
}

async function hashUntrackedFiles(
  projectRoot: string,
  nulSeparatedPaths: string,
): Promise<Array<{ path: string; type: "file" | "symlink"; digest: Digest }>> {
  const paths = nulSeparatedPaths.split("\0").filter(Boolean).sort()
  const results: Array<{
    path: string
    type: "file" | "symlink"
    digest: Digest
  }> = []

  for (const path of paths) {
    const candidate = resolve(projectRoot, path)
    const relation = relative(projectRoot, candidate)
    if (relation.startsWith("..") || isAbsolute(relation)) {
      throw new Error(`Git reported an untracked path outside the project: ${path}`)
    }
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink()) {
      const target = await readlink(candidate)
      results.push({
        path,
        type: "symlink",
        digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
      })
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`Cannot fingerprint non-file untracked source: ${path}`)
    }
    results.push({
      path,
      type: "file",
      digest: await new Promise<Digest>((resolveDigest, rejectDigest) => {
        const hash = createHash("sha256")
        const stream = createReadStream(candidate)
        stream.on("data", (chunk) => hash.update(chunk))
        stream.once("error", rejectDigest)
        stream.once("end", () => {
          resolveDigest(`sha256:${hash.digest("hex")}`)
        })
      }),
    })
  }
  return results
}

export async function collectSourceRevision(
  projectRoot: string,
  runner: GitRunner = defaultGitRunner,
): Promise<SourceRevision> {
  const repositoryFallback = `local:${canonicalDigest({
    projectRoot: resolve(projectRoot),
  })}`
  const [repositoryRemote, commitOutput, status, diffDigest, untrackedPaths] = await Promise.all([
    optionalRemote(runner, projectRoot),
    requiredGitOutput(runner, ["rev-parse", "HEAD"], projectRoot),
    requiredGitOutput(
      runner,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      projectRoot,
    ),
    collectDiffDigest(runner, projectRoot),
    requiredGitOutput(
      runner,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      projectRoot,
    ),
  ])
  const commitSha = commitOutput.trim()
  if (!commitSha) {
    throw new SourceIdentityError("rev-parse HEAD", "returned no commit")
  }
  const dirtyTree = status.length > 0
  const emptyDiffDigest = `sha256:${createHash("sha256").digest("hex")}`
  if (!dirtyTree && diffDigest !== emptyDiffDigest) {
    throw new SourceIdentityError(
      "status/diff",
      "returned inconsistent working-tree state",
    )
  }
  if (!dirtyTree && untrackedPaths.length > 0) {
    throw new SourceIdentityError(
      "status/untracked files",
      "returned inconsistent working-tree state",
    )
  }
  const repository = safeRepositoryIdentifier(
    repositoryRemote,
    repositoryFallback,
  )
  let untracked: Awaited<ReturnType<typeof hashUntrackedFiles>> = []
  if (dirtyTree) {
    try {
      untracked = await hashUntrackedFiles(projectRoot, untrackedPaths)
    } catch {
      throw new SourceIdentityError(
        "untracked files",
        "could not be fingerprinted",
      )
    }
  }

  return {
    repository,
    commitSha,
    dirtyTree,
    ...(dirtyTree
      ? { diffDigest: canonicalDigest({ status, diffDigest, untracked }) }
      : {}),
  }
}

export function createBuildIdentity(
  project: LoadedProjectConfig,
  plan: WebResolvedScenarioPlan,
  sourceRevision: SourceRevision,
): BuildIdentity {
  const target = plan.target as {
    platform: "web"
    entrypoint: { baseUrl: string; path: string }
  }
  const publicEnvironment = {
    platform: target.platform,
    baseUrl: target.entrypoint.baseUrl,
    profileId: plan.device.profileId,
    renderSpace: plan.device.renderSpace,
    locale: plan.locale,
    theme: plan.theme,
  }
  return {
    platform: "web",
    artifactDigest: canonicalDigest({
      sourceRevision,
      scenarioDigest: plan.scenarioDigest,
      planDigest: plan.planDigest,
    }),
    buildConfigDigest: project.digest,
    publicEnvironmentDigest: canonicalDigest(publicEnvironment),
  }
}

export function createIntendedEnvironmentDigest(
  plan: WebResolvedScenarioPlan,
  browserChannel?: string,
): Digest {
  return canonicalDigest({
    adapter: "uieval.playwright.chromium@0.1.0",
    device: plan.device,
    locale: plan.locale,
    timezone: plan.determinism.timezone,
    theme: plan.theme,
    browserChannel: browserChannel ?? "playwright-chromium",
  })
}
