// A bridge start dials once. A second dial drops the socket the apps see: presence flaps and what an app asked on the first
// socket goes unanswered (e2e schedules "wake", "window passed", "hold", apps E15 and bridge-oversize-card went red on it
// once the bridge listed a 21st feature). A fresh bridge sends the whole list, which every relay since 5367f571 takes; the
// file keeps what a relay said otherwise (a 4401: the safe list) for the next start. The RelayClient, the bridge's real
// feature list and the memo file are real; only the socket class is replaced.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FEATURES_IMPLIED_FEATURE,
  FEATURES_MAX_V1,
  generateBridgeKey,
  newUlid,
  WIDE_FEATURES_FEATURE,
  WS_CLOSE,
} from '@talos-app/protocol'
import { realClock } from '../src/clock.ts'
import { bridgeFeatures } from '../src/handshake.ts'
import { createLogger } from '../src/log.ts'
import { RelayClient } from '../src/relay-client.ts'
import { relayFeaturesMemo } from '../src/relay-features-memo.ts'

class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static made: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }
  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code }))
  }
  deliver(type: string, fields: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, type, id: newUlid(), ts: new Date().toISOString(), ...fields }) })
  }
  hello() {
    return this.sent.find((f) => f.type === 'hello') as { client: { features?: string[] } } | undefined
  }
}

const RELAY = 'http://127.0.0.1:1'
const RealSocket = globalThis.WebSocket
const clients: RelayClient[] = []
let dir = ''
let file = ''
let logLines: string[] = []
beforeEach(() => {
  FakeSocket.made = []
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  dir = mkdtempSync(join(tmpdir(), 'relay-features-'))
  file = join(dir, 'relay-features.json')
  logLines = []
})
afterEach(async () => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = RealSocket
  for (const c of clients.splice(0)) await c.stop()
  rmSync(dir, { recursive: true, force: true })
})

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!ok()) throw new Error(`timed out: ${what}`)
}
const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(2, '0')}/1`)
const log = () => createLogger(null, 'info', (line) => logLines.push(line))

/** One bridge start: a real RelayClient with the real memo on `path`, for `relayUrl`. */
async function start(features: string[], path = file, relayUrl = RELAY) {
  const key = await generateBridgeKey()
  const l = log()
  const client = new RelayClient({
    relayUrl,
    loadKeys: async () => [{ privateKey: key.privateKey, publicKeyB64: key.publicKeyB64, keyId: key.keyId }],
    client: { name: 'test', version: '0' },
    features: () => features,
    agentConfigRev: () => 0,
    clock: realClock,
    log: l,
    random: () => 0,
    featuresMemo: relayFeaturesMemo(path, relayUrl, l),
    events: { onReady() {}, onFrame() {}, onBadFrame() {}, onDisconnect() {}, onSuperseded() {} },
  })
  clients.push(client)
  client.start()
  return client
}
async function stopAll() {
  for (const c of clients.splice(0)) await c.stop()
}
async function helloOn(i: number) {
  await until(() => FakeSocket.made.length > i, `socket ${i}`)
  const ws = FakeSocket.made[i] as FakeSocket
  ws.deliver('challenge', { nonce: 'n'.repeat(43), server_time: 1_700_000_000, relay_host: '127.0.0.1:1', protocol: 1 })
  await until(() => ws.hello() !== undefined, `hello on socket ${i}`)
  return { ws, features: ws.hello()?.client.features ?? [] }
}
const ready = (ws: FakeSocket, features: string[]) =>
  ws.deliver('ready', {
    session_id: 'sess_test',
    policy: { max_frame_bytes: 65536, ping_ms: 60_000 },
    server_seq: 0,
    presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
    features,
  })
const settle = () => new Promise((r) => setTimeout(r, 60))
const on = { available: true }
/** The bridge's own list with every optional feature on: what a live bridge sends. */
const realList = () =>
  bridgeFeatures({
    search: on,
    memory: on,
    health: on,
    speak: on,
    folders: on,
    files: on,
    agentsMd: on,
    filesPut: on,
    filesSent: on,
    problems: {},
    config: { subthreadsSupported: () => true },
  })
// what the deployed relay's ready lists, in the part the bridge reads
const RELAY_READY = [WIDE_FEATURES_FEATURE, FEATURES_IMPLIED_FEATURE, 'bridge-standby/1']

test('a fresh bridge (no relay-features.json) with its real list dials once: no second socket, so no flap', async () => {
  const all = realList()
  expect(all.length).toBeGreaterThan(FEATURES_MAX_V1) // the case that went red: more than any relay took before
  expect(existsSync(file)).toBe(false)
  await start(all)
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  ready(first.ws, RELAY_READY)
  await settle()
  expect(FakeSocket.made).toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ relay: RELAY, features: RELAY_READY })
  // and a restart: one dial again, now with the retired ones folded into the marker the relay reads
  await stopAll()
  FakeSocket.made = []
  await start(all)
  const again = await helloOn(0)
  expect(again.features[0]).toBe(FEATURES_IMPLIED_FEATURE)
  ready(again.ws, RELAY_READY)
  await settle()
  expect(FakeSocket.made).toHaveLength(1)
})

test('against a relay that takes only 20: refused once (4401), then 20; the restart sends 20 first and dials once', async () => {
  const all = names(21)
  await start(all)
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  first.ws.close(WS_CLOSE.UNAUTHORIZED)
  const second = await helloOn(1)
  expect(second.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  ready(second.ws, ['bridge-standby/1'])
  await settle()
  expect(FakeSocket.made).toHaveLength(2)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ relay: RELAY, features: ['bridge-standby/1'] })

  await stopAll()
  FakeSocket.made = []
  await start(all)
  const again = await helloOn(0)
  expect(again.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  ready(again.ws, ['bridge-standby/1'])
  await settle()
  expect(FakeSocket.made).toHaveLength(1)
})

test('a 4401 is kept as the safe list even before any ready: a restart in between starts with 20', async () => {
  const all = names(21)
  await start(all)
  ;(await helloOn(0)).ws.close(WS_CLOSE.UNAUTHORIZED)
  await helloOn(1) // the safe redial, never answered
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ relay: RELAY, features: [] })
  await stopAll()
  FakeSocket.made = []
  await start(all)
  expect((await helloOn(0)).features).toEqual(all.slice(0, FEATURES_MAX_V1))
})

test('a list kept for another relay URL, or a damaged file, is no list: the first hello is the whole one', async () => {
  const all = names(21)
  writeFileSync(file, JSON.stringify({ relay: 'https://other.example', features: [] }))
  await start(all)
  expect((await helloOn(0)).features).toEqual(all)
  await stopAll()
  for (const bad of [
    '{ not json',
    JSON.stringify({ relay: RELAY, features: 'bridge-standby/1' }),
    JSON.stringify({ relay: RELAY, features: [42] }),
    JSON.stringify({ relay: RELAY, features: names(65) }),
  ]) {
    writeFileSync(file, bad)
    FakeSocket.made = []
    await start(all)
    expect((await helloOn(0)).features).toEqual(all)
    await stopAll()
  }
})

test('a memo that cannot be written says so in the log and costs nothing else', async () => {
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const all = names(21)
  await start(all, join(blocker, 'relay-features.json'))
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  ready(first.ws, RELAY_READY)
  await settle()
  expect(FakeSocket.made).toHaveLength(1)
  expect(logLines.some((l) => l.includes('relay features not remembered'))).toBe(true)
})
