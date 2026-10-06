/**
 * The five constraint kinds, evaluated against the normalized property space.
 *
 * Adding a sixth kind requires an ADR. Expectations resolve from a design token
 * set; tolerance, severity, and which constraints run are policy, so nothing
 * here reads a design source or a platform. See docs/adr/0002.
 *
 * Failure semantics, which never let uncertainty become a pass:
 *   - property absent from every in-scope node  -> unsupported
 *   - value present but not normalizable        -> invalid
 *   - zero nodes matched while requireMatch     -> invalid
 *   - missing token reference or empty range    -> configuration error (throws)
 */

import type {
  AbstractProperty,
  DesignTokenSet,
  DesignValueSet,
  GeometryConstraint,
  NormalizedColor,
} from "../../contracts/model"
import { colorsEqual } from "../../normalize/color"
import { nearestStep } from "../../normalize/length"

import {
  isComparable,
  nodeIdentity,
  type NormalizedNode,
  type NormalizedValue,
} from "./property-space"

/**
 * Constraint shapes live in the contract layer so the policy validator and this
 * engine cannot drift apart. `Constraint` is an alias, not a second definition.
 */
export type Constraint = GeometryConstraint
export type ConstraintScope = NonNullable<GeometryConstraint["scope"]>

export class ConstraintConfigurationError extends Error {
  constructor(
    readonly constraintId: string,
    message: string,
  ) {
    super(`constraint '${constraintId}': ${message}`)
    this.name = "ConstraintConfigurationError"
  }
}

export interface Violation {
  readonly nodeId: string
  readonly identity?: string
  readonly detail: string
}

export interface ConstraintResult {
  readonly constraintId: string
  readonly kind: Constraint["kind"]
  readonly status: "passed" | "failed" | "unsupported" | "invalid"
  readonly matchedNodes: number
  readonly comparedNodes: number
  /** Nodes carrying the property in a form this engine cannot compare. */
  readonly unnormalizableNodes: number
  readonly violations: readonly Violation[]
  readonly invalidReason?: "no-match" | "unnormalizable-values" | "missing-evidence" | "insufficient-peers"
}

function inScope(node: NormalizedNode, scope: ConstraintScope | undefined): boolean {
  if (!scope) return true
  if (scope.visibleOnly && !node.visible) return false
  if (scope.roles && (node.role === undefined || !scope.roles.includes(node.role))) {
    return false
  }
  return true
}

function numericOf(value: NormalizedValue): number | undefined {
  if (value.kind === "length") return value.px
  if (value.kind === "number") return value.value
  return undefined
}

function describe(value: NormalizedValue): string {
  switch (value.kind) {
    case "length":
      return `${String(value.px)}px`
    case "number":
      return String(value.value)
    case "color":
      return `rgba(${[value.color.r, value.color.g, value.color.b, value.color.alpha].join(", ")})`
    case "family":
      return value.family
    case "keyword":
      return value.keyword
    case "unnormalizable":
      return value.raw
  }
}

function requireValueSet(
  tokenSet: DesignTokenSet,
  constraintId: string,
  ref: string,
): DesignValueSet {
  const found = tokenSet.valueSets?.find((valueSet) => valueSet.id === ref)
  if (!found) {
    throw new ConstraintConfigurationError(constraintId, `unknown value set '${ref}'`)
  }
  return found
}

function requireScale(tokenSet: DesignTokenSet, constraintId: string, ref: string) {
  const found = tokenSet.scales?.find((scale) => scale.id === ref)
  if (!found) {
    throw new ConstraintConfigurationError(constraintId, `unknown scale '${ref}'`)
  }
  return found
}

function requireRange(tokenSet: DesignTokenSet, constraintId: string, ref: string) {
  const found = tokenSet.ranges?.find((range) => range.id === ref)
  if (!found) {
    throw new ConstraintConfigurationError(constraintId, `unknown range '${ref}'`)
  }
  if (found.min === undefined && found.max === undefined) {
    throw new ConstraintConfigurationError(constraintId, `range '${ref}' bounds nothing`)
  }
  return found
}

interface Reading {
  readonly node: NormalizedNode
  readonly value: NormalizedValue
}

function readProperty(
  nodes: readonly NormalizedNode[],
  constraint: Constraint,
  property: AbstractProperty,
): { readings: Reading[]; matched: number; unnormalizable: number } {
  let matched = 0
  let unnormalizable = 0
  const readings: Reading[] = []

  for (const node of nodes) {
    if (!inScope(node, constraint.scope)) continue
    const value = node.properties.get(property)
    if (value === undefined) continue
    matched += 1
    if (!isComparable(value)) {
      unnormalizable += 1
      continue
    }
    readings.push({ node, value })
  }
  return { readings, matched, unnormalizable }
}

function settle(
  constraint: Constraint,
  matched: number,
  unnormalizable: number,
  readings: readonly Reading[],
  violations: readonly Violation[],
): ConstraintResult {
  const base = {
    constraintId: constraint.id,
    kind: constraint.kind,
    matchedNodes: matched,
    comparedNodes: readings.length,
    unnormalizableNodes: unnormalizable,
  }

  if (matched === 0) {
    // No in-scope node carries the property at all: the platform or the capture
    // did not supply it, which is unknown rather than compliant.
    if (constraint.requireMatch === false) {
      return { ...base, status: "unsupported", violations: [] }
    }
    return {
      ...base,
      status: "invalid",
      invalidReason: "no-match",
      violations: [],
    }
  }

  // A defect found on comparable nodes is reported as a defect. Coverage gaps
  // are counted separately in `unnormalizableNodes` rather than folded into the
  // status, because an unrelated unreadable node must not mask a real failure.
  if (violations.length > 0) {
    return { ...base, status: "failed", violations }
  }

  if (unnormalizable > 0) {
    return {
      ...base,
      status: "invalid",
      invalidReason: "unnormalizable-values",
      violations: [],
    }
  }

  return { ...base, status: "passed", violations }
}

