/**
 * The normalized property space that design facts and captured evidence both
 * translate into before any comparison happens.
 *
 * Constraints address properties by abstract name. No constraint may name a CSS
 * property, a DOM concept, or a design-tool field, which is what lets one
 * constraint run against web evidence today and against a view hierarchy when a
 * native adapter exists. See docs/adr/0002.
 */

import type { AbstractProperty, NormalizedColor } from "../../contracts/model"

export type { AbstractProperty }

export type NormalizedValue =
  | { readonly kind: "length"; readonly px: number }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "color"; readonly color: NormalizedColor }
  | { readonly kind: "family"; readonly family: string }
  | { readonly kind: "keyword"; readonly keyword: string }
  /** Present in evidence but outside what this engine can compare. */
  | { readonly kind: "unnormalizable"; readonly raw: string }

export interface NormalizedNode {
  readonly nodeId: string
  readonly uiId?: string
  readonly testId?: string
  readonly role?: string
  readonly accessibleName?: string
  readonly visible: boolean
  readonly properties: ReadonlyMap<AbstractProperty, NormalizedValue>
}

export function isComparable(value: NormalizedValue): boolean {
  return value.kind !== "unnormalizable"
}

/** Stable identity for grouping the same element across nodes and captures. */
export function nodeIdentity(node: NormalizedNode): string | undefined {
  if (node.uiId !== undefined) return `uiId:${node.uiId}`
  if (node.testId !== undefined) return `testId:${node.testId}`
  if (node.role !== undefined && node.accessibleName !== undefined) {
    return `role:${node.role}/${node.accessibleName}`
  }
  return undefined
}
