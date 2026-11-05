// `$TALOS_APP_HOME/status.json` (DESKTOP-SPEC 6.2): the live bridge's health, written for the Mac menu bar and for
// `talos-app status` / `doctor` / `enroll`. Content-free by design: pid, mode and relay connection, never message text,
// ids of content or tokens.
//
// Only the LIVE bridge writes it. A worker or a headless process (`talos-app post`, `codex run`) never constructs a
// StatusWriter, so it cannot overwrite the live file. A bridge that was superseded (4409) writes one last `superseded`
// snapshot and stops, and even that write is skipped when a newer, living bridge has already written its own file.
import { existsSync } from 'node:fs'
import type { Clock } from './clock.ts'
import { readJsonFile, writeJsonAtomic } from './fsutil.ts'
import type { Logger } from './log.ts'

export type StatusMode = 'live' | 'headless' | 'superseded'

export type BridgeStatusFile = {
  v: 1
  pid: number
  instance: string
  started_at: string
  mode: StatusMode
  relay: { connected: boolean; last_connect_at: string | null; last_close_code: number | null }
  queue_depth: number
  /** What the owner saved. */
  permission_relay: boolean
  /** What this session told Claude Code at start. Differs from `permission_relay` after a switch: on needs a restart. */
  permission_relay_declared: boolean
  /** The 7-character commit the running process was started from (D61); null for a bridge that can't tell. */
  bridge_commit: string | null
  /** The session this bridge runs under carries CLAUDE_CODE_CHILD_SESSION, so Claude Code is not saving its transcript. */
  /** true: the session carries the marker. 'unknown': this Mac does not show process environments, so it could not be checked. */
  claude_session_marker_inherited: boolean | 'unknown'
  updated_at: string
}

/** The keys a reader may rely on (a test pins them). Nothing else is ever written. */
export const STATUS_KEYS = [
  'v',
  'pid',
  'instance',
  'started_at',
  'mode',
  'relay',
  'queue_depth',
  'permission_relay',
  'permission_relay_declared',
  'bridge_commit',
  'claude_session_marker_inherited',
  'updated_at',
] as const
export const STATUS_RELAY_KEYS = ['connected', 'last_connect_at', 'last_close_code'] as const

/** The readers (menu bar) call a file older than this stale: heartbeat well inside it. */
export const STATUS_HEARTBEAT_MS = 15_000
export const STATUS_FRESH_MS = 45_000

export type StatusSnapshot = Pick<
  BridgeStatusFile,
  'mode' | 'relay' | 'queue_depth' | 'permission_relay' | 'permission_relay_declared'
>

const defaultAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // alive, just not ours
  }
}

/** A file that parses as a status file of version 1, else undefined (torn, wrong shape, unknown version). */
export function parseStatusFile(raw: unknown): BridgeStatusFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const relay = o.relay as Record<string, unknown> | undefined
  if (o.v !== 1 || typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return undefined
  if (o.mode !== 'live' && o.mode !== 'headless' && o.mode !== 'superseded') return undefined
  if (!relay || typeof relay.connected !== 'boolean' || typeof o.updated_at !== 'string') return undefined
  if (Number.isNaN(Date.parse(o.updated_at))) return undefined
  return {
    v: 1,
    pid: o.pid,
    instance: typeof o.instance === 'string' ? o.instance : '',
    started_at: typeof o.started_at === 'string' ? o.started_at : '',
    mode: o.mode,
    relay: {
      connected: relay.connected,
      last_connect_at: typeof relay.last_connect_at === 'string' ? relay.last_connect_at : null,
      last_close_code: typeof relay.last_close_code === 'number' ? relay.last_close_code : null,
    },
    queue_depth: typeof o.queue_depth === 'number' ? o.queue_depth : 0,
    permission_relay: o.permission_relay === true,
    // an older bridge never wrote it: it declared whatever it had configured
    permission_relay_declared:
      typeof o.permission_relay_declared === 'boolean' ? o.permission_relay_declared : o.permission_relay === true,
    bridge_commit: typeof o.bridge_commit === 'string' && o.bridge_commit ? o.bridge_commit : null,
    // an older bridge never wrote it: absent reads as "not flagged"; an unrecognised value is not trusted as a clean answer
    claude_session_marker_inherited:
      o.claude_session_marker_inherited === true
        ? true
        : o.claude_session_marker_inherited === false || o.claude_session_marker_inherited === undefined
          ? false
          : 'unknown',
    updated_at: o.updated_at,
  }
}

export function readStatusFile(path: string): BridgeStatusFile | undefined {
  return existsSync(path) ? parseStatusFile(readJsonFile(path)) : undefined
}

