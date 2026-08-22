import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  assertPathContained,
  assertSafeRelativePath,
  assertSafeSegment,
  atomicWriteFile,
  ensureContainedDirectory,
} from "./filesystem"

export interface RunStoreOptions {
  /** Root of the generated `.ui-eval` working area. */
  root: string
}

export type RunStoreErrorCode =
  | "invalid-run-id"
  | "invalid-relative-path"
  | "containment-violation"
  | "invalid-json"

export class RunStoreError extends Error {
  constructor(
    readonly code: RunStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RunStoreError"
  }
}

function jsonBytes(value: unknown): Buffer {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) {
    throw new RunStoreError(
      "invalid-json",
      "run JSON must have a serializable top-level value",
    )
  }
  return Buffer.from(`${json}\n`, "utf8")
}

export class RunStore {
  private readonly root: string
  private readonly runsRoot: string

  constructor(options: RunStoreOptions)
  constructor(root: string)
  constructor(rootOrOptions: string | RunStoreOptions) {
    const root =
      typeof rootOrOptions === "string" ? rootOrOptions : rootOrOptions.root
    if (typeof root !== "string" || root.length === 0) {
      throw new RunStoreError(
        "containment-violation",
        "run store root is required",
      )
    }

    this.root = resolve(root)
    this.runsRoot = join(this.root, "runs")
    try {
      assertPathContained(this.root, this.runsRoot)
    } catch (error) {
      throw new RunStoreError(
        "containment-violation",
        "runs directory escapes the configured root",
        { cause: error },
      )
    }
  }

  async writeReport(runId: string, value: unknown): Promise<string> {
    return this.writeJson(runId, "report.json", value)
  }

  async writeJson(runId: string, value: unknown): Promise<string>
  async writeJson(
    runId: string,
    relativePath: string,
    value: unknown,
  ): Promise<string>
  async writeJson(
    runId: string,
    relativePathOrValue: string | unknown,
    maybeValue?: unknown,
  ): Promise<string> {
    const hasExplicitPath =
      arguments.length >= 3 && typeof relativePathOrValue === "string"
    const relativePath = hasExplicitPath
      ? (relativePathOrValue as string)
      : "report.json"
    const value = hasExplicitPath ? maybeValue : relativePathOrValue
    return this.writeBinary(runId, relativePath, jsonBytes(value))
  }

  async writeJSON(runId: string, value: unknown): Promise<string>
  async writeJSON(
    runId: string,
    relativePath: string,
    value: unknown,
  ): Promise<string>
  async writeJSON(
    runId: string,
    relativePathOrValue: string | unknown,
    maybeValue?: unknown,
  ): Promise<string> {
    if (arguments.length >= 3 && typeof relativePathOrValue === "string") {
      return this.writeJson(runId, relativePathOrValue, maybeValue)
    }
    return this.writeJson(runId, relativePathOrValue)
  }

  async writeText(
    runId: string,
    relativePath: string,
    value: string,
  ): Promise<string> {
    if (typeof value !== "string") {
      throw new TypeError("run text payload must be a string")
    }
    return this.writeBinary(runId, relativePath, Buffer.from(value, "utf8"))
  }

  async writeBinary(
    runId: string,
    relativePath: string,
    value: Uint8Array | ArrayBuffer,
  ): Promise<string> {
    const target = await this.prepareTarget(runId, relativePath)
    const bytes =
      value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value)
    await atomicWriteFile(target, bytes)
    return target
  }

  async read(runId: string, relativePath: string): Promise<Buffer> {
    const target = await this.prepareTarget(runId, relativePath)
    const targetStat = await lstat(target)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new RunStoreError(
        "containment-violation",
        "run output must be a regular file",
      )
    }
    const [realRunRoot, realTarget] = await Promise.all([
      realpath(join(this.runsRoot, runId)),
      realpath(target),
    ])
    try {
      assertPathContained(realRunRoot, realTarget)
    } catch (error) {
      throw new RunStoreError(
        "containment-violation",
        "run output resolves outside its run directory",
        { cause: error },
      )
    }
    return readFile(realTarget)
  }

  private async prepareTarget(
    runId: string,
    relativePath: string,
  ): Promise<string> {
    try {
      assertSafeSegment(runId, "runId")
    } catch (error) {
      throw new RunStoreError(
        "invalid-run-id",
        error instanceof Error ? error.message : "runId is invalid",
        { cause: error },
      )
    }

    try {
      assertSafeRelativePath(relativePath)
    } catch (error) {
      throw new RunStoreError(
        "invalid-relative-path",
        error instanceof Error ? error.message : "relativePath is invalid",
        { cause: error },
      )
    }

    const runRoot = join(this.runsRoot, runId)
    const target = join(runRoot, ...relativePath.split("/"))
    try {
      assertPathContained(runRoot, target)
      await ensureContainedDirectory(this.root, dirname(target))
    } catch (error) {
      throw new RunStoreError(
        "containment-violation",
        "run output path escapes its run directory",
        { cause: error },
      )
    }
    return target
  }
}
