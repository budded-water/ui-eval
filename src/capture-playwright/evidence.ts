import type { ConsoleMessage, Page, Request, Response } from "playwright"

import type {
  AssertionSpec,
  ConsoleEvidencePayload,
  DomEvidencePayload,
  LayoutEvidencePayload,
  MetricValue,
  NetworkEvidencePayload,
  RenderSpace,
  StylesEvidencePayload,
} from "../contracts/model"

const MAX_LOG_TEXT = 4_096
const MAX_URL_BYTES = 2_048
const MAX_METHOD_BYTES = 64
const MAX_RESOURCE_TYPE_BYTES = 128
const MAX_FAILURE_TEXT_BYTES = 1_024
const MAX_CRASH_TEXT_BYTES = 4_096
const MAX_DOM_IDENTIFIER_BYTES = 256
const MAX_DOM_TEXT_BYTES = 1_000
const MAX_ASSERTION_TEXT_BYTES = 1_024
export const MAX_ASSERTION_TEXT_PREVIEW_BYTES = MAX_ASSERTION_TEXT_BYTES * 2
const TRUNCATION_MARKER = "…[TRUNCATED]"
const SENSITIVE_KEY =
  /(?:auth(?:orization)?|cookie|credential|jwt|password|secret|session|signature|token|api[-_]?key)/i

export const RUNTIME_EVIDENCE_LIMITS = {
  console: { maxEntries: 500, maxTotalBytes: 512 * 1024 },
  network: { maxEntries: 2_000, maxTotalBytes: 1024 * 1024 },
  crash: { maxEntries: 200, maxTotalBytes: 256 * 1024 },
} as const

interface CollectionStats {
  capturedCount: number
  droppedCount: number
  truncatedCount: number
  limitReason?: string
}

interface RetainedEntry<T> {
  value: T
  bytes: number
  priority: 0 | 1 | 2
  truncated: boolean
}

interface ChannelState<T> {
  target: T[]
  retained: Array<RetainedEntry<T>>
  droppedCount: number
  totalBytes: number
  reasons: Set<string>
  maxEntries: number
  maxTotalBytes: number
}

export interface CrashEntry {
  type: "page-error" | "page-crash"
  message: string
}

export interface CrashEvidencePayload {
  schemaVersion: "uieval.crash/v1alpha1"
  collection: CollectionStats
  entries: CrashEntry[]
}

export interface CollectedRuntimeEvidence {
  consoleEntries: ConsoleEvidencePayload["entries"]
  networkEntries: NetworkEvidencePayload["entries"]
  crashEntries: CrashEntry[]
  collection: {
    console: ChannelState<ConsoleEvidencePayload["entries"][number]>
    network: ChannelState<NetworkEvidencePayload["entries"][number]>
    crash: ChannelState<CrashEntry>
  }
}

export interface DomEvidenceSet {
  dom: DomEvidencePayload
  layout: LayoutEvidencePayload
  styles: StylesEvidencePayload
  fontFamilies: string[]
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= maxBytes) return { value, truncated: false }
  return {
    value: bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, ""),
    truncated: true,
  }
}

function truncateUtf8WithMarker(
  value: string,
  maxBytes: number,
): { value: string; truncated: true } {
  const marker = truncateUtf8(TRUNCATION_MARKER, maxBytes).value
  const markerBytes = Buffer.byteLength(marker, "utf8")
  const prefix = truncateUtf8(value, Math.max(0, maxBytes - markerBytes)).value
  return { value: `${prefix}${marker}`, truncated: true }
}

function redactAndLimit(
  value: string,
  maxBytes = MAX_LOG_TEXT,
  options: { markTruncation?: boolean; sourceTruncated?: boolean } = {},
): { value: string; truncated: boolean } {
  // Bound work before applying regular expressions so a hostile page cannot
  // turn a single console/page-error value into an unbounded allocation.
  const sourceCharacterLimit = maxBytes * 2
  const sourceWasTruncated = value.length > sourceCharacterLimit
  const redacted = value
    .slice(0, sourceCharacterLimit)
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /\b(password|secret|token|api[-_]?key|auth(?:orization)?|cookie|set-cookie|credential|jwt|session|signature)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
  if (
    options.markTruncation &&
    (options.sourceTruncated ||
      sourceWasTruncated ||
      Buffer.byteLength(redacted, "utf8") > maxBytes)
  ) {
    return truncateUtf8WithMarker(redacted, maxBytes)
  }
  const limited = truncateUtf8(redacted, maxBytes)
  return {
    value: limited.value,
    truncated: sourceWasTruncated || limited.truncated,
  }
}

