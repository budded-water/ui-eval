import { createServer, type Server } from "node:http"

import type {
  ArtifactRef,
  MockServerFixtureConfig,
  ResolvedFixture,
} from "../contracts/model"
import { MOCK_SERVER_FIXTURE_LIMITS } from "../contracts/schemas"
import { validateMockServerFixtureConfig } from "../contracts/validation"

export interface MockServerArtifactResolver {
  resolve(ref: ArtifactRef): Promise<Uint8Array>
}

export interface MockServerSession {
  verify(): void
  stop(): Promise<void>
}

export interface StartMockServerOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export type MockServerErrorCode =
  | "MOCK_SERVER_ABORTED"
  | "MOCK_SERVER_ARTIFACT_MISSING"
  | "MOCK_SERVER_ARTIFACT_TOO_LARGE"
  | "MOCK_SERVER_ARTIFACT_UNAVAILABLE"
  | "MOCK_SERVER_CONFIG_INVALID"
  | "MOCK_SERVER_LISTEN_FAILED"
  | "MOCK_SERVER_REQUIRED_ROUTE_MISSED"
  | "MOCK_SERVER_STOP_FAILED"
  | "UNSUPPORTED_FIXTURE_PROVIDER"

export class MockServerError extends Error {
  readonly origin = "fixture" as const
  readonly retryable = false

  constructor(
    readonly code: MockServerErrorCode,
    message: string,
    readonly fixtureId: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "MockServerError"
  }
}

interface OwnedMockServer {
  fixtureId: string
  config: MockServerFixtureConfig
  hits: Map<string, number>
  server: Server
  stop(): Promise<void>
}

function emitProgress(
  callback: StartMockServerOptions["onProgress"],
  message: string,
): void {
  try {
    callback?.(message)
  } catch {
    // Diagnostic callbacks cannot take ownership of a live fixture server.
  }
}

function closeServer(
  server: Server,
  fixtureId: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(
          new MockServerError(
            "MOCK_SERVER_STOP_FAILED",
            `Mock-server fixture "${fixtureId}" did not stop cleanly.`,
            fixtureId,
            { cause: error },
          ),
        )
      } else resolve()
    })
    server.closeAllConnections()
  })
}

function throwIfAborted(signal: AbortSignal | undefined, fixtureId: string): void {
  if (!signal?.aborted) return
  throw new MockServerError(
    "MOCK_SERVER_ABORTED",
    `Mock-server fixture "${fixtureId}" startup was interrupted.`,
    fixtureId,
    { cause: signal.reason },
  )
}

async function loadConfig(
  fixture: ResolvedFixture,
  resolver: MockServerArtifactResolver,
): Promise<MockServerFixtureConfig> {
  if (!fixture.artifact) {
    throw new MockServerError(
      "MOCK_SERVER_ARTIFACT_MISSING",
      `Mock-server fixture "${fixture.id}" has no sealed config artifact.`,
      fixture.id,
    )
  }
  if (fixture.artifact.sizeBytes > MOCK_SERVER_FIXTURE_LIMITS.maxArtifactBytes) {
    throw new MockServerError(
      "MOCK_SERVER_ARTIFACT_TOO_LARGE",
      `Mock-server fixture "${fixture.id}" exceeds the bounded config size.`,
      fixture.id,
    )
  }

  let bytes: Uint8Array
  try {
    bytes = await resolver.resolve(fixture.artifact)
  } catch (error) {
    throw new MockServerError(
      "MOCK_SERVER_ARTIFACT_UNAVAILABLE",
      `Mock-server fixture "${fixture.id}" config artifact is unavailable.`,
      fixture.id,
      { cause: error },
    )
  }
  if (bytes.byteLength > MOCK_SERVER_FIXTURE_LIMITS.maxArtifactBytes) {
    throw new MockServerError(
      "MOCK_SERVER_ARTIFACT_TOO_LARGE",
      `Mock-server fixture "${fixture.id}" resolved beyond the bounded config size.`,
      fixture.id,
    )
  }

  try {
    return validateMockServerFixtureConfig(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    )
  } catch (error) {
    throw new MockServerError(
      "MOCK_SERVER_CONFIG_INVALID",
      `Mock-server fixture "${fixture.id}" config artifact is invalid.`,
      fixture.id,
      { cause: error },
    )
  }
}

