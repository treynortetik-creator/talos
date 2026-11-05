// The bridge end of the Talos mod link (docs/CLAUDE-CODE.md C2.3). The mod calls two tools, `talos_mod_hello` and
// `talos_mod_sync`; this class is everything behind them.
//
// Threat model, in one paragraph: the key is hygiene, not a boundary. In bypass mode the model can already do whatever
// the mod can, so nothing here lets mod-reported data ALLOW anything: it informs the app and it refuses (a stale Stop,
// a missing capability). The boundary is the bridge's own osig check and command policy on `session.control`, which run
// before a control is queued (WP-C3). The key is a file the bridge writes (0600, under $TALOS_APP_HOME) and the mod reads
// with `$.fs`. It never travels: no tool result carries it and no call argument does either. `hello` sends
// HMAC(key, "hello\n" + ts) and every sync sends HMAC(key, "sync\n" + seq + "\n" + canonical body) in the `mod_key`
// field (43 base64url characters, the same shape), so a plugin whose hook sees the arguments can read the data but
// cannot forge a call or replay one (seq only goes up, ts must be fresh and is used once). A model that only calls tools
// (a prompt injection that reads no files) gets nothing, with or without the mod loaded; one that can read files can
// read the key, which is why this is hygiene and the owner's signature on controls is the boundary.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type AgentsSnapshotT,
  inventoryCommandsFromEngine,
  MOD_LIVE_WINDOW_MS,
  ModControlResult,
  type ModControlResultT,
  type ModControlT,
  ModEvent,
  type ModEventT,
  ModKey,
  SessionInventory,
  type SessionInventoryT,
  SessionState,
  type SessionStateT,
} from '@talos-app/protocol'
import type { Clock } from '../clock.ts'
import { writeFileAtomic } from '../fsutil.ts'
import type { Logger } from '../log.ts'
import { ModAgents } from './agents.ts'
import { canonicalJson } from './canonical.ts'

/** Where the link sends what it learns. The bridge wires `state`/`inventory` to ephemeral relay frames. */
export interface ModEventSink {
  state(state: SessionStateT): void
  inventory(inventory: SessionInventoryT): void
  /** `prompt_open` / `prompt_closed` and the rest, in order. WP-C1's closer (C3.4) subscribes here. */
  event?(event: ModEventT): void
  /** A control's result, for WP-C3 to turn into `session.control.result`. */
  result?(result: ModControlResultT): void
  /** docs/SUBAGENTS.md: a checked, trimmed agents snapshot for a `session.agents` frame (throttled, memory only). */
  agents?(snapshot: AgentsSnapshotT): void
}

/** Where the shared secret lives. The bridge's is a 0600 file; tests use memory. */
export interface ModKeyStore {
  read(): string | undefined
  write(key: string): void
}

/** The live bridge's store: `mod.key` under $TALOS_APP_HOME, 0600, written atomically. */
export function fileKeyStore(path: string): ModKeyStore {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8').trim()
      } catch {
        return undefined
      }
    },
    write: (key) => writeFileAtomic(path, `${key}\n`, 0o600),
  }
}

export type ModHelloResult = { ok: true } | { ok: false; code: 'already_connected' | 'refused'; message: string }
export type ModSyncResult =
  | { ok: true; response: { controls: ModControlT[] } }
  | { ok: false; code: 'unauthorized' | 'bad_request'; message: string }

export type ModSnapshot = { live: boolean; state?: SessionStateT; inventory?: SessionInventoryT }

/** A live mod's state is re-published at least this often, so `at` is the last moment the mod was heard from. */
export const STATE_HEARTBEAT_MS = 10_000
export const INVENTORY_HEARTBEAT_MS = 60_000
/** After the live window lapses with no sync, "mod offline" goes out this much later. */
const LAPSE_SLACK_MS = 500
const MAX_EVENTS = 200
const MAX_RESULTS = 50
const MAX_CONTROLS_PER_SYNC = 20
const MAX_QUEUED_CONTROLS = 100

