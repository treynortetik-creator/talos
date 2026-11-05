// Replay driver for the relay hub: fake sockets go into the real Hub (all modules wired by startRelay) on a fake clock,
// and every frame the hub sends or closes is written down in order. Ids the hub makes at random are renamed by first
// appearance, so the transcript is the same on every run and only changes when the hub's behaviour does.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BridgeKeyPair,
  bindingFrom,
  createDeviceKey,
  type DeviceKey,
  generateBridgeKey,
  signChallenge,
  signOwnerFrame,
} from '@talos-app/protocol'
import { buildCard, type FakeClock, fakeClock } from '@talos-app/testkit'
import type { Conn } from '../../src/core/hub.ts'
import type { RunningRelay } from '../../src/index.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const START_ISO = '2026-10-28T15:00:00.000Z'

export type LogEntry = { to: string; frame: unknown } | { to: string; closed: number; reason?: string }

export class FakeConn implements Conn {
  closed: { code: number; reason?: string } | null = null
  constructor(
    readonly name: string,
    private log: LogEntry[],
  ) {}
  send(text: string): void {
    this.log.push({ to: this.name, frame: JSON.parse(text) })
  }
  close(code: number, reason?: string): void {
    if (this.closed) return // a socket that is already closed ignores a second close, as a real one does
    this.closed = { code, ...(reason ? { reason } : {}) }
    this.log.push({ to: this.name, closed: code, ...(reason ? { reason } : {}) })
  }
  terminate(): void {}
}

type Attached = { onMessage(text: string): void; onClose(): void }

export type Replay = {
  relay: TestRelay
  clock: FakeClock
  log: LogEntry[]
  note(text: string): void
  device: DeviceKey
  bridgeKey: BridgeKeyPair
  /** Opens an app socket for a session; `pinned: false` is a device the Mac has not approved. */
  app(name: string, opts?: { deviceId?: string | null; pinned?: boolean }): { conn: FakeConn; at: Attached }
  /** Opens a bridge socket and answers its challenge with `key` (default: the key the relay trusts). */
  bridge(
    name: string,
    opts?: { key?: BridgeKeyPair; features?: string[]; badSig?: boolean },
  ): Promise<{ conn: FakeConn; at: Attached }>
  /** Sends one frame text and waits until the hub has handled everything queued before it. */
  appSend(a: { conn: FakeConn; at: Attached }, frame: Record<string, unknown> | string): Promise<void>
  bridgeSend(a: { conn: FakeConn; at: Attached }, frame: Record<string, unknown> | string): Promise<void>
  hello(a: { conn: FakeConn; at: Attached }, extra?: Record<string, unknown>): Promise<void>
  signed(frame: Record<string, unknown>): Promise<Record<string, unknown>>
  state(): unknown
  finish(): { steps: unknown[]; state: unknown }
  stop(): Promise<void>
}

let counter = 0
/** A fixed, valid ULID for the nth id of a run: the same on every run. */
export const uid = (prefix = ''): string => `${prefix}01HXTEST${String(++counter).padStart(18, '0')}`
const fid = () => uid()

export const frame = (type: string, fields: Record<string, unknown> = {}) => ({
  v: 1,
  type,
  id: fid(),
  ts: START_ISO,
  ...fields,
})

