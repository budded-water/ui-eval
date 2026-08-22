import type { Locator, Page } from "playwright"

import type { WebRuntimeLocator } from "../contracts/model"

export const WEB_LOCATOR_PRIORITY = [
  "uiId",
  "testId",
  "role",
  "text",
  "css",
] as const

function escapeCssAttributeValue(value: string): string {
  let escaped = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0xfffd
    escaped +=
      codePoint <= 0x1f || codePoint === 0x7f || character === '"' || character === "\\"
        ? `\\${codePoint.toString(16)} `
        : character
  }
  return escaped
}

export function webLocator(
  page: Pick<Page, "locator" | "getByTestId" | "getByRole" | "getByText">,
  target: WebRuntimeLocator,
): Locator {
  if (target.platform !== "web") {
    throw new TypeError("Playwright capture accepts only web locators")
  }

  switch (target.by) {
    case "uiId":
      return page.locator(
        `[data-ui-id="${escapeCssAttributeValue(target.value)}"]`,
      )
    case "testId":
      return page.getByTestId(target.value)
    case "role":
      return page.getByRole(
        target.value as Parameters<Page["getByRole"]>[0],
        {
        ...(target.name === undefined ? {} : { name: target.name }),
        exact: true,
        },
      )
    case "text":
      return page.getByText(target.value, { exact: true })
    case "css":
      return page.locator(target.value)
  }
}

export function describeWebLocator(target: WebRuntimeLocator): string {
  const name = target.name === undefined ? "" : ` name=${JSON.stringify(target.name)}`
  return `${target.by}=${JSON.stringify(target.value)}${name}`
}
