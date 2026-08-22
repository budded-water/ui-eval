import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { Page } from "playwright"
import { describe, expect, it, vi } from "vitest"

import type { RenderSpace } from "../contracts/model"
import {
  validateConsoleEvidencePayload,
  validateNetworkEvidencePayload,
} from "../contracts/validation"
import {
  captureDomEvidence,
  consolePayload,
  crashPayload,
  createRuntimeEvidenceCollector,
  networkPayload,
  redactText,
  RUNTIME_EVIDENCE_LIMITS,
  sanitizeAssertionMetric,
  sanitizeUrl,
} from "./evidence"

const execFileAsync = promisify(execFile)

type RuntimeEvent =
  | "console"
  | "response"
  | "requestfailed"
  | "pageerror"
  | "crash"

function runtimePage(): {
  page: Page
  emit: (event: RuntimeEvent, payload?: unknown) => void
} {
  const handlers = new Map<RuntimeEvent, Array<(payload?: unknown) => void>>()
  const page = {
    on: vi.fn((event: RuntimeEvent, handler: (payload?: unknown) => void) => {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(handler)
      handlers.set(event, eventHandlers)
      return page
    }),
  }
  return {
    page: page as unknown as Page,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
  }
}

function consoleMessage(
  text: string,
  level: "log" | "warning" | "error" = "log",
) {
  return {
    location: () => ({ url: "https://candidate.test/page" }),
    type: () => level,
    text: () => text,
  }
}

function response(url: string, status: number) {
  return {
    url: () => url,
    status: () => status,
    request: () => ({
      method: () => "GET",
      resourceType: () => "document",
    }),
  }
}

const renderSpace: RenderSpace = {
  logicalWidth: 800,
  logicalHeight: 600,
  logicalUnit: "css-px",
  deviceScaleFactor: 1,
  screenshotWidthPx: 800,
  screenshotHeightPx: 600,
  orientation: "landscape",
}

