// A relay (or a proxy in front of it) that takes the connection and then says nothing: no challenge, or no `ready` after the
// hello. The heartbeat watchdog only starts at `ready`, so without a bound on the handshake one such dial waits for ever
// and the bridge never tries again. Real sockets; the bridge's own timers run on a fake clock.
import { afterEach, expect, test } from 'bun:test'
import net from 'node:net'
import { generateBridgeKey, newUlid } from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { HANDSHAKE_TIMEOUT_MS, RelayClient } from '../src/relay-client.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const frame = (type: string, fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, type, id: newUlid(), ts: new Date().toISOString(), ...fields })
const challenge = () =>
  frame('challenge', {
    nonce: 'n'.repeat(43),
    server_time: Math.floor(Date.now() / 1000),
    relay_host: '127.0.0.1',
    protocol: 1,
  })
const ready = () =>
  frame('ready', {
    session_id: 'sess_x',
    policy: { max_frame_bytes: 262144, ping_ms: 25000 },
    server_seq: 0,
    presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
  })

/** A WebSocket server whose behaviour per connection the test picks: 'mute' never speaks, 'no-ready' never answers the hello. */
function relay(mode: () => 'mute' | 'no-ready' | 'ok') {
  let opens = 0
  let hellos = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response('no', { status: 404 })
    },
    websocket: {
      open(ws) {
        opens++
        if (mode() !== 'mute') ws.send(challenge())
      },
      message(ws, msg) {
        if ((JSON.parse(String(msg)) as { type: string }).type !== 'hello') return
        hellos++
        if (mode() === 'ok') ws.send(ready())
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port as number, opens: () => opens, hellos: () => hellos }
}

async function client(port: number) {
  const clock = fakeClock()
  const key = await generateBridgeKey()
  const logs: Array<{ msg: string; fields: Record<string, unknown> }> = []
  const keep = (msg: string, fields: Record<string, unknown> = {}) => void logs.push({ msg, fields })
  const state = { readies: 0, disconnects: [] as number[] }
  const c = new RelayClient({
    relayUrl: `http://127.0.0.1:${port}`,
    loadKeys: async () => [key as never],
    client: { name: 'test', version: '0' },
    agentConfigRev: () => 1,
    clock,
    log: { ...nullLogger, warn: keep, info: keep },
    random: () => 0.5, // the backoff's middle: exactly 1 s, 2 s, 5 s ...
    events: {
      onReady: () => void state.readies++,
      onFrame: () => {},
      onBadFrame: () => {},
      onDisconnect: ({ code }) => void state.disconnects.push(code),
      onSuperseded: () => {},
    },
  })
  cleanups.push(() => void c.stop())
  const named = (msg: string) => logs.filter((l) => l.msg === msg)
  return { c, clock, state, named }
}

test('a relay that accepts the socket and never sends a challenge is given up on, logged, and dialled again on the backoff', async () => {
  const r = relay(() => 'mute')
  const { c, clock, state, named } = await client(r.port)
  c.start()
  await waitFor(() => r.opens() === 1, 3000, 'first dial')

  clock.advance(HANDSHAKE_TIMEOUT_MS - 1)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(0)
  clock.advance(1)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(1)
  expect(named('relay handshake timed out; reconnecting')[0]?.fields).toMatchObject({ after_ms: HANDSHAKE_TIMEOUT_MS })
  expect(state.disconnects).toEqual([1006])
  expect(c.lastCloseCode).toBe(1006)
  expect(named('reconnect scheduled').at(-1)?.fields).toMatchObject({ in_ms: 1000, attempt: 1 })

  clock.advance(1000)
  await waitFor(() => r.opens() === 2, 3000, 'second dial')
  // still frozen: the next wait is the next backoff step, not the first again
  clock.advance(HANDSHAKE_TIMEOUT_MS)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(2)
  expect(named('reconnect scheduled').at(-1)?.fields).toMatchObject({ in_ms: 2000, attempt: 2 })
  clock.advance(2000)
  await waitFor(() => r.opens() === 3, 3000, 'third dial')
})

test('a relay that challenges and then never answers the hello is given up on the same way, then connects once it answers', async () => {
  let mode: 'no-ready' | 'ok' = 'no-ready'
  const r = relay(() => mode)
  const { c, clock, state, named } = await client(r.port)
  c.start()
  await waitFor(() => r.hellos() === 1, 3000, 'hello sent')
  clock.advance(HANDSHAKE_TIMEOUT_MS)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(1)

  mode = 'ok' // the relay thaws
  clock.advance(1000)
  await waitFor(() => state.readies === 1, 3000, 'ready on the second dial')
  expect(c.connected).toBe(true)
  // the abandoned first socket closing late must not take the live one down
  await new Promise((res) => setTimeout(res, 100))
  expect(c.connected).toBe(true)
  expect(state.disconnects).toEqual([1006])
})

test('a port that takes the TCP connection and never answers the upgrade is given up on too', async () => {
  const socks: net.Socket[] = []
  const srv = net.createServer((s) => void socks.push(s))
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
  cleanups.push(() => {
    for (const s of socks) s.destroy()
    srv.close()
  })
  const { c, clock, named } = await client((srv.address() as net.AddressInfo).port)
  c.start()
  await waitFor(() => socks.length === 1, 3000, 'first dial')
  clock.advance(HANDSHAKE_TIMEOUT_MS)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(1)
  clock.advance(1000)
  await waitFor(() => socks.length === 2, 3000, 'second dial')
})

test('a handshake that finishes in time is left alone: no timeout fires later on the live connection', async () => {
  const r = relay(() => 'ok')
  const { c, clock, state, named } = await client(r.port)
  c.start()
  await waitFor(() => state.readies === 1, 3000, 'ready')
  clock.advance(HANDSHAKE_TIMEOUT_MS + 1)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(0)
  expect(c.connected).toBe(true)
  expect(r.opens()).toBe(1)
})

test('stop() during a frozen handshake leaves no timer behind and dials nothing more', async () => {
  const r = relay(() => 'mute')
  const { c, clock, named } = await client(r.port)
  c.start()
  await waitFor(() => r.opens() === 1, 3000, 'first dial')
  await c.stop()
  clock.advance(HANDSHAKE_TIMEOUT_MS * 3)
  expect(named('relay handshake timed out; reconnecting')).toHaveLength(0)
  expect(r.opens()).toBe(1)
  expect(clock.pending).toBe(0)
})
