import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ArtifactStoreError,
  LocalArtifactStore,
  type ArtifactRef,
} from "./artifact-store"

describe("LocalArtifactStore", () => {
  let root: string
  let outsideRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ui-eval-artifacts-"))
    outsideRoot = await mkdtemp(join(tmpdir(), "ui-eval-artifacts-outside-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  function artifactPath(ref: ArtifactRef): string {
    const hex = ref.digest.slice("sha256:".length)
    return join(
      root,
      "artifacts",
      "projects",
      ref.projectId,
      "stores",
      ref.storeId,
      "sha256",
      hex.slice(0, 2),
      hex,
    )
  }

  function sensitivityMarkerPath(
    ref: ArtifactRef,
    sensitivity: ArtifactRef["sensitivity"],
  ): string {
    const hex = ref.digest.slice("sha256:".length)
    return join(
      root,
      "artifacts",
      "projects",
      ref.projectId,
      "stores",
      ref.storeId,
      "metadata",
      "sha256",
      hex.slice(0, 2),
      hex,
      `sensitivity-${sensitivity}.json`,
    )
  }

  it("deduplicates identical bytes and resolves verified content", async () => {
    const store = new LocalArtifactStore({
      root,
      projectId: "project-a",
      storeId: "local",
    })
    const bytes = Buffer.from("sealed evidence")

    const refs = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.put(bytes, { mediaType: "text/plain", sensitivity: "sensitive" }),
      ),
    )

    expect(new Set(refs.map((ref) => ref.digest))).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      id: refs[0].digest,
      projectId: "project-a",
      storeId: "local",
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      sensitivity: "sensitive",
    })
    await expect(store.resolve(refs[0])).resolves.toEqual(bytes)

    const entries = await readdir(join(artifactPath(refs[0]), ".."))
    expect(entries).toEqual([refs[0].digest.slice("sha256:".length)])
  })

  it("references existing sealed inputs without recreating missing bytes or downgrading sensitivity", async () => {
    const store = new LocalArtifactStore({ root, projectId: "project-a", storeId: "local" })
    const input = { sealed: true }
    const ref = await store.put(input, { sensitivity: "sensitive" })
    expect(await store.referenceExisting(input, { sensitivity: "internal" })).toEqual(ref)
    await rm(artifactPath(ref))
    await expect(store.referenceExisting(input)).rejects.toMatchObject({ code: "artifact-missing" })
    await expect(readFile(artifactPath(ref))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses deterministic JSON bytes for content addressing", async () => {
    const store = new LocalArtifactStore(root, "project-a", "local")

    const first = await store.putJson({ beta: 2, alpha: { z: 1, a: 0 } })
    const second = await store.put({ alpha: { a: 0, z: 1 }, beta: 2 })

    expect(first.digest).toBe(second.digest)
    expect(first.mediaType).toBe("application/json")
    await expect(store.resolve(first)).resolves.toEqual(
      Buffer.from('{"alpha":{"a":0,"z":1},"beta":2}'),
    )
  })

  it("persists sensitivity monotonically and ignores a forged lower-label ref", async () => {
    const store = new LocalArtifactStore(root, "project-a", "local")
    const bytes = Buffer.from("credential-bearing evidence")

    const sensitive = await store.put(bytes, {
      mediaType: "text/plain",
      sensitivity: "sensitive",
    })
    const repeated = await store.put(bytes, {
      mediaType: "text/plain",
      sensitivity: "internal",
    })
    const resolution = await store.resolveWithMetadata({
      ...repeated,
      sensitivity: "public",
    })

    expect(sensitive.sensitivity).toBe("sensitive")
    expect(repeated.sensitivity).toBe("sensitive")
    expect(resolution).toEqual({ bytes, sensitivity: "sensitive" })
    expect(
      JSON.parse(await readFile(sensitivityMarkerPath(sensitive, "sensitive"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      digest: sensitive.digest,
      sensitivity: "sensitive",
    })
    await expect(
      readFile(sensitivityMarkerPath(sensitive, "internal")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps concurrent classifications monotonic for one digest", async () => {
    const store = new LocalArtifactStore(root, "project-a", "local")
    const bytes = Buffer.from("concurrently classified evidence")

    const refs = await Promise.all([
      store.put(bytes, { sensitivity: "public" }),
      store.put(bytes, { sensitivity: "sensitive" }),
      store.put(bytes, { sensitivity: "internal" }),
      store.put(bytes, { sensitivity: "public" }),
    ])
    const lowerRef = await store.put(bytes, { sensitivity: "internal" })
    const resolution = await store.resolveWithMetadata({
      ...refs[0],
      sensitivity: "public",
    })

    expect(new Set(refs.map((ref) => ref.digest))).toHaveLength(1)
    expect(lowerRef.sensitivity).toBe("sensitive")
    expect(resolution.sensitivity).toBe("sensitive")
  })

  it("treats legacy objects without metadata as sensitive and migrates on put", async () => {
    const store = new LocalArtifactStore(root, "project-a", "local")
    const original = await store.put(Buffer.from("legacy evidence"), {
      sensitivity: "internal",
    })
    const metadataRoot = join(
      root,
      "artifacts",
      "projects",
      original.projectId,
      "stores",
      original.storeId,
      "metadata",
    )
    await rm(metadataRoot, { recursive: true, force: true })

    const resolution = await store.resolveWithMetadata({
      ...original,
      sensitivity: "public",
    })
    const migrated = await store.put(Buffer.from("legacy evidence"), {
      sensitivity: "internal",
    })

    expect(resolution.sensitivity).toBe("sensitive")
    expect(migrated.sensitivity).toBe("sensitive")
    await expect(
      readFile(sensitivityMarkerPath(migrated, "sensitive"), "utf8"),
    ).resolves.toContain('"sensitivity":"sensitive"')
  })

  it("fails closed when sensitivity metadata is corrupt or a symlink", async () => {
    const store = new LocalArtifactStore(root, "project-a", "local")
    const corrupt = await store.put(Buffer.from("corrupt metadata"), {
      sensitivity: "internal",
    })
    await writeFile(sensitivityMarkerPath(corrupt, "internal"), "not-json")

    await expect(store.resolveWithMetadata(corrupt)).rejects.toMatchObject({
      code: "artifact-corrupt",
    })

    const linked = await store.put(Buffer.from("linked metadata"), {
      sensitivity: "internal",
    })
    const linkedMarker = sensitivityMarkerPath(linked, "internal")
    await rm(linkedMarker)
    const outsideMarker = join(outsideRoot, "sensitivity-internal.json")
    await writeFile(outsideMarker, "{}")
    await symlink(outsideMarker, linkedMarker)

    await expect(store.resolveWithMetadata(linked)).rejects.toMatchObject({
      code: "containment-violation",
    })
  })

  it("rejects size and digest corruption instead of trusting metadata", async () => {
    const store = new LocalArtifactStore(root, "project-a", "local")
    const ref = await store.put(Buffer.from("original"))

    await expect(
      store.resolve({ ...ref, sizeBytes: ref.sizeBytes + 1 }),
    ).rejects.toMatchObject({
      code: "artifact-corrupt",
    })

    await writeFile(artifactPath(ref), Buffer.from("tampered"))
    await expect(store.resolve(ref)).rejects.toMatchObject({
      code: "artifact-corrupt",
    })
    await expect(store.put(Buffer.from("original"))).rejects.toMatchObject({
      code: "artifact-corrupt",
    })
  })

  it("enforces project and store scope before resolving an object", async () => {
    const source = new LocalArtifactStore(root, "project-a", "local")
    const otherProject = new LocalArtifactStore(root, "project-b", "local")
    const otherStore = new LocalArtifactStore(root, "project-a", "remote")
    const ref = await source.put(Buffer.from("private evidence"))

    await expect(otherProject.resolve(ref)).rejects.toMatchObject({
      code: "scope-mismatch",
    })
    await expect(otherStore.resolve(ref)).rejects.toMatchObject({
      code: "scope-mismatch",
    })
  })

  it("rejects malformed ids, digests, and path-like scope identifiers", async () => {
    expect(
      () => new LocalArtifactStore(root, "../project-b", "local"),
    ).toThrowError(ArtifactStoreError)

    const store = new LocalArtifactStore(root, "project-a", "local")
    const ref = await store.put(Buffer.from("evidence"))
    const traversalRef = {
      ...ref,
      id: "sha256:../../outside",
      digest: "sha256:../../outside",
    } as ArtifactRef

    await expect(store.resolve(traversalRef)).rejects.toMatchObject({
      code: "invalid-ref",
    })
    await expect(
      store.resolve({ ...ref, id: "../../outside" }),
    ).rejects.toMatchObject({
      code: "invalid-ref",
    })
  })

  it("does not follow a storage-directory symlink outside the configured root", async () => {
    await mkdir(join(root, "artifacts"))
    await symlink(outsideRoot, join(root, "artifacts", "projects"))
    const store = new LocalArtifactStore(root, "project-a", "local")

    await expect(store.put(Buffer.from("must stay contained"))).rejects.toMatchObject({
      code: "containment-violation",
    })
    expect(await readdir(outsideRoot)).toEqual([])
  })
})
