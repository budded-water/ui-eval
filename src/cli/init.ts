import { appendFile, lstat, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { ensureContainedDirectory } from "../storage-local/filesystem"

export interface InitUiEvalProjectOptions {
  projectRoot: string
  route: string
  scenarioId: string
}

export interface InitUiEvalProjectResult {
  created: string[]
  updated: string[]
  skipped: string[]
}

const scenarioIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const packageJsonReadLimitBytes = 1024 * 1024

type SupportedPackageManager = "bun" | "npm" | "pnpm" | "yarn"

interface DevCommand {
  command: SupportedPackageManager
  args: ["run", "dev"]
}

const lockfilesByPackageManager = {
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
} as const satisfies Record<SupportedPackageManager, readonly string[]>

function assertSafeInputs(options: InitUiEvalProjectOptions): void {
  if (!scenarioIdPattern.test(options.scenarioId)) {
    throw new Error(
      "scenario id must start with an alphanumeric character and contain only letters, numbers, '.', '_' or '-'",
    )
  }
  if (
    !options.route.startsWith("/") ||
    options.route.startsWith("//") ||
    options.route.includes("\\") ||
    options.route.includes("://")
  ) {
    throw new Error("route must be a same-origin path beginning with a single '/'")
  }
}

function projectIdFor(projectRoot: string): string {
  const normalized = basename(projectRoot)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128)
  return normalized || "ui-project"
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && !metadata.isSymbolicLink()
  } catch {
    return false
  }
}

async function declaredPackageManager(
  projectRoot: string,
): Promise<SupportedPackageManager | undefined> {
  const packageJsonPath = join(projectRoot, "package.json")
  try {
    const metadata = await lstat(packageJsonPath)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > packageJsonReadLimitBytes
    ) {
      return undefined
    }
    const value = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      packageManager?: unknown
    }
    if (typeof value.packageManager !== "string") return undefined
    const match = /^(bun|npm|pnpm|yarn)@/.exec(value.packageManager)
    return match?.[1] as SupportedPackageManager | undefined
  } catch {
    return undefined
  }
}

async function detectedPackageManager(
  projectRoot: string,
): Promise<SupportedPackageManager> {
  const declared = await declaredPackageManager(projectRoot)
  if (declared) return declared

  const detected = new Set<SupportedPackageManager>()
  await Promise.all(
    Object.entries(lockfilesByPackageManager).flatMap(([manager, names]) =>
      names.map(async (name) => {
        if (await regularFile(join(projectRoot, name))) {
          detected.add(manager as SupportedPackageManager)
        }
      }),
    ),
  )
  return detected.size === 1 ? [...detected][0] : "npm"
}

function devCommand(packageManager: SupportedPackageManager): DevCommand {
  return { command: packageManager, args: ["run", "dev"] }
}

function projectTemplate(
  projectRoot: string,
  packageManager: SupportedPackageManager,
): unknown {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ProjectConfig",
    projectId: projectIdFor(projectRoot),
    artifactRoot: ".ui-eval",
    devServer: {
      ...devCommand(packageManager),
      url: "http://127.0.0.1:3000",
      reuseExisting: false,
      startupTimeoutMs: 60_000,
    },
    baseUrls: { local: "http://127.0.0.1:3000" },
    deviceProfiles: {
      "desktop-chromium": {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    defaults: { locale: "en", theme: "light", timezone: "UTC" },
    supportedCapabilities: [
      "screenshot",
      "dom",
      "computed-styles",
      "layout-metadata",
      "console",
      "network",
      "trace",
      "crash",
    ],
  }
}

function policyTemplate(): unknown {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "PolicySource",
    id: "phase-0a-default",
    revision: 1,
    profile: "web-default",
  }
}

function scenarioTemplate(route: string, scenarioId: string): unknown {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "ScenarioSource",
    id: scenarioId,
    revision: 1,
    name: `${scenarioId} desktop smoke`,
    visibility: "agent-visible",
    tags: ["phase-0a", "smoke"],
    target: {
      platform: "web",
      entrypoint: { baseUrlRef: "local", path: route },
    },
    determinism: {
      timezone: "UTC",
      clock: { mode: "real" },
      randomSeed: `${scenarioId}-v1`,
    },
    requiredCapabilities: [
      "screenshot",
      "console",
      "network",
      "crash",
    ],
    matrix: {
      deviceProfiles: ["desktop-chromium"],
      locales: ["en"],
      themes: ["light"],
    },
    steps: [
      { id: "open-page", action: "goto", path: route },
      {
        id: "wait-for-main",
        action: "waitFor",
        target: { platform: "web", by: "css", value: "main" },
        condition: "visible",
        timeoutMs: 15_000,
      },
      { id: "capture-ready", action: "checkpoint", checkpointId: "ready" },
    ],
    checkpoints: [
      {
        id: "ready",
        requiredChannels: [
          "screenshot",
          "console",
          "network",
          "crash",
        ],
        captureScope: "full-page",
        stabilize: {
          disableAnimations: true,
          waitForFonts: true,
          stableFrames: 2,
          timeoutMs: 15_000,
        },
        assertions: [
          {
            id: "main-visible",
            kind: "visible",
            target: { platform: "web", by: "css", value: "main" },
            expected: true,
          },
          { id: "no-page-crash", kind: "no-crash", expected: true },
        ],
      },
    ],
  }
}

export async function initUiEvalProject(
  options: InitUiEvalProjectOptions,
): Promise<InitUiEvalProjectResult> {
  assertSafeInputs(options)
  const packageManager = await detectedPackageManager(options.projectRoot)

  const files: Array<readonly [string, unknown]> = [
    [
      "ui-eval/project.json",
      projectTemplate(options.projectRoot, packageManager),
    ],
    ["ui-eval/policies/default.json", policyTemplate()],
    [
      `ui-eval/scenarios/${options.scenarioId}.json`,
      scenarioTemplate(options.route, options.scenarioId),
    ],
  ]
  const result: InitUiEvalProjectResult = {
    created: [],
    updated: [],
    skipped: [],
  }

  const gitignorePath = join(options.projectRoot, ".gitignore")
  await ensureContainedDirectory(options.projectRoot, dirname(gitignorePath))
  try {
    await writeFile(gitignorePath, ".ui-eval/\n", {
      encoding: "utf8",
      flag: "wx",
    })
    result.created.push(".gitignore")
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error
    }
    const metadata = await lstat(gitignorePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("refusing to modify an unsafe .gitignore entry")
    }
    const current = await readFile(gitignorePath, "utf8")
    const alreadyIgnored = current
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .some((entry) => [".ui-eval", ".ui-eval/", "/.ui-eval/"].includes(entry))
    if (alreadyIgnored) {
      result.skipped.push(".gitignore")
    } else {
      await appendFile(
        gitignorePath,
        `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}.ui-eval/\n`,
        "utf8",
      )
      result.updated.push(".gitignore")
    }
  }

  for (const [relativePath, value] of files) {
    const target = join(options.projectRoot, ...relativePath.split("/"))
    await ensureContainedDirectory(options.projectRoot, dirname(target))
    try {
      await writeFile(target, json(value), { encoding: "utf8", flag: "wx" })
      result.created.push(relativePath)
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        result.skipped.push(relativePath)
        continue
      }
      throw error
    }
  }

  return result
}
