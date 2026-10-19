import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Value } from "@sinclair/typebox/value"
import { hasIncompleteCleanup, IncompleteCleanupError } from "../runtime/cleanup"
import { startIntegrationSession } from "./session"
import {
  IntegrationSessionSchema, IntegrationSessionReadySchema, IntegrationSessionStoppedSchema,
  type IntegrationSessionContext,
} from "./session-protocol"

const roots: string[] = []
const context: IntegrationSessionContext = {
  executionId: "synthetic-execution", projectId: "synthetic-native",
  integrationDirectory: "/synthetic/integration", suiteDigest: `sha256:${"a".repeat(64)}`, deviceId: "synthetic-device",
}
const fixture = `
const { createInterface } = require('node:readline');
const { writeFileSync, appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[1], record = process.argv[2];
let start;
const send = (kind, extra = {}) => console.log(JSON.stringify({ apiVersion: start.apiVersion, kind, sessionId: start.sessionId, ...extra }));
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.kind === 'start') {
    start = message;
    if (record) writeFileSync(record, JSON.stringify({ start, pid: process.pid }) + '\\n');
    if (mode === 'no-ready') return;
    if (mode === 'early-exit') return process.exit(0);
    if (mode === 'malformed') return console.log('sensitive-candidate-output');
    if (mode === 'wrong-id') return send('ready', { sessionId: '00000000-0000-0000-0000-000000000000' });
    if (mode === 'extra-field') return send('ready', { secret: 'sensitive-candidate-output' });
    if (mode === 'stdout-overflow') return process.stdout.write('x'.repeat(17000));
    if (mode === 'stderr-overflow') return process.stderr.write('x'.repeat(65537));
    if (mode === 'partial-line') return process.stdout.write('sensitive-candidate-output');
    if (mode === 'descendant') {
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 100)"], { stdio: 'ignore' });
      if (record) appendFileSync(record, JSON.stringify({ descendant: descendant.pid }) + '\\n');
    }
    send('ready');
    if (mode === 'duplicate-ready') send('ready');
    if (mode === 'die-after-ready') setTimeout(() => process.exit(0), 100);
  } else if (message.kind === 'stop') {
    if (message.sessionId !== start.sessionId) return process.exit(9);
    if (record) appendFileSync(record, JSON.stringify({ stop: message }) + '\\n');
    if (mode === 'hang-stop') { process.on('SIGTERM', () => {}); return; }
    if (mode === 'no-ack') return process.exit(0);
    if (mode === 'partial-line') return process.exit(0);
    send('stopped', { status: mode === 'cleanup-failed' ? 'inconclusive' : 'pass' });
    if (mode === 'no-exit') return;
    if (mode === 'trailing-output') console.log('sensitive-candidate-output');
    if (mode === 'duplicate-stopped') send('stopped', { status: 'pass' });
    process.exit(mode === 'nonzero-exit' ? 7 : 0);
  }
});
setInterval(() => {}, 100);
`

