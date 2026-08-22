import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import type {
  ArtifactRef,
  CaptureBundleSpec,
  CaptureCapability,
  EvidenceRecord,
} from "../contracts/model"
import { LocalArtifactStore } from "../storage-local/artifact-store"
import {
  materializeEvidenceAliases,
  type EvidenceArtifactResolver,
  type EvidenceRunWriter,
} from "./evidence-aliases"

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as ArtifactRef["digest"]

function artifact(
  character: string,
  sensitivity: ArtifactRef["sensitivity"] = "internal",
  mediaType = "application/json",
): ArtifactRef {
  const value = digest(character)
  return {
    id: value,
    projectId: "project-a",
    storeId: "local-cas-v1",
    digest: value,
    mediaType,
    sizeBytes: 8,
    sensitivity,
  }
}

const renderSpace = {
  logicalWidth: 800,
  logicalHeight: 600,
  logicalUnit: "css-px" as const,
  deviceScaleFactor: 1,
  screenshotWidthPx: 800,
  screenshotHeightPx: 600,
  orientation: "landscape" as const,
}

function capture(records: EvidenceRecord[]): CaptureBundleSpec {
  const required = records.filter((record) => record.required)
  const captured = required.filter(
    (record) => record.status === "captured" && record.artifact,
  )
  const environmentBase = {
    os: "test",
    architecture: "test",
    rendererProfile: "desktop",
    browserOrDevice: "chromium",
    browserOrOsVersion: "1",
    driverVersion: "1",
    locale: "en-US",
    timezone: "UTC",
    fontSetDigest: digest("f"),
  }
  return {
    executionId: "run-1",
    runManifestDigest: digest("1"),
    captureKey: digest("2"),
    scenarioId: "scenario-a",
    variant: {
      variantKey: "desktop-en-light",
      values: { deviceProfile: "desktop", locale: "en-US", theme: "light" },
      contextDigest: digest("3"),
    },
    sourceRevision: { repository: "test", commitSha: "abc123" },
    build: {
      platform: "web",
      artifactDigest: digest("4"),
      buildConfigDigest: digest("5"),
      publicEnvironmentDigest: digest("6"),
    },
    adapter: { id: "test", version: "1", platform: "web" },
    environment: {
      ...environmentBase,
      environmentDigest: digest("7"),
    },
    capabilities: records.map((record) => record.channel),
    status: captured.length === required.length ? "completed" : "partial",
    completeness: {
      expectedRequired: required.length,
      capturedRequired: captured.length,
      missingRequired: required.length - captured.length,
    },
    stepResults: [],
    assertionResults: [],
    checkpoints: [
      {
        checkpointId: "ready",
        renderSpace,
        capturedAt: "2026-08-10T00:00:00.000Z",
        evidence: records,
      },
    ],
  }
}

function record(
  channel: CaptureCapability,
  ref: ArtifactRef,
): EvidenceRecord {
  return {
    channel,
    required: true,
    status: "captured",
    artifact: ref,
  }
}

function ports(options?: {
  resolve?: (ref: ArtifactRef) => Promise<Buffer>
  trustedSensitivity?: ArtifactRef["sensitivity"]
  write?: (runId: string, path: string, bytes: Uint8Array) => Promise<string>
}) {
  const resolveBytes =
    options?.resolve ?? (async () => Buffer.from("evidence"))
  const resolve = vi.fn(async (ref: ArtifactRef) => ({
    bytes: await resolveBytes(ref),
    sensitivity: options?.trustedSensitivity ?? ref.sensitivity,
  }))
  const writeBinary = vi.fn(
    options?.write ??
      (async (_runId: string, path: string) => `/runs/run-1/${path}`),
  )
  return {
    artifactStore: {
      resolveWithMetadata: resolve,
    } as unknown as EvidenceArtifactResolver,
    runStore: { writeBinary } as unknown as EvidenceRunWriter,
    resolve,
    writeBinary,
  }
}

