import { canonicalDigest } from "../contracts/canonical-json"
import type {
  DesignTokenSet,
  Digest,
  GeometryEvaluatorConfig,
} from "../contracts/model"
import { validateGeometryEvaluatorConfig } from "../contracts/validation"

import {
  importTailwindTheme,
  type TailwindThemeOptions,
  type UnresolvedToken,
} from "./tailwind-theme"

/**
 * Named ownership profile for the reference Tailwind producer.
 *
 * Ranges are intentionally absent: geometry policies may carry authored ranges
 * such as a zero-overflow ceiling that cannot be derived from CSS declarations.
 */
export const TAILWIND_THEME_PRODUCER_OWNED_COLLECTIONS = [
  "valueSets",
  "scales",
] as const satisfies readonly (keyof DesignTokenSet)[]

export type TailwindOwnedTokenCollection =
  (typeof TAILWIND_THEME_PRODUCER_OWNED_COLLECTIONS)[number]

export interface TailwindTokenDriftResult {
  readonly status: "in-sync" | "drift" | "unresolved"
  readonly producerOwnedCollections: typeof TAILWIND_THEME_PRODUCER_OWNED_COLLECTIONS
  readonly changedCollections: readonly TailwindOwnedTokenCollection[]
  readonly generatedDigest: Digest
  readonly sealedDigest: Digest
  readonly declarationCount: number
  readonly unresolved: readonly UnresolvedToken[]
}

type TailwindOwnedTokenSet = Pick<
  DesignTokenSet,
  TailwindOwnedTokenCollection
>

function ownedProjection(tokenSet: DesignTokenSet): TailwindOwnedTokenSet {
  return {
    ...(tokenSet.valueSets === undefined
      ? {}
      : { valueSets: tokenSet.valueSets }),
    ...(tokenSet.scales === undefined ? {} : { scales: tokenSet.scales }),
  }
}

export function checkTailwindTokenDrift(
  css: string,
  geometryConfigInput: unknown,
  options: TailwindThemeOptions = {},
): TailwindTokenDriftResult {
  const geometryConfig: GeometryEvaluatorConfig =
    validateGeometryEvaluatorConfig(geometryConfigInput)
  const imported = importTailwindTheme(css, options)
  const generated = ownedProjection(imported.tokenSet)
  const sealed = ownedProjection(geometryConfig.tokenSet)
  const changedCollections =
    TAILWIND_THEME_PRODUCER_OWNED_COLLECTIONS.filter(
      (collection) =>
        canonicalDigest(generated[collection] ?? null) !==
        canonicalDigest(sealed[collection] ?? null),
    )
  const generatedDigest = canonicalDigest(generated)
  const sealedDigest = canonicalDigest(sealed)

  return {
    status:
      imported.unresolved.length > 0
        ? "unresolved"
        : changedCollections.length > 0
          ? "drift"
          : "in-sync",
    producerOwnedCollections: TAILWIND_THEME_PRODUCER_OWNED_COLLECTIONS,
    changedCollections,
    generatedDigest,
    sealedDigest,
    declarationCount: imported.declarationCount,
    unresolved: imported.unresolved,
  }
}