/** What a sync's MAC covers: every body member the mod sent, nothing else. */
const BODY_KEYS = ['state', 'inventory', 'events', 'results', 'agents'] as const
/** What hello answers: the sync members beyond C2's that this bridge reads (and MACs). The mod sends `agents` only then. */
export const MOD_LINK_FEATURES = ['agents'] as const
const bodyOf = (raw: Record<string, unknown>) =>
  Object.fromEntries(BODY_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]))

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const digest = (s: string) => createHash('sha256').update(s).digest()
const sameState = (a: SessionStateT, b: SessionStateT) => {
  const { at: _a, ...x } = a
  const { at: _b, ...y } = b
  return JSON.stringify(x) === JSON.stringify(y)
}
const sameInventory = (a: SessionInventoryT, b: SessionInventoryT) => {
  const { at: _a, ...x } = a
  const { at: _b, ...y } = b
  return JSON.stringify(x) === JSON.stringify(y)
}

export class ModLink {
  private key: string
  private established = false
  private lastSeq = 0
  private lastHelloTs = Number.NEGATIVE_INFINITY
  private lastSeen = 0
  private lastStatePublish = Number.NEGATIVE_INFINITY
  private lastInventoryPublish = Number.NEGATIVE_INFINITY
  private lapseTimer: unknown
  private readonly keys: ModKeyStore
  private state: SessionStateT | undefined
  private inventory: SessionInventoryT | undefined
  private sentState: SessionStateT | undefined
  private sentInventory: SessionInventoryT | undefined
  private readonly queue: ModControlT[] = []
  private readonly clock: Clock
  private readonly log: Logger
  private readonly sink: ModEventSink
  private readonly random: (n: number) => Uint8Array
  private badKeys = 0
  private readonly agents: ModAgents

  constructor(deps: {
    clock: Clock
    log: Logger
    sink: ModEventSink
    random?: (n: number) => Uint8Array
    /** Omit for an in-memory secret nobody can read (tools refuse every hello; nothing leaks). */
    keys?: ModKeyStore
  }) {
    this.clock = deps.clock
    this.log = deps.log
    this.sink = deps.sink
    this.random = deps.random ?? ((n) => randomBytes(n))
    let mem: string | undefined
    this.keys = deps.keys ?? {
      read: () => mem,
      write: (k) => {
        mem = k
      },
    }
    this.agents = new ModAgents(this.clock, this.log, (s) => this.sink.agents?.(s))
    this.key = this.newKey()
    this.keys.write(this.key) // a throw here (unwritable home) stops the bridge from starting, which is the safe side
  }

  private newKey(): string {
    return Buffer.from(this.random(32)).toString('base64url')
  }

  /** Stops the lapse timer (Bridge.stop). */
  close(): void {
    if (this.lapseTimer !== undefined) this.clock.clearTimeout(this.lapseTimer)
    this.lapseTimer = undefined
    this.agents.close()
  }

  /** A mod synced inside the live window (a hello counts: the mod must follow it with a sync). */
  get live(): boolean {
    return this.established && this.clock.now() - this.lastSeen <= MOD_LIVE_WINDOW_MS
  }

  /**
   * `talos_mod_hello({ ts, proof })`. The proof is HMAC(key, "hello\n" + ts): evidence the caller read the key file,
   * without the key. `ts` must be within 30 s of now and newer than the last hello. Refused while a mod is live (no sync
   * for 30 s frees it). Success rotates the key into the file; the mod re-reads it. Returns no secret, ever.
   */
  hello(raw: unknown): ModHelloResult {
    const refuse = (why: string): ModHelloResult => {
      this.log.security(`mod hello refused: ${why}`)
      return { ok: false, code: why === 'live' ? 'already_connected' : 'refused', message: 'refused' }
    }
    if (this.live) return refuse('live')
    const a = isObj(raw) ? raw : {}
    const ts = a.ts
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return refuse('no ts')
    if (Math.abs(this.clock.now() - ts) > MOD_LIVE_WINDOW_MS) return refuse('stale ts')
    if (ts <= this.lastHelloTs) return refuse('replayed ts')
    if (!this.macMatches(a.proof, `hello\n${ts}`)) return refuse('bad proof')
    const next = this.newKey()
    try {
      this.keys.write(next)
    } catch {
      this.log.error('mod key could not be written')
      return refuse('unwritable')
    }
    this.key = next
    this.established = true
    this.lastHelloTs = ts
    this.lastSeq = 0
    this.lastSeen = this.clock.now()
    this.badKeys = 0
    // a fresh mod has not reported yet: forget the last one's facts so the app never shows a dead session as current
    this.state = undefined
    this.inventory = undefined
    this.sentState = undefined
    this.sentInventory = undefined
    this.queue.length = 0
    this.armLapse()
    this.log.info('mod hello accepted')
    return { ok: true }
  }

