// A relay that stops for a deploy closes with 1012 ("Service Restart"): the bridge redials on a short fixed delay for 30 s,
// without growing the backoff. Every other code keeps the backoff. RelayClient is real; the socket and the clock are fake.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { FEATURES_MAX_V1, generateBridgeKey, WS_CLOSE } from '@talos-app/protocol'
import type { Clock } from '../src/clock.ts'
import type { Logger } from '../src/log.ts'
import { backoffMs, RelayClient } from '../src/relay-client.ts'

class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static made: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send() {}
  close() {}
  /** The relay ends this socket with `code` (before any ready). */
  end(code: number) {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code })
  }
}

type Fire = { fn: () => void; ms: number; at: number }
let nowMs = 0
let timers: Fire[] = []
const clock: Clock = {
  now: () => nowMs,
  setTimeout: (fn, ms) => {
    const t = { fn, ms, at: nowMs + ms }
    timers.push(t)
    return t
  },
  clearTimeout: (h) => {
    timers = timers.filter((t) => t !== h)
  },
}
let infos: Array<{ msg: string; f: Record<string, unknown> | undefined }> = []
let warns: string[] = []
const log = {
  debug() {},
  info: (msg: string, f?: Record<string, unknown>) => infos.push({ msg, f }),
  warn: (msg: string) => warns.push(msg),
  error() {},
} as unknown as Logger

const RealSocket = globalThis.WebSocket
const clients: RelayClient[] = []
beforeEach(() => {
  FakeSocket.made = []
  timers = []
  infos = []
  warns = []
  nowMs = 1_000_000
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
})
afterEach(async () => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = RealSocket
  for (const c of clients.splice(0)) await c.stop()
})

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!ok()) throw new Error(`timed out: ${what}`)
}

async function start(features: string[] = []) {
  const key = await generateBridgeKey()
  const client = new RelayClient({
    relayUrl: 'http://127.0.0.1:1',
    loadKeys: async () => [{ privateKey: key.privateKey, publicKeyB64: key.publicKeyB64, keyId: key.keyId }],
    client: { name: 'test', version: '0' },
    features: () => features,
    agentConfigRev: () => 0,
    clock,
    log,
    random: () => 0.5,
    events: { onReady() {}, onFrame() {}, onBadFrame() {}, onDisconnect() {}, onSuperseded() {} },
  })
  clients.push(client)
  client.start()
  await until(() => FakeSocket.made.length === 1, 'first dial')
  return client
}

/** The link was up (the relay had answered with ready) when it ended: the restart window opens only then. Set directly,
 * because the signed challenge-hello-ready exchange is not what these tests are about (relay-client-features.test.ts does it). */
const wasUp = (c: RelayClient) => {
  ;(c as unknown as { authed: boolean }).authed = true
}

const scheduled = () =>
  infos.filter((i) => i.msg === 'reconnect scheduled').map((i) => i.f as { in_ms: number; attempt: number })
/** Runs the pending reconnect timer (the one `reconnect scheduled` set) and waits for the next dial. */
async function redial(n: number) {
  const t = timers.at(-1)
  if (!t) throw new Error('no timer')
  timers = timers.filter((x) => x !== t)
  nowMs = Math.max(nowMs, t.at)
  t.fn()
  await until(() => FakeSocket.made.length === n, `dial ${n}`)
}

test('close 1012 schedules the redial within 750 ms and leaves attempt alone', async () => {
  wasUp(await start())
  FakeSocket.made[0]?.end(WS_CLOSE.RESTARTING)
  const s = scheduled()
  expect(s).toHaveLength(1)
  expect(s[0]?.in_ms).toBeLessThanOrEqual(750)
  expect(s[0]?.in_ms).toBeGreaterThanOrEqual(250)
  expect(s[0]?.attempt).toBe(0)
})

test('inside 30 s every retry stays short and attempt does not grow; after 30 s the normal backoff resumes', async () => {
  wasUp(await start())
  FakeSocket.made[0]?.end(WS_CLOSE.RESTARTING)
  for (let i = 1; i <= 3; i++) {
    await redial(i + 1)
    FakeSocket.made[i]?.end(1006)
  }
  expect(scheduled().map((s) => s.attempt)).toEqual([0, 0, 0, 0])
  expect(scheduled().every((s) => s.in_ms <= 750)).toBe(true)
  nowMs += 31_000
  await redial(5)
  FakeSocket.made[4]?.end(1006)
  const last = scheduled().at(-1)
  expect(last?.in_ms).toBe(backoffMs(0, () => 0.5))
  expect(last?.attempt).toBe(1)
})

test('a 1012 on a link that never came up keeps the backoff: a proxy that says it at every dial cannot loop', async () => {
  await start()
  FakeSocket.made[0]?.end(WS_CLOSE.RESTARTING)
  expect(scheduled().map((s) => [s.in_ms, s.attempt])).toEqual([[backoffMs(0, () => 0.5), 1]])
})

test('close 1006 keeps the backoff', async () => {
  await start()
  FakeSocket.made[0]?.end(1006)
  await redial(2)
  FakeSocket.made[1]?.end(1006)
  expect(scheduled().map((s) => s.in_ms)).toEqual([backoffMs(0, () => 0.5), backoffMs(1, () => 0.5)])
  expect(scheduled().map((s) => s.attempt)).toEqual([1, 2])
})

test('1012 before ready does not drop a wide hello to the safe list', async () => {
  const all = Array.from({ length: FEATURES_MAX_V1 + 10 }, (_, i) => `f${String(i).padStart(2, '0')}/1`)
  await start(all)
  // the dial must have sent a wide hello for the fallback to be in play: challenge it
  const ws = FakeSocket.made[0] as FakeSocket
  ws.onmessage?.({
    data: JSON.stringify({
      v: 1,
      type: 'challenge',
      id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      ts: new Date().toISOString(),
      nonce: 'n'.repeat(43),
      server_time: 1_700_000_000,
      relay_host: '127.0.0.1:1',
      protocol: 1,
    }),
  })
  await new Promise((r) => setTimeout(r, 50))
  ws.end(WS_CLOSE.RESTARTING)
  expect(warns.some((w) => /wide hello/.test(w))).toBe(false)
})