describe("capture evidence redaction", () => {
  it("keeps the tsx-serialized page evaluator self-contained", async () => {
    const evidenceModuleUrl = new URL("./evidence.ts", import.meta.url).href
    const script = `
      const loaded = await import(${JSON.stringify(evidenceModuleUrl)})
      const { captureDomEvidence } = loaded.default ?? loaded
      const page = {
        evaluate: async (evaluator) => {
          if (/\\b__name\\b/.test(evaluator.toString())) {
            throw new Error("tsx helper leaked into Playwright page callback")
          }
          return { url: "https://candidate.test/page", title: "", nodes: [] }
        },
      }
      await captureDomEvidence(page, {
        logicalWidth: 800,
        logicalHeight: 600,
        logicalUnit: "css-px",
        deviceScaleFactor: 1,
        screenshotWidthPx: 800,
        screenshotHeightPx: 600,
        orientation: "landscape",
      })
      process.stdout.write("ok")
    `
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
    )

    expect(stdout).toBe("ok")
  })

  it("redacts credentials and sensitive query parameters", () => {
    expect(
      sanitizeUrl(
        "https://user:pass@example.test/path?token=secret&view=grid#private",
      ),
    ).toBe(
      "https://example.test/path?token=%5BREDACTED%5D&view=grid",
    )
  })

  it("seals URL assertion metrics without userinfo, path, query values, or hashes", () => {
    const metric = sanitizeAssertionMetric(
      "url",
      "https://alice:password@example.test/magic-link/path-secret?code=oauth-secret&state=csrf-secret&foo=arbitrary-secret#hash-secret",
    )

    expect(metric).toEqual({
      kind: "string",
      value: "https://example.test/[REDACTED_PATH]?[REDACTED_QUERY]",
    })
    expect(JSON.stringify(metric)).not.toMatch(
      /alice|password|path-secret|oauth-secret|csrf-secret|arbitrary-secret|hash-secret/,
    )
  })

  it("keeps only a safe origin for root URL assertions", () => {
    expect(
      sanitizeAssertionMetric(
        "url",
        "https://candidate.test/?anything=must-not-leak",
      ),
    ).toEqual({
      kind: "string",
      value: "https://candidate.test/?[REDACTED_QUERY]",
    })
    expect(sanitizeAssertionMetric("url", "not-a-url secret-value")).toEqual({
      kind: "string",
      value: "[REDACTED_URL]",
    })
  })

  it("marks and byte-bounds text assertion metrics without retaining late secrets", () => {
    const metric = sanitizeAssertionMetric(
      "text",
      `token=front-secret ${"界".repeat(2_000)} token=late-secret`,
    )

    expect(metric.kind).toBe("string")
    if (metric.kind !== "string") throw new Error("expected a string metric")
    expect(metric.value).toContain("token=[REDACTED]")
    expect(metric.value).toContain("…[TRUNCATED]")
    expect(metric.value).not.toContain("front-secret")
    expect(metric.value).not.toContain("late-secret")
    expect(metric.value).not.toContain("�")
    expect(Buffer.byteLength(metric.value, "utf8")).toBeLessThanOrEqual(1_024)
  })

  it("withholds assertion text from sensitive DOM targets and preserves booleans", () => {
    expect(
      sanitizeAssertionMetric("text", "arbitrary private account text", {
        sensitiveTarget: true,
      }),
    ).toEqual({ kind: "string", value: "[REDACTED]" })
    expect(sanitizeAssertionMetric("visible", true)).toEqual({
      kind: "boolean",
      value: true,
    })
  })

  it("redacts authorization-like values before sealing logs", () => {
    expect(
      redactText("Authorization: Bearer abc.def token=my-secret password=hunter2"),
    ).toBe(
      "Authorization=[REDACTED] [REDACTED] token=[REDACTED] password=[REDACTED]",
    )
  })

  it("removes sensitive DOM text, accessible names, identifiers, and font names", async () => {
    const computedStyle = {
      display: "block",
      position: "static",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderColor: "rgb(0, 0, 0)",
      borderRadius: "0px",
      boxShadow: "none",
      fontFamily: "secret-font-family",
      fontSize: "16px",
      fontWeight: "400",
      lineHeight: "normal",
    }
    const page = {
      evaluate: vi.fn(async () => ({
        url: "https://candidate.test/page?token=secret-url",
        title: "Safe title",
        nodes: [
          {
            sensitive: true,
            nodeId: "node-0",
            uiId: "secret-ui-id",
            testId: "secret-test-id",
            role: "secret-role",
            accessibleName: "secret-accessible-name",
            tagName: "input",
            text: "secret-node-text",
            visible: true,
            enabled: true,
            rect: { x: 0, y: 0, width: 100, height: 20 },
            computedStyle,
          },
          {
            sensitive: false,
            nodeId: "node-1",
            uiId: "safe-ui-id",
            testId: "safe-test-id",
            role: "button",
            accessibleName: "Safe name",
            tagName: "button",
            text: "Safe text",
            visible: true,
            enabled: true,
            rect: { x: 0, y: 20, width: 100, height: 20 },
            computedStyle: { ...computedStyle, fontFamily: "safe-font" },
          },
        ],
      })),
    } as unknown as Page

    const evidence = await captureDomEvidence(page, renderSpace)
    const sensitiveNode = evidence.dom.nodes[0]
    expect(sensitiveNode).toMatchObject({
      text: "[REDACTED]",
      accessibleName: "[REDACTED]",
    })
    expect(sensitiveNode).not.toHaveProperty("uiId")
    expect(sensitiveNode).not.toHaveProperty("testId")
    expect(sensitiveNode).not.toHaveProperty("role")
    expect(sensitiveNode.computedStyle).not.toHaveProperty("fontFamily")
    expect(evidence.dom.nodes[1]).toMatchObject({
      uiId: "safe-ui-id",
      testId: "safe-test-id",
      role: "button",
      accessibleName: "Safe name",
      text: "Safe text",
    })
    expect(evidence.fontFamilies).toEqual(["safe-font"])

    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toMatch(
      /secret-(?:ui-id|test-id|role|accessible-name|node-text|font-family|url)/,
    )
  })
})

