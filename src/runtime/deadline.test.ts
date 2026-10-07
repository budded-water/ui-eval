import { describe, expect, it } from "vitest"
import { withOwnedDeadline } from "./deadline"
import { IncompleteCleanupError } from "./cleanup"

describe("owned integration deadlines", () => {
  it("awaits cooperative cleanup and refuses a late success after the deadline", async () => {
    let cleaned = false
    await expect(withOwnedDeadline((signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve("late pass") }, 5), { once: true })
    }), 5, undefined, 100)).rejects.toThrow("deadline")
    expect(cleaned).toBe(true)
  })
  it("fails closed when cleanup never settles or explicitly fails", async () => {
    await expect(withOwnedDeadline(() => new Promise(() => {}), 5, undefined, 5)).rejects.toBeInstanceOf(IncompleteCleanupError)
    await expect(withOwnedDeadline((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new IncompleteCleanupError("cleanup failed")))
    }), 5, undefined, 50)).rejects.toBeInstanceOf(IncompleteCleanupError)
  })
})
