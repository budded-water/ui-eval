import { createHash } from "node:crypto"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import { canonicalJson } from "../contracts/canonical-json"
import type { ArtifactRef as ContractArtifactRef } from "../contracts/model"
import {
  assertPathContained,
  assertSafeSegment,
  atomicWriteFile,
  ensureContainedDirectory,
} from "./filesystem"

export type Sha256Digest = `sha256:${string}`
export type ArtifactSensitivity = "public" | "internal" | "sensitive"

// v2 introduced authoritative, monotonic per-digest sensitivity metadata. A
// new namespace is intentional: legacy v1 bytes have no trustworthy label and
// must not poison or silently downgrade newly sealed policy/evidence artifacts.
export const DEFAULT_LOCAL_ARTIFACT_STORE_ID = "local-cas-v2"

/** Derived wire shape with the digest narrowed after runtime verification. */
export type ArtifactRef = Omit<ContractArtifactRef, "digest"> & { digest: Sha256Digest }

export interface ArtifactPutOptions {
  mediaType?: string
  sensitivity?: ArtifactSensitivity
  redaction?: { applied: boolean; policyId?: string }
}

export interface ResolvedArtifact {
  bytes: Buffer
  /**
   * The strictest sensitivity persisted for this digest or supplied by the
   * caller. Unlike ArtifactRef.sensitivity, this value is authoritative for
   * decisions that can materialize plaintext outside the CAS.
   */
  sensitivity: ArtifactSensitivity
}

export interface LocalArtifactStoreOptions {
  root: string
  projectId: string
  storeId: string
}

export type ArtifactStoreErrorCode =
  | "invalid-config"
  | "invalid-ref"
  | "scope-mismatch"
  | "artifact-missing"
  | "artifact-corrupt"
  | "containment-violation"

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ArtifactStoreError"
  }
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const MEDIA_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;[^\r\n]+)?$/
const SENSITIVITY_RANK: Record<ArtifactSensitivity, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
}
const SENSITIVITIES = [
  "public",
  "internal",
  "sensitive",
] as const satisfies readonly ArtifactSensitivity[]

interface SensitivityMarker {
  schemaVersion: 1
  digest: Sha256Digest
  sensitivity: ArtifactSensitivity
}

function stricterSensitivity(
  left: ArtifactSensitivity,
  right: ArtifactSensitivity,
): ArtifactSensitivity {
  return SENSITIVITY_RANK[left] >= SENSITIVITY_RANK[right] ? left : right
}

function sha256(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function asBytes(value: unknown): { bytes: Buffer; isJson: boolean } {
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value), isJson: false }
  }
  if (value instanceof ArrayBuffer) {
    return { bytes: Buffer.from(value), isJson: false }
  }

  return { bytes: Buffer.from(canonicalJson(value), "utf8"), isJson: true }
}

function normalizeOptions(
  options: ArtifactPutOptions | string | undefined,
): ArtifactPutOptions {
  return typeof options === "string" ? { mediaType: options } : (options ?? {})
}

function validatePutOptions(options: ArtifactPutOptions): void {
  if (
    options.mediaType !== undefined &&
    (options.mediaType.length > 255 ||
      !MEDIA_TYPE_PATTERN.test(options.mediaType))
  ) {
    throw new ArtifactStoreError("invalid-ref", "mediaType is invalid")
  }
  if (
    options.sensitivity !== undefined &&
    !["public", "internal", "sensitive"].includes(options.sensitivity)
  ) {
    throw new ArtifactStoreError("invalid-ref", "sensitivity is invalid")
  }
  if (
    options.redaction?.policyId !== undefined &&
    (options.redaction.policyId.length === 0 ||
      options.redaction.policyId.length > 256)
  ) {
    throw new ArtifactStoreError("invalid-ref", "redaction policyId is invalid")
  }
}

export class LocalArtifactStore {
  readonly projectId: string
  readonly storeId: string

