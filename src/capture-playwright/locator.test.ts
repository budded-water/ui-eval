import { describe, expect, it, vi } from "vitest"

import type { WebRuntimeLocator } from "../contracts/model"
import { describeWebLocator, webLocator } from "./locator"

function mockPage() {
  const result = { locator: true }
  return {
    result,
    page: {
      locator: vi.fn(() => result),
      getByTestId: vi.fn(() => result),
      getByRole: vi.fn(() => result),
      getByText: vi.fn(() => result),
    },
  }
}

describe("webLocator", () => {
  it.each([
    [
      { platform: "web", by: "uiId", value: 'hero"cta' },
      "locator",
      '[data-ui-id="hero\\22 cta"]',
    ],
    [
      { platform: "web", by: "testId", value: "hero-cta" },
      "getByTestId",
      "hero-cta",
    ],
    [
      { platform: "web", by: "text", value: "Continue" },
      "getByText",
      "Continue",
    ],
    [
      { platform: "web", by: "css", value: "main > button" },
      "locator",
      "main > button",
    ],
  ] as const)("maps %s to semantic Playwright API", (target, method, value) => {
    const { page, result } = mockPage()

    expect(webLocator(page as never, target as WebRuntimeLocator)).toBe(result)
    if (target.by === "text") {
      expect(page[method]).toHaveBeenCalledWith(value, { exact: true })
    } else {
      expect(page[method]).toHaveBeenCalledWith(value)
    }
  })

  it("maps role and accessible name without falling back to CSS", () => {
    const { page, result } = mockPage()
    const target = {
      platform: "web",
      by: "role",
      value: "button",
      name: "Book now",
    } as const

    expect(webLocator(page as never, target)).toBe(result)
    expect(page.getByRole).toHaveBeenCalledWith("button", {
      name: "Book now",
      exact: true,
    })
    expect(page.locator).not.toHaveBeenCalled()
    expect(describeWebLocator(target)).toBe('role="button" name="Book now"')
  })
})