export type BridgeLiveness =
  | { state: 'none' } // no file: no live bridge has run here (or it is an old bridge that never wrote one)
  | { state: 'live'; status: BridgeStatusFile; relayConnected: boolean; ageMs: number }
  | { state: 'stale'; status: BridgeStatusFile; ageMs: number } // pid alive but the file stopped updating
  | { state: 'dead'; status: BridgeStatusFile; ageMs: number } // the pid is gone: a fresh-looking file means nothing
  | { state: 'superseded'; status: BridgeStatusFile; ageMs: number }

/** What a reader should believe about the file. A dead pid beats a fresh stamp (DESKTOP-SPEC 6.2). */
export function bridgeLiveness(
  path: string,
  nowMs: number,
  alive: (pid: number) => boolean = defaultAlive,
): BridgeLiveness {
  const status = readStatusFile(path)
  if (!status) return { state: 'none' }
  const ageMs = nowMs - Date.parse(status.updated_at)
  if (!alive(status.pid)) return { state: 'dead', status, ageMs }
  if (status.mode === 'superseded') return { state: 'superseded', status, ageMs }
  if (status.mode !== 'live' || ageMs >= STATUS_FRESH_MS || ageMs < -5000) return { state: 'stale', status, ageMs }
  return { state: 'live', status, relayConnected: status.relay.connected, ageMs }
}

/** Is a bridge process alive here, and which commit did it say it started from (D61)? */
export function runningBridge(l: BridgeLiveness): { running: boolean; startedFrom: string | null } {
  if (l.state === 'live' || l.state === 'stale') return { running: true, startedFrom: l.status.bridge_commit }
  return { running: false, startedFrom: null }
}

export type StatusWriterOptions = {
  path: string
  clock: Clock
  log: Logger
  instance: string
  /** The commit this process started from; cached by the caller at start, never re-read. */
  commit?: string | undefined
  /** Computed once at start (the environment of a running process does not change). */
  sessionMarkerInherited?: boolean | 'unknown'
  snapshot: () => StatusSnapshot
  pid?: number
  alive?: (pid: number) => boolean
  heartbeatMs?: number
}

export class StatusWriter {
  private timer: unknown = null
  private last = ''
  private done = false
  private readonly startedAt: string
  private readonly pid: number

  constructor(private readonly o: StatusWriterOptions) {
    this.startedAt = new Date(o.clock.now()).toISOString()
    this.pid = o.pid ?? process.pid
  }

  /** Writes now, then every 15 s. */
  start() {
    if (this.done) return
    this.write(true)
    this.schedule()
  }

  /** Something changed (connected, closed, config): write now if the content differs from the last write. */
  poke() {
    if (this.done) return
    this.write(false)
  }

  /** The bridge lost its live role (4409): one last `superseded` snapshot, then never again. */
  supersede() {
    if (this.done) return
    this.stopTimer()
    this.done = true
    this.writeNow('superseded')
  }

  stop() {
    this.stopTimer()
    this.done = true
  }

  private stopTimer() {
    if (this.timer) this.o.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    if (this.done) return
    this.timer = this.o.clock.setTimeout(() => {
      this.write(true)
      this.schedule()
    }, this.o.heartbeatMs ?? STATUS_HEARTBEAT_MS)
  }

  /** A newer bridge that is still alive owns the file; an older one (about to go away) must not stamp over it. */
  private ownedByNewerBridge(): boolean {
    const existing = readStatusFile(this.o.path)
    if (!existing || existing.instance === this.o.instance) return false
    if (existing.started_at <= this.startedAt) return false
    return (this.o.alive ?? defaultAlive)(existing.pid)
  }

  private write(force: boolean) {
    this.writeNow(undefined, force)
  }

  private writeNow(modeOverride?: StatusMode, force = true) {
    try {
      const snap = this.o.snapshot()
      const mode = modeOverride ?? snap.mode
      const body = { ...snap, mode }
      const key = JSON.stringify(body)
      if (!force && key === this.last) return
      if (this.ownedByNewerBridge()) return
      const file: BridgeStatusFile = {
        v: 1,
        pid: this.pid,
        instance: this.o.instance,
        started_at: this.startedAt,
        mode,
        relay: body.relay,
        queue_depth: body.queue_depth,
        permission_relay: body.permission_relay,
        permission_relay_declared: body.permission_relay_declared,
        bridge_commit: this.o.commit ?? null,
        claude_session_marker_inherited: this.o.sessionMarkerInherited ?? false,
        updated_at: new Date(this.o.clock.now()).toISOString(),
      }
      writeJsonAtomic(this.o.path, file, 0o600)
      this.last = key
    } catch (e) {
      // a status file that cannot be written must never take the bridge down
      this.o.log.warn('status.json not written', { error: (e as Error).message })
    }
  }
}