export function redactText(value: string): string {
  return redactAndLimit(value).value
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]")
    }
    url.hash = ""
    return url.toString()
  } catch {
    return redactText(value)
  }
}

function boundedSanitizedUrl(value: string): {
  value: string
  truncated: boolean
} {
  const sanitized = sanitizeUrl(value)
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_URL_BYTES) {
    return { value: sanitized, truncated: false }
  }
  try {
    const parsed = new URL(sanitized)
    return {
      value: `${parsed.origin}/__ui_eval_truncated_url__`,
      truncated: true,
    }
  } catch {
    return redactAndLimit(sanitized, MAX_URL_BYTES, { markTruncation: true })
  }
}

function boundedAssertionUrl(value: string): {
  value: string
  truncated: boolean
} {
  try {
    const parsed = new URL(value)
    // Assertion values are copied into run-visible JSON and HTML. Preserve only
    // structural information that cannot contain a magic-link, OAuth code, or
    // application secret. The raw URL is still used for the in-memory equality
    // decision; it never crosses this presentation boundary.
    const path = parsed.pathname === "/" ? "/" : "/[REDACTED_PATH]"
    const query = parsed.search ? "?[REDACTED_QUERY]" : ""
    const sanitized = `${parsed.origin}${path}${query}`
    return {
      value:
        Buffer.byteLength(sanitized, "utf8") <= MAX_URL_BYTES
          ? sanitized
          : "[REDACTED_URL]",
      truncated: sanitized !== value,
    }
  } catch {
    return { value: "[REDACTED_URL]", truncated: true }
  }
}

/**
 * Assertion values are run-visible in JSON and HTML reports. Seal only this
 * bounded representation into CaptureBundle; callers may still compare raw
 * values in memory before crossing that boundary.
 */
export function sanitizeAssertionMetric(
  kind: AssertionSpec["kind"],
  value: string | number | boolean,
  options: { sensitiveTarget?: boolean; sourceTruncated?: boolean } = {},
): MetricValue {
  if (typeof value === "boolean") return { kind: "boolean", value }
  if (typeof value === "number") return { kind: "number", value }
  if (kind === "url") {
    return { kind: "string", value: boundedAssertionUrl(value).value }
  }
  return {
    kind: "string",
    value: options.sensitiveTarget
      ? "[REDACTED]"
      : redactAndLimit(value, MAX_ASSERTION_TEXT_BYTES, {
          markTruncation: true,
          sourceTruncated: options.sourceTruncated,
        }).value,
  }
}

function sameOrigin(value: string, candidateOrigin: string): boolean {
  try {
    return new URL(value).origin === candidateOrigin
  } catch {
    return false
  }
}

function channelState<T>(
  limits: { maxEntries: number; maxTotalBytes: number },
  target: T[],
): ChannelState<T> {
  return {
    target,
    retained: [],
    droppedCount: 0,
    totalBytes: 0,
    reasons: new Set(),
    ...limits,
  }
}

function retainEntry<T>(
  state: ChannelState<T>,
  value: T,
  options: { priority: 0 | 1 | 2; truncated: boolean },
): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
  const wouldExceedCount = state.retained.length >= state.maxEntries
  const wouldExceedBytes = state.totalBytes + bytes > state.maxTotalBytes

  if (wouldExceedCount) state.reasons.add("entry-count")
  if (wouldExceedBytes) state.reasons.add("total-bytes")
  if (options.truncated) state.reasons.add("per-entry-bytes")

  while (
    options.priority > 0 &&
    (state.retained.length >= state.maxEntries ||
      state.totalBytes + bytes > state.maxTotalBytes)
  ) {
    const lowestPriority = Math.min(
      ...state.retained.map((entry) => entry.priority),
    )
    if (lowestPriority >= options.priority) break
    const disposableIndex = state.retained.findIndex(
      (entry) => entry.priority === lowestPriority,
    )
    if (disposableIndex < 0) break
    const [discarded] = state.retained.splice(disposableIndex, 1)
    state.target.splice(disposableIndex, 1)
    state.totalBytes -= discarded.bytes
    state.droppedCount += 1
  }

  if (
    state.retained.length >= state.maxEntries ||
    state.totalBytes + bytes > state.maxTotalBytes
  ) {
    state.droppedCount += 1
    return
  }

  state.retained.push({ value, bytes, ...options })
  state.target.push(value)
  state.totalBytes += bytes
}

