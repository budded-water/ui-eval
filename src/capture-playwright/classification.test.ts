import { describe, expect, it } from "vitest"

import {
  CaptureOperationError,
  classifyMainDocumentResponse,
  classifyNetworkObservation,
  classifyStepFailure,
  productPageError,
} from "./classification"

describe("capture failure classification", () => {
  it("treats a missing semantic target as a product failure", () => {
    const timeout = Object.assign(new Error("locator timeout exceeded"), {
      name: "TimeoutError",
    })

    expect(classifyStepFailure(timeout, "locator")).toEqual({
      origin: "product",
      code: "target-timeout",
      retryable: false,
    })
  })

  it("keeps candidate reachability and browser failures in infrastructure origins", () => {
    expect(
      classifyStepFailure(
        new Error("page.goto: net::ERR_CONNECTION_REFUSED"),
        "navigation",
      ),
    ).toEqual({
      origin: "runner",
      code: "candidate-unreachable",
      retryable: true,
    })
    expect(
      classifyStepFailure(
        new Error("Target page, context or browser has been closed"),
        "driver",
      ),
    ).toEqual({
      origin: "driver",
      code: "browser-unavailable",
      retryable: true,
    })
  })

  it("treats a renderer page crash as a product failure", () => {
    expect(
      classifyStepFailure(new Error("locator.click: Page crashed"), "driver"),
    ).toEqual({
      origin: "product",
      code: "candidate-page-crash",
      retryable: false,
    })
  })

  it("preserves an explicit fixture classification", () => {
    const failure = new CaptureOperationError("fixture unavailable", {
      origin: "fixture",
      code: "fixture-unavailable",
      retryable: false,
    })

    expect(classifyStepFailure(failure, "driver")).toEqual(
      failure.classification,
    )
  })

  it("classifies same-origin 5xx and uncaught page errors as product evidence", () => {
    expect(
      classifyNetworkObservation({ sameOrigin: true, status: 503 }, "action", "tap"),
    ).toMatchObject({
      origin: "product",
      phase: "action",
      code: "same-origin-http-5xx",
      retryable: false,
      stepId: "tap",
    })
    expect(productPageError("render exploded", "checkpoint")).toMatchObject({
      origin: "product",
      code: "uncaught-page-error",
      retryable: false,
    })
  })

  it("treats top-level 4xx and 5xx documents as conclusive product failures", () => {
    expect(classifyMainDocumentResponse(404, "prepare")).toEqual({
      origin: "product",
      phase: "prepare",
      code: "same-origin-main-document-http-4xx",
      message: "Candidate main document returned HTTP 404",
      retryable: false,
    })
    expect(classifyMainDocumentResponse(503, "setup", "goto-error")).toEqual({
      origin: "product",
      phase: "setup",
      code: "same-origin-main-document-http-5xx",
      message: "Candidate main document returned HTTP 503",
      retryable: false,
      stepId: "goto-error",
    })
    expect(classifyMainDocumentResponse(399, "prepare")).toBeNull()
  })

  it("does not turn successful or third-party responses into product failures", () => {
    expect(
      classifyNetworkObservation({ sameOrigin: true, status: 200 }),
    ).toBeNull()
    expect(
      classifyNetworkObservation({
        sameOrigin: false,
        failureText: "upstream unavailable",
      }),
    ).toMatchObject({
      origin: "external-service",
      code: "external-request-failed",
    })
  })
})
