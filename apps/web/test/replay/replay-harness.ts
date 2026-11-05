// Replay driver for the web socket client: the real createSocketClient runs against a scripted socket on fake timers, so
// every frame it sends and the state it ends in can be written down. Ids and signatures made at random are renamed by
// first appearance, so the same behaviour always prints the same text.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOwnerFrame } from '@talos-app/protocol'
import { vi } from 'vitest'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const START_ISO = '2026-10-28T15:00:00.000Z'

export type Step = { dir: 'app->relay' | 'relay->app' | 'note' | 'event'; frame?: unknown; text?: string }

/** The socket the client is given. Nothing is sent anywhere: the test decides what the relay says. */
export class ScriptedSocket {
  static all: ScriptedSocket[] = []
  static log: Step[] = []
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  static CLOSING = 2
  readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []
  constructor(readonly url: string) {
    ScriptedSocket.all.push(this)
    ScriptedSocket.log.push({ dir: 'event', text: `socket ${ScriptedSocket.all.length} opened` })
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string) {
    this.sent.push(data)
    let frame: unknown = data
    try {
      frame = JSON.parse(data)
    } catch {}
    ScriptedSocket.log.push({ dir: 'app->relay', frame })
  }
  close(code = 1000) {
    this.drop(code)
  }
  /** The relay says something. */
  receive(frame: unknown) {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
    let shown: unknown = data
    try {
      shown = JSON.parse(data)
    } catch {}
    ScriptedSocket.log.push({ dir: 'relay->app', frame: shown })
    this.onmessage?.({ data })
  }
  /** The link ends (a close from the relay, or the network). */
  drop(code: number, reason?: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    ScriptedSocket.log.push({
      dir: 'event',
      text: `socket ${ScriptedSocket.all.indexOf(this) + 1} closed ${code}${reason ? ` ${reason}` : ''}`,
    })
    this.onclose?.({ code, ...(reason ? { reason } : {}) })
  }
}

/** WebCrypto calls that have started and not finished: the signer runs on a real thread, so settle waits for these. */
let cryptoInFlight = 0
function trackCrypto() {
  const subtle = crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const name of ['sign', 'digest', 'generateKey', 'importKey', 'exportKey', 'verify']) {
    const real = (subtle[name] as (...a: unknown[]) => Promise<unknown>).bind(crypto.subtle)
    vi.spyOn(subtle, name).mockImplementation((...a: unknown[]) => {
      cryptoInFlight++
      return real(...a).finally(() => {
        cryptoInFlight--
      })
    })
  }
}

let counter = 0
/** A fixed, valid ULID for the nth id of a run. */
export const uid = (prefix = ''): string => `${prefix}01HXTEST${String(++counter).padStart(18, '0')}`

export const srv = (type: string, fields: Record<string, unknown> = {}) => ({
  v: 1,
  type,
  id: uid(),
  ts: START_ISO,
  ...fields,
})

export const readyFrame = (extra: Record<string, unknown> = {}) =>
  srv('ready', {
    session_id: 'sess_replay0001',
    policy: { max_frame_bytes: 262144, ping_ms: 25000 },
    server_seq: 0,
    presence: { bridge_online: true, last_seen: START_ISO, queue_depth: 0 },
    ...extra,
  })

export type Run = {
  client: SocketClient
  sockets: typeof ScriptedSocket
  /** The most recent socket. */
  sock(): ScriptedSocket
  note(text: string): void
  /** Lets promises, the signer and timers at the current fake time run until nothing more happens. */
  settle(): Promise<void>
  advance(ms: number): Promise<void>
  /** Jumps the clock (a phone left asleep) without running the timers in between. */
  jumpTo(iso: string): void
  /** Checks every owner signature the client made, then returns the transcript with signatures blanked. */
  finish(): Promise<{ steps: Step[]; state: unknown }>
  stop(): void
}

export async function startRun(opts: { pinned?: boolean } = {}): Promise<Run> {
  counter = 0
  ScriptedSocket.all = []
  ScriptedSocket.log = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date(START_ISO))
  trackCrypto()
  const client = createSocketClient({
    storage: createMemoryStorage(),
    WebSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
    wsUrl: 'wss://relay.example.com/ws',
    backoff: { baseMs: 1000, maxMs: 4000, random: () => 0.5 },
    isOnline: () => true,
    isVisible: () => true,
    clientInfo: { version: '0.0.0', standalone: true, platform: 'replay' },
    now: () => Date.now(),
  })
  const run: Run = {
    client,
    sockets: ScriptedSocket,
    sock: () => ScriptedSocket.all[ScriptedSocket.all.length - 1] as ScriptedSocket,
    note: (text) => ScriptedSocket.log.push({ dir: 'note', text }),
    async settle() {
      // Real crypto finishes on a real macrotask; stop once nothing is sent and the state stops changing.
      let still = 0
      let last = ''
      for (let i = 0; i < 2000 && still < 6; i++) {
        await new Promise<void>((r) => setImmediate(r))
        await vi.advanceTimersByTimeAsync(0)
        const now = `${ScriptedSocket.log.length}|${JSON.stringify(snapshot(client))}`
        still = now === last && cryptoInFlight === 0 ? still + 1 : 0
        last = now
      }
    },
    async advance(ms) {
      await vi.advanceTimersByTimeAsync(ms)
      await run.settle()
    },
    jumpTo(iso) {
      vi.setSystemTime(new Date(iso))
    },
    async finish() {
      const aliases = new Map<string, string>()
      const id = client.store.getState().deviceId
      if (id) aliases.set(id, '<device>')
      // The scrubber below blanks every `osig`, so first prove each one is a real signature by this device's key over
      // exactly the frame that was sent. A signing site that sent junk fails here instead of vanishing into <secret>.
      const key = await client.deviceKey()
      for (const step of ScriptedSocket.log) {
        if (step.dir !== 'app->relay') continue
        const f = step.frame as Record<string, unknown>
        if (typeof f !== 'object' || f === null || !('osig' in f)) continue
        if (!key || !(await verifyOwnerFrame(f, key.publicJwk)))
          throw new Error(`the client sent a ${String(f.type)} frame whose owner signature does not verify`)
      }
      return {
        steps: scrub(ScriptedSocket.log, aliases) as Step[],
        state: scrub(snapshot(client), aliases),
      }
    },
    stop() {
      client.close()
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
  await client.ensureDevice()
  await client.start({ pinned: opts.pinned ?? true })
  await run.settle()
  return run
}

/** The part of the client's state that the screens read, as plain data. */
export function snapshot(client: SocketClient) {
  const s = client.store.getState()
  return {
    connection: s.connection,
    devicePinned: s.devicePinned,
    lastSeq: s.lastSeq,
    serverSeq: s.serverSeq ?? null,
    readySeq: s.readySeq ?? null,
    presence: s.presence,
    unread: s.unread,
    readUpto: s.readUpto ?? {},
    messages: s.messages,
    cards: s.cards,
    statuses: s.statuses,
    catchup: s.catchup,
    outbox: client.outboxSize(),
    meta: client.meta.getState(),
  }
}

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g
// `nonce` is not here: the web client is never sent the relay's random challenge, only pings with a nonce the test chose,
// and the client's pong must echo that one.
const SECRET_KEYS = new Set(['sig', 'osig', 'public_key', 'pubkey', 'session_id'])

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
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [walk(k), walk(x, k)]))
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
