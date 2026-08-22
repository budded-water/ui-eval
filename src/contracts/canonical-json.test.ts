import { describe, expect, it } from "vitest"

import {
  canonicalDigest,
  canonicalJson,
  DigestExclusionProfiles,
  excludeDigestFields,
} from "./canonical-json"

describe("canonical JSON", () => {
  it("produces stable bytes and digests regardless of object key order", () => {
    const first = {
      z: 3,
      nested: { beta: true, alpha: [3, { y: "yes", x: "no" }] },
      a: "first",
    }
    const second = {
      a: "first",
      nested: { alpha: [3, { x: "no", y: "yes" }], beta: true },
      z: 3,
    }

    expect(canonicalJson(first)).toBe(
      '{"a":"first","nested":{"alpha":[3,{"x":"no","y":"yes"}],"beta":true},"z":3}',
    )
    expect(canonicalDigest(first)).toBe(canonicalDigest(second))
  })

  it("is sensitive to every value unless the caller names an exclusion", () => {
    const base = {
      planDigest: "sha256:self",
      executionId: "run-1",
      target: { path: "/terms", locale: "en" },
    }
    const changedInput = {
      ...base,
      target: { ...base.target, locale: "zh" },
    }
    const changedSelfDigest = { ...base, planDigest: "sha256:changed" }

    expect(canonicalDigest(changedInput)).not.toBe(canonicalDigest(base))
    expect(canonicalDigest(changedSelfDigest)).not.toBe(canonicalDigest(base))
    expect(
      canonicalDigest(changedSelfDigest, {
        exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
      }),
    ).toBe(
      canonicalDigest(base, {
        exclusions: DigestExclusionProfiles.resolvedScenarioPlan,
      }),
    )
  })

  it("supports exact JSON Pointer exclusions without mutating the input", () => {
    const input = {
      metadata: { createdAt: "today", specDigest: "self", id: "contract-1" },
      spec: { createdAt: "business-value", enabled: true },
    }

    expect(
      excludeDigestFields(input, {
        paths: ["/metadata/createdAt", "/metadata/specDigest"],
      }),
    ).toEqual({
      metadata: { id: "contract-1" },
      spec: { createdAt: "business-value", enabled: true },
    })
    expect(input.metadata.specDigest).toBe("self")
  })

  it("rejects non-wire and cyclic values", () => {
    expect(() => canonicalJson({ invalid: undefined })).toThrow(/undefined/)
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(/non-finite/)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/)
  })
})
