// Test harness: a real Bridge (live mode) wired to the testkit's FakeRelay, with notifications captured in memory.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JwkP256T } from '@talos-app/protocol'
import {
  FakeApp,
  FakeRelay,
  type FakeRelayOptions,
  loadExampleConfig,
  mkFrame,
  sleep,
  waitFor,
} from '@talos-app/testkit'
import { Bridge, type BridgeOptions } from '../src/bridge.ts'
import type { Clock } from '../src/clock.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import type { Notification } from '../src/notify.ts'

export const fixture = (name: string) => join(import.meta.dir, 'fixtures', name)

export function tempHome(prefix = 'talos-bridge-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export type Harness = {
  relay: FakeRelay
  bridge: Bridge
  home: string
  app: FakeApp
  notes: Notification[]
  pinned: Record<string, JwkP256T>
  stop(): Promise<void>
  /** Waits until the inbound queue is idle and at least `n` notifications arrived. */
  waitNotes(n: number, ms?: number): Promise<void>
}

export async function startHarness(
  opts: {
    relay?: FakeRelayOptions
    env?: Record<string, string>
    clock?: Clock
    home?: string
    pinApp?: boolean
    bridge?: Partial<BridgeOptions>
    config?: (c: ReturnType<typeof loadExampleConfig>) => ReturnType<typeof loadExampleConfig>
    startBridge?: boolean
  } = {},
): Promise<Harness> {
  // the relay judges a card's expiry on the same clock as the Mac, or a card made on an injected clock would already be old
  const { clock } = opts
  const relay = await new FakeRelay({ ...(clock ? { now: () => clock.now() } : {}), ...opts.relay }).start()
  const home = opts.home ?? tempHome()
  mkdirSync(home, { recursive: true })
  const cfg = (opts.config ?? ((c) => c))(loadExampleConfig('default'))
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
  writeFileSync(
    join(home, 'bridge.key'),
    JSON.stringify({
      v: 1,
      pkcs8: relay.bridgeKey.privateKeyPkcs8B64,
      public: relay.bridgeKey.publicKeyB64,
      key_id: relay.bridgeKey.keyId,
    }),
    { mode: 0o600 },
  )
  const app = new FakeApp({ relayWs: relay.wsBase })
  await app.connect()
  const pinned: Record<string, JwkP256T> = opts.pinApp === false ? {} : { [app.device.deviceId]: app.device.publicJwk }
  const now = new Date().toISOString()
  writeFileSync(
    join(home, 'devices.json'),
    JSON.stringify({
      version: 1,
      devices: Object.entries(pinned).map(([id, jwk]) => ({
        id,
        name: 'Test device',
        pubkey_jwk: jwk,
        pinned_at: now,
      })),
    }),
    { mode: 0o600 },
  )
  const env = loadEnv({
    TALOS_APP_HOME: home,
    TALOS_APP_RELAY_URL: relay.httpUrl,
    TALOS_APP_BRIDGE: '1',
    ...opts.env,
  })
  const bridge = await Bridge.create({
    env,
    logger: nullLogger,
    inbound: { settleMs: 20, maxSettleMs: 200 },
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...opts.bridge,
  })
  const notes: Notification[] = []
  bridge.setEmit(async (n) => {
    notes.push(n)
  })
  if (opts.startBridge !== false) {
    bridge.start()
    await relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    // `ready` is recorded by the relay BEFORE the bridge reads it. Wait for the bridge's own side: the socket authed
    // (so ephemeral frames send and durable ones go out instead of queueing) and the post-ready config.sync acked.
    // Keyed on `connected`, so it holds after a restart too.
    await waitFor(() => bridge.client?.connected === true, 10_000, 'the bridge socket to be authed')
    await waitFor(() => bridge.ctx.store.outboxCount() === 0, 10_000, 'the post-ready config.sync to be acked')
  }
  return {
    relay,
    bridge,
    home,
    app,
    notes,
    pinned,
    async stop() {
      await bridge.stop()
      await app.close()
      await stopRelay(relay)
    },
    async waitNotes(n, ms = 4000) {
      await waitFor(() => notes.length >= n, ms, `${n} notifications (have ${notes.length})`)
    },
  }
}

export { sleep, waitFor }

/**
 * Signs an owner frame as the paired app would, then pushes it straight to the bridge. The FakeRelay refuses
 * frames the real relay refuses (forbidden config field, unknown card), so a hostile relay that lets them through
 * can only be played this way. Proves the bridge enforces its own allowlist and ledger check.
 */
export async function pushOwnerFrameToBridge(h: Harness, frame: Record<string, unknown>) {
  const signed = await h.app.sign(frame)
  const sent = h.relay.sendToBridge(signed)
  return { ...sent, id: String(sent.id) }
}

/** The config.patch the app would send, delivered past the relay's own checks. */
export function pushConfigPatchPastRelay(h: Harness, base_rev: number, patch: Record<string, unknown>) {
  return pushOwnerFrameToBridge(h, { ...mkFrame('config.patch'), base_rev, patch })
}

/** The card.resolve the app would send, delivered past the relay's own checks. */
export function pushCardResolvePastRelay(
  h: Harness,
  card: { id: string },
  payload_hash: string,
  action: 'primary' | 'kill' | 'revise' = 'primary',
  extra: Record<string, unknown> = {},
) {
  return pushOwnerFrameToBridge(h, { ...mkFrame('card.resolve'), card_id: card.id, action, payload_hash, ...extra })
}

/**
 * Retries `check` (an `expect`) until it passes, rethrowing its last failure after `timeoutMs`. Put it after the fixed
 * sleep a test already had, never instead of it: on time it behaves exactly as before, late (a loaded machine) it waits.
 */
export async function eventually(check: () => void, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      check()
      return
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e
    }
    await sleep(10)
  }
}

/** The bridge pings every 25 s of injected time and the fake relay pongs; silence past this means the last pong has not landed yet. */
const PONG_DUE_MS = 25_000

/**
 * Advances a fake clock in steps so the bridge's heartbeat watchdog (2.5 pings of silence) never trips. Pass the
 * bridge's `client` and each step waits for the pong that step's ping earned, not for a fixed delay: fake time can
 * outrun a late pong by any amount on a loaded box. Without a client it falls back to a short real pause.
 */
export async function advanceSteps(
  clock: { advance(ms: number): void },
  ms: number,
  step = 20_000,
  client?: { connected: boolean; silentForMs: number },
) {
  for (let left = ms; left > 0; left -= step) {
    clock.advance(Math.min(step, left))
    if (client)
      await waitFor(() => !client.connected || client.silentForMs <= PONG_DUE_MS, 10_000, 'the pong for a clock step')
    else await sleep(40)
  }
}

/**
 * FakeRelay.stop() waits for `server.close()` before it drops keep-alive connections, which never finish on Bun 1.3.11
 * (the bridge's fetch keeps its HTTP connection open). Dropping them first makes stop() return everywhere.
 * Testkit fix wanted: call closeAllConnections() before awaiting close().
 */
export async function stopRelay(relay: FakeRelay): Promise<void> {
  ;(relay as unknown as { server?: { closeAllConnections?: () => void } }).server?.closeAllConnections?.()
  await relay.stop()
}
