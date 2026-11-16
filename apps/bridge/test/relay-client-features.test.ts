// The hello's features follow what the relay said in its last `ready` (packages/protocol/src/features-cap.ts); before any,
// a fresh client assumes the relay takes the whole list (every relay since 5367f571). A hello the relay would have taken
// more of, or one leaning on a marker the relay does not read, is sent again once; a wide hello that ends before `ready`
// (4401, or any other close of a dial whose hello went out) drops to the 20 any relay takes, once per start. RelayClient
// is real; only the socket class is replaced.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  FEATURES_IMPLIED_FEATURE,
  FEATURES_MAX_V1,
  generateBridgeKey,
  NATIVE_ACT_FEATURE,
  newUlid,
  PROBLEMS_FEATURE,
  WIDE_FEATURES_FEATURE,
  WS_CLOSE,
} from '@talos-app/protocol'
import { realClock } from '../src/clock.ts'
import { createLogger } from '../src/log.ts'
import { RelayClient } from '../src/relay-client.ts'

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

const RealSocket = globalThis.WebSocket
const clients: RelayClient[] = []
beforeEach(() => {
  FakeSocket.made = []
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
const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(2, '0')}/1`)

async function start(features: string[]) {
  const key = await generateBridgeKey()
  const client = new RelayClient({
    relayUrl: 'http://127.0.0.1:1',
    loadKeys: async () => [{ privateKey: key.privateKey, publicKeyB64: key.publicKeyB64, keyId: key.keyId }],
    client: { name: 'test', version: '0' },
    features: () => features,
    agentConfigRev: () => 0,
    clock: realClock,
    log: createLogger(null, 'error', () => {}),
    random: () => 0,
    events: { onReady() {}, onFrame() {}, onBadFrame() {}, onDisconnect() {}, onSuperseded() {} },
  })
  clients.push(client)
  client.start()
  return client
}
/** Socket `i`: challenge it, wait for its hello. */
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

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

test('a fresh client sends the whole list first; a relay that takes 64 means one dial', async () => {
  const all = names(30)
  await start(all)
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  ready(first.ws, [WIDE_FEATURES_FEATURE])
  await settle()
  expect(FakeSocket.made).toHaveLength(1)
})

test('twenty or fewer: the retired ones go by name until the relay reads the marker, then the marker; a rollback redials', async () => {
  const all = [NATIVE_ACT_FEATURE, PROBLEMS_FEATURE, ...names(18)]
  const client = await start(all)
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  ready(first.ws, [WIDE_FEATURES_FEATURE, FEATURES_IMPLIED_FEATURE])
  await settle()
  expect(FakeSocket.made).toHaveLength(1) // by name is fine for any relay
  await client.restartNow()
  const second = await helloOn(1)
  expect(second.features).toEqual([FEATURES_IMPLIED_FEATURE, ...names(18)])
  // the relay was rolled back meanwhile: it does not read the marker, so the hello goes again with the names
  ready(second.ws, [WIDE_FEATURES_FEATURE])
  const third = await helloOn(2)
  expect(third.features).toEqual(all)
})

test('a hello refused before the ready (4401: an older relay refuses a longer list too) makes the next one the safe one', async () => {
  const all = names(30)
  const client = await start(all)
  const first = await helloOn(0)
  ready(first.ws, [WIDE_FEATURES_FEATURE])
  await client.restartNow()
  const second = await helloOn(1)
  expect(second.features).toEqual(all)
  second.ws.close(WS_CLOSE.UNAUTHORIZED) // a relay rolled back past the widening
  const third = await helloOn(2)
  expect(third.features).toEqual(all.slice(0, FEATURES_MAX_V1))
})

test('thirty features to a relay that takes only twenty: refused (4401), then twenty go, and no third dial', async () => {
  const all = names(30)
  await start(all)
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  first.ws.close(WS_CLOSE.UNAUTHORIZED)
  const second = await helloOn(1)
  expect(second.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  ready(second.ws, ['bridge-standby/1'])
  await settle()
  expect(FakeSocket.made).toHaveLength(2)
})

test('one redial per relay list: the same list disagreeing again is not redialled again', async () => {
  const all = names(30)
  await start(all)
  const first = await helloOn(0)
  first.ws.close(WS_CLOSE.UNAUTHORIZED)
  const second = await helloOn(1)
  expect(second.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  ready(second.ws, [WIDE_FEATURES_FEATURE]) // the relay says it takes more: redial
  const third = await helloOn(2)
  expect(third.features).toEqual(all)
  third.ws.close(WS_CLOSE.UNAUTHORIZED) // the redial met an instance that refused it, before any ready
  const fourth = await helloOn(3)
  expect(fourth.features).toEqual(all.slice(0, FEATURES_MAX_V1)) // after a 4401: the safe list
  ready(fourth.ws, [WIDE_FEATURES_FEATURE]) // disagrees again, with the same list that made the first redial
  await settle(100)
  expect(FakeSocket.made).toHaveLength(4) // no second redial for it
})

test('a wide first hello that ends before ready without a 4401 (a proxy 1006) drops to the safe list for the next dial', async () => {
  const all = names(30)
  await start(all)
  const first = await helloOn(0)
  expect(first.features).toEqual(all)
  first.ws.close(1006)
  const second = await helloOn(1)
  expect(second.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  ready(second.ws, ['bridge-standby/1'])
  await settle()
  expect(FakeSocket.made).toHaveLength(2)
})

test('the fallback is once per start: after a ready, a wide dial that ends early is tried again as it was', async () => {
  const all = names(30)
  await start(all)
  ;(await helloOn(0)).ws.close(1006)
  const second = await helloOn(1)
  expect(second.features).toEqual(all.slice(0, FEATURES_MAX_V1))
  ready(second.ws, [WIDE_FEATURES_FEATURE]) // the relay takes more after all: redial with the whole list
  const third = await helloOn(2)
  expect(third.features).toEqual(all)
  third.ws.close(1006) // a blip, after this start already fell back once
  const fourth = await helloOn(3)
  expect(fourth.features).toEqual(all)
})

test('a socket that ends before any hello went out is not about the list: the next hello is still the whole one', async () => {
  const all = names(30)
  await start(all)
  await until(() => FakeSocket.made.length > 0, 'socket 0')
  ;(FakeSocket.made[0] as FakeSocket).close(1006) // closed before the challenge: no hello was sent
  const second = await helloOn(1)
  expect(second.features).toEqual(all)
})
