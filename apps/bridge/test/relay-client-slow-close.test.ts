// Review proof (bridge #6): RelayClient over a real WebSocket, with a TCP proxy that can stall the client->server direction (a slow or
// lossy network). `restartNow()` (called when `talos-app rotate` swaps bridge.key) gives the old socket 1.5 s to close,
// then dials again. When the old socket's close completes AFTER that, its onclose handler runs against the NEW
// connection: it clears the new ping timer, marks the client unauthenticated and schedules a third connection. The relay
// (modelled here like the real hub: a newer hello supersedes the older socket with 4409) then closes the healthy second
// socket with 4409, and the client goes `superseded` for good although only one bridge exists.
// Fails on main at 7cd80ce.
import { afterEach, expect, test } from 'bun:test'
import net from 'node:net'
import { generateBridgeKey, newUlid } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { realClock } from '../src/clock.ts'
import { nullLogger } from '../src/log.ts'
import { RelayClient } from '../src/relay-client.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const frame = (type: string, fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, type, id: newUlid(), ts: new Date().toISOString(), ...fields })

function fakeRelayHub() {
  let live: { close(code: number): void } | null = null
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
        ws.send(
          frame('challenge', {
            nonce: 'n'.repeat(43),
            server_time: Math.floor(Date.now() / 1000),
            relay_host: '127.0.0.1',
            protocol: 1,
          }),
        )
      },
      message(ws, msg) {
        const f = JSON.parse(String(msg)) as { type: string }
        if (f.type !== 'hello') return
        hellos++
        // Like the relay hub: a newer authenticated bridge supersedes the older socket.
        if (live && live !== ws) live.close(4409)
        live = ws
        ws.send(
          frame('ready', {
            session_id: 'sess_x',
            policy: { max_frame_bytes: 262144, ping_ms: 25000 },
            server_seq: 0,
            presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
          }),
        )
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port as number, hellos: () => hellos }
}

/** Forwards bytes both ways; while `stalled`, client->server bytes are held back (the close frame among them). */
function stallingProxy(target: number) {
  const pipes: Array<{ stall(ms: number): void }> = []
  const srv = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1')
    let held: Buffer[] | null = null
    upstream.on('data', (d) => client.write(d))
    client.on('data', (d) => {
      if (held) held.push(d)
      else upstream.write(d)
    })
    const end = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', end)
    upstream.on('error', end)
    client.on('close', () => upstream.end())
    upstream.on('close', () => client.end())
    pipes.push({
      stall(ms) {
        held = []
        setTimeout(() => {
          for (const d of held ?? []) upstream.write(d)
          held = null
        }, ms)
      },
    })
  })
  srv.listen(0, '127.0.0.1')
  cleanups.push(() => srv.close())
  return {
    port: () => (srv.address() as net.AddressInfo).port,
    pipes,
  }
}

test('a slow close during restartNow() must not leave a single bridge superseded', async () => {
  const hub = fakeRelayHub()
  const proxy = stallingProxy(hub.port)
  await new Promise((r) => setTimeout(r, 50))
  const key = await generateBridgeKey()
  let superseded = false
  let readies = 0
  const client = new RelayClient({
    relayUrl: `http://127.0.0.1:${proxy.port()}`,
    loadKeys: async () => [{ privateKey: key.privateKey, publicKeyB64: key.publicKeyB64, keyId: key.keyId }],
    client: { name: 'bughunt', version: '0' },
    agentConfigRev: () => 0,
    clock: realClock,
    log: nullLogger,
    random: () => 0.5,
    events: {
      onReady: () => {
        readies++
      },
      onFrame: () => {},
      onBadFrame: () => {},
      onDisconnect: () => {},
      onSuperseded: () => {
        superseded = true
      },
    },
  })
  cleanups.push(() => void client.stop())
  client.start()
  const until = async (fn: () => boolean, ms: number) => {
    const t0 = Date.now()
    while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20))
  }
  await until(() => client.connected, 3000)
  expect(client.connected).toBe(true)
  // The network gets slow: the old socket's close frame takes 3 s to reach the relay.
  proxy.pipes[0]?.stall(3000)
  await client.restartNow()
  await until(() => readies >= 2, 3000)
  // Let the delayed close land and anything it set off play out.
  await new Promise((r) => setTimeout(r, 5000))
  expect({ superseded, connected: client.connected, hellos: hub.hellos() }).toEqual({
    superseded: false,
    connected: true,
    hellos: 2,
  })
}, 20_000)

// A relay that accepts the hello and then hangs up on every connection (e.g. 1009 for an oversized frame in the outbox).
// `ready` used to reset the backoff, so this looped at about one connect per second forever.
test('a relay that hangs up right after ready gets exponential backoff, not a 1 s hammer', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response('no', { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.send(
          frame('challenge', {
            nonce: 'n'.repeat(43),
            server_time: Math.floor(Date.now() / 1000),
            relay_host: '127.0.0.1',
            protocol: 1,
          }),
        )
      },
      message(ws, msg) {
        if ((JSON.parse(String(msg)) as { type: string }).type !== 'hello') return
        ws.send(
          frame('ready', {
            session_id: 'sess_x',
            policy: { max_frame_bytes: 262144, ping_ms: 25000 },
            server_seq: 0,
            presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
          }),
        )
        setTimeout(() => ws.close(1009), 20)
      },
    },
  })
  cleanups.push(() => server.stop(true))
  const key = await generateBridgeKey()
  const delays: number[] = []
  const client = new RelayClient({
    relayUrl: `http://127.0.0.1:${server.port}`,
    loadKeys: async () => [{ privateKey: key.privateKey, publicKeyB64: key.publicKeyB64, keyId: key.keyId }],
    client: { name: 'backoff', version: '0' },
    agentConfigRev: () => 0,
    clock: realClock,
    log: {
      ...nullLogger,
      info: (m, f) => {
        if (m === 'reconnect scheduled') delays.push((f as { in_ms: number }).in_ms)
      },
    },
    random: () => 0.5,
    events: {
      onReady: () => {},
      onFrame: () => {},
      onBadFrame: () => {},
      onDisconnect: () => {},
      onSuperseded: () => {},
    },
  })
  cleanups.push(() => void client.stop())
  client.start()
  await waitFor(() => delays.length >= 3, 10_000, 'three reconnect delays')
  expect(delays.slice(0, 3)).toEqual([1000, 2000, 5000])
}, 15_000)
