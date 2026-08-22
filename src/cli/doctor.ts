import { access, mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import { resolve } from "node:path"
import { chromium, type LaunchOptions } from "playwright"

import { loadProjectConfig } from "../project/config"

export interface DoctorCheck {
  id: "runtime" | "config" | "artifact-store" | "browser" | "dev-server"
  status: "pass" | "warn" | "fail"
  message: string
}

export interface DoctorResult {
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  projectRoot: string
  browserChannel?: string
  checkBrowser?: (launchOptions: LaunchOptions) => Promise<string>
  fetchImpl?: typeof fetch
}

async function defaultBrowserCheck(
  launchOptions: LaunchOptions,
): Promise<string> {
  const browser = await chromium.launch({ headless: true, ...launchOptions })
  try {
    return browser.version()
  } finally {
    await browser.close()
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = []
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10)
  checks.push({
    id: "runtime",
    status: nodeMajor >= 20 ? "pass" : "fail",
    message:
      nodeMajor >= 20
        ? `Node.js ${process.versions.node}`
        : `Node.js 20+ is required; found ${process.versions.node}`,
  })

  let project: Awaited<ReturnType<typeof loadProjectConfig>> | undefined
  try {
    project = await loadProjectConfig({ projectRoot: options.projectRoot })
    checks.push({
      id: "config",
      status: "pass",
      message: `Loaded ${project.path}`,
    })
  } catch (error) {
    checks.push({
      id: "config",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (project) {
    const artifactRoot = resolve(
      project.projectRoot,
      project.value.artifactRoot ?? ".ui-eval",
    )
    try {
      await mkdir(artifactRoot, { recursive: true })
      await access(artifactRoot, constants.R_OK | constants.W_OK)
      checks.push({
        id: "artifact-store",
        status: "pass",
        message: `Generated artifacts are writable at ${artifactRoot}`,
      })
    } catch (error) {
      checks.push({
        id: "artifact-store",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      })
    }

    const fetchImpl = options.fetchImpl ?? fetch
    try {
      const server = project.value.devServer
      const probeUrl = new URL(
        server.readiness?.path ?? "/",
        server.url,
      ).toString()
      const response = await fetchImpl(probeUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_500),
      })
      if (!server.reuseExisting) {
        checks.push({
          id: "dev-server",
          status: "fail",
          message: `A server is already responding at ${server.url}; evaluate will refuse this unowned process because reuseExisting is false.`,
        })
      } else {
        const bodyMatches = server.readiness
          ? (await response.text()).includes(server.readiness.bodyIncludes)
          : false
        const healthy = response.status >= 200 && response.status < 500
        checks.push({
          id: "dev-server",
          status: healthy && bodyMatches ? "pass" : "fail",
          message:
            healthy && bodyMatches
              ? `Candidate server proved the configured project identity at ${probeUrl}.`
              : `A server responded at ${server.url}, but it did not prove the configured project identity.`,
        })
      }
    } catch {
      checks.push({
        id: "dev-server",
        status: "warn",
        message: "Candidate server is offline; evaluate will start it from project.json",
      })
    }
  }

  try {
    const version = await (options.checkBrowser ?? defaultBrowserCheck)(
      options.browserChannel ? { channel: options.browserChannel } : {},
    )
    checks.push({
      id: "browser",
      status: "pass",
      message: `Chromium ${version}${options.browserChannel ? ` via ${options.browserChannel}` : ""}`,
    })
  } catch (error) {
    checks.push({
      id: "browser",
      status: "fail",
      message: `${error instanceof Error ? error.message : String(error)}. Install Playwright Chromium with your package manager or pass --browser-channel chrome.`,
    })
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  }
}
