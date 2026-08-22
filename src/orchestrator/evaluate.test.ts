import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  CaptureBundleSpec,
  CaptureCapability,
  WebResolvedScenarioPlan,
} from "../contracts/model"
import {
  PLAYWRIGHT_CAPTURE_ADAPTER_ID,
  PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
  PLAYWRIGHT_CAPTURE_CAPABILITIES,
  type CaptureWebScenarioContext,
} from "../capture-playwright/adapter"
import { BINARY_EVIDENCE_LIMITS } from "../capture-playwright/binary-evidence"
import { canonicalDigest } from "../contracts/canonical-json"
import { initUiEvalProject } from "../cli/init"
import {
  evaluateScenario,
  normalizedCandidateEvidenceDigest,
} from "./evaluate"
import { MockServerError } from "./mock-server"

const roots: string[] = []

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    }),
  )
  return nested.flat()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

function screenshotPixels(redValues: readonly number[]): Buffer {
  const image = new PNG({ width: redValues.length, height: 1 })
  redValues.forEach((red, index) => {
    image.data.set([red, 0, 0, 255], index * 4)
  })
  return PNG.sync.write(image)
}

function screenshot(red: number): Buffer {
  return screenshotPixels([red, red])
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12, "ascii")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function executable(plan: WebResolvedScenarioPlan) {
  type TestAssertion = {
    id: string
    kind: "visible" | "hidden" | "enabled" | "text" | "url" | "no-crash"
    expected?: string | boolean
  }
  type TestStep = {
    id: string
    action?: string
    assertion?: TestAssertion
  }
  return plan as WebResolvedScenarioPlan & {
    setup: TestStep[]
    steps: TestStep[]
    cleanup: TestStep[]
    checkpoints: Array<{
      id: string
      requiredChannels: CaptureCapability[]
      assertions?: TestAssertion[]
    }>
  }
}

async function successfulCapture(
  sourcePlan: WebResolvedScenarioPlan,
  context: CaptureWebScenarioContext,
): Promise<CaptureBundleSpec> {
  const plan = executable(sourcePlan)
  const checkpoint = plan.checkpoints[0]
  if (!checkpoint) throw new Error("checkpoint missing")
  const evidence = await Promise.all(
    checkpoint.requiredChannels.map(async (channel) => {
      const isScreenshot = channel === "screenshot"
      const isTrace = channel === "trace"
      const artifact = await context.artifactStore.put(
        isScreenshot ? screenshot(20) : isTrace ? Buffer.from("zip") : { channel },
        {
          mediaType: isScreenshot
            ? "image/png"
            : isTrace
              ? "application/zip"
              : "application/json",
          sensitivity: "internal",
        },
      )
      return {
        channel,
        required: true,
        status: "captured" as const,
        artifact,
      }
    }),
  )
  const environmentBase = {
    os: "test",
    architecture: "test",
    rendererProfile: "desktop-chromium",
    browserOrDevice: context.browserChannel
      ? `chromium:${context.browserChannel}`
      : "chromium:playwright",
    browserOrOsVersion: "1",
    driverVersion: "test",
    locale: plan.locale,
    timezone: plan.determinism.timezone,
    fontSetDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }
  return {
    executionId: context.executionId,
    runManifestDigest: context.runManifestDigest,
    captureKey: context.captureKey,
    scenarioId: plan.scenarioId,
    variant: plan.variant,
    sourceRevision: context.sourceRevision,
    build: context.build,
    adapter: {
      id: PLAYWRIGHT_CAPTURE_ADAPTER_ID,
      version: PLAYWRIGHT_CAPTURE_ADAPTER_VERSION,
      platform: "web",
    },
    environment: {
      ...environmentBase,
      environmentDigest: canonicalDigest(environmentBase),
    },
    capabilities: [...PLAYWRIGHT_CAPTURE_CAPABILITIES],
    status: "completed",
    completeness: {
      expectedRequired: evidence.length,
      capturedRequired: evidence.length,
      missingRequired: 0,
    },
    stepResults: [...plan.setup, ...plan.steps, ...plan.cleanup].map((step) => ({
      stepId: step.id,
      status: "passed",
      origin: "product",
    })),
    assertionResults: [
      ...[...plan.setup, ...plan.steps, ...plan.cleanup].flatMap((step) => {
        if (step.action !== "assert" || !step.assertion) return []
        const stringMetric =
          step.assertion.kind === "text" || step.assertion.kind === "url"
        const value = stringMetric
          ? {
              kind: "string" as const,
              value:
                typeof step.assertion.expected === "string"
                  ? step.assertion.expected
                  : "",
            }
          : { kind: "boolean" as const, value: true }
        return [
          {
            assertionId: step.assertion.id,
            stepId: step.id,
            status: "passed" as const,
            origin: "product" as const,
            expected: value,
            actual: value,
          },
        ]
      }),
      ...(checkpoint.assertions ?? []).map((assertion) => {
        const stringMetric = assertion.kind === "text" || assertion.kind === "url"
        const value = stringMetric
          ? {
              kind: "string" as const,
              value:
                typeof assertion.expected === "string"
                  ? assertion.expected
                  : "",
            }
          : { kind: "boolean" as const, value: true }
        return {
          assertionId: assertion.id,
          checkpointId: checkpoint.id,
          status: "passed" as const,
          origin: "product" as const,
          expected: value,
          actual: value,
        }
      }),
    ],
    checkpoints: [
      {
        checkpointId: checkpoint.id,
        renderSpace: plan.device.renderSpace,
        capturedAt: "2026-08-10T00:00:00.000Z",
        evidence,
      },
    ],
  }
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-orchestrator-"))
  roots.push(root)
  await initUiEvalProject({
    projectRoot: root,
    route: "/privacy",
    scenarioId: "privacy-desktop",
  })
  return root
}

