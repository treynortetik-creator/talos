// Test harness: a real Bridge (live mode) wired to the testkit's FakeRelay, with notifications captured in memory.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CardT, CLAIM_DEADLINE_MS, CONFIG_PROPOSE_FEATURE, type JwkP256T } from '@talos-app/protocol'
import {
  FakeApp,
  FakeRelay,
  type FakeRelayOptions,
  loadExampleConfig,
  mkFrame,
  sleep,
  waitFor,
  waitScale,
} from '@talos-app/testkit'
import { Bridge, type BridgeOptions } from '../src/bridge.ts'
import type { Clock } from '../src/clock.ts'
import { loadEnv } from '../src/config.ts'
import { createLogger } from '../src/log.ts'
import type { Notification } from '../src/notify.ts'
import { testTempDir } from './temp-dirs.ts'

/** startHarness's own waits (ms before the testkit's x3): the relay's `ready`, the socket authed, the post-ready config.sync acked. */
const START_READY_MS = 3000 // expectFrame's default
const START_AUTHED_MS = 10_000
const START_SYNCED_MS = 10_000
/** The longest startHarness can wait for a bridge it starts (9 + 30 + 30 s at x3): a test that starts one has this on top of its own waits. */
export const HARNESS_START_MS = (START_READY_MS + START_AUTHED_MS + START_SYNCED_MS) * waitScale()

export const fixture = (name: string) => join(import.meta.dir, 'fixtures', name)

/**
 * What the root ./install.sh leaves in an agent folder that `start` and `doctor` look for (src/kit-marker.ts): the stamp and
 * a CLAUDE.md. A test of a healthy agent folder adds it; returns the folder.
 */
export function writeKit(agentDir: string): string {
  writeFileSync(join(agentDir, '.talos-version'), '2.0.0\n')
  writeFileSync(join(agentDir, 'CLAUDE.md'), '# agent\n')
  return agentDir
}

/** A throw-away bridge home, removed once the test file that made it has finished (temp-dirs.ts). */
export function tempHome(prefix = 'talos-bridge-test-'): string {
  return testTempDir(prefix)
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
    /** Called as each start stage is reached (a test that dumps its timings when it fails): relay up, app connected, bridge made, ready seen, authed, synced. */
    stage?: (name: string) => void
  } = {},
): Promise<Harness> {
  // the relay judges a card's expiry on the same clock as the Mac, or a card made on an injected clock would already be old
  const { clock } = opts
  const stage = opts.stage ?? (() => {})
  const relay = await new FakeRelay({ ...(clock ? { now: () => clock.now() } : {}), ...opts.relay }).start()
  stage('relay started')
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
  stage('app connected')
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
    logger: createLogger(null, 'error', () => {}), // its own: the problem-report tap lives on the logger, and a shared one carries a stopped bridge's late error into the next test's bridge
    inbound: { settleMs: 20, maxSettleMs: 200 },
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...opts.bridge,
  })
  const notes: Notification[] = []
  bridge.setEmit(async (n) => {
    notes.push(n)
  })
  if (opts.startBridge !== false) {
    stage('bridge created')
    bridge.start()
    await relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    stage('relay saw ready')
    // `ready` is recorded by the relay BEFORE the bridge reads it. Wait for the bridge's own side: the socket authed
    // (so ephemeral frames send and durable ones go out instead of queueing) and the post-ready config.sync acked.
    // Keyed on `connected`, so it holds after a restart too.
    await waitFor(() => bridge.client?.connected === true, START_AUTHED_MS, 'the bridge socket to be authed')
    stage('bridge socket authed')
    await waitFor(() => bridge.ctx.store.outboxCount() === 0, START_SYNCED_MS, 'the post-ready config.sync to be acked')
    stage('config.sync acked')
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
 * The bridge's own lines to the owner (author `system`), one per message id, in the order they first reached the relay. A durable
 * frame is resent after a reconnect until the relay acks it, and the receiver dedupes on id, so the same line can cross the wire twice
 * (a pane Run's channel change redials the relay just as its line goes out). Counting wire frames made "one line" flake.
 */
export function systemNotices(x: { relay: { frames: { direction: string; raw: unknown }[] } }): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of x.relay.frames) {
    const raw = f.raw as { type?: string; message?: { id?: string; author?: string; text?: string } }
    if (f.direction !== 'from_bridge' || raw.type !== 'reply' || raw.message?.author !== 'system') continue
    const id = raw.message.id ?? `noid:${out.length}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(String(raw.message.text))
  }
  return out
}

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
 * `check` may be async: its promise is awaited, so a rejected `expect` inside it is retried too (not left unhandled).
 */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await check()
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
 * Moves a fake clock past a thread session's claim deadline (`ms`, default just over CLAIM_DEADLINE_MS, which is minutes now):
 * one long jump with `set` (no timer runs in it), then short steps so the timers that came due fire, in order. A long run of
 * short steps would take seconds of real time and outlast a test's own timeout.
 */
export async function pastClaimDeadline(
  clock: { now(): number; set(ms: number): void; advance(ms: number): void },
  ms = CLAIM_DEADLINE_MS + 1_000,
  /** Called after the jump and after each step: renew the supervisor's heartbeat (a stale one hands the message to main early). */
  beat: () => void = () => {},
) {
  if (ms > 30_000) clock.set(clock.now() + ms - 30_000)
  beat()
  for (let left = Math.min(ms, 30_000); left > 0; left -= 10_000) {
    await advanceSteps(clock, Math.min(10_000, left), 10_000)
    beat()
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

/** A relay that knows settings cards (`config-propose/1`): `create_thread` and `archive_thread` draw one, so a test that calls them needs it. */
export const CARD_RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }

/**
 * `create_thread` and `archive_thread` show the owner a settings card (docs/bridge.md). A test that wants the change made
 * takes the newest such card the bridge sent and taps Apply on it, then waits for the card to finish.
 */
export async function approveLatestConfigCard(h: Harness): Promise<void> {
  await waitFor(
    () =>
      h.relay.frames.some(
        (r) => r.direction === 'from_bridge' && r.raw.type === 'card.create' && (r.raw.card as CardT).kind === 'config',
      ),
    4000,
    'a settings card',
  )
  const cards = h.relay.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'card.create' && (r.raw.card as CardT).kind === 'config',
  )
  const card = cards[cards.length - 1]?.raw.card as CardT
  await h.app.resolveCard(card, 'primary', card.payload_hash)
  await h.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
    direction: 'from_bridge',
  })
}