async function setup(mode = "pass", options: { signal?: AbortSignal; startupTimeoutMs?: number; cleanupTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ui-eval-session-"))
  roots.push(root)
  const record = join(root, "messages.jsonl")
  const config = {
    command: process.execPath, args: ["-e", fixture, mode, record],
    startupTimeoutMs: options.startupTimeoutMs ?? 2000, cleanupTimeoutMs: options.cleanupTimeoutMs ?? 1000,
  }
  return { root, record, config, start: () => startIntegrationSession(config, context, { cwd: root, signal: options.signal }) }
}

async function records(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("suite session protocol", () => {
  it("keeps resources alive across the suite and binds idempotent cleanup to its exact context", async () => {
    const input = await setup()
    const handle = await input.start()
    handle.assertAlive()
    expect(handle.signal.aborted).toBe(false)
    const first = handle.stop()
    expect(handle.stop()).toBe(first)
    await first
    expect(handle.signal.aborted).toBe(false)
    expect(() => handle.assertAlive()).toThrow("not active")
    const rows = await records(input.record)
    expect(rows).toHaveLength(2)
    expect(rows[0].start).toMatchObject({ ...context, apiVersion: "uieval.io/integration-session-v1", kind: "start" })
    expect(rows[1].stop).toEqual({ apiVersion: "uieval.io/integration-session-v1", kind: "stop", sessionId: (rows[0].start as { sessionId: string }).sessionId })
    expect(() => process.kill(rows[0].pid as number, 0)).toThrow()
  })

  it("bounds readiness and still allows confirmed cleanup after startup timeout", async () => {
    const input = await setup("no-ready", { startupTimeoutMs: 150 })
    await expect(input.start()).rejects.toThrow("readiness deadline")
    expect((await records(input.record))[1]).toHaveProperty("stop")
  })

  it.each(["wrong-id", "extra-field", "malformed", "duplicate-ready", "stdout-overflow", "stderr-overflow"])("rejects %s without retaining candidate diagnostics", async (mode) => {
    const input = await setup(mode)
    let failure: unknown
    try {
      const handle = await input.start()
      await new Promise((done) => setTimeout(done, 30))
      await handle.stop()
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain("sensitive-candidate-output")
    const rows = await records(input.record)
    expect(() => process.kill(rows[0].pid as number, 0)).toThrow()
  })

  it("invalidates early exit even when the process exited zero", async () => {
    const input = await setup("early-exit")
    await expect(input.start()).rejects.toBeInstanceOf(IncompleteCleanupError)
  })

  it("signals unexpected failure during a scenario and still exposes failed cleanup", async () => {
    const input = await setup("die-after-ready")
    const handle = await input.start()
    await new Promise<void>((done) => handle.signal.addEventListener("abort", () => done(), { once: true }))
    expect(() => handle.assertAlive()).toThrow("exited before cleanup")
    await expect(handle.stop()).rejects.toBeInstanceOf(IncompleteCleanupError)
  })

  it.each(["cleanup-failed", "nonzero-exit", "no-ack", "hang-stop", "no-exit"])("requires confirmed cleanup for %s", async (mode) => {
    const input = await setup(mode, { cleanupTimeoutMs: 400 })
    const handle = await input.start()
    const start = performance.now()
    await expect(handle.stop()).rejects.toBeInstanceOf(IncompleteCleanupError)
    expect(performance.now() - start).toBeLessThan(1500)
    const rows = await records(input.record)
    expect(() => process.kill(rows[0].pid as number, 0)).toThrow()
  })

  it.each(["trailing-output", "duplicate-stopped"])("never passes %s after a valid stopped message", async (mode) => {
    const input = await setup(mode)
    const handle = await input.start()
    await expect(handle.stop()).rejects.toThrow("protocol data")
  })

  it("rejects an unterminated protocol line", async () => {
    const input = await setup("partial-line", { startupTimeoutMs: 150 })
    await expect(input.start()).rejects.toBeInstanceOf(IncompleteCleanupError)
  })

  it("gives cleanup a fresh budget after cancellation without exposing caller error text", async () => {
    const controller = new AbortController()
    const input = await setup("pass", { signal: controller.signal })
    const handle = await input.start()
    controller.abort(new Error("sensitive-caller-reason"))
    expect(handle.signal.aborted).toBe(true)
    await expect(handle.stop()).rejects.toThrow("interrupted")
    expect(String(handle.signal.reason)).not.toContain("sensitive-caller-reason")
    expect((await records(input.record))[1]).toHaveProperty("stop")
  })

  it("does not spawn a session for already-aborted input", async () => {
    const controller = new AbortController()
    controller.abort()
    const input = await setup("pass", { signal: controller.signal })
    await expect(input.start()).rejects.toThrow()
    await expect(readFile(input.record)).rejects.toThrow()
  })

  it.skipIf(process.platform === "win32")("cleans lingering descendants in its owned process group", async () => {
    const input = await setup("descendant", { cleanupTimeoutMs: 2000 })
    const handle = await input.start()
    await handle.stop()
    const rows = await records(input.record)
    const descendant = rows.find((row) => row.descendant)?.descendant as number
    expect(descendant).toBeTypeOf("number")
    expect(() => process.kill(descendant, 0)).toThrow()
  })

  it("rejects unsupported config and protocol shapes", async () => {
    const input = await setup()
    expect(Value.Check(IntegrationSessionSchema, { ...input.config, shell: true })).toBe(false)
    expect(Value.Check(IntegrationSessionSchema, { ...input.config, cleanupTimeoutMs: 60001 })).toBe(false)
    expect(Value.Check(IntegrationSessionSchema, { ...input.config, startupTimeoutMs: 300001 })).toBe(false)
    const message = { apiVersion: "uieval.io/integration-session-v1", kind: "ready", sessionId: "00000000-0000-0000-0000-000000000000" }
    expect(Value.Check(IntegrationSessionReadySchema, message)).toBe(true)
    expect(Value.Check(IntegrationSessionStoppedSchema, { ...message, kind: "stopped", status: "pass", cleanupSettled: true })).toBe(false)
    await expect(startIntegrationSession({ ...input.config, cleanupTimeoutMs: 0 }, context, { cwd: input.root })).rejects.toThrow("Invalid")
    await expect(readFile(input.record)).rejects.toThrow()
  })

  it("does not label a spawn failure as unresolved owned resources", async () => {
    const input = await setup()
    let failure: unknown
    try { await startIntegrationSession({ ...input.config, command: join(input.root, "missing-command") }, context, { cwd: input.root }) }
    catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(hasIncompleteCleanup(failure)).toBe(false)
    expect(String(failure)).not.toContain(input.root)
  })
})
