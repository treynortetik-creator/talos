// The bridge WebSocket handshake rules (spec 5.4, 3.4), driven against the REAL hub (the only implementation):
//   challenge on connect · `hello` within 10 s or close 4408 · anything else first, or a bad hello, is 4401 ·
//   a pre-auth frame over 64 KiB is 4413.
import { type BridgeKeyPair, generateBridgeKey, signChallenge, WS_CLOSE } from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function setup() {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const hub = relay.runtime.hub
  const sent: Array<Record<string, unknown>> = []
  const closes: number[] = []
  const conn = {
    send: (t: string) => void sent.push(JSON.parse(t)),
    close: (c: number) => void closes.push(c),
    terminate: () => void closes.push(-1),
  }
  const sock = hub.attachBridge(conn, { ip: '198.51.100.5', relayHost: 'relay.example.com' })
  const settle = () => new Promise((r) => setTimeout(r, 20))
  const hello = async (key: BridgeKeyPair = relay!.bridgeKey, ch = sent[0]) => ({
    v: 1,
    type: 'hello',
    id: '01JBF3V7Q8K2M4N6P8R0S2T41M',
    ts: new Date(clock.now()).toISOString(),
    role: 'bridge',
    key_id: key.keyId,
    sig: await signChallenge(key.privateKey, ch as never),
    client: { name: 'bridge', version: '1' },
    agent_config_rev: 0,
  })
  return { clock, hub, sent, closes, sock, settle, hello }
}

describe('bridge WebSocket handshake (real hub)', () => {
  it('sends a challenge, then accepts the right hello', async () => {
    const s = await setup()
    expect(s.sent[0]).toMatchObject({ type: 'challenge', relay_host: 'relay.example.com', protocol: 1 })
    s.sock.onMessage(JSON.stringify(await s.hello()))
    // the hello goes through async signature verification: wait for its answer, not a fixed delay
    await waitFor(() => s.sent.some((f) => f.type === 'ready'), 4000, 'ready')
    expect(s.sent.some((f) => f.type === 'ready')).toBe(true)
    s.clock.advance(11_000)
    expect(s.closes).toEqual([])
  })

  it('wrong key closes 4401', async () => {
    const s = await setup()
    s.sock.onMessage(JSON.stringify(await s.hello(await generateBridgeKey())))
    await s.settle()
    expect(s.closes).toEqual([WS_CLOSE.UNAUTHORIZED])
  })

  it("a hello that replays another socket's challenge closes 4401", async () => {
    const s = await setup()
    const other: Array<Record<string, unknown>> = []
    const closes: number[] = []
    const second = s.hub.attachBridge(
      { send: (t) => void other.push(JSON.parse(t)), close: (c) => void closes.push(c), terminate: () => {} },
      { ip: '198.51.100.6', relayHost: 'relay.example.com' },
    )
    second.onMessage(JSON.stringify(await s.hello(undefined, s.sent[0])))
    await s.settle()
    expect(closes).toEqual([WS_CLOSE.UNAUTHORIZED])
  })

  it('anything but a hello first closes 4401', async () => {
    const s = await setup()
    s.sock.onMessage(
      JSON.stringify({ v: 1, type: 'ping', id: '01JBF3V7Q8K2M4N6P8R0S2T41M', ts: new Date().toISOString() }),
    )
    await s.settle()
    expect(s.closes[0]).toBe(WS_CLOSE.UNAUTHORIZED)
    const t = await setup()
    t.sock.onMessage('not json')
    await t.settle()
    expect(t.closes[0]).toBe(WS_CLOSE.UNAUTHORIZED)
  })

  it('no hello within 10 s closes 4408', async () => {
    const s = await setup()
    s.clock.advance(9_900)
    expect(s.closes).toEqual([])
    s.clock.advance(200)
    expect(s.closes).toEqual([WS_CLOSE.HANDSHAKE_TIMEOUT])
  })

  it('a 70 KiB pre-auth frame closes 4413', async () => {
    const s = await setup()
    s.sock.onMessage(JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))
    await s.settle()
    expect(s.closes).toEqual([WS_CLOSE.FRAME_TOO_LARGE])
  })
})
