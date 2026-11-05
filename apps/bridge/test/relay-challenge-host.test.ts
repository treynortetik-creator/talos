// The hello signature covers the relay host named in the challenge. A server the bridge dialled that names ANOTHER host
// could pass the bridge's signature on to that host's real relay and speak as the bridge there. So the bridge signs only
// when the challenge names the host it dialled (loopback dev URLs excepted). RelayClient is real; only the socket class is
// replaced, because a non-loopback URL cannot be dialled from a test.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { generateBridgeKey, newUlid, verifyChallenge } from '@talos-app/protocol'
import { realClock } from '../src/clock.ts'
import { createLogger } from '../src/log.ts'
import { RelayClient } from '../src/relay-client.ts'

class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static made: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  sent: Array<Record<string, unknown>> = []
  closedWith: number | undefined
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
    this.closedWith = code
    this.readyState = FakeSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code }))
  }
  deliver(type: string, fields: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, type, id: newUlid(), ts: new Date().toISOString(), ...fields }) })
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

const challenge = (relay_host: string) => ({
  nonce: 'n'.repeat(43),
  server_time: 1_700_000_000,
  relay_host,
  protocol: 1,
})

async function dial(relayUrl: string) {
  const key = await generateBridgeKey()
  const security: string[] = []
  const log = createLogger(null, 'error', () => {})
  log.security = (m) => void security.push(m)
  const client = new RelayClient({
    relayUrl,
    loadKeys: async () => [{ privateKey: key.privateKey, publicKeyB64: key.publicKeyB64, keyId: key.keyId }],
    client: { name: 'test', version: '0' },
    agentConfigRev: () => 0,
    clock: realClock,
    log,
    events: { onReady() {}, onFrame() {}, onBadFrame() {}, onDisconnect() {}, onSuperseded() {} },
  })
  clients.push(client)
  client.start()
  for (let i = 0; i < 200 && FakeSocket.made.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
  const ws = FakeSocket.made[0] as FakeSocket
  expect(ws).toBeDefined()
  return { ws, key, security }
}

test('a challenge naming the host that was dialled is signed, and the signature binds that host', async () => {
  const { ws, key } = await dial('https://relay.example.com')
  expect(ws.url).toBe('wss://relay.example.com/bridge')
  ws.deliver('challenge', challenge('relay.example.com'))
  for (let i = 0; i < 200 && ws.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
  const hello = ws.sent[0] as { type: string; sig: string }
  expect(hello.type).toBe('hello')
  expect(await verifyChallenge(key.publicKeyB64, challenge('relay.example.com'), hello.sig)).toBe(true)
  expect(await verifyChallenge(key.publicKeyB64, challenge('evil.example.net'), hello.sig)).toBe(false)
})

test('a challenge naming another host gets no signature: no hello, the socket is closed, a security line is logged', async () => {
  const { ws, security } = await dial('https://relay.example.com')
  ws.deliver('challenge', challenge('evil.example.net'))
  for (let i = 0; i < 200 && ws.closedWith === undefined; i++) await new Promise((r) => setTimeout(r, 5))
  expect(ws.sent).toEqual([])
  expect(ws.closedWith).toBe(1008)
  expect(security).toEqual(['challenge names a different relay host; refusing to sign'])
})
