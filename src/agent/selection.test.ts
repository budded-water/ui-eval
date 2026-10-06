import { describe, expect, it } from "vitest"
import { selectAgentScenarios } from "./selection"
const scenario = (id: string) => ({ id, dimensions: ["ui"], timeoutMs: 1000 })
const suite = { scenarios: [scenario("mandatory")], optionalScenarios: [scenario("extra"), scenario("responsive")] }

describe("append-only scenario selection", () => {
  it("retains the required floor and resolves suggestions from declared inputs", () => {
    expect(selectAgentScenarios(suite as never, ["extra", "extra"]).map(({ id }) => id)).toEqual(["mandatory", "extra"])
    expect(selectAgentScenarios(suite as never).map(({ id }) => id)).toEqual(["mandatory"])
  })
  it("expands to full declared scope when impact is uncertain", () => {
    expect(selectAgentScenarios(suite as never, [], true).map(({ id }) => id)).toEqual(["mandatory", "extra", "responsive"])
  })
  it("rejects unknown suggestions instead of silently skipping required work", () => {
    expect(() => selectAgentScenarios(suite as never, ["invented"])).toThrow("Undeclared scenario")
  })
})