async function projectWithTwoDeviceVariants(): Promise<string> {
  const root = await project()
  const projectPath = join(root, "ui-eval/project.json")
  const projectConfig = JSON.parse(await readFile(projectPath, "utf8")) as {
    deviceProfiles: Record<string, unknown>
  }
  projectConfig.deviceProfiles["mobile-chromium"] = {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  }
  await writeFile(projectPath, `${JSON.stringify(projectConfig, null, 2)}\n`)

  const scenarioPath = join(
    root,
    "ui-eval/scenarios/privacy-desktop.json",
  )
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
    matrix: { deviceProfiles: string[] }
  }
  scenario.matrix.deviceProfiles = ["desktop-chromium", "mobile-chromium"]
  await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`)
  return root
}

async function projectWithMockFixture(): Promise<string> {
  const root = await project()
  const scenarioPath = join(
    root,
    "ui-eval/scenarios/privacy-desktop.json",
  )
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
    fixtures?: unknown[]
  }
  scenario.fixtures = [
    {
      id: "catalog-api",
      provider: "mock-server",
      configPath: "fixtures/catalog-api.json",
    },
  ]
  await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`)
  await mkdir(join(root, "ui-eval/fixtures"), { recursive: true })
  await writeFile(
    join(root, "ui-eval/fixtures/catalog-api.json"),
    `${JSON.stringify(
      {
        apiVersion: "uieval.io/v1alpha1",
        kind: "MockServerFixtureConfig",
        listen: { port: 18_001 },
        routes: [
          {
            id: "catalog",
            method: "GET",
            path: "/api/catalog",
            required: true,
            response: {
              status: 200,
              contentType: "application/json",
              body: "[]",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return root
}

const deps = {
  capture: successfulCapture,
  ensureServer: async () => ({
    url: "http://127.0.0.1:3000",
    reused: true,
    stop: async () => {},
  }),
  sourceRevision: async () => ({
    repository: "test",
    commitSha: "abc123",
    dirtyTree: false,
  }),
  createExecutionId: () => "run-test",
  now: () => new Date("2026-08-10T00:00:00.000Z"),
} satisfies Parameters<typeof evaluateScenario>[1]

describe("evaluateScenario", () => {
  it("runs the sealed pipeline and writes canonical JSON plus a truthful HTML view", async () => {
    const projectRoot = await project()
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop", policy: "default" },
      deps,
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "pass",
    })
    await access(result.runs[0].reportPath)
    await access(result.runs[0].htmlPath)
    const html = await readFile(result.runs[0].htmlPath, "utf8")
    expect(html).toContain("Geometry")
    expect(html).toContain("unsupported")
    expect(html).toContain(
      "ui-eval evaluate privacy-desktop --policy default",
    )
    expect(html).toContain("--policy default")
    expect(html).toContain("Provenance")
    expect(html).toContain("execution@0.1.0")
    expect(html).not.toContain("Overall score")
    expect(
      result.runs[0].report.spec.coverage.byDimension.find(
        (entry) => entry.dimension === "geometry",
      )?.counts,
    ).toMatchObject({ evaluated: 0, unsupported: 3 })
  })

  it("releases an owned candidate server before starting the next matrix variant", async () => {
    const projectRoot = await projectWithTwoDeviceVariants()
    const lifecycle: string[] = []
    let serverNumber = 0
    let executionNumber = 0

    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop", policy: "default" },
      {
        ...deps,
        createExecutionId: () => `run-matrix-${++executionNumber}`,
        ensureServer: async () => {
          const currentServer = ++serverNumber
          lifecycle.push(`start:${currentServer}`)
          return {
            url: "http://127.0.0.1:3000",
            reused: false,
            stop: async () => {
              lifecycle.push(`stop:${currentServer}`)
            },
          }
        },
        capture: async (plan, context) => {
          lifecycle.push(`capture:${plan.variant.values.deviceProfile}`)
          return successfulCapture(plan, context)
        },
      },
    )

    expect(result.runs).toHaveLength(2)
    expect(lifecycle).toEqual([
      "start:1",
      "capture:desktop-chromium",
      "stop:1",
      "start:2",
      "capture:mobile-chromium",
      "stop:2",
    ])
  })

  it("owns fixture lifecycle around the candidate server and verifies usage after capture", async () => {
    const projectRoot = await projectWithMockFixture()
    const lifecycle: string[] = []

    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop", policy: "default" },
      {
        ...deps,
        startFixtures: async () => {
          lifecycle.push("fixture:start")
          return {
            verify: () => lifecycle.push("fixture:verify"),
            stop: async () => {
              lifecycle.push("fixture:stop")
            },
          }
        },
        ensureServer: async () => {
          lifecycle.push("server:start")
          return {
            url: "http://127.0.0.1:3000",
            reused: false,
            stop: async () => {
              lifecycle.push("server:stop")
            },
          }
        },
        capture: async (plan, context) => {
          lifecycle.push("capture")
          return successfulCapture(plan, context)
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "pass",
    })
    expect(lifecycle).toEqual([
      "fixture:start",
      "server:start",
      "capture",
      "fixture:verify",
      "server:stop",
      "fixture:stop",
    ])
  })

  it("turns a missed required fixture route into fixture infrastructure evidence", async () => {
    const projectRoot = await projectWithMockFixture()
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop", policy: "default" },
      {
        ...deps,
        startFixtures: async () => ({
          verify: () => {
            throw new MockServerError(
              "MOCK_SERVER_REQUIRED_ROUTE_MISSED",
              "required catalog route was not requested",
              "catalog-api",
            )
          },
          stop: async () => {},
        }),
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    const capture = JSON.parse(
      await readFile(
        join(projectRoot, ".ui-eval/runs/run-test/capture.json"),
        "utf8",
      ),
    ) as { spec: { executionErrors?: unknown[] } }
    expect(capture.spec.executionErrors).toEqual([
      expect.objectContaining({
        origin: "fixture",
        code: "mock-server-required-route-missed",
        retryable: false,
      }),
    ])
  })

  it("stops fixtures even when candidate-server cleanup fails", async () => {
    const projectRoot = await projectWithMockFixture()
    const fixtureStop = vi.fn(async () => {})
    const stopFailure = Object.assign(new Error("owned server did not stop"), {
      code: "STOP_FAILED",
    })

    await expect(
      evaluateScenario(
        { projectRoot, scenario: "privacy-desktop", policy: "default" },
        {
          ...deps,
          startFixtures: async () => ({ verify: () => {}, stop: fixtureStop }),
          ensureServer: async () => ({
            url: "http://127.0.0.1:3000",
            reused: false,
            stop: async () => {
              throw stopFailure
            },
          }),
        },
      ),
    ).rejects.toBe(stopFailure)
    expect(fixtureStop).toHaveBeenCalledOnce()
    await expect(
      access(join(projectRoot, ".ui-eval/runs/run-test/report.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      access(join(projectRoot, ".ui-eval/runs/run-test/report.html")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fails closed instead of starting another variant when owned server cleanup fails", async () => {
    const projectRoot = await projectWithTwoDeviceVariants()
    const capturedVariants: string[] = []
    const stopFailure = Object.assign(new Error("owned server did not stop"), {
      code: "STOP_FAILED",
    })
    let serverStarts = 0
    let executionNumber = 0

    await expect(
      evaluateScenario(
        { projectRoot, scenario: "privacy-desktop", policy: "default" },
        {
          ...deps,
          createExecutionId: () => `run-stop-failure-${++executionNumber}`,
          ensureServer: async () => {
            serverStarts += 1
            return {
              url: "http://127.0.0.1:3000",
              reused: false,
              stop: async () => {
                throw stopFailure
              },
            }
          },
          capture: async (plan, context) => {
            capturedVariants.push(String(plan.variant.values.deviceProfile))
            return successfulCapture(plan, context)
          },
        },
      ),
    ).rejects.toBe(stopFailure)

    expect(serverStarts).toBe(1)
    expect(capturedVariants).toEqual(["desktop-chromium"])
    await expect(
      access(
        join(
          projectRoot,
          ".ui-eval/runs/run-stop-failure-1/report.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("turns a changed local reference into review evidence, not an accuracy score", async () => {
    const projectRoot = await project()
    await writeFile(join(projectRoot, "reference.png"), screenshot(240))
    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0].rawStatus).toBe("needs-review")
    expect(result.runs[0].report.spec.findings[0]).toMatchObject({
      dimension: "pixel",
      severity: "info",
    })
    expect(result.runs[0].report.spec).not.toHaveProperty("scores")
    await access(join(projectRoot, ".ui-eval/runs/run-test/diff.png"))
  })

  it("reports oversized reference IHDR dimensions as runner infrastructure", async () => {
    const projectRoot = await project()
    await writeFile(
      join(projectRoot, "reference.png"),
      pngHeader(BINARY_EVIDENCE_LIMITS.png.maxWidthPx + 1, 1),
    )

    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    const html = await readFile(result.runs[0].htmlPath, "utf8")
    expect(html).toContain("reference-png-dimensions-exceeded")
    await expect(
      access(join(projectRoot, ".ui-eval/runs/run-test/reference.png")),
    ).rejects.toThrow()
  })

  it("rejects an oversized sparse reference before reading it", async () => {
    const projectRoot = await project()
    const referencePath = join(projectRoot, "reference.png")
    await writeFile(referencePath, screenshot(240))
    await truncate(
      referencePath,
      BINARY_EVIDENCE_LIMITS.png.maxEncodedBytes + 1,
    )

    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    const html = await readFile(result.runs[0].htmlPath, "utf8")
    expect(html).toContain("reference-png-encoded-bytes-exceeded")
  })

  it("keeps candidate and reference links distinct when their digests match", async () => {
    const projectRoot = await project()
    await writeFile(join(projectRoot, "reference.png"), screenshot(20))

    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0].rawStatus).toBe("pass")
    const html = await readFile(result.runs[0].htmlPath, "utf8")
    expect(html).toContain(
      '<span>Candidate</span><img src="candidate.png"',
    )
    expect(html).toContain(
      '<span>Reference</span><img src="reference.png"',
    )
  })

  it("keys the evaluation by reference content without keying finding identity by measurement", async () => {
    const firstRoot = await project()
    const secondRoot = await project()
    await writeFile(
      join(firstRoot, "reference.png"),
      screenshotPixels([240, 20]),
    )
    await writeFile(
      join(secondRoot, "reference.png"),
      screenshotPixels([240, 240]),
    )

    const first = await evaluateScenario(
      {
        projectRoot: firstRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )
    const second = await evaluateScenario(
      {
        projectRoot: secondRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(first.runs[0].report.spec.evaluationKey).not.toBe(
      second.runs[0].report.spec.evaluationKey,
    )
    expect(first.runs[0].report.spec.findings[0].fingerprint).toBe(
      second.runs[0].report.spec.findings[0].fingerprint,
    )
    expect(first.runs[0].report.spec.findings[0].comparison).toBe(
      "local-reference-candidate",
    )
  })

  it("reports an explicit product assertion as candidate failure with valid evidence", async () => {
    const projectRoot = await project()
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        capture: async (plan, context) => {
          const capture = await successfulCapture(plan, context)
          capture.assertionResults[0] = {
            ...capture.assertionResults[0],
            status: "failed",
            expected: { kind: "boolean", value: true },
            actual: { kind: "boolean", value: false },
          }
          return capture
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "fail",
    })
    expect(result.runs[0].report.spec.findings[0]).toMatchObject({
      dimension: "interaction",
      severity: "critical",
    })
  })

  it("keeps sensitive runtime diagnostics out of every run-visible artifact", async () => {
    const projectRoot = await project()
    const sentinel = "private.person@example.invalid-4111111111111111"
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        capture: async (plan, context) => {
          const capture = await successfulCapture(plan, context)
          const consoleRecord = capture.checkpoints[0].evidence.find(
            (record) => record.channel === "console",
          )
          if (!consoleRecord) throw new Error("console evidence missing")
          consoleRecord.artifact = await context.artifactStore.putJson(
            {
              schemaVersion: "uieval.console/v1alpha1",
              entries: [{ level: "error", text: sentinel }],
            },
            { sensitivity: "sensitive" },
          )
          capture.executionErrors = [
            {
              origin: "product",
              phase: "action",
              code: "candidate-page-error",
              message: `page error included ${sentinel}`,
              retryable: false,
            },
          ]
          return capture
        },
      },
    )

    expect(result.runs[0].rawStatus).toBe("fail")
    expect(
      result.runs[0].report.spec.coverage.byDimension.find(
        (entry) => entry.dimension === "runtime",
      )?.counts,
    ).toMatchObject({ evaluated: 3, passed: 2, failed: 1 })
    const runRoot = join(projectRoot, ".ui-eval/runs/run-test")
    const runText = (
      await Promise.all(
        (await filesUnder(runRoot)).map((path) => readFile(path).then(String)),
      )
    ).join("\n")
    expect(runText).not.toContain(sentinel)
    expect(runText).toContain("raw content is intentionally omitted")
    await expect(access(join(runRoot, "console.json"))).rejects.toThrow()
  })

  it("rejects an ambiguous local reference before starting the candidate server", async () => {
    const projectRoot = await project()
    const scenarioPath = join(
      projectRoot,
      "ui-eval/scenarios/privacy-desktop.json",
    )
    const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
      steps: unknown[]
      checkpoints: Array<{
        id: string
        requiredChannels: CaptureCapability[]
        captureScope: string
        stabilize: Record<string, unknown>
        assertions?: unknown[]
      }>
    }
    scenario.steps.push({
      id: "capture-secondary",
      action: "checkpoint",
      checkpointId: "secondary",
    })
    scenario.checkpoints.push({
      ...scenario.checkpoints[0],
      id: "secondary",
      assertions: [],
    })
    await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`)
    await writeFile(join(projectRoot, "reference.png"), screenshot(240))

    let serverStarts = 0
    await expect(
      evaluateScenario(
        {
          projectRoot,
          scenario: "privacy-desktop",
          referencePath: "reference.png",
        },
        {
          ...deps,
          ensureServer: async () => {
            serverStarts += 1
            return deps.ensureServer()
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "VISUAL_REFERENCE_CHECKPOINT_AMBIGUOUS",
    })
    expect(serverStarts).toBe(0)
  })

  it("propagates cancellation through capture and awaits owned server cleanup", async () => {
    const projectRoot = await project()
    const controller = new AbortController()
    const interruption = Object.assign(new Error("interrupted by test"), {
      code: "INTERRUPTED",
    })
    const stop = vi.fn(async () => {})

    await expect(
      evaluateScenario(
        {
          projectRoot,
          scenario: "privacy-desktop",
          signal: controller.signal,
        },
        {
          ...deps,
          ensureServer: async () => ({
            url: "http://127.0.0.1:3000",
            reused: false,
            stop,
          }),
          capture: async (plan, context) => {
            expect(context.signal).toBe(controller.signal)
            controller.abort(interruption)
            return successfulCapture(plan, context)
          },
        },
      ),
    ).rejects.toBe(interruption)
    expect(stop).toHaveBeenCalledOnce()
  })

  it("cleans up when cancellation races with owned server readiness", async () => {
    const projectRoot = await project()
    const controller = new AbortController()
    const interruption = Object.assign(new Error("cancelled after readiness"), {
      code: "INTERRUPTED",
    })
    const stop = vi.fn(async () => {})

    await expect(
      evaluateScenario(
        {
          projectRoot,
          scenario: "privacy-desktop",
          signal: controller.signal,
        },
        {
          ...deps,
          ensureServer: async () => {
            controller.abort(interruption)
            return {
              url: "http://127.0.0.1:3000",
              reused: false,
              stop,
            }
          },
        },
      ),
    ).rejects.toBe(interruption)
    expect(stop).toHaveBeenCalledOnce()
  })

  it("never forwards raw candidate-server stderr through CLI progress", async () => {
    const projectRoot = await project()
    const sentinel = "candidate-server-secret-4111111111111111"
    const progress: string[] = []

    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        onProgress: (message) => progress.push(message),
      },
      {
        ...deps,
        ensureServer: async (_config, options) => {
          options.onProgress?.({
            type: "stderr",
            message: sentinel,
            url: "http://127.0.0.1:3000",
          })
          options.onProgress?.({
            type: "ready",
            message: "candidate ready",
            url: "http://127.0.0.1:3000",
          })
          return {
            url: "http://127.0.0.1:3000",
            reused: true,
            stop: async () => {},
          }
        },
      },
    )

    expect(result.runs[0].rawStatus).toBe("pass")
    expect(progress.join("\n")).toContain("candidate ready")
    expect(progress.join("\n")).not.toContain(sentinel)
  })

  it("rejects mismatched assertion metrics from an untrusted capture adapter without leaking them", async () => {
    const projectRoot = await project()
    const expectedSecret = "token=adapter-expected-secret"
    const actualSecret = `password=adapter-actual-secret ${"x".repeat(4_000)}`
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        capture: async (plan, context) => {
          const capture = await successfulCapture(plan, context)
          capture.assertionResults[0] = {
            ...capture.assertionResults[0],
            status: "failed",
            expected: { kind: "color", value: expectedSecret },
            actual: { kind: "number", value: 1, unit: actualSecret },
          }
          return capture
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    const serializedReport = JSON.stringify(result.runs[0].report)
    expect(serializedReport).not.toContain("adapter-expected-secret")
    expect(serializedReport).not.toContain("adapter-actual-secret")

    const runRoot = join(projectRoot, ".ui-eval/runs/run-test")
    for (const path of await filesUnder(runRoot)) {
      const bytes = await readFile(path)
      expect(bytes.includes(Buffer.from("adapter-expected-secret"))).toBe(false)
      expect(bytes.includes(Buffer.from("adapter-actual-secret"))).toBe(false)
    }
  })

  it("re-sanitizes correct-kind string metrics from an untrusted capture adapter", async () => {
    const projectRoot = await project()
    const scenarioPath = join(
      projectRoot,
      "ui-eval/scenarios/privacy-desktop.json",
    )
    const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
      steps: unknown[]
    }
    scenario.steps.splice(scenario.steps.length - 1, 0, {
      id: "assert-copy",
      action: "assert",
      assertion: {
        id: "copy-text",
        kind: "text",
        target: { platform: "web", by: "css", value: "main" },
        expected: "safe copy",
      },
    })
    await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`)

    const expectedSecret = "token=correct-kind-expected-secret"
    const actualSecret = `password=correct-kind-actual-secret ${"x".repeat(4_000)}`
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        capture: async (plan, context) => {
          const capture = await successfulCapture(plan, context)
          const assertion = capture.assertionResults.find(
            (candidate) => candidate.assertionId === "copy-text",
          )
          if (!assertion) throw new Error("text assertion result missing")
          Object.assign(assertion, {
            status: "failed",
            expected: { kind: "string", value: expectedSecret },
            actual: { kind: "string", value: actualSecret },
          })
          return capture
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "fail",
    })
    const runRoot = join(projectRoot, ".ui-eval/runs/run-test")
    for (const path of await filesUnder(runRoot)) {
      const bytes = await readFile(path)
      expect(bytes.includes(Buffer.from("correct-kind-expected-secret"))).toBe(
        false,
      )
      expect(bytes.includes(Buffer.from("correct-kind-actual-secret"))).toBe(
        false,
      )
    }
  })

  it("returns inconclusive for an explicitly requested corrupt reference", async () => {
    const projectRoot = await project()
    await writeFile(join(projectRoot, "reference.png"), "not a png", "utf8")
    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "inconclusive",
    })
    expect(result.runs[0].report.spec).not.toHaveProperty("scores")
  })

  it("does not copy a dimension-mismatched reference into the run", async () => {
    const projectRoot = await project()
    await writeFile(
      join(projectRoot, "reference.png"),
      screenshotPixels([20, 20, 20]),
    )
    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "inconclusive",
    })
    await expect(
      access(join(projectRoot, ".ui-eval/runs/run-test/reference.png")),
    ).rejects.toThrow()
  })

  it("rejects a project-local reference symlink without copying its target", async () => {
    const projectRoot = await project()
    const outside = await mkdtemp(join(tmpdir(), "ui-eval-reference-outside-"))
    roots.push(outside)
    const outsideReference = join(outside, "outside.png")
    await writeFile(outsideReference, screenshot(240))
    await symlink(outsideReference, join(projectRoot, "reference.png"))

    const result = await evaluateScenario(
      {
        projectRoot,
        scenario: "privacy-desktop",
        referencePath: "reference.png",
      },
      deps,
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "valid",
      rawStatus: "inconclusive",
    })
    await expect(
      access(join(projectRoot, ".ui-eval/runs/run-test/reference.png")),
    ).rejects.toThrow()
  })

  it("persists an infrastructure report when the candidate server cannot start", async () => {
    const projectRoot = await project()
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        ensureServer: async () => {
          throw Object.assign(new Error("server exited"), {
            code: "PROCESS_EXITED",
          })
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    await access(result.runs[0].reportPath)
  })

  it("turns an unresolvable captured artifact into a structured infrastructure report", async () => {
    const projectRoot = await project()
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        capture: async (plan, context) => {
          const capture = await successfulCapture(plan, context)
          const screenshotRecord = capture.checkpoints[0].evidence.find(
            (record) => record.channel === "screenshot",
          )
          if (!screenshotRecord?.artifact) {
            throw new Error("screenshot artifact missing")
          }
          screenshotRecord.artifact = {
            ...screenshotRecord.artifact,
            id: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            digest:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          }
          return capture
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    expect(result.runs[0].report.spec.coverage.total.invalid).toBeGreaterThan(0)
    await access(result.runs[0].reportPath)
  })

  it("rejects a structurally valid capture that belongs to another sealed run", async () => {
    const projectRoot = await project()
    const result = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      {
        ...deps,
        capture: async (plan, context) => {
          const capture = await successfulCapture(plan, context)
          capture.executionId = "stale-run"
          capture.scenarioId = "foreign-scenario"
          return capture
        },
      },
    )

    expect(result.runs[0]).toMatchObject({
      executionOutcome: "infra-error",
      rawStatus: "inconclusive",
    })
    expect(result.runs[0].report.spec.provenance.evaluators).toHaveLength(3)
    await access(result.runs[0].reportPath)
  })
})

describe("normalizedCandidateEvidenceDigest", () => {
  it("ignores non-decision trace artifacts but includes decision results", async () => {
    const projectRoot = await project()
    const firstResult = await evaluateScenario(
      { projectRoot, scenario: "privacy-desktop" },
      deps,
    )
    const capturePath = join(
      projectRoot,
      ".ui-eval/runs/run-test/capture.json",
    )
    const envelope = JSON.parse(await readFile(capturePath, "utf8")) as {
      spec: CaptureBundleSpec
    }
    const first = normalizedCandidateEvidenceDigest(envelope.spec, {
      includeScreenshot: false,
    })
    const trace = envelope.spec.checkpoints[0].evidence.find(
      (record) => record.channel === "trace",
    )
    if (!trace?.artifact) throw new Error("trace artifact missing")
    const changedTrace = structuredClone(envelope.spec)
    const changedTraceRecord = changedTrace.checkpoints[0].evidence.find(
      (record) => record.channel === "trace",
    )!
    changedTraceRecord.artifact = {
      ...trace.artifact,
      id: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      digest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }
    expect(
      normalizedCandidateEvidenceDigest(changedTrace, {
        includeScreenshot: false,
      }),
    ).toBe(first)

    const failedAssertion = structuredClone(envelope.spec)
    failedAssertion.assertionResults[0].status = "failed"
    expect(
      normalizedCandidateEvidenceDigest(failedAssertion, {
        includeScreenshot: false,
      }),
    ).not.toBe(first)
    expect(firstResult.runs[0].rawStatus).toBe("pass")
  })
})
