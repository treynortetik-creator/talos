// Bughunt harness: the REAL relay (startRelay, real auth module, real hooks module) on a free port, driven over real HTTP.
// The owner session is minted through the real AuthCore (a pinned device + a session row), the same rows a passkey
// sign-in would write, so every /api request below goes through the production requireSession / requireCsrf.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentConfigT, generateBridgeKey, newUlid, parseFrame } from '@talos-app/protocol'
import { authState } from '../src/auth/state.ts'
import { DEFAULT_AGENT_CONFIG } from '../src/core/default-config.ts'
import { NoopTransport } from '../src/core/push.ts'
import { runtimeOf } from '../src/core/runtime.ts'
import { loadEnv } from '../src/env.ts'
import { type RunningRelay, startRelay } from '../src/index.ts'
import { TEST_DATA_KEY } from './helpers/fake-services.ts'

export const ORIGIN = 'https://relay.example.com'

export type BugRelay = {
  relay: RunningRelay
  base: string
  cookie: string
  logs: string[]
  /** Milliseconds added to the relay's clock (rate-limit refills, replay windows, hour budgets). */
  skew: { ms: number }
  now(): number
  api(method: string, path: string, body?: unknown): Promise<Response>
  hook(path: string, init: { body?: string | Uint8Array; headers?: Record<string, string> }): Promise<Response>
  setConfig(mut: (c: AgentConfigT) => void): void
  stop(): Promise<void>
}

export async function startBugRelay(env: Record<string, string> = {}): Promise<BugRelay> {
  const dir = mkdtempSync(join(tmpdir(), 'talos-bughunt-'))
  const key = await generateBridgeKey()
  const logs: string[] = []
  const skew = { ms: 0 }
  const clock = {
    now: () => Date.now() + skew.ms,
    setTimeout: (fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return h
    },
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  const rec = (level: string) => (o: unknown, m?: string) => logs.push(`${level} ${JSON.stringify(o)} ${m ?? ''}`)
  const log = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child() {
      return log
    },
  }
  const relay = await startRelay({
    env: loadEnv({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      PUBLIC_ORIGIN: ORIGIN,
      RP_ID: 'relay.example.com',
      DATA_KEY: TEST_DATA_KEY,
      BRIDGE_PUBKEY: key.publicKeyB64,
      LOG_LEVEL: 'debug',
      ...env,
    }),
    host: '127.0.0.1',
    port: 0,
    transport: new NoopTransport(),
    clock,
    log: log as never,
  })
  const core = authState(relay.services).core
  const deviceId = 'd_abcdefghijklmnopqrst'
  core.upsertDevice({
    id: deviceId,
    name: 'phone',
    pubkeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as never,
    credentialId: null,
    binding: 'b',
    codeId: 'c',
  })
  core.setPinned(deviceId, true)
  const token = core.createSession(null, deviceId)
  const cookie = `__Host-talos_s=${token}`
  const base = `http://127.0.0.1:${relay.port}`
  const b: BugRelay = {
    relay,
    base,
    cookie,
    logs,
    skew,
    now: () => clock.now(),
    api: (method, path, body) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          cookie,
          origin: ORIGIN,
          'x-talos-csrf': '1',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    hook: (path, init) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
      }),
    setConfig(mut) {
      const hub = runtimeOf(relay.services).hub
      const cfg = structuredClone(hub.agentConfig() ?? DEFAULT_AGENT_CONFIG)
      mut(cfg)
      cfg.rev += 1
      const raw = { v: 1, type: 'config.sync', id: newUlid(), ts: new Date().toISOString(), config: cfg, rev: cfg.rev }
      const parsed = parseFrame(raw, { direction: 'bridge_to_relay' })
      if (!parsed.ok) throw new Error(`bad config.sync: ${parsed.message}`)
      hub.processBridgeDurable(parsed.frame, raw)
    },
    async stop() {
      await relay.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return b
}