describe("runtime evidence budgets", () => {
  it("bounds console entries, persists deterministic stats, and retains errors", () => {
    const runtime = runtimePage()
    const collected = createRuntimeEvidenceCollector(
      runtime.page,
      "https://candidate.test",
    )

    for (let index = 0; index < RUNTIME_EVIDENCE_LIMITS.console.maxEntries; index += 1) {
      runtime.emit("console", consoleMessage(`ordinary-${index}`))
    }
    runtime.emit("console", consoleMessage("blocking-error", "error"))

    const payload = consolePayload(collected)
    expect(payload.collection).toEqual({
      capturedCount: RUNTIME_EVIDENCE_LIMITS.console.maxEntries,
      droppedCount: 1,
      truncatedCount: 0,
      limitReason: "entry-count",
    })
    expect(payload.entries).toContainEqual(
      expect.objectContaining({ level: "error", text: "blocking-error" }),
    )
    expect(() => validateConsoleEvidencePayload(payload)).not.toThrow()
  })

  it("records per-entry truncation without leaking late secrets", () => {
    const runtime = runtimePage()
    const collected = createRuntimeEvidenceCollector(
      runtime.page,
      "https://candidate.test",
    )
    runtime.emit(
      "console",
      consoleMessage(`${"x".repeat(5_000)} token=late-secret`),
    )

    const payload = consolePayload(collected)
    expect(payload.collection).toMatchObject({
      capturedCount: 1,
      droppedCount: 0,
      truncatedCount: 1,
      limitReason: "per-entry-bytes",
    })
    expect(Buffer.byteLength(payload.entries[0].text, "utf8")).toBeLessThanOrEqual(
      4_096,
    )
    expect(JSON.stringify(payload)).not.toContain("late-secret")
  })

  it("bounds network entries while retaining same-origin product failures", () => {
    const runtime = runtimePage()
    const collected = createRuntimeEvidenceCollector(
      runtime.page,
      "https://candidate.test",
    )

    for (let index = 0; index < RUNTIME_EVIDENCE_LIMITS.network.maxEntries; index += 1) {
      runtime.emit(
        "response",
        response(`https://candidate.test/resource-${index}`, 200),
      )
    }
    runtime.emit("response", response("https://candidate.test/failure", 500))

    const payload = networkPayload(collected)
    expect(payload.collection).toEqual({
      capturedCount: RUNTIME_EVIDENCE_LIMITS.network.maxEntries,
      droppedCount: 1,
      truncatedCount: 0,
      limitReason: "entry-count",
    })
    expect(payload.entries).toContainEqual(
      expect.objectContaining({
        url: "https://candidate.test/failure",
        status: 500,
        sameOrigin: true,
      }),
    )
    expect(() => validateNetworkEvidencePayload(payload)).not.toThrow()
  })

  it("bounds page errors and reports dropped observations", () => {
    const runtime = runtimePage()
    const collected = createRuntimeEvidenceCollector(
      runtime.page,
      "https://candidate.test",
    )

    for (let index = 0; index <= RUNTIME_EVIDENCE_LIMITS.crash.maxEntries; index += 1) {
      runtime.emit("pageerror", new Error(`page-error-${index}`))
    }

    const payload = crashPayload(collected)
    expect(payload.entries).toHaveLength(RUNTIME_EVIDENCE_LIMITS.crash.maxEntries)
    expect(payload.collection).toEqual({
      capturedCount: RUNTIME_EVIDENCE_LIMITS.crash.maxEntries,
      droppedCount: 1,
      truncatedCount: 0,
      limitReason: "entry-count",
    })
  })
})