  /** `talos_mod_sync`. Checks the MAC and the sequence number first and reads nothing else until they pass. */
  sync(raw: unknown): ModSyncResult {
    const seq = isObj(raw) ? raw.seq : undefined
    if (
      !isObj(raw) ||
      !this.established ||
      !this.liveWindow() ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq <= this.lastSeq ||
      !this.macMatches(raw.mod_key, `sync\n${seq}\n${canonicalJson(bodyOf(raw))}`)
    ) {
      this.badKeys++
      this.log.security('bad mod key', { count: this.badKeys })
      return { ok: false, code: 'unauthorized', message: 'unauthorized: say hello again' }
    }
    this.lastSeq = seq
    this.lastSeen = this.clock.now()
    const at = new Date(this.clock.now()).toISOString()

    if (raw.state !== undefined) this.takeState(raw.state, at)
    if (raw.inventory !== undefined) this.takeInventory(raw.inventory, at)
    if (Array.isArray(raw.events)) this.takeEvents(raw.events.slice(0, MAX_EVENTS), at)
    if (Array.isArray(raw.results)) this.takeResults(raw.results.slice(0, MAX_RESULTS))
    this.agents.onSync(raw.agents)
    this.heartbeat(at)
    this.armLapse()
    return { ok: true, response: { controls: this.queue.splice(0, MAX_CONTROLS_PER_SYNC) } }
  }

  /** WP-C3: hand a checked control to the mod; it leaves with the next sync. */
  enqueue(control: ModControlT): boolean {
    if (this.queue.length >= MAX_QUEUED_CONTROLS) return false
    this.queue.push(control)
    return true
  }

  snapshot(): ModSnapshot {
    const live = this.live
    return {
      live,
      ...(this.state ? { state: this.state } : {}),
      ...(this.inventory ? { inventory: this.inventory } : {}),
    }
  }