function violationFor(reading: Reading, detail: string): Violation {
  const identity = nodeIdentity(reading.node)
  return {
    nodeId: reading.node.nodeId,
    ...(identity === undefined ? {} : { identity }),
    detail,
  }
}

export function evaluateConstraint(
  constraint: Constraint,
  nodes: readonly NormalizedNode[],
  tokenSet: DesignTokenSet,
): ConstraintResult {
  if (constraint.kind === "ratio") {
    const range = requireRange(tokenSet, constraint.id, constraint.rangeRef)
    const numerator = readProperty(nodes, constraint, constraint.numerator)
    const denominator = readProperty(nodes, constraint, constraint.denominator)
    const denominatorByNode = new Map(
      denominator.readings.map((reading) => [reading.node.nodeId, reading.value]),
    )

    const violations: Violation[] = []
    const readings: Reading[] = []
    for (const reading of numerator.readings) {
      const other = denominatorByNode.get(reading.node.nodeId)
      if (other === undefined) continue
      const top = numericOf(reading.value)
      const bottom = numericOf(other)
      if (top === undefined || bottom === undefined || bottom === 0) continue
      readings.push(reading)
      const ratio = top / bottom
      if (
        (range.min !== undefined && ratio < range.min) ||
        (range.max !== undefined && ratio > range.max)
      ) {
        violations.push(
          violationFor(reading, `ratio ${ratio.toFixed(3)} outside range '${range.id}'`),
        )
      }
    }
    return settle(
      constraint,
      Math.min(numerator.matched, denominator.matched),
      numerator.unnormalizable + denominator.unnormalizable,
      readings,
      violations,
    )
  }

  if (constraint.kind === "cross-node-equal") {
    const { readings, matched, unnormalizable } = readProperty(
      nodes,
      constraint,
      constraint.property,
    )
    const groups = new Map<string, Reading[]>()
    for (const reading of readings) {
      const identity = nodeIdentity(reading.node)
      if (identity === undefined) continue
      if (!groups.has(identity)) groups.set(identity, [])
      groups.get(identity)?.push(reading)
    }

    const violations: Violation[] = []
    if (![...groups.values()].some((group) => group.length >= 2)) {
      return {
        ...settle(constraint, matched, unnormalizable, readings, []),
        status: constraint.requireMatch === false ? "unsupported" : "invalid",
        invalidReason: "insufficient-peers",
      }
    }
    for (const [identity, group] of groups) {
      if (group.length < 2) continue
      const numbers = group.map((reading) => numericOf(reading.value))
      if (numbers.some((value) => value === undefined)) {
        const distinct = new Set(group.map((reading) => describe(reading.value)))
        if (distinct.size > 1) {
          violations.push(
            violationFor(group[0], `'${identity}' disagrees: ${[...distinct].join(" vs ")}`),
          )
        }
        continue
      }
      const values = numbers as number[]
      const spread = Math.max(...values) - Math.min(...values)
      if (spread > constraint.tolerance) {
        violations.push(
          violationFor(
            group[0],
            `'${identity}' spreads ${spread.toFixed(2)} beyond tolerance ${String(constraint.tolerance)}`,
          ),
        )
      }
    }
    return settle(constraint, matched, unnormalizable, readings, violations)
  }

  const { readings, matched, unnormalizable } = readProperty(
    nodes,
    constraint,
    constraint.property,
  )
  const violations: Violation[] = []

  if (constraint.kind === "value-in-set") {
    const valueSet = requireValueSet(tokenSet, constraint.id, constraint.valueSetRef)
    for (const reading of readings) {
      const allowed =
        valueSet.valueKind === "color"
          ? reading.value.kind === "color" &&
            valueSet.values.some((candidate: NormalizedColor) =>
              colorsEqual(candidate, (reading.value as { color: NormalizedColor }).color),
            )
          : (reading.value.kind === "family" || reading.value.kind === "keyword") &&
            valueSet.values.includes(describe(reading.value))
      if (!allowed) {
        violations.push(
          violationFor(
            reading,
            `${describe(reading.value)} is not in '${valueSet.id}'`,
          ),
        )
      }
    }
  } else if (constraint.kind === "value-on-scale") {
    const scale = requireScale(tokenSet, constraint.id, constraint.scaleRef)
    for (const reading of readings) {
      const value = numericOf(reading.value)
      if (value === undefined) continue
      const nearest = nearestStep(value, scale.steps)
      if (nearest && nearest.distance > constraint.tolerance) {
        violations.push(
          violationFor(
            reading,
            `${describe(reading.value)} is ${nearest.distance.toFixed(2)} from the nearest '${scale.id}' step ${String(nearest.step)}`,
          ),
        )
      }
    }
  } else {
    const range = requireRange(tokenSet, constraint.id, constraint.rangeRef)
    for (const reading of readings) {
      const value = numericOf(reading.value)
      if (value === undefined) continue
      if (
        (range.min !== undefined && value < range.min) ||
        (range.max !== undefined && value > range.max)
      ) {
        violations.push(
          violationFor(
            reading,
            `${describe(reading.value)} is outside range '${range.id}'`,
          ),
        )
      }
    }
  }

  return settle(constraint, matched, unnormalizable, readings, violations)
}

export function evaluateConstraints(
  constraints: readonly Constraint[],
  nodes: readonly NormalizedNode[],
  tokenSet: DesignTokenSet,
): ConstraintResult[] {
  return constraints.map((constraint) =>
    evaluateConstraint(constraint, nodes, tokenSet),
  )
}
