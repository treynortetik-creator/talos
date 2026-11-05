// Replay driver for the bridge's inbound pipeline: a real Bridge on a fake clock, with the testkit's FakeRelay pushing
// frames at it. Records every frame the bridge sends, every notification the agent would see, and the Mac's own state
// after. Ids made at random are renamed by first appearance, and the temp folder and keys are named, so the same
// behaviour always prints the same text.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeClock, mkFrame } from '@talos-app/testkit'
import { type Harness, startHarness } from '../helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const START_ISO = '2026-10-28T15:00:00.000Z'

/**
 * Frames the golden does not record. A ping/pong is the harness's own barrier. workers.status is sent by a file watcher
 * poke, not by the inbound pipeline, so whether it appears depends on real fs.watch timing and not on the code under test.
 */
const UNRECORDED = new Set(['ping', 'pong', 'workers.status'])
const recorded = (f: { raw: { type?: unknown } }) => !UNRECORDED.has(String(f.raw.type))

export type Replay = {
  h: Harness
  clock: ReturnType<typeof fakeClock>
  /** Frames the test pushed at the bridge, in order. */
  pushed: Array<{ id: string; type: string }>
  note(text: string): void
  /** A frame with the fixed time, ready to sign. */
  frame(type: string, fields?: Record<string, unknown>): Record<string, unknown>
  /** Signs as the paired app and pushes it at the bridge past the relay's own checks. */
  pushSigned(frame: Record<string, unknown>): Promise<Record<string, unknown>>
  push(frame: Record<string, unknown>, opts?: { durable?: boolean }): Record<string, unknown>
  settle(): Promise<void>
  finish(): { steps: unknown[]; state: unknown }
  stop(): Promise<void>
}

export async function startReplay(opts: { pinApp?: boolean; permissionRelay?: boolean } = {}): Promise<Replay> {
  const clock = fakeClock(START_ISO)
  const h = await startHarness({
    clock,
    ...(opts.pinApp === false ? { pinApp: false } : {}),
    ...(opts.permissionRelay ? { config: (c) => ({ ...c, permission_relay: true }) } : {}),
  })
  const marks: Array<{ frames: number; notes: number; text: string }> = []
  const pushed: Replay['pushed'] = []
  const bridge = h.bridge
  let syncs = 0
  const stable = () =>
    `${h.relay.frames.length}|${h.notes.length}|${bridge.ctx.store.outboxCount()}|${JSON.stringify(h.notes)}`
  const waitStable = async () => {
    let still = 0
    let last = ''
    for (let i = 0; i < 100_000 && still < 10; i++) {
      await bridge.inbound?.idle()
      await new Promise<void>((res) => setImmediate(res))
      const now = stable()
      still = now === last ? still + 1 : 0
      last = now
    }
  }
  const r: Replay = {
    h,
    clock,
    pushed,
    note: (text) =>
      marks.push({
        frames: h.relay.frames.filter(recorded).length,
        notes: h.notes.length,
        text,
      }),
    frame: (type, fields = {}) => ({ ...mkFrame(type, {}, START_ISO), ...fields }),
    async pushSigned(frame) {
      const signed = await h.app.sign(frame)
      return r.push(signed)
    },
    push(frame, o = {}) {
      const sent = h.relay.sendToBridge(frame, o)
      pushed.push({ id: String(sent.id), type: String(sent.type) })
      return sent
    },
    async settle() {
      // The socket keeps order and the bridge answers a ping straight away, so its pong proves every frame pushed before
      // the ping has reached the inbound pipeline. Then time moves once, past the batching window, by a fixed step.
      // A second ping at the end: the bridge's socket keeps order too, so its pong proves every frame the bridge sent
      // before it has reached the recorder, however slow loopback is on a loaded machine.
      const barrier = async () => {
        const nonce = `sync${String(++syncs).padStart(4, '0')}`
        h.relay.sendToBridge(mkFrame('ping', { nonce }, START_ISO), { durable: false })
        const answered = () => h.relay.frames.some((f) => f.raw.type === 'pong' && f.raw.nonce === nonce)
        for (let i = 0; i < 100_000 && !answered(); i++) await new Promise<void>((res) => setImmediate(res))
        if (!answered()) throw new Error(`the bridge never answered the ping ${nonce} with the same nonce`)
      }
      await barrier()
      await waitStable()
      clock.advance(300)
      await waitStable()
      await barrier()
      await waitStable()
    },
    finish() {
      const aliases = new Map<string, string>([
        [h.home, '<home>'],
        [h.app.device.deviceId, '<device>'],
        [h.relay.bridgeKey.keyId, '<bridge-key>'],
      ])
      const steps: unknown[] = []
      const frames = h.relay.frames.filter(recorded).map((f) => ({ dir: f.direction, frame: f.raw }))
      let noteIx = 0
      for (const [i, f] of frames.entries()) {
        while (noteIx < marks.length && (marks[noteIx] as { frames: number }).frames <= i) {
          steps.push({ note: (marks[noteIx] as { text: string }).text })
          noteIx++
        }
        steps.push(f)
      }
      for (; noteIx < marks.length; noteIx++) steps.push({ note: (marks[noteIx] as { text: string }).text })
      const approvedDir = join(h.home, 'approved')
      const state = {
        notifications: h.notes,
        outbox: bridge.ctx.store.outboxCount(),
        seen: Object.fromEntries(pushed.map((p) => [`${p.type}:${p.id}`, bridge.ctx.store.hasSeen(p.id)])),
        cards: Object.fromEntries([...new Set(cardIds(h))].map((id) => [id, bridge.ctx.ledger.get(id) ?? null])),
        approved: existsSync(approvedDir) ? readdirSync(approvedDir).sort() : [],
      }
      return { steps: scrub(steps, aliases) as unknown[], state: scrub(state, aliases) }
    },
    async stop() {
      await h.stop()
    },
  }
  return r
}