  /** The last state, only while the mod is live: stale mod data must not feed any decision. */
  liveState(): SessionStateT | undefined {
    return this.live ? this.state : undefined
  }
  liveInventory(): SessionInventoryT | undefined {
    return this.live ? this.inventory : undefined
  }
  /** The last agents snapshot, only while the mod is live (checkSessionControl's `agents` for `agent_stop`). */
  liveAgents(): AgentsSnapshotT | undefined {
    return this.live ? this.agents.last() : undefined
  }
  /** The relay (re)connected with `agents/1`: send the held snapshot again now (docs/SUBAGENTS.md 5.3). */
  resendAgents(): void {
    this.agents.resend()
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private liveWindow(): boolean {
    return this.clock.now() - this.lastSeen <= MOD_LIVE_WINDOW_MS
  }

  /** `candidate` is HMAC-SHA256(key, message) as 43 base64url characters. Compared in constant time. */
  private macMatches(candidate: unknown, message: string): boolean {
    if (typeof candidate !== 'string' || !ModKey.safeParse(candidate).success) return false
    const expected = createHmac('sha256', this.key).update(message).digest('base64url')
    return timingSafeEqual(digest(candidate), digest(expected))
  }

  /** Keeps `at` honest: a live mod's unchanged state and inventory are re-published on a beat, a dead one's are not. */
  private heartbeat(at: string) {
    const now = this.clock.now()
    if (this.state && now - this.lastStatePublish >= STATE_HEARTBEAT_MS) {
      this.state = { ...this.state, at }
      this.sentState = this.state
      this.lastStatePublish = now
      this.sink.state(this.state)
    }
    if (this.inventory && now - this.lastInventoryPublish >= INVENTORY_HEARTBEAT_MS) {
      this.inventory = { ...this.inventory, at }
      this.sentInventory = this.inventory
      this.lastInventoryPublish = now
      this.sink.inventory(this.inventory)
    }
  }

  /** One timer, re-armed by every hello and sync. If it fires with the mod still silent, the app is told. */
  private armLapse() {
    if (this.lapseTimer !== undefined) this.clock.clearTimeout(this.lapseTimer)
    this.lapseTimer = this.clock.setTimeout(() => this.onLapse(), MOD_LIVE_WINDOW_MS + LAPSE_SLACK_MS)
  }

  private onLapse() {
    this.lapseTimer = undefined
    if (this.live) return
    this.agents.onLapse()
    if (!this.state) return
    // "mod offline": no capabilities, no readings, just who and when. The last known state stays in snapshot() only.
    const at = new Date(this.clock.now()).toISOString()
    const offline: SessionStateT = {
      session_id: this.state.session_id,
      source: 'mod',
      capabilities: [],
      rate_limits: [],
      surfaces: [],
      at,
    }
    this.sentState = offline
    this.lastStatePublish = Number.NEGATIVE_INFINITY
    this.log.warn('mod offline: no sync inside the live window')
    this.sink.state(offline)
  }

  private takeState(raw: unknown, at: string) {
    const parsed = SessionState.safeParse(raw)
    if (!parsed.success || parsed.data.source !== 'mod') {
      this.log.warn('mod sync: state dropped', { reason: parsed.success ? 'source is not mod' : 'did not fit' })
      return
    }
    this.state = { ...parsed.data, at }
    this.publishState()
  }

  private takeInventory(raw: unknown, at: string) {
    if (!isObj(raw)) {
      this.log.warn('mod sync: inventory dropped', { reason: 'not an object' })
      return
    }
    // Routes are computed here from (source, name), never taken from the mod (C4.2, review R3).
    const { commands, dropped } = inventoryCommandsFromEngine(raw.commands)
    const keep = <T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, list: unknown, max: number) =>
      (Array.isArray(list) ? list : [])
        .map((x) => schema.safeParse(x))
        .filter((r) => r.success)
        .map((r) => r.data as T)
        .slice(0, max)
    const candidate = {
      commands,
      models: keep(SessionInventory.shape.models.element, raw.models, 20),
      efforts: (Array.isArray(raw.efforts) ? raw.efforts : [])
        .filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length <= 16)
        .slice(0, 8),
      mcp_servers: keep(SessionInventory.shape.mcp_servers.element, raw.mcp_servers, 100),
      plugins: keep(SessionInventory.shape.plugins.element, raw.plugins, 200),
      ...(isObj(raw.codex) ? { codex: raw.codex } : {}),
      at,
    }
    const parsed = SessionInventory.safeParse(candidate)
    if (!parsed.success) {
      this.log.warn('mod sync: inventory dropped', { reason: 'did not fit' })
      return
    }
    if (dropped > 0) this.log.info('mod sync: commands dropped', { count: dropped })
    this.inventory = parsed.data
    if (!this.sentInventory || !sameInventory(this.sentInventory, parsed.data)) {
      this.sentInventory = parsed.data
      this.lastInventoryPublish = this.clock.now()
      this.sink.inventory(parsed.data)
    }
  }

  private takeEvents(raw: unknown[], at: string) {
    let dropped = 0
    let stateTouched = false
    const next = this.state ? structuredClone(this.state) : undefined // never mutate what was already sent
    for (const r of raw) {
      const p = ModEvent.safeParse(r)
      if (!p.success) {
        dropped++
        continue
      }
      const e = p.data
      if (next) stateTouched = this.applyEvent(next, e) || stateTouched
      this.sink.event?.(e)
    }
    if (dropped > 0) this.log.warn('mod sync: events dropped', { count: dropped })
    if (stateTouched && next) {
      this.state = { ...next, at }
      this.publishState()
    }
  }

  /** Applies an event to the held state in place; true when something changed. */
  private applyEvent(s: SessionStateT, e: ModEventT): boolean {
    switch (e.type) {
      case 'turn_start':
        s.busy = true
        s.turn_id = e.turn_id
        s.stopped_at_mac = false
        return true
      case 'turn_complete':
        s.busy = false
        if (s.turn_id === e.turn_id) delete s.turn_id
        return true
      case 'compacting':
        s.compacting = e.on
        return true
      case 'model_switched':
        s.model = { id: e.model }
        return true
      case 'effort_changed':
        if (e.effort === 'auto') delete s.effort
        else s.effort = e.effort
        return true
      case 'stopped_at_mac':
        s.stopped_at_mac = true
        s.busy = false
        delete s.turn_id
        return true
      case 'surfaces':
        s.surfaces = e.surfaces
        return true
      default:
        return false // prompt_open / prompt_closed carry no session state
    }
  }

  private takeResults(raw: unknown[]) {
    let dropped = 0
    for (const r of raw) {
      const p = ModControlResult.safeParse(r)
      if (p.success) this.sink.result?.(p.data)
      else dropped++
    }
    if (dropped > 0) this.log.warn('mod sync: results dropped', { count: dropped })
  }

  private publishState() {
    if (!this.state) return
    if (this.sentState && sameState(this.sentState, this.state)) return
    this.sentState = this.state
    this.lastStatePublish = this.clock.now()
    this.sink.state(this.state)
  }
}
