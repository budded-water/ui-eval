import { Type, type Static } from "@sinclair/typebox"
import { DeploymentExpectationSchema } from "../contracts/schemas"
import type { ProjectConfig } from "./config"

const strict = { additionalProperties: false }
const id = Type.String({ minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })
const path = Type.String({ minLength: 1, maxLength: 512, pattern: "^/(?!/)[^\\\\?#]*$" })
export const ExecutionProfileSchema = Type.Union([
  Type.Object({ mode: Type.Literal("local"), baseUrlRef: id }, strict),
  Type.Object({ mode: Type.Literal("remote"), baseUrlRef: id,
    frontend: Type.Object({ identityPath: path,
      expected: Type.Optional(Type.Omit(DeploymentExpectationSchema, ["revision"])) }, strict),
    backend: Type.Optional(Type.Object({ baseUrlRef: id, identityPath: path, expected: DeploymentExpectationSchema }, strict)),
    readinessTimeoutMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
  }, strict),
])
export type ExecutionProfile = Static<typeof ExecutionProfileSchema>
export interface ResolvedExecutionProfile {
  id: string
  config: ExecutionProfile
  baseUrl: string
  frontendIdentityUrl?: string
  backendIdentityUrl?: string
}

export function resolveExecutionProfile(project: Readonly<ProjectConfig>, name?: string): ResolvedExecutionProfile | undefined {
  if (!name) return undefined
  const config = project.executionProfiles?.[name]
  if (!config) throw new Error(`Unknown execution profile: ${name}`)
  const url = (reference: string) => {
    const value = project.baseUrls[reference]
    if (!value) throw new Error(`Unknown base URL for execution profile: ${reference}`)
    const parsed = new URL(value)
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Execution profile requires a credential-free HTTP(S) base URL")
    }
    return parsed.toString()
  }
  const baseUrl = url(config.baseUrlRef)
  if (config.mode === "local") {
    if (new URL(baseUrl).origin !== new URL(project.devServer.url).origin) throw new Error("Execution profile must use the local server origin")
    return { id: name, config, baseUrl }
  }
  const identityUrl = (base: string, reference: string) => {
    if (!/^\/(?!\/)[^\\?#]*$/.test(reference)) throw new Error("Invalid deployment identity path")
    const resolved = new URL(reference, base)
    if (resolved.origin !== new URL(base).origin) throw new Error("Deployment identity path escaped its origin")
    return resolved.toString()
  }
  return { id: name, config, baseUrl,
    frontendIdentityUrl: identityUrl(baseUrl, config.frontend.identityPath),
    ...(config.backend ? { backendIdentityUrl: identityUrl(url(config.backend.baseUrlRef), config.backend.identityPath) } : {}),
  }
}