function stats<T>(state: ChannelState<T>): CollectionStats {
  const limitReason = Array.from(state.reasons).sort().join(",")
  return {
    capturedCount: state.retained.length,
    droppedCount: state.droppedCount,
    truncatedCount: state.retained.filter((entry) => entry.truncated).length,
    ...(limitReason ? { limitReason } : {}),
  }
}

export function createRuntimeEvidenceCollector(
  page: Page,
  candidateOrigin: string,
): CollectedRuntimeEvidence {
  const consoleEntries: ConsoleEvidencePayload["entries"] = []
  const networkEntries: NetworkEvidencePayload["entries"] = []
  const crashEntries: CrashEntry[] = []
  const collected: CollectedRuntimeEvidence = {
    consoleEntries,
    networkEntries,
    crashEntries,
    collection: {
      console: channelState(RUNTIME_EVIDENCE_LIMITS.console, consoleEntries),
      network: channelState(RUNTIME_EVIDENCE_LIMITS.network, networkEntries),
      crash: channelState(RUNTIME_EVIDENCE_LIMITS.crash, crashEntries),
    },
  }

  page.on("console", (message: ConsoleMessage) => {
    const location = message.location()
    const level = message.type()
    if (!["debug", "info", "log", "warning", "error"].includes(level)) return
    const text = redactAndLimit(message.text())
    const url = location.url ? boundedSanitizedUrl(location.url) : undefined
    retainEntry(collected.collection.console, {
      level: level as ConsoleEvidencePayload["entries"][number]["level"],
      text: text.value,
      ...(url ? { url: url.value } : {}),
    }, {
      priority: level === "error" ? 2 : level === "warning" ? 1 : 0,
      truncated: text.truncated || Boolean(url?.truncated),
    })
  })

  page.on("response", (response: Response) => {
    const request = response.request()
    const url = boundedSanitizedUrl(response.url())
    const method = truncateUtf8(request.method(), MAX_METHOD_BYTES)
    const resourceType = truncateUtf8(
      request.resourceType(),
      MAX_RESOURCE_TYPE_BYTES,
    )
    const entry = {
      url: url.value,
      method: method.value,
      status: response.status(),
      resourceType: resourceType.value,
      sameOrigin: sameOrigin(response.url(), candidateOrigin),
    }
    retainEntry(collected.collection.network, entry, {
      priority: entry.sameOrigin && entry.status >= 500 ? 2 : 0,
      truncated: url.truncated || method.truncated || resourceType.truncated,
    })
  })

  page.on("requestfailed", (request: Request) => {
    const url = boundedSanitizedUrl(request.url())
    const method = truncateUtf8(request.method(), MAX_METHOD_BYTES)
    const resourceType = truncateUtf8(
      request.resourceType(),
      MAX_RESOURCE_TYPE_BYTES,
    )
    const failureText = redactAndLimit(
      request.failure()?.errorText ?? "request failed",
      MAX_FAILURE_TEXT_BYTES,
    )
    const entry = {
      url: url.value,
      method: method.value,
      resourceType: resourceType.value,
      sameOrigin: sameOrigin(request.url(), candidateOrigin),
      failureText: failureText.value,
    }
    retainEntry(collected.collection.network, entry, {
      priority: entry.sameOrigin ? 2 : 1,
      truncated:
        url.truncated ||
        method.truncated ||
        resourceType.truncated ||
        failureText.truncated,
    })
  })

  page.on("pageerror", (error: Error) => {
    const message = redactAndLimit(error.message, MAX_CRASH_TEXT_BYTES)
    retainEntry(collected.collection.crash, {
      type: "page-error",
      message: message.value,
    }, {
      priority: 2,
      truncated: message.truncated,
    })
  })

  page.on("crash", () => {
    retainEntry(collected.collection.crash, {
      type: "page-crash",
      message: "Candidate page crashed",
    }, {
      priority: 2,
      truncated: false,
    })
  })

  return collected
}