  private readonly root: string
  private readonly storeRoot: string

  constructor(options: LocalArtifactStoreOptions)
  constructor(root: string, projectId: string, storeId: string)
  constructor(
    rootOrOptions: string | LocalArtifactStoreOptions,
    projectId?: string,
    storeId?: string,
  ) {
    const options =
      typeof rootOrOptions === "string"
        ? { root: rootOrOptions, projectId, storeId }
        : rootOrOptions

    if (
      typeof options.root !== "string" ||
      typeof options.projectId !== "string" ||
      typeof options.storeId !== "string"
    ) {
      throw new ArtifactStoreError(
        "invalid-config",
        "root, projectId, and storeId are required",
      )
    }

    try {
      assertSafeSegment(options.projectId, "projectId")
      assertSafeSegment(options.storeId, "storeId")
    } catch (error) {
      throw new ArtifactStoreError(
        "invalid-config",
        error instanceof Error ? error.message : "invalid artifact store config",
        { cause: error },
      )
    }

    this.root = resolve(options.root)
    this.projectId = options.projectId
    this.storeId = options.storeId
    this.storeRoot = join(
      this.root,
      "artifacts",
      "projects",
      this.projectId,
      "stores",
      this.storeId,
    )

    try {
      assertPathContained(this.root, this.storeRoot)
    } catch (error) {
      throw new ArtifactStoreError(
        "containment-violation",
        "artifact store path escapes the configured root",
        { cause: error },
      )
    }
  }

  async put(
    value: unknown,
    options?: ArtifactPutOptions | string,
  ): Promise<ArtifactRef> {
    const normalizedOptions = normalizeOptions(options)
    validatePutOptions(normalizedOptions)

    const { bytes, isJson } = asBytes(value)
    const digest = sha256(bytes)
    const requestedSensitivity = normalizedOptions.sensitivity ?? "internal"
    const baseRef: ArtifactRef = {
      id: digest,
      projectId: this.projectId,
      storeId: this.storeId,
      digest,
      mediaType:
        normalizedOptions.mediaType ??
        (isJson ? "application/json" : "application/octet-stream"),
      sizeBytes: bytes.byteLength,
      sensitivity: requestedSensitivity,
      ...(normalizedOptions.redaction
        ? { redaction: { ...normalizedOptions.redaction } }
        : {}),
    }

    const target = this.artifactPath(digest)
    const directory = resolve(target, "..")
    const metadataDirectory = resolve(
      this.sensitivityMarkerPath(digest, requestedSensitivity),
      "..",
    )

    try {
      await ensureContainedDirectory(this.root, directory)
      await ensureContainedDirectory(this.root, metadataDirectory)

      const artifactExists = await this.exists(target)
      const persistedSensitivity = await this.readPersistedSensitivity(
        digest,
        artifactExists,
      )
      const effectiveSensitivity = persistedSensitivity
        ? stricterSensitivity(persistedSensitivity, requestedSensitivity)
        : requestedSensitivity

      // Sensitivity is committed before bytes. A crash can therefore leave a
      // conservative marker without an object, but never an unclassified new
      // object. Separate immutable rank markers make concurrent puts monotonic:
      // no writer can overwrite a stricter classification with a lower one.
      await this.writeSensitivityMarker(digest, effectiveSensitivity)

      const ref = { ...baseRef, sensitivity: effectiveSensitivity }
      if (artifactExists) {
        await this.readVerified(ref, target)
        const trustedSensitivity = await this.readPersistedSensitivity(
          digest,
          true,
        )
        return {
          ...ref,
          sensitivity: trustedSensitivity
            ? stricterSensitivity(effectiveSensitivity, trustedSensitivity)
            : effectiveSensitivity,
        }
      }

      await atomicWriteFile(target, bytes)
      await this.readVerified(ref, target)
      const trustedSensitivity = await this.readPersistedSensitivity(
        digest,
        true,
      )
      return {
        ...ref,
        sensitivity: trustedSensitivity
          ? stricterSensitivity(effectiveSensitivity, trustedSensitivity)
          : effectiveSensitivity,
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError(
        "containment-violation",
        "failed to seal artifact inside the configured store",
        { cause: error },
      )
    }
  }

  async putJson(
    value: unknown,
    options: Omit<ArtifactPutOptions, "mediaType"> & { mediaType?: string } = {},
  ): Promise<ArtifactRef> {
    return this.put(value, { mediaType: "application/json", ...options })
  }

  async putJSON(
    value: unknown,
    options: Omit<ArtifactPutOptions, "mediaType"> & { mediaType?: string } = {},
  ): Promise<ArtifactRef> {
    return this.putJson(value, options)
  }

  async resolve(ref: ArtifactRef): Promise<Buffer> {
    return (await this.resolveWithMetadata(ref)).bytes
  }

  async resolveWithMetadata(ref: ArtifactRef): Promise<ResolvedArtifact> {
    this.validateRef(ref)
    const target = this.artifactPath(ref.digest)
    const bytes = await this.readVerified(ref, target)
    const persistedSensitivity = await this.readPersistedSensitivity(
      ref.digest,
      true,
    )
    return {
      bytes,
      sensitivity: persistedSensitivity
        ? stricterSensitivity(ref.sensitivity, persistedSensitivity)
        : ref.sensitivity,
    }
  }

  private artifactPath(digest: Sha256Digest): string {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new ArtifactStoreError(
        "invalid-ref",
        "artifact digest must be a lowercase sha256 digest",
      )
    }

    const hex = digest.slice("sha256:".length)
    const target = join(this.storeRoot, "sha256", hex.slice(0, 2), hex)
    try {
      assertPathContained(this.storeRoot, target)
    } catch (error) {
      throw new ArtifactStoreError(
        "containment-violation",
        "artifact digest resolves outside the configured store",
        { cause: error },
      )
    }
    return target
  }

