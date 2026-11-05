import { FakeApp, FakeBridge, type FakeBridgeOptions, type FakeClock, sleep, waitFor } from '@talos-app/testkit'
import type { TestRelay } from './harness.ts'

export function kit(relay: TestRelay) {
  const app = (opts: { deviceKey?: FakeApp['device']; visible?: boolean; lastSeq?: number } = {}) =>
    new FakeApp({ relayWs: relay.wsBase, headers: relay.appHeaders, ...opts })
  const bridge = (opts: Partial<FakeBridgeOptions> = {}) =>
    new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, ...opts })
  const connectedApp = async (opts: Parameters<typeof app>[0] = {}) => {
    const a = app(opts)
    await a.connect()
    return a
  }
  return { app, bridge, connectedApp }
}

/** Moves a fake clock forward in steps, letting socket I/O (pongs, acks) run between steps. */
export async function advance(clock: FakeClock, ms: number, step = 20_000) {
  for (let left = ms; left > 0; left -= step) {
    clock.advance(Math.min(step, left))
    await sleep(15)
  }
}

export const sha256 = async (bytes: Uint8Array) => {
  const { sha256Hex } = await import('@talos-app/protocol')
  return sha256Hex(bytes)
}

import { type BridgeKeyPair, signChallenge } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { WebSocket } from 'ws'

/** A bridge socket that authenticates and then does nothing: never acks, so the relay's resend schedule can be observed. */
export async function silentBridge(relay: { wsBase: string }, key: BridgeKeyPair) {
  const received: Array<Record<string, unknown>> = []
  const ws = new WebSocket(`${relay.wsBase}/bridge`)
  let closeCode: number | null = null
  ws.on('close', (c) => {
    closeCode = c
  })
  await new Promise<void>((resolve, reject) => {
    ws.on('message', async (d) => {
      const f = JSON.parse(d.toString()) as Record<string, unknown>
      received.push(f)
      if (f.type === 'ping') ws.send(JSON.stringify(mkFrame('pong', { nonce: f.nonce })))
      if (f.type === 'challenge') {
        const sig = await signChallenge(key.privateKey, f as never)
        ws.send(
          JSON.stringify(
            mkFrame('hello', {
              role: 'bridge',
              key_id: key.keyId,
              sig,
              client: { name: 'silent', version: '0' },
              agent_config_rev: 0,
            }),
          ),
        )
      }
      if (f.type === 'ready') resolve()
    })
    ws.on('error', reject)
    ws.on('close', (c) => reject(new Error(`closed ${c}`)))
  })
  const count = (type: string, id?: string) =>
    received.filter((f) => f.type === type && (id === undefined || f.id === id)).length
  /**
   * A barrier: ping the relay and wait for its pong. The relay handles bridge frames one at a time, in order, and the
   * socket is ordered, so once the pong is here every frame we sent earlier was handled and every frame the relay sent
   * before it (a resend fired by a fake-clock step, say) has arrived. Proves "nothing more came" without a sleep.
   */
  const sync = async () => {
    const nonce = `sync_${Math.random().toString(36).slice(2, 12)}`
    ws.send(JSON.stringify(mkFrame('ping', { nonce })))
    await waitFor(() => received.some((f) => f.type === 'pong' && f.nonce === nonce), 10_000, 'pong')
  }
  return {
    ws,
    received,
    get closeCode() {
      return closeCode
    },
    count,
    /**
     * Waits (real time, generous) until `count(type, id)` reaches `n`, then syncs so the exact count can be asserted.
     * A fixed sleep here flakes under load: the frame is still in flight through the app socket, the relay and back.
     */
    async reaches(type: string, id: string | undefined, n: number) {
      await waitFor(() => count(type, id) >= n, 10_000, `${n} x ${type}`)
      await sync()
    },
    sync,
    ack: (ref: string, stage?: 'delivered' | 'consumed') =>
      ws.send(JSON.stringify(mkFrame('ack', { ref, ...(stage ? { stage } : {}) }))),
    send: (frame: Record<string, unknown>) => ws.send(JSON.stringify({ ...mkFrame(String(frame.type)), ...frame })),
    close: () =>
      new Promise<void>((r) => {
        ws.once('close', () => r())
        ws.close()
      }),
  }
}

export const newConn = () => `cn_${'a'.repeat(22)}`
export const sub = (n = 1) => ({
  endpoint: `https://push.example.com/send/${n}`,
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
})

import { signBridgeHttp } from '@talos-app/protocol'

/** A request signed the way the bridge signs them (Ed25519 over method, path+query, ts, nonce, body hash). */
export async function bridgeFetch(
  relay: { httpBase: string; bridgeKey: BridgeKeyPair },
  method: string,
  path: string,
  body?: Uint8Array | string,
  headers: Record<string, string> = {},
) {
  const authorization = await signBridgeHttp({
    privateKey: relay.bridgeKey.privateKey,
    keyId: relay.bridgeKey.keyId,
    method,
    pathWithQuery: path,
    body: body ?? '',
  })
  return fetch(`${relay.httpBase}${path}`, {
    method,
    headers: { authorization, ...headers },
    ...(body !== undefined ? { body: body as BodyInit } : {}),
  })
}

export const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
  0, 0, 0,
])
