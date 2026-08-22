import type { ExecutionError } from "../contracts/model"

export type StepFailureOrigin = "product" | "runner" | "driver" | "fixture"

export interface ClassifiedStepFailure {
  origin: StepFailureOrigin
  code: string
  retryable: boolean
}

export class CaptureOperationError extends Error {
  constructor(
    message: string,
    readonly classification: ClassifiedStepFailure,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "CaptureOperationError"
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function classifyStepFailure(
  error: unknown,
  operation: "navigation" | "locator" | "assertion" | "stabilization" | "driver",
): ClassifiedStepFailure {
  if (error instanceof CaptureOperationError) return error.classification

  const name = errorName(error)
  const message = errorMessage(error)

  if (
    operation === "navigation" &&
    /ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|NAME_NOT_RESOLVED|TIMED_OUT)/i.test(
      message,
    )
  ) {
    return {
      origin: "runner",
      code: "candidate-unreachable",
      retryable: true,
    }
  }

  if (/\bpage crashed\b/i.test(message)) {
    return {
      origin: "product",
      code: "candidate-page-crash",
      retryable: false,
    }
  }

  if (
    /browser.*(?:closed|disconnected)|target page, context or browser has been closed/i.test(
      message,
    )
  ) {
    return { origin: "driver", code: "browser-unavailable", retryable: true }
  }

  if (name === "TimeoutError" || /timeout.*exceeded/i.test(message)) {
    if (operation === "locator" || operation === "assertion") {
      return { origin: "product", code: "target-timeout", retryable: false }
    }
    return {
      origin: operation === "navigation" ? "runner" : "driver",
      code:
        operation === "stabilization"
          ? "stabilization-timeout"
          : "driver-timeout",
      retryable: true,
    }
  }

  return { origin: "driver", code: "driver-operation-failed", retryable: true }
}

export interface NetworkObservation {
  sameOrigin: boolean
  status?: number
  failureText?: string
}

/**
 * A top-level document response is the candidate itself, not incidental
 * network noise. Client and server errors are therefore conclusive product
 * failures even when the returned error document happens to satisfy shallow
 * DOM assertions.
 */
export function classifyMainDocumentResponse(
  status: number,
  phase: ExecutionError["phase"],
  stepId?: string,
): ExecutionError | null {
  if (status < 400) return null

  const statusClass = status < 500 ? "4xx" : "5xx"
  return {
    origin: "product",
    phase,
    code: `same-origin-main-document-http-${statusClass}`,
    message: `Candidate main document returned HTTP ${status}`,
    retryable: false,
    ...(stepId === undefined ? {} : { stepId }),
  }
}

export function classifyNetworkObservation(
  observation: NetworkObservation,
  phase: ExecutionError["phase"] = "action",
  stepId?: string,
): ExecutionError | null {
  if (observation.sameOrigin && (observation.status ?? 0) >= 500) {
    return {
      origin: "product",
      phase,
      code: "same-origin-http-5xx",
      message: `Candidate returned HTTP ${observation.status}`,
      retryable: false,
      ...(stepId === undefined ? {} : { stepId }),
    }
  }

  if (observation.failureText) {
    return {
      origin: observation.sameOrigin ? "product" : "external-service",
      phase,
      code: observation.sameOrigin
        ? "same-origin-request-failed"
        : "external-request-failed",
      message: observation.failureText,
      retryable: !observation.sameOrigin,
      ...(stepId === undefined ? {} : { stepId }),
    }
  }

  return null
}

export function productPageError(
  message: string,
  phase: ExecutionError["phase"],
  stepId?: string,
): ExecutionError {
  return {
    origin: "product",
    phase,
    code: "uncaught-page-error",
    message,
    retryable: false,
    ...(stepId === undefined ? {} : { stepId }),
  }
}