export function consolePayload(
  collected: CollectedRuntimeEvidence,
): ConsoleEvidencePayload {
  return {
    schemaVersion: "uieval.console/v1alpha1",
    collection: stats(collected.collection.console),
    entries: [...collected.consoleEntries],
  }
}

export function networkPayload(
  collected: CollectedRuntimeEvidence,
): NetworkEvidencePayload {
  return {
    schemaVersion: "uieval.network/v1alpha1",
    collection: stats(collected.collection.network),
    entries: [...collected.networkEntries],
  }
}

export function crashPayload(
  collected: CollectedRuntimeEvidence,
): CrashEvidencePayload {
  return {
    schemaVersion: "uieval.crash/v1alpha1",
    collection: stats(collected.collection.crash),
    entries: [...collected.crashEntries],
  }
}

export async function captureDomEvidence(
  page: Page,
  renderSpace: RenderSpace,
): Promise<DomEvidenceSet> {
  const snapshot = await page.evaluate((limits) => {
    const root = document.documentElement
    const elements = root
      ? [root, ...Array.from(root.querySelectorAll("*"))].slice(0, 5_000)
      : []
    const ids = new Map<Element, string>()
    elements.forEach((element, index) => ids.set(element, `node-${index}`))

    const nodes = elements.map((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const ariaDisabled = element.getAttribute("aria-disabled") === "true"
      const disabled = "disabled" in element && Boolean((element as HTMLInputElement).disabled)
      const sensitive = Boolean(
        element.closest(
          '[data-ui-eval-sensitive], [data-sensitive], input[type="password"]',
        ),
      )
      let directText = ""
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue
        const remaining = limits.textCharacters - directText.length
        if (remaining <= 0) break
        directText += ` ${(node.textContent ?? "").slice(0, remaining)}`
      }
      directText = directText.replace(/\s+/g, " ").trim()
      // Keep the browser callback self-contained. The CLI runs through tsx,
      // whose name-preservation transform can otherwise rewrite a locally
      // bound helper to `__name(...)`; Playwright serializes the callback but
      // not that Node-side helper into the page.
      const uiId =
        element
          .getAttribute("data-ui-id")
          ?.slice(0, limits.attributeCharacters) ?? undefined
      const testId =
        element
          .getAttribute("data-testid")
          ?.slice(0, limits.attributeCharacters) ?? undefined
      const role =
        element.getAttribute("role")?.slice(0, limits.attributeCharacters) ??
        undefined
      const ariaLabel =
        element
          .getAttribute("aria-label")
          ?.slice(0, limits.attributeCharacters) ?? undefined
      const alt =
        element.getAttribute("alt")?.slice(0, limits.attributeCharacters) ??
        undefined
      const title =
        element.getAttribute("title")?.slice(0, limits.attributeCharacters) ??
        undefined
      const rawAccessibleName =
        ariaLabel ?? alt ?? title

      return {
        sensitive,
        nodeId: ids.get(element) ?? "node-unknown",
        parentNodeId: element.parentElement
          ? ids.get(element.parentElement)
          : undefined,
        uiId: sensitive ? undefined : uiId,
        testId: sensitive ? undefined : testId,
        role: sensitive ? undefined : role,
        accessibleName:
          rawAccessibleName === undefined
            ? undefined
            : sensitive
              ? "[REDACTED]"
              : rawAccessibleName,
        tagName: element.tagName.toLowerCase(),
        text:
          directText.length === 0
            ? undefined
            : sensitive
              ? "[REDACTED]"
              : directText,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0",
        enabled: !disabled && !ariaDisabled,
        rect: {
          x: rect.x,
          y: rect.y,
          width: Math.max(0, rect.width),
          height: Math.max(0, rect.height),
        },
        computedStyle: {
          display: style.display.slice(0, limits.styleCharacters),
          position: style.position.slice(0, limits.styleCharacters),
          color: style.color.slice(0, limits.styleCharacters),
          backgroundColor: style.backgroundColor.slice(
            0,
            limits.styleCharacters,
          ),
          borderColor: style.borderColor.slice(0, limits.styleCharacters),
          borderRadius: style.borderRadius.slice(0, limits.styleCharacters),
          boxShadow: style.boxShadow.slice(0, limits.styleCharacters),
          fontFamily: sensitive
            ? undefined
            : style.fontFamily.slice(0, limits.styleCharacters),
          fontSize: style.fontSize.slice(0, limits.styleCharacters),
          fontWeight: style.fontWeight.slice(0, limits.styleCharacters),
          lineHeight: style.lineHeight.slice(0, limits.styleCharacters),
        },
      }
    })

    const href = window.location.href
    return {
      url:
        href.length <= limits.urlCharacters
          ? href
          : `${window.location.origin}/__ui_eval_truncated_url__`,
      title: document.title.slice(0, limits.textCharacters),
      nodes,
    }
  }, {
    attributeCharacters: MAX_DOM_IDENTIFIER_BYTES * 2,
    styleCharacters: 1_024,
    textCharacters: MAX_DOM_TEXT_BYTES * 2,
    urlCharacters: MAX_URL_BYTES * 2,
  })

  const nodes = snapshot.nodes.map(
    ({
      nodeId,
      sensitive,
      parentNodeId,
      uiId,
      testId,
      role,
      accessibleName,
      tagName,
      text,
      visible,
      enabled,
      rect,
      computedStyle,
    }) => {
      const safeUiId = sensitive
        ? undefined
        : uiId === undefined
          ? undefined
          : truncateUtf8(uiId, MAX_DOM_IDENTIFIER_BYTES).value
      const safeTestId = sensitive
        ? undefined
        : testId === undefined
          ? undefined
          : truncateUtf8(testId, MAX_DOM_IDENTIFIER_BYTES).value
      const safeRole = sensitive
        ? undefined
        : role === undefined
          ? undefined
          : truncateUtf8(role, MAX_DOM_IDENTIFIER_BYTES).value
      const safeAccessibleName =
        accessibleName === undefined
          ? undefined
          : sensitive
            ? "[REDACTED]"
            : truncateUtf8(accessibleName, MAX_DOM_TEXT_BYTES).value
      const safeText =
        text === undefined
          ? undefined
          : sensitive
            ? "[REDACTED]"
            : truncateUtf8(text, MAX_DOM_TEXT_BYTES).value
      const safeComputedStyle = { ...computedStyle }
      if (sensitive) delete safeComputedStyle.fontFamily

      return {
        nodeId,
        ...(parentNodeId === undefined ? {} : { parentNodeId }),
        ...(safeUiId === undefined ? {} : { uiId: safeUiId }),
        ...(safeTestId === undefined ? {} : { testId: safeTestId }),
        ...(safeRole === undefined ? {} : { role: safeRole }),
        ...(safeAccessibleName === undefined
          ? {}
          : { accessibleName: safeAccessibleName }),
        tagName,
        ...(safeText === undefined ? {} : { text: safeText }),
        visible,
        enabled,
        rect,
        computedStyle: safeComputedStyle,
      }
    },
  )
  return {
    dom: {
      schemaVersion: "uieval.dom/v1alpha1",
      url: sanitizeUrl(snapshot.url),
      title: redactText(snapshot.title),
      nodes,
    },
    layout: {
      schemaVersion: "uieval.layout/v1alpha1",
      renderSpace,
      nodes: nodes.map(
        ({
          nodeId,
          parentNodeId,
          uiId,
          testId,
          role,
          accessibleName,
          rect,
          visible,
        }) => ({
          nodeId,
          ...(parentNodeId === undefined ? {} : { parentNodeId }),
          ...(uiId === undefined ? {} : { uiId }),
          ...(testId === undefined ? {} : { testId }),
          ...(role === undefined ? {} : { role }),
          ...(accessibleName === undefined ? {} : { accessibleName }),
          rect,
          visible,
        }),
      ),
    },
    styles: {
      schemaVersion: "uieval.styles/v1alpha1",
      nodes: nodes.map(
        ({ nodeId, uiId, testId, role, accessibleName, computedStyle }) => ({
          nodeId,
          ...(uiId === undefined ? {} : { uiId }),
          ...(testId === undefined ? {} : { testId }),
          ...(role === undefined ? {} : { role }),
          ...(accessibleName === undefined ? {} : { accessibleName }),
          computedStyle,
        }),
      ),
    },
    fontFamilies: Array.from(
      new Set(
        nodes
          .map((node) =>
            "fontFamily" in node.computedStyle
              ? node.computedStyle.fontFamily
              : undefined,
          )
          .filter((family): family is string => Boolean(family)),
      ),
    ).sort(),
  }
}
