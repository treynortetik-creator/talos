// BUGHUNT (packaging / SIGTERM): one WebSocket that has not finished its handshake (a /bridge socket that never sends
// `hello`, or an /ws socket before its app `hello`) keeps `stop()` (the SIGTERM handler in src/index.ts) from ever
// resolving. hub.stop() clears the 10 s handshake timers and only closes sockets it already registered as authed
// (this.bridge / authed apps), wss.close() does not close existing clients (ws 8), and http.closeAllConnections() does not
// see upgraded sockets. Reproduced against the production image too: `docker stop -t 45` with one idle /bridge socket
// open took 45 s and exited 137 (SIGKILL), so a redeploy waits for the platform's kill and WAL checkpoint/close never run.
// Suggested fix: in stop(), terminate every client in `wss.clients` (or track pending sockets in the hub) before
// awaiting http.close.

import { afterEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startTestRelay, type TestRelay } from '../core/harness.ts'

vi.setConfig({ testTimeout: 20_000 })
let relay: TestRelay | null = null
let ws: WebSocket | null = null
afterEach(async () => {
  ws?.terminate()
  ws = null
  await relay?.stop().catch(() => {})
  relay = null
})

async function stopWithin(r: TestRelay, ms: number): Promise<'stopped' | 'hung'> {
  return Promise.race([
    r.relay.stop().then(() => 'stopped' as const),
    new Promise<'hung'>((res) => setTimeout(() => res('hung'), ms)),
  ])
}

it('stop() finishes promptly with a pre-auth /bridge socket open', async () => {
  relay = await startTestRelay()
  ws = new WebSocket(`${relay.wsBase}/bridge`)
  await new Promise<void>((res) => ws?.once('message', () => res())) // the challenge; we never answer it
  expect(await stopWithin(relay, 3000)).toBe('stopped')
})

it('stop() finishes promptly when an authed app socket stops answering (half-open phone)', async () => {
  relay = await startTestRelay()
  ws = new WebSocket(`${relay.wsBase}/ws`, { headers: relay.appHeaders })
  await new Promise<void>((res, rej) => {
    ws?.once('open', () => res())
    ws?.once('error', rej)
  })
  const ready = new Promise<void>((res) => ws?.once('message', () => res()))
  ws.send(
    JSON.stringify({
      v: 1,
      type: 'hello',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: new Date().toISOString(),
      role: 'app',
      device_id: 'd_aaaaaaaaaaaaaaaaaaaa',
      last_seq: 0,
      visible: true,
      client: { version: '0.0.0', standalone: false, platform: 'test' },
    }),
  )
  await ready
  // The phone drops off the network: its TCP stays open but it never answers the close handshake.
  ;(ws as unknown as { _socket: { pause(): void } })._socket.pause()
  expect(await stopWithin(relay, 3000)).toBe('stopped')
})
