import { describe, expect, it } from "vitest"
import { validateProjectConfig } from "./config"
import { resolveExecutionProfile } from "./execution-profile"

const project = {
  apiVersion: "uieval.io/v1alpha1", kind: "ProjectConfig", projectId: "profiles",
  devServer: { command: "node", args: ["server.mjs"], url: "http://localhost:3000", reuseExisting: false, startupTimeoutMs: 1000 },
  baseUrls: { local: "http://localhost:3000", preview: "https://preview.example.invalid", api: "https://api.example.invalid" },
  deviceProfiles: { desktop: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 } },
  defaults: { locale: "en", theme: "light", timezone: "UTC" }, supportedCapabilities: ["screenshot"],
  executionProfiles: {
    local: { mode: "local", baseUrlRef: "local" },
    remote: { mode: "remote", baseUrlRef: "preview", frontend: { identityPath: "/version" },
      backend: { baseUrlRef: "api", identityPath: "/version", expected: { revision: "backend-v2", apiContractVersion: "v2" } },
      readinessTimeoutMs: 1000 },
  },
}

describe("execution profiles", () => {
  it("accepts local and remote profiles without changing legacy configuration", () => {
    expect(validateProjectConfig(project)).toBe(true)
    expect(resolveExecutionProfile(project as never)).toBeUndefined()
    expect(resolveExecutionProfile(project as never, "remote")?.baseUrl).toBe(new URL(project.baseUrls.preview).toString())
  })
  it("rejects undeclared profiles and URL references", () => {
    expect(() => resolveExecutionProfile(project as never, "missing")).toThrow("Unknown execution profile")
    const changed = structuredClone(project)
    changed.executionProfiles.remote.baseUrlRef = "missing"
    expect(() => resolveExecutionProfile(changed as never, "remote")).toThrow("Unknown base URL")
  })
  it("rejects a local profile whose origin does not match its server", () => {
    const changed = structuredClone(project)
    changed.executionProfiles.local.baseUrlRef = "preview"
    expect(() => resolveExecutionProfile(changed as never, "local")).toThrow("local server origin")
  })
  it.each(["//foreign.example.invalid/version", "/\\foreign.example.invalid/version", "/version?secret=value"])("rejects unsafe identity path %s", (path) => {
    const changed = structuredClone(project)
    changed.executionProfiles.remote.frontend.identityPath = path
    expect(() => resolveExecutionProfile(changed as never, "remote")).toThrow("identity path")
  })
  it.each(["https://user:password@preview.example.invalid", "https://preview.example.invalid?token=secret", "https://preview.example.invalid#fragment", "file:///tmp/identity"])("rejects credentials, query, fragment and non-HTTP target %s", (url) => {
    const changed = structuredClone(project)
    changed.baseUrls.preview = url
    expect(() => resolveExecutionProfile(changed as never, "remote")).toThrow("credential-free HTTP(S)")
  })
  it.each([0, 60001])("rejects an out-of-range readiness timeout %s", (timeout) => {
    const changed = structuredClone(project)
    changed.executionProfiles.remote.readinessTimeoutMs = timeout
    expect(validateProjectConfig(changed)).toBe(false)
  })
})