const cardIds = (h: Harness): string[] =>
  h.relay.frames.flatMap((f) => {
    const c = (f.raw as { card?: { id?: string } }).card
    return c?.id ? [c.id] : []
  })

const ULID = /[0-9A-HJKMNP-TV-Z]{26}|\bd_[a-z2-7]{20}\b|sha256:[0-9a-f]{64}/g
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
const VOLATILE_NUMBERS = new Set(['server_time', 'disk_free_bytes', 'uptime_s'])
const SECRET_KEYS = new Set(['version', 'sig', 'osig', 'public_key', 'pubkey', 'session_id', 'stepup_token'])

/** Renames random ids by first appearance and blanks signatures, so the same behaviour always prints the same text. */
export function scrub(value: unknown, aliases: Map<string, string>): unknown {
  const seen = new Map<string, string>()
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'number' && key && VOLATILE_NUMBERS.has(key)) return '<number>'
    if (typeof v === 'string') {
      if (key && SECRET_KEYS.has(key)) return '<secret>'
      // The relay stand-in stamps its own frames with the wall clock; only the bridge's fake-clock times are kept.
      if (ISO.test(v) && !v.startsWith('2026-10-28') && !v.startsWith('2026-10-29')) return '<wall-time>'
      let s = v
      for (const [from, to] of aliases) s = s.split(from).join(to)
      return s.replace(ULID, (m) => {
        if (!seen.has(m))
          seen.set(
            m,
            m.startsWith('d_')
              ? `<dev${seen.size + 1}>`
              : m.startsWith('sha256:')
                ? `<hash${seen.size + 1}>`
                : `<id${seen.size + 1}>`,
          )
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
          walk(k),
          challenge && k === 'nonce' ? '<challenge-nonce>' : walk(x, k),
        ]),
      )
    }
    return v
  }
  return walk(value)
}

export const goldenPath = (name: string, dir = join(HERE, 'golden')) => join(dir, `${name}.golden.json`)
export const readGolden = (name: string, dir?: string): string | null =>
  existsSync(goldenPath(name, dir)) ? readFileSync(goldenPath(name, dir), 'utf8') : null

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
