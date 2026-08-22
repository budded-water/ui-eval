import { createHash } from "node:crypto"

import type { Digest } from "./model"

export interface DigestExclusions {
  /** Exact RFC 6901 JSON Pointer paths. */
  paths?: readonly string[]
  /** Property names to omit wherever they occur. Use only for contract-defined fields. */
  propertyNames?: readonly string[]
}

export interface CanonicalJsonOptions {
  exclusions?: DigestExclusions
}

/**
 * Named exclusion sets make self-referential and operational fields explicit at
 * each digest call site. canonicalDigest() itself excludes nothing by default.
 */
export const DigestExclusionProfiles = {
  resolvedScenarioPlan: {
    propertyNames: ["planDigest"],
  },
  sealedRunManifest: {
    propertyNames: ["executionId", "captureKey"],
  },
  evaluationPlan: {
    propertyNames: ["evaluationId", "evaluationKey"],
  },
  contractEnvelope: {
    paths: ["/metadata/specDigest", "/metadata/createdAt"],
  },
  normalizedCandidateEvidence: {
    propertyNames: [
      "executionId",
      "createdAt",
      "capturedAt",
      "attempt",
      "repeatGroupId",
      "specDigest",
    ],
  },
} as const satisfies Record<string, DigestExclusions>

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1")
}

function validatePointer(pointer: string): void {
  if (pointer !== "" && !pointer.startsWith("/")) {
    throw new TypeError(`Invalid JSON Pointer exclusion: ${pointer}`)
  }
}

function assertWireObject(value: object): asserts value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON accepts only plain JSON objects")
  }
}

/**
 * Returns a JSON-only copy with the explicitly named fields removed. The input
 * is never mutated. Values that cannot appear on the wire are rejected.
 */
export function excludeDigestFields(
  value: unknown,
  exclusions: DigestExclusions = {},
): unknown {
  const excludedPaths = new Set(exclusions.paths ?? [])
  for (const pointer of excludedPaths) validatePointer(pointer)
  const excludedNames = new Set(exclusions.propertyNames ?? [])
  const ancestors = new Set<object>()

  const visit = (current: unknown, pointer: string): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers")
      }
      return Object.is(current, -0) ? 0 : current
    }
    if (
      typeof current === "undefined" ||
      typeof current === "bigint" ||
      typeof current === "function" ||
      typeof current === "symbol"
    ) {
      throw new TypeError(`Canonical JSON does not support ${typeof current} values`)
    }

    if (ancestors.has(current)) {
      throw new TypeError("Canonical JSON does not support cyclic values")
    }
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) => {
          if (!(index in current)) {
            throw new TypeError("Canonical JSON does not support sparse arrays")
          }
          const childPointer = `${pointer}/${index}`
          if (excludedPaths.has(childPointer)) return null
          return visit(item, childPointer)
        })
      }

      assertWireObject(current)
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(current).sort()) {
        const childPointer = `${pointer}/${escapePointerToken(key)}`
        if (excludedNames.has(key) || excludedPaths.has(childPointer)) continue
        result[key] = visit(current[key], childPointer)
      }
      return result
    } finally {
      ancestors.delete(current)
    }
  }

  if (excludedPaths.has("")) return null
  return visit(value, "")
}

export function canonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  return JSON.stringify(excludeDigestFields(value, options.exclusions))
}

export function canonicalDigest(
  value: unknown,
  options: CanonicalJsonOptions = {},
): Digest {
  const payload = canonicalJson(value, options)
  const hash = createHash("sha256").update(payload, "utf8").digest("hex")
  return `sha256:${hash}`
}

/** Digest only the spec payload, avoiding envelope operational metadata. */
export function canonicalSpecDigest(value: { spec: unknown }): Digest {
  return canonicalDigest(value.spec)
}
