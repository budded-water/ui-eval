import { afterEach, expect, it, vi } from "vitest"
import { nativePilotCommand } from "./cli"
import { summarizeNativeProgress } from "./progress"

vi.mock("./progress", () => ({ summarizeNativeProgress: vi.fn() }))
afterEach(() => vi.resetAllMocks())

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
