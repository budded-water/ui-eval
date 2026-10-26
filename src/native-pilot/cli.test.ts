import { afterEach, expect, it, vi } from "vitest"
import { nativePilotCommand } from "./cli"
import { summarizeNativeProgress } from "./progress"
import { recordNativeReview } from "./review"

vi.mock("./progress", () => ({ summarizeNativeProgress: vi.fn() }))
vi.mock("./review", () => ({ recordNativeReview: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it.each([["pass", 0], ["fail", 1], ["inconclusive", 2]] as const)("returns %s human review with exit %s", async (decision, code) => {
  const output = { result: { decision }, reportPath: "/local/review.json", htmlPath: "/local/review.html" } as Awaited<ReturnType<typeof recordNativeReview>>
  vi.mocked(recordNativeReview).mockResolvedValue(output)
  for (const format of ["text", "json"]) {
    const stdout = vi.fn()
    expect(await nativePilotCommand(["review", "--report", "report.json", "--review", "layout", "--decision", decision, "--reviewer", "owner", "--note", "Synthetic observation", "--format", format], { cwd: "/candidate", stdout })).toBe(code)
    expect(recordNativeReview).toHaveBeenCalledWith(expect.objectContaining({ decision }))
    if (format === "json") expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(output)
    else expect(stdout.mock.calls[0][0]).toContain(`HUMAN ${decision.toUpperCase()}`)
  }
})

it.each([["complete", 0], ["blocked", 1], ["pending", 2]] as const)("projects %s progress through CLI exit %s without requiring a device command", async (status, code) => {
  vi.mocked(summarizeNativeProgress).mockResolvedValue({ result: { status }, reportPath: "/local/summary.json", htmlPath: "/local/summary.html" } as Awaited<ReturnType<typeof summarizeNativeProgress>>)
  const stdout = vi.fn()
  expect(await nativePilotCommand(["progress", "--scope", "ui-eval/progress.json", "--format", "json"], { cwd: "/candidate", stdout })).toBe(code)
  expect(summarizeNativeProgress).toHaveBeenCalledWith({ projectRoot: "/candidate", scope: "ui-eval/progress.json", signal: undefined })
  expect(JSON.parse(stdout.mock.calls[0][0]).result.status).toBe(status)
})

it.each([["progress"], ["progress", "--scope", "scope.json", "--device", "unrelated"], ["evaluate", "home", "--scope", "scope.json", "--device", "unrelated"]])("rejects incomplete/misrouted progress options %j", async (...args) => {
  await expect(nativePilotCommand(args, { cwd: "/candidate", stdout: vi.fn() })).rejects.toThrow()
  expect(summarizeNativeProgress).not.toHaveBeenCalled()
})

it("rejects an unsupported human decision before recording an observation", async () => {
  await expect(nativePilotCommand(["review", "--report", "report.json", "--review", "layout", "--decision", "skip", "--reviewer", "owner", "--note", "Synthetic"], { cwd: "/candidate", stdout: vi.fn() })).rejects.toThrow("pass|fail|inconclusive")
  expect(recordNativeReview).not.toHaveBeenCalled()
})