describe("materializeEvidenceAliases", () => {
  it("honors CAS sensitivity history when a later ref is downgraded", async () => {
    const root = await mkdtemp(join(tmpdir(), "ui-eval-sensitive-alias-"))
    try {
      const store = new LocalArtifactStore({
        root,
        projectId: "project-a",
        storeId: "local-cas-v1",
      })
      const bytes = Buffer.from("historically sensitive evidence")
      const sensitive = await store.put(bytes, {
        mediaType: "image/png",
        sensitivity: "sensitive",
      })
      const repeated = await store.put(bytes, {
        mediaType: "image/png",
        sensitivity: "internal",
      })
      const forged = {
        ...repeated,
        sensitivity: "internal" as const,
      } as ArtifactRef
      const writeBinary = vi.fn(async () => "/runs/run-1/candidate.png")

      const result = await materializeEvidenceAliases(
        capture([record("screenshot", forged)]),
        store,
        { writeBinary },
      )

      expect(sensitive.sensitivity).toBe("sensitive")
      expect(repeated.sensitivity).toBe("sensitive")
      expect(writeBinary).not.toHaveBeenCalled()
      expect(result.aliases.byDigest).toEqual(new Map())
      expect(
        result.capture.checkpoints[0].evidence[0].artifact?.sensitivity,
      ).toBe("sensitive")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps sensitive digests CAS-only and monotonically upgrades every occurrence", async () => {
    const screenshot = artifact("a", "internal", "image/png")
    const sensitive = artifact("b", "sensitive")
    const mislabeled = { ...sensitive, sensitivity: "internal" as const }
    const source = capture([
      record("screenshot", screenshot),
      record("console", sensitive),
      record("dom", mislabeled),
    ])
    const { artifactStore, runStore, resolve, writeBinary } = ports()

    const result = await materializeEvidenceAliases(
      source,
      artifactStore,
      runStore,
    )

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(writeBinary).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "candidate.png",
      Buffer.from("evidence"),
    )
    expect(result.aliases.byDigest).toEqual(
      new Map([[screenshot.digest, "candidate.png"]]),
    )
    expect(result.aliases.byChannel).toEqual(
      new Map([["screenshot", "candidate.png"]]),
    )
    expect(result.warnings).toEqual([])
    expect(
      result.capture.checkpoints[0].evidence.map(
        (evidence) => evidence.artifact?.sensitivity,
      ),
    ).toEqual(["internal", "sensitive", "sensitive"])
    expect(source.checkpoints[0].evidence[2].artifact?.sensitivity).toBe(
      "internal",
    )
  })

  it.each([
    "console",
    "network",
    "trace",
    "video",
    "device-logs",
    "crash",
    "performance",
  ] satisfies CaptureCapability[])(
    "never materializes a plaintext alias for mislabeled %s evidence",
    async (channel) => {
      const source = capture([record(channel, artifact("a", "internal"))])
      const { artifactStore, runStore, resolve, writeBinary } = ports()

      const result = await materializeEvidenceAliases(
        source,
        artifactStore,
        runStore,
      )

      expect(resolve).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          digest: digest("a"),
          sensitivity: "sensitive",
        }),
      )
      expect(writeBinary).not.toHaveBeenCalled()
      expect(result.aliases.byDigest).toEqual(new Map())
      expect(result.aliases.byChannel).toEqual(new Map())
      expect(
        result.capture.checkpoints[0].evidence[0].artifact?.sensitivity,
      ).toBe("sensitive")
    },
  )

  it("lets a mislabeled sensitive channel protect a digest also used by an aliasable channel", async () => {
    const shared = artifact("a", "internal", "image/png")
    const source = capture([
      record("screenshot", shared),
      record("console", { ...shared, mediaType: "application/json" }),
    ])
    const { artifactStore, runStore, writeBinary } = ports()

    const result = await materializeEvidenceAliases(
      source,
      artifactStore,
      runStore,
    )

    expect(writeBinary).not.toHaveBeenCalled()
    expect(result.aliases.byDigest).toEqual(new Map())
    expect(
      result.capture.checkpoints[0].evidence.map(
        (evidence) => evidence.artifact?.sensitivity,
      ),
    ).toEqual(["sensitive", "sensitive"])
  })

  it("marks unresolved CAS evidence corrupt and recomputes completeness and status", async () => {
    const screenshot = artifact("a", "internal", "image/png")
    const dom = artifact("b")
    const source = capture([
      record("screenshot", screenshot),
      record("dom", dom),
    ])
    const snapshot = structuredClone(source)
    const { artifactStore, runStore } = ports({
      resolve: async (ref) => {
        if (ref.digest === dom.digest) throw new Error("corrupt")
        return Buffer.from("evidence")
      },
    })

    const result = await materializeEvidenceAliases(
      source,
      artifactStore,
      runStore,
    )

    expect(source).toEqual(snapshot)
    expect(result.capture).toMatchObject({
      status: "partial",
      completeness: {
        expectedRequired: 2,
        capturedRequired: 1,
        missingRequired: 1,
      },
      executionErrors: [
        {
          origin: "runner",
          phase: "checkpoint",
          code: "artifact-resolution-failed",
          retryable: true,
        },
      ],
    })
    expect(result.capture.checkpoints[0].evidence[1]).toMatchObject({
      channel: "dom",
      status: "corrupt",
      artifact: dom,
      error: { code: "artifact-resolution-failed" },
    })
    expect(result.aliases.byDigest.get(screenshot.digest)).toBe("candidate.png")
    expect(result.aliases.byDigest.has(dom.digest)).toBe(false)
  })

  it("marks a capture failed when no required CAS evidence remains valid", async () => {
    const source = capture([record("dom", artifact("b"))])
    const { artifactStore, runStore } = ports({
      resolve: async () => {
        throw new Error("missing")
      },
    })

    const result = await materializeEvidenceAliases(
      source,
      artifactStore,
      runStore,
    )

    expect(result.capture.status).toBe("failed")
    expect(result.capture.completeness).toEqual({
      expectedRequired: 1,
      capturedRequired: 0,
      missingRequired: 1,
    })
  })

  it("reports alias write failures as presentation warnings without invalidating evidence", async () => {
    const screenshot = artifact("a", "internal", "image/png")
    const dom = artifact("b")
    const source = capture([
      record("screenshot", screenshot),
      record("dom", dom),
    ])
    const { artifactStore, runStore, writeBinary } = ports({
      write: async (_runId, path) => {
        if (path === "candidate.png") throw new Error("disk full")
        return `/runs/run-1/${path}`
      },
    })

    const result = await materializeEvidenceAliases(
      source,
      artifactStore,
      runStore,
    )

    expect(result.capture.status).toBe("completed")
    expect(result.capture.completeness.missingRequired).toBe(0)
    expect(result.capture.executionErrors).toBeUndefined()
    expect(writeBinary).toHaveBeenCalledTimes(2)
    expect(result.aliases.byDigest).toEqual(new Map([[dom.digest, "dom.json"]]))
    expect(result.aliases.byChannel).toEqual(new Map([["dom", "dom.json"]]))
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "evidence-alias-write-failed",
        checkpointId: "ready",
        channel: "screenshot",
        artifactDigest: screenshot.digest,
        relativePath: "candidate.png",
      }),
    ])
  })

  it("never upgrades a failed or partial capture from evidence counts alone", async () => {
    const screenshot = artifact("a", "internal", "image/png")
    const failed = capture([record("screenshot", screenshot)])
    failed.status = "failed"
    failed.executionErrors = [
      {
        origin: "runner",
        phase: "action",
        code: "capture-aborted",
        message: "Capture was aborted",
        retryable: false,
      },
    ]
    const partial = structuredClone(failed)
    partial.status = "partial"
    const { artifactStore, runStore } = ports()

    const failedResult = await materializeEvidenceAliases(
      failed,
      artifactStore,
      runStore,
    )
    const partialResult = await materializeEvidenceAliases(
      partial,
      artifactStore,
      runStore,
    )

    expect(failedResult.capture.status).toBe("failed")
    expect(partialResult.capture.status).toBe("partial")
    expect(failedResult.capture.completeness.missingRequired).toBe(0)
    expect(partialResult.capture.completeness.missingRequired).toBe(0)
  })
})
