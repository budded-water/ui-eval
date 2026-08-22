import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

import {
  collectSourceRevision,
  SourceIdentityError,
  type GitRunner,
} from "./identity"

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("collectSourceRevision", () => {
  it("records dirty source inputs without exposing the diff", async () => {
    const calls = new Map([
      ["config --get remote.origin.url", "git@example.test:team/repo.git\n"],
      ["rev-parse HEAD", "abc123\n"],
      ["status --porcelain=v1 --untracked-files=all", " M app/page.tsx\n"],
      ["diff --binary --no-ext-diff HEAD", "secret source diff\n"],
      ["ls-files --others --exclude-standard -z", ""],
    ])
    const revision = await collectSourceRevision("/workspace/repo", async (args) =>
      calls.get(args.join(" ")) ?? "",
    )

    expect(revision).toMatchObject({
      repository: "example.test:team/repo.git",
      commitSha: "abc123",
      dirtyTree: true,
    })
    expect(revision.diffDigest).toMatch(/^sha256:/)
    expect(JSON.stringify(revision)).not.toContain("secret source diff")
  })

  it("removes HTTPS credentials and token-bearing URL components deterministically", async () => {
    const remotes = [
      "https://build-user:first-secret@github.com/acme/product.git?token=query-secret#private",
      "https://oauth2:second-secret@github.com/acme/product.git?access_token=another-secret",
    ]
    const revisions = await Promise.all(
      remotes.map((remote) =>
        collectSourceRevision("/workspace/repo", async (args) => {
          if (args.join(" ") === "config --get remote.origin.url") return remote
          if (args.join(" ") === "rev-parse HEAD") return "abc123"
          return ""
        }),
      ),
    )

    expect(revisions.map((revision) => revision.repository)).toEqual([
      "https://github.com/acme/product.git",
      "https://github.com/acme/product.git",
    ])
    const serialized = JSON.stringify(revisions)
    for (const secret of [
      "build-user",
      "first-secret",
      "query-secret",
      "oauth2",
      "second-secret",
      "access_token",
      "another-secret",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("redacts credentials nested inside an allowlisted remote-helper URL", async () => {
    const revision = await collectSourceRevision(
      "/workspace/repo",
      async (args) =>
        args.join(" ") === "config --get remote.origin.url"
          ? "hg::https://build-user:top-secret@example.test/team/repo?token=query-secret#private"
          : args.join(" ") === "rev-parse HEAD"
            ? "abc123\n"
            : "",
    )

    expect(revision.repository).toBe(
      "hg::https://example.test/team/repo",
    )
    expect(JSON.stringify(revision)).not.toMatch(
      /build-user|top-secret|query-secret/,
    )
  })

  it("retains a safe SCP-style SSH repository identifier without its user", async () => {
    const revision = await collectSourceRevision(
      "/workspace/repo",
      async (args) =>
        args.join(" ") === "config --get remote.origin.url"
          ? "git@example.test:team/repo.git"
          : args.join(" ") === "rev-parse HEAD"
            ? "abc123"
            : "",
    )

    expect(revision.repository).toBe("example.test:team/repo.git")
    expect(JSON.stringify(revision)).not.toContain("git@example.test")
  })

  it("fails closed for a malformed credential-bearing HTTPS remote", async () => {
    const revision = await collectSourceRevision(
      "/workspace/repo",
      async (args) =>
        args.join(" ") === "config --get remote.origin.url"
          ? "https://user:top-secret@"
          : args.join(" ") === "rev-parse HEAD"
            ? "abc123"
            : "",
    )

    expect(revision.repository).toMatch(/^local:sha256:/)
    expect(JSON.stringify(revision)).not.toContain("top-secret")
  })

  it("never copies an unsafe helper or unsupported URL into provenance", async () => {
    const remotes = [
      "ext::sh -c 'send super-secret'",
      "file:///Users/private-user/repo",
      "custom://user:secret@example.test/repo",
      "plain-secret-token",
    ]
    const revisions = await Promise.all(
      remotes.map((remote) =>
        collectSourceRevision("/workspace/repo", async (args) => {
          if (args.join(" ") === "config --get remote.origin.url") return remote
          if (args.join(" ") === "rev-parse HEAD") return "abc123"
          return ""
        }),
      ),
    )

    expect(new Set(revisions.map((revision) => revision.repository)).size).toBe(1)
    for (const revision of revisions) {
      expect(revision.repository).toMatch(/^local:sha256:/)
    }
    expect(JSON.stringify(revisions)).not.toMatch(
      /super-secret|private-user|plain-secret-token|user:secret/,
    )
  })

  it("fails explicitly when required Git identity commands fail", async () => {
    const commands = [
      "rev-parse HEAD",
      "status --porcelain=v1 --untracked-files=all",
      "diff --binary --no-ext-diff HEAD",
      "ls-files --others --exclude-standard -z",
    ]

    for (const failedCommand of commands) {
      await expect(
        collectSourceRevision("/workspace/repo", async (args) => {
          const command = args.join(" ")
          if (command === failedCommand) throw new Error("secret Git stderr")
          if (command === "rev-parse HEAD") return "abc123"
          return ""
        }),
      ).rejects.toMatchObject({
        name: "SourceIdentityError",
        code: "SOURCE_IDENTITY_UNAVAILABLE",
      })
    }
  })

  it("does not include underlying Git stderr in the structured error", async () => {
    let error: unknown
    try {
      await collectSourceRevision("/workspace/repo", async (args) => {
        if (args.join(" ") === "rev-parse HEAD") {
          throw new Error("credential=top-secret")
        }
        return ""
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(SourceIdentityError)
    expect(String(error)).not.toContain("top-secret")
  })

  it("rejects inconsistent clean status and non-empty diff output", async () => {
    await expect(
      collectSourceRevision("/workspace/repo", async (args) => {
        const command = args.join(" ")
        if (command === "rev-parse HEAD") return "abc123"
        if (command === "diff --binary --no-ext-diff HEAD") return "changed"
        return ""
      }),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_UNAVAILABLE" })
  })

  it("changes identity when an untracked file changes without changing its path", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-identity-"))
    roots.push(projectRoot)
    const sourcePath = join(projectRoot, "new-page.tsx")
    const runner: GitRunner = async (args) => {
      const command = args.join(" ")
      if (command === "status --porcelain=v1 --untracked-files=all") {
        return "?? new-page.tsx\n"
      }
      if (command === "ls-files --others --exclude-standard -z") {
        return "new-page.tsx\0"
      }
      if (command === "rev-parse HEAD") return "abc123\n"
      if (command === "config --get remote.origin.url") return "repo\n"
      return ""
    }

    await writeFile(sourcePath, "first", "utf8")
    const first = await collectSourceRevision(projectRoot, runner)
    await writeFile(sourcePath, "second", "utf8")
    const second = await collectSourceRevision(projectRoot, runner)

    expect(first.diffDigest).not.toBe(second.diffDigest)
  })

  it("stream-hashes a diff larger than the bounded Git metadata buffer", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ui-eval-large-diff-"))
    roots.push(projectRoot)
    const sourcePath = join(projectRoot, "large-source.txt")
    const git = (args: string[]) =>
      execFileAsync("git", args, {
        cwd: projectRoot,
        maxBuffer: 1024 * 1024,
      })

    await git(["init"])
    await git(["config", "user.email", "ui-eval@example.test"])
    await git(["config", "user.name", "UI Eval"])
    await writeFile(sourcePath, "initial\n", "utf8")
    await git(["add", "large-source.txt"])
    await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"])
    await writeFile(sourcePath, `${"x".repeat(5 * 1024 * 1024)}\n`, "utf8")

    const revision = await collectSourceRevision(projectRoot)

    expect(revision).toMatchObject({ dirtyTree: true })
    expect(revision.diffDigest).toMatch(/^sha256:/)
  }, 20_000)
})