export async function startReplay(): Promise<Replay> {
  counter = 0
  const clock = fakeClock(START_ISO)
  const bridgeKey = await generateBridgeKey()
  const relay = await startTestRelay({ clock, bridgeKey })
  const device = await createDeviceKey()
  const log: LogEntry[] = []
  const hub = relay.runtime.hub
  hub.start()

  const barrier = async (a: { conn: FakeConn; at: Attached }) => {
    // A socket the hub already closed is not pinged: the hub would close it a second time, which a real socket ignores and
    // the transcript should not show. For one that closes while handling this frame, the wait ends when it closes.
    if (a.conn.closed) return
    // A ping is answered after every frame queued before it on the same socket, so the pong marks the end of the work.
    const nonce = `sync${++counter}`.padEnd(8, '0')
    const before = log.length
    a.at.onMessage(JSON.stringify(frame('ping', { nonce })))
    for (let i = 0; i < 2000; i++) {
      if (a.conn.closed) break
      if (log.slice(before).some((e) => 'frame' in e && (e.frame as { nonce?: string }).nonce === nonce)) break
      await new Promise<void>((r) => setImmediate(r))
    }
    // drop the barrier's own pong from the transcript
    for (let i = log.length - 1; i >= before; i--) {
      const e = log[i] as LogEntry
      if ('frame' in e && (e.frame as { nonce?: string }).nonce === nonce) log.splice(i, 1)
    }
  }
  const text = (f: Record<string, unknown> | string) => (typeof f === 'string' ? f : JSON.stringify(f))

  const aliases = new Map<string, string>([
    [device.deviceId, '<device>'],
    [bridgeKey.keyId, '<bridge-key>'],
  ])

  const r: Replay = {
    relay,
    clock,
    log,
    device,
    bridgeKey,
    note: (t) => log.push({ to: '#', frame: { note: t } }),
    app(name, opts = {}) {
      const conn = new FakeConn(name, log)
      const deviceId = opts.deviceId === undefined ? device.deviceId : opts.deviceId
      const session = {
        sessionId: `test-${deviceId ?? 'none'}${opts.pinned === false ? '-unpinned' : ''}`,
        deviceId,
      }
      const at = hub.attachApp(conn, { session, ip: '203.0.113.7' })
      return { conn, at }
    },
    async bridge(name, opts = {}) {
      const conn = new FakeConn(name, log)
      const at = hub.attachBridge(conn, { ip: '203.0.113.9', relayHost: 'relay.example.com' })
      const challenge = log
        .map((e) => e)
        .reverse()
        .find((e) => e.to === name && 'frame' in e && (e.frame as { type?: string }).type === 'challenge') as
        | { frame: { nonce: string; relay_host: string; server_time: number } }
        | undefined
      const key = opts.key ?? bridgeKey
      const sig = await signChallenge(
        key.privateKey,
        opts.badSig ? { ...challenge!.frame, nonce: 'not-the-nonce' } : challenge!.frame,
      )
      at.onMessage(
        JSON.stringify(
          frame('hello', {
            role: 'bridge',
            key_id: key.keyId,
            sig,
            client: { name: 'replay', version: '0', ...(opts.features ? { features: opts.features } : {}) },
            agent_config_rev: 0,
          }),
        ),
      )
      const a = { conn, at }
      await barrier(a)
      return a
    },
    async appSend(a, f) {
      a.at.onMessage(text(f))
      await barrier(a)
    },
    async bridgeSend(a, f) {
      a.at.onMessage(text(f))
      await barrier(a)
    },
    async hello(a, extra = {}) {
      await r.appSend(
        a,
        frame('hello', {
          role: 'app',
          device_id: device.deviceId,
          last_seq: 0,
          visible: true,
          client: { version: '0.0.0', standalone: true, platform: 'test' },
          ...extra,
        }),
      )
    },
    signed: (f) => signOwnerFrame({ ...f, device_id: device.deviceId }, device.privateKey),
    state() {
      const s = relay.runtime.store
      const events = Array.from({ length: s.maxSeq() }, (_, i) => s.getEventBySeq(i + 1)).filter(Boolean)
      const cardIds = events.flatMap((e) => {
        const c = (e as { card?: { id?: string } } | null)?.card
        return c?.id ? [c.id] : []
      })
      return {
        cards: Object.fromEntries(cardIds.map((id) => [id, s.getCard(id)])),
        max_seq: s.maxSeq(),
        presence: hub.presence(),
        bridge_online: hub.bridgeOnline(),
        app_sockets: hub.appCount(),
        pending_cards: s.allPendingCards().length,
        events,
      }
    },
    finish() {
      return { steps: scrub(log, aliases), state: scrub(r.state(), aliases) } as { steps: unknown[]; state: unknown }
    },
    async stop() {
      await relay.stop()
    },
  }
  return r
}
export type { RunningRelay }
export { bindingFrom, buildCard }

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g
const SECRET_KEYS = new Set(['sig', 'osig', 'public_key', 'pubkey', 'session_id', 'stepup_token'])

/** Renames random ids by first appearance and blanks signatures, so the same behaviour always prints the same text. */
export function scrub(value: unknown, aliases: Map<string, string>): unknown {
  const seen = new Map<string, string>()
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SECRET_KEYS.has(key)) return '<secret>'
      let s = v
      for (const [from, to] of aliases) s = s.split(from).join(to)
      return s.replace(ULID, (m) => {
        if (!seen.has(m)) seen.set(m, `<id${seen.size + 1}>`)
        return seen.get(m) as string
      })
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      // Only the relay's random challenge nonce is blanked. A nonce the test chose (a ping's) stays, so an answer that
      // echoes the wrong one shows up.
      const challenge = (v as { type?: unknown }).type === 'challenge'
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          challenge && k === 'nonce' ? '<challenge-nonce>' : walk(x, k),
        ]),
      )
    }
    return v
  }
  return walk(value)
}

/** The checked-in golden file for a replay. */
export function goldenPath(name: string, dir = join(HERE, 'golden')): string {
  return join(dir, `${name}.golden.json`)
}
export function readGolden(name: string, dir?: string): string | null {
  const p = goldenPath(name, dir)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/**
 * Whether this run rewrites the golden. UPDATE_GOLDEN=1 is for a person on purpose: with CI set it throws, so a CI run
 * can never record whatever the code does today and pass.
 */
export function goldenMode(env: Record<string, string | undefined> = process.env): 'check' | 'update' {
  if (env.UPDATE_GOLDEN !== '1') return 'check'
  const ci = env.CI
  if (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false')
    throw new Error('UPDATE_GOLDEN=1 is refused when CI is set: a CI run must compare, never record.')
  return 'update'
}

/** Writes the sequences that ran over the file, keeping the stored ones that did not run (a filtered run). */
export function saveGolden(name: string, ran: Record<string, unknown>, dir?: string): void {
  const kept = JSON.parse(readGolden(name, dir) ?? '{}') as Record<string, unknown>
  writeFileSync(goldenPath(name, dir), `${JSON.stringify({ ...kept, ...ran }, null, 2)}\n`)
}
