import { describe, expect, it } from "vitest"

import type {
  AssertionResult,
  CaptureBundleSpec,
  ExecutionError,
  StepResult,
} from "../contracts/model"
import {
  classifyExecutionOutcome,
  evaluateFunctionalEvidence,
  type FunctionalCaptureInput,
} from "./functional"

const context = {
  scenarioId: "terms-desktop",
  executionId: "run-1",
  checkpointId: "ready",
  variantKey: "desktop-chromium__zh__light",
  contextDigest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
}

function capture(
  overrides: Partial<
    Pick<
      CaptureBundleSpec,
      | "status"
      | "completeness"
      | "stepResults"
      | "assertionResults"
      | "executionErrors"
    >
  > = {},
): FunctionalCaptureInput {
  return {
    status: "completed",
    completeness: {
      expectedRequired: 2,
      capturedRequired: 2,
      missingRequired: 0,
    },
    stepResults: [] as StepResult[],
    assertionResults: [] as AssertionResult[],
    executionErrors: [] as ExecutionError[],
    ...overrides,
  }
}

describe("classifyExecutionOutcome", () => {
  it("distinguishes product failures from infrastructure failures", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          executionErrors: [
            {
              origin: "product",
              phase: "action",
              code: "page-error",
              message: "render failed",
              retryable: false,
            },
          ],
        }),
      ),
    ).toBe("valid")

    expect(
      classifyExecutionOutcome(
        capture({
          status: "failed",
          executionErrors: [
            {
              origin: "driver",
              phase: "prepare",
              code: "browser-launch-failed",
              message: "missing browser",
              retryable: true,
            },
          ],
        }),
      ),
    ).toBe("infra-error")
  })

  it("marks missing required evidence inconclusive", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          status: "partial",
          completeness: {
            expectedRequired: 2,
            capturedRequired: 1,
            missingRequired: 1,
          },
        }),
      ),
    ).toBe("invalid-evidence")
  })

  it("keeps third-party request failures advisory", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          executionErrors: [
            {
              origin: "external-service",
              phase: "action",
              code: "external-request-failed",
              message: "optional CDN request failed",
              retryable: true,
            },
          ],
        }),
      ),
    ).toBe("valid")
  })

  it("treats runner result failures as infrastructure without a matching error entry", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          stepResults: [
            {
              stepId: "capture-again",
              status: "failed",
              origin: "runner",
              errorCode: "duplicate-checkpoint",
            },
          ],
        }),
      ),
    ).toBe("infra-error")
  })

  it("fails closed for non-product failed assertions and skipped steps", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          assertionResults: [
            {
              assertionId: "heading-visible",
              status: "failed",
              origin: "runner",
            },
          ],
        }),
      ),
    ).toBe("infra-error")

    expect(
      classifyExecutionOutcome(
        capture({
          stepResults: [
            {
              stepId: "open-menu",
              status: "skipped",
              origin: "driver",
            },
          ],
        }),
      ),
    ).toBe("infra-error")
  })

  it("rejects incomplete or implausibly attributed success results", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          stepResults: [
            {
              stepId: "open-menu",
              status: "not-executed",
              origin: "product",
            },
          ],
        }),
      ),
    ).toBe("invalid-evidence")

    expect(
      classifyExecutionOutcome(
        capture({
          assertionResults: [
            {
              assertionId: "heading-visible",
              status: "passed",
              origin: "runner",
            },
          ],
        }),
      ),
    ).toBe("invalid-evidence")
  })

  it("keeps an observed product crash conclusive when later evidence is missing", () => {
    expect(
      classifyExecutionOutcome(
        capture({
          status: "partial",
          completeness: {
            expectedRequired: 2,
            capturedRequired: 1,
            missingRequired: 1,
          },
          executionErrors: [
            {
              origin: "product",
              phase: "action",
              code: "candidate-page-crash",
              message: "page crashed",
              retryable: false,
            },
          ],
        }),
      ),
    ).toBe("valid")
  })
})

describe("evaluateFunctionalEvidence", () => {
  it("emits stable actionable findings for failed steps and assertions", () => {
    const input = capture({
      stepResults: [
        {
          stepId: "open-terms",
          status: "passed",
          origin: "product",
        },
        {
          stepId: "click-primary",
          status: "failed",
          origin: "product",
          errorCode: "target-not-actionable",
        },
      ],
      assertionResults: [
        {
          assertionId: "terms-heading-text",
          checkpointId: "ready",
          status: "failed",
          origin: "product",
          expected: { kind: "string", value: "用户服务协议" },
          actual: { kind: "string", value: "服务" },
        },
      ],
    })

    const first = evaluateFunctionalEvidence(input, context)
    const second = evaluateFunctionalEvidence(input, {
      ...context,
      executionId: "run-2",
    })

    expect(first.metrics).toMatchObject({
      "execution.valid": false,
      "execution.failedSteps": 1,
      "interaction.failedAssertions": 1,
      "runtime.criticalErrors": 0,
      "coverage.requiredRatio": 1,
    })
    expect(first.findings).toHaveLength(2)
    expect(first.findings.map((finding) => finding.fingerprint)).toEqual(
      second.findings.map((finding) => finding.fingerprint),
    )
  })

  it("counts observed product runtime errors without calling them infrastructure", () => {
    const result = evaluateFunctionalEvidence(
      capture({
        executionErrors: [
          {
            origin: "product",
            phase: "action",
            code: "same-origin-5xx",
            message: "GET /api/profile returned 500",
            retryable: false,
          },
        ],
      }),
      context,
    )

    expect(result.executionOutcome).toBe("valid")
    expect(result.metrics["runtime.criticalErrors"]).toBe(1)
    expect(result.findings[0]).toMatchObject({
      dimension: "runtime",
      severity: "critical",
      ruleId: "runtime.product-error",
    })
  })

  it("does not emit quality findings or misleading metrics for infra failure", () => {
    const result = evaluateFunctionalEvidence(
      capture({
        status: "failed",
        executionErrors: [
          {
            origin: "runner",
            phase: "prepare",
            code: "server-unavailable",
            message: "server did not become ready",
            retryable: true,
          },
        ],
      }),
      context,
    )

    expect(result.executionOutcome).toBe("infra-error")
    expect(result.metrics).toEqual({})
    expect(result.findings).toEqual([])
  })
})