  private sensitivityMarkerPath(
    digest: Sha256Digest,
    sensitivity: ArtifactSensitivity,
  ): string {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new ArtifactStoreError(
        "invalid-ref",
        "artifact digest must be a lowercase sha256 digest",
      )
    }

    const hex = digest.slice("sha256:".length)
    const target = join(
      this.storeRoot,
      "metadata",
      "sha256",
      hex.slice(0, 2),
      hex,
      `sensitivity-${sensitivity}.json`,
    )
    try {
      assertPathContained(this.storeRoot, target)
    } catch (error) {
      throw new ArtifactStoreError(
        "containment-violation",
        "artifact metadata resolves outside the configured store",
        { cause: error },
      )
    }
    return target
  }

  private validateRef(ref: ArtifactRef): void {
    if (!ref || typeof ref !== "object") {
      throw new ArtifactStoreError("invalid-ref", "artifact ref is required")
    }
    if (ref.projectId !== this.projectId || ref.storeId !== this.storeId) {
      throw new ArtifactStoreError(
        "scope-mismatch",
        "artifact ref belongs to a different project or store",
      )
    }
    if (!DIGEST_PATTERN.test(ref.digest) || ref.id !== ref.digest) {
      throw new ArtifactStoreError(
        "invalid-ref",
        "artifact ref contains a malformed id or digest",
      )
    }
    if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0) {
      throw new ArtifactStoreError(
        "invalid-ref",
        "artifact ref contains an invalid size",
      )
    }
    if (!SENSITIVITIES.includes(ref.sensitivity)) {
      throw new ArtifactStoreError(
        "invalid-ref",
        "artifact ref contains an invalid sensitivity",
      )
    }
  }

  private async readPersistedSensitivity(
    digest: Sha256Digest,
    artifactExists: boolean,
  ): Promise<ArtifactSensitivity | undefined> {
    let persisted: ArtifactSensitivity | undefined

    for (const sensitivity of SENSITIVITIES) {
      const marker = await this.readSensitivityMarker(digest, sensitivity)
      if (!marker) continue
      persisted = persisted
        ? stricterSensitivity(persisted, marker.sensitivity)
        : marker.sensitivity
    }

    // Objects created before sensitivity metadata existed are unknowable. They
    // remain readable, but are conservatively classified as sensitive so a
    // forged lower-label ref cannot materialize them outside the CAS. A later
    // put lazily persists this classification.
    return persisted ?? (artifactExists ? "sensitive" : undefined)
  }

  private async readSensitivityMarker(
    digest: Sha256Digest,
    sensitivity: ArtifactSensitivity,
  ): Promise<SensitivityMarker | undefined> {
    const target = this.sensitivityMarkerPath(digest, sensitivity)
    try {
      const targetStat = await lstat(target)
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new ArtifactStoreError(
          "containment-violation",
          "artifact sensitivity metadata must be a regular file",
        )
      }

      const [realStoreRoot, realTarget] = await Promise.all([
        realpath(this.storeRoot),
        realpath(target),
      ])
      assertPathContained(realStoreRoot, realTarget)

      const bytes = await readFile(realTarget, "utf8")
      let value: unknown
      try {
        value = JSON.parse(bytes)
      } catch (error) {
        throw new ArtifactStoreError(
          "artifact-corrupt",
          "artifact sensitivity metadata is not valid JSON",
          { cause: error },
        )
      }

      if (
        !value ||
        typeof value !== "object" ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== 1 ||
        !("digest" in value) ||
        value.digest !== digest ||
        !("sensitivity" in value) ||
        value.sensitivity !== sensitivity
      ) {
        throw new ArtifactStoreError(
          "artifact-corrupt",
          "artifact sensitivity metadata does not match its CAS object",
        )
      }

      return value as SensitivityMarker
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined
      }
      throw new ArtifactStoreError(
        "containment-violation",
        "artifact sensitivity metadata could not be safely resolved",
        { cause: error },
      )
    }
  }

  private async writeSensitivityMarker(
    digest: Sha256Digest,
    sensitivity: ArtifactSensitivity,
  ): Promise<void> {
    const target = this.sensitivityMarkerPath(digest, sensitivity)
    if (await this.readSensitivityMarker(digest, sensitivity)) return

    const marker: SensitivityMarker = {
      schemaVersion: 1,
      digest,
      sensitivity,
    }
    await atomicWriteFile(target, Buffer.from(canonicalJson(marker), "utf8"))
    await this.readSensitivityMarker(digest, sensitivity)
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await stat(target)
      return true
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false
      }
      throw error
    }
  }

  private async readVerified(ref: ArtifactRef, target: string): Promise<Buffer> {
    try {
      const targetStat = await lstat(target)
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new ArtifactStoreError(
          "containment-violation",
          "artifact must be a regular file",
        )
      }

      const [realRoot, realStoreRoot, realTarget] = await Promise.all([
        realpath(this.root),
        realpath(this.storeRoot),
        realpath(target),
      ])
      assertPathContained(realRoot, realStoreRoot)
      assertPathContained(realStoreRoot, realTarget)

      const bytes = await readFile(realTarget)
      if (bytes.byteLength !== ref.sizeBytes) {
        throw new ArtifactStoreError(
          "artifact-corrupt",
          `artifact size mismatch: expected ${ref.sizeBytes}, received ${bytes.byteLength}`,
        )
      }
      if (sha256(bytes) !== ref.digest) {
        throw new ArtifactStoreError(
          "artifact-corrupt",
          "artifact digest mismatch",
        )
      }
      return bytes
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new ArtifactStoreError("artifact-missing", "artifact does not exist", {
          cause: error,
        })
      }
      throw new ArtifactStoreError(
        "containment-violation",
        "artifact could not be safely resolved",
        { cause: error },
      )
    }
  }
}
