import { createServer } from "node:http"
import { once } from "node:events"
import { describe, expect, it, vi } from "vitest"

import type { ArtifactRef, ResolvedFixture } from "../contracts/model"
import { MOCK_SERVER_FIXTURE_LIMITS } from "../contracts/schemas"
import {
  MockServerError,
  startMockServerFixtures,
} from "./mock-server"

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("port unavailable")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function artifact(sizeBytes: number): ArtifactRef {
  return {
    id: "mock-config",
    projectId: "test-project",
    storeId: "test-store",
    digest: `sha256:${"a".repeat(64)}`,
    mediaType: "application/json",
    sizeBytes,
    sensitivity: "internal",
  }
}

function fixture(ref: ArtifactRef): ResolvedFixture {
  return {
    id: "catalog-api",
    provider: "mock-server",
    configDigest: ref.digest,
    artifact: ref,
  }
}

function config(port: number) {
  return {
    apiVersion: "uieval.io/v1alpha1",
    kind: "MockServerFixtureConfig",
    listen: { port },
    routes: [
      {
        id: "catalog",
        method: "GET",
        path: "/api/catalog?market=cn",
        required: true,
        response: {
          status: 200,
          contentType: "application/json",
          body: '[{"id":"synthetic"}]',
        },
      },
    ],
  }
}

describe("loopback mock-server fixtures", () => {
  it("rejects a pre-aborted startup before resolving or binding", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    const resolve = vi.fn(async () => Buffer.from("{}"))

    await expect(
      startMockServerFixtures(
        [fixture(artifact(2))],
        { resolve },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "MOCK_SERVER_ABORTED" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("serves only exact declared routes and verifies required usage", async () => {
    const port = await freePort()
    const bytes = Buffer.from(JSON.stringify(config(port)))
    const session = await startMockServerFixtures(
      [fixture(artifact(bytes.byteLength))],
      { resolve: async () => bytes },
    )
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/catalog?market=cn`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ id: "synthetic" }])
      const unmatched = await fetch(`http://127.0.0.1:${port}/api/catalog`)
      expect(unmatched.status).toBe(404)
      session.verify()
    } finally {
      await session.stop()
    }
  })

  it("fails closed when a required route was never requested", async () => {
    const port = await freePort()
    const bytes = Buffer.from(JSON.stringify(config(port)))
    const session = await startMockServerFixtures(
      [fixture(artifact(bytes.byteLength))],
      { resolve: async () => bytes },
    )
    try {
      expect(() => session.verify()).toThrowError(
        expect.objectContaining({
          name: "MockServerError",
          code: "MOCK_SERVER_REQUIRED_ROUTE_MISSED",
          origin: "fixture",
        }),
      )
    } finally {
      await session.stop()
    }
  })

  it("rejects an oversized artifact before resolving its bytes", async () => {
    const resolve = vi.fn(async () => Buffer.from("{}"))
    await expect(
      startMockServerFixtures(
        [fixture(artifact(MOCK_SERVER_FIXTURE_LIMITS.maxArtifactBytes + 1))],
        { resolve },
      ),
    ).rejects.toMatchObject({
      code: "MOCK_SERVER_ARTIFACT_TOO_LARGE",
      origin: "fixture",
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("releases its loopback port during owned cleanup", async () => {
    const port = await freePort()
    const bytes = Buffer.from(JSON.stringify(config(port)))
    const session = await startMockServerFixtures(
      [fixture(artifact(bytes.byteLength))],
      { resolve: async () => bytes },
    )
    await fetch(`http://127.0.0.1:${port}/api/catalog?market=cn`)
    await session.stop()

    const replacement = createServer()
    replacement.listen(port, "127.0.0.1")
    await once(replacement, "listening")
    await new Promise<void>((resolve) => replacement.close(() => resolve()))
  })

  it("preserves fixture classification on listen collisions", async () => {
    const port = await freePort()
    const occupied = createServer()
    occupied.listen(port, "127.0.0.1")
    await once(occupied, "listening")
    const bytes = Buffer.from(JSON.stringify(config(port)))
    try {
      await expect(
        startMockServerFixtures(
          [fixture(artifact(bytes.byteLength))],
          { resolve: async () => bytes },
        ),
      ).rejects.toBeInstanceOf(MockServerError)
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })
})