async function startOne(
  fixture: ResolvedFixture,
  resolver: MockServerArtifactResolver,
  options: StartMockServerOptions,
): Promise<OwnedMockServer> {
  throwIfAborted(options.signal, fixture.id)
  const config = await loadConfig(fixture, resolver)
  throwIfAborted(options.signal, fixture.id)
  const hits = new Map(config.routes.map((route) => [route.id, 0]))
  const server = createServer((request, response) => {
    const method = request.method ?? ""
    const path = request.url ?? ""
    const route = config.routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    )
    if (!route) {
      response.writeHead(method === "GET" || method === "HEAD" ? 404 : 405, {
        "cache-control": "no-store",
        connection: "close",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      })
      response.end(method === "HEAD" ? undefined : "fixture route not found")
      return
    }

    hits.set(route.id, (hits.get(route.id) ?? 0) + 1)
    const body = Buffer.from(route.response.body, "utf8")
    response.writeHead(route.response.status, {
      "cache-control": "no-store",
      "content-length": String(body.byteLength),
      "content-type": `${route.response.contentType}; charset=utf-8`,
      "x-content-type-options": "nosniff",
    })
    response.end(method === "HEAD" ? undefined : body)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(
        new MockServerError(
          "MOCK_SERVER_LISTEN_FAILED",
          `Mock-server fixture "${fixture.id}" could not bind its loopback port.`,
          fixture.id,
          { cause: error },
        ),
      )
    }
    server.once("error", onError)
    server.listen(config.listen.port, "127.0.0.1", () => {
      server.off("error", onError)
      resolve()
    })
  })

  if (options.signal?.aborted) {
    await closeServer(server, fixture.id)
    throwIfAborted(options.signal, fixture.id)
  }

  emitProgress(
    options.onProgress,
    `Started mock-server fixture ${fixture.id} on loopback port ${config.listen.port}.`,
  )
  let stopPromise: Promise<void> | undefined
  return {
    fixtureId: fixture.id,
    config,
    hits,
    server,
    stop() {
      if (stopPromise) return stopPromise
      stopPromise = closeServer(server, fixture.id)
      return stopPromise
    },
  }
}

export async function startMockServerFixtures(
  fixtures: readonly ResolvedFixture[],
  resolver: MockServerArtifactResolver,
  options: StartMockServerOptions = {},
): Promise<MockServerSession> {
  const servers: OwnedMockServer[] = []
  try {
    for (const fixture of fixtures) {
      if (fixture.provider !== "mock-server") {
        throw new MockServerError(
          "UNSUPPORTED_FIXTURE_PROVIDER",
          `Fixture provider "${fixture.provider}" is not executable.`,
          fixture.id,
        )
      }
      servers.push(await startOne(fixture, resolver, options))
    }
  } catch (error) {
    await Promise.allSettled(servers.reverse().map((server) => server.stop()))
    throw error
  }

  let stopPromise: Promise<void> | undefined
  return {
    verify() {
      for (const server of servers) {
        const missed = server.config.routes.filter(
          (route) => route.required && (server.hits.get(route.id) ?? 0) === 0,
        )
        if (missed.length > 0) {
          throw new MockServerError(
            "MOCK_SERVER_REQUIRED_ROUTE_MISSED",
            `Mock-server fixture "${server.fixtureId}" did not receive required route ids: ${missed.map((route) => route.id).join(", ")}.`,
            server.fixtureId,
          )
        }
      }
    },
    stop() {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        const results = await Promise.allSettled(
          [...servers].reverse().map((server) => server.stop()),
        )
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        if (failure) throw failure.reason
      })()
      return stopPromise
    },
  }
}
