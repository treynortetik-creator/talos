// Health alarms, relay side (docs/V2-FEATURES.md V2.3; the hourly external check of V2.4 is dropped, owner 2026-10-29).
// The watchdog owns every Mac-side alert: `session_stopped` after 5 minutes without a bridge (once per outage, and not
// within MAC_ALERT_MIN_GAP_MIN of the previous one), `mac_back` only if a down push went out in that outage, `mod_quiet`
// once per outage. A Mac-side alert inside the quiet window is held; at the window's end the condition is re-checked and
// the alert is sent only if it still holds, so a laptop asleep all night produces nothing. The flags live in store state, so
// a redeploy does not repeat an alert. All of it is clock-driven (one poll), never a socket event: a laptop that opens and
// shuts five times an evening is one push.

import type { AgentConfigT } from '@talos-app/protocol'
import {
  DISK_LOW_BYTES,
  DISK_RECOVERED_BYTES,
  HEALTH_FEATURE,
  HealthBeat,
  type HealthBeatT,
  type HealthStatusT,
  isQuiet,
  type MacProblemT,
  type RelayProblemT,
} from '@talos-app/protocol'
import { bridgeAuthRefusedAt } from '../auth/contract.ts'
import type { RelayEnv } from '../env.ts'
import type { Bus, Clock, Logger } from '../services.ts'
import { VERSION } from '../version.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import { registerRelayFeature } from './features.ts'
import type { CorePush } from './push.ts'
import type { Store } from './store.ts'

/** The bridge counts as gone after this long (the hub's SESSION_STOPPED_AFTER_MS). */
export const BRIDGE_GONE_MS = 5 * 60_000
export const HEALTH_POLL_MS = 15_000

const STATE_KEY = 'health_watch'
const BEAT_KEY = 'health_beat'
const BEAT_AT_KEY = 'health_beat_at'

type Persisted = {
  /** When the last `session_stopped` went out (the min-gap rule). */
  last_mac_alert_at: number | null
  /** This outage has been dealt with (pushed or suppressed by the gap): no second look. */
  down_handled: boolean
  /** What the owner's phone last heard from us: "stopped" (down) or "back" (up). A "back" is owed while it says down. */
  heard: 'down' | 'up' | null
  /** `mod_quiet` went out in this quiet spell. */
  mod_notified: boolean
  /** `disk_low` went out in this episode; cleared only when free space is back above DISK_RECOVERED_BYTES. */
  disk_notified: boolean
}
const FRESH: Persisted = {
  last_mac_alert_at: null,
  down_handled: false,
  heard: null,
  mod_notified: false,
  disk_notified: false,
}

/** A beat gap longer than this means the bridge reconnected in between (it beats every 60 s). */
const BEAT_GAP_MS = 90_000

export type HealthDeps = {
  store: Store
  clock: Clock
  log: Logger
  env: RelayEnv
  bus: Pick<Bus, 'bridgeOnline' | 'onBridgeFrame'>
  push: CorePush
  config: () => AgentConfigT | null
  /** Media bytes + the database file: compared with VOLUME_SOFT_CAP_MB for `storage_full`. */
  storageBytes: () => number
}

export class HealthWatch {
  private st: Persisted
  private timer: unknown = null
  private stopped = true
  private readonly upSince: number
  /** A beat has arrived since the bridge last connected (an old stored beat says nothing about now). */
  private beatLive = false
  /** When the first beat of this bridge connection arrived: a mod quiet spell never counts from before it. */
  private beatLiveAt: number | null = null
  private lastBeatAt: number | null = null
  private wasOnline: boolean

  constructor(private d: HealthDeps) {
    this.upSince = d.clock.now()
    this.st = this.load()
    this.wasOnline = d.bus.bridgeOnline()
  }

  start(): void {
    this.stopped = false
    registerRelayFeature(HEALTH_FEATURE)
    this.d.bus.onBridgeFrame('health.beat', (frame) => {
      const at = this.d.clock.now()
      this.d.store.setState(BEAT_AT_KEY, String(at))
      if (!this.beatLive || this.lastBeatAt === null || at - this.lastBeatAt > BEAT_GAP_MS) this.beatLiveAt = at
      this.lastBeatAt = at
      this.beatLive = true
      // the hub keeps the beat itself (V2.3 rule 1); this keeps a copy that is always parsed
      this.d.store.setState(BEAT_KEY, JSON.stringify(frame.beat))
    })
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.d.clock.clearTimeout(this.timer)
    this.timer = null
  }

  // ---- watchdog ---------------------------------------------------------------------------------------------------

  private arm(): void {
    if (this.stopped) return
    this.timer = this.d.clock.setTimeout(() => {
      this.timer = null
      try {
        this.tick()
      } catch (e) {
        this.d.log.error({ err: e instanceof Error ? e.name : 'error' }, 'health tick failed')
      }
      this.arm()
    }, HEALTH_POLL_MS)
  }

  private quietNow(): boolean {
    const cfg = this.d.config() ?? DEFAULT_AGENT_CONFIG
    return isQuiet(new Date(this.d.clock.now()), cfg.quiet_window, cfg.timezone)
  }

  private fire(template: 'session_stopped' | 'mod_quiet' | 'mac_back' | 'disk_low'): void {
    this.d.push
      .notify({ template }, { fromHealth: true })
      .catch((e) => this.d.log.error({ err: e instanceof Error ? e.name : 'error', template }, 'health push failed'))
  }

  /** Bridge gone: its beat is no longer live. Also run by status(), so the app never reads a dead process's beat between ticks. */
  private noteOnline(): boolean {
    const online = this.d.bus.bridgeOnline()
    if (!online && this.wasOnline) {
      this.beatLive = false
      this.beatLiveAt = null
    }
    this.wasOnline = online
    return online
  }

  /** One look at the world. Public so a test (or a future event hook) can force an immediate evaluation. */
  tick(): void {
    const now = this.d.clock.now()
    // another instance on the same store may have moved the flags: always start from what the store says
    this.st = this.load()
    const online = this.noteOnline()
    const quiet = this.quietNow()
    if (online) {
      if (this.st.down_handled) this.update({ down_handled: false })
      // The phone last heard "stopped": a "back" is owed. It is held through the quiet window and survives blips and
      // redeploys; it is only superseded by a new "stopped" going out (which sets `heard` to down again anyway).
      if (this.st.heard === 'down' && !quiet) {
        this.update({ heard: 'up' })
        this.fire('mac_back')
      }
      this.modRule(now, quiet)
      this.diskRule(quiet)
      return
    }
    const downSince = this.downSince()
    if (downSince === null || this.st.down_handled || now - downSince < BRIDGE_GONE_MS) return
    if (quiet) return // held: re-evaluated on every poll, so it goes out only if the Mac is still gone when the window ends
    const gapMs = this.d.env.MAC_ALERT_MIN_GAP_MIN * 60_000
    const last = this.st.last_mac_alert_at
    // inside the gap: wait. A short outage ends before the gap does (silent); a long one is alerted when the gap runs out.
    if (last !== null && now - last < gapMs) return
    this.update({ down_handled: true, heard: 'down', last_mac_alert_at: now })
    this.fire('session_stopped')
  }

  private modRule(now: number, quiet: boolean): void {
    const m = this.modQuiet(now)
    if (!m) {
      if (this.st.mod_notified && this.beatLive) this.update({ mod_notified: false })
      return
    }
    if (this.st.mod_notified || quiet) return
    this.update({ mod_notified: true })
    this.fire('mod_quiet')
  }

  /**
   * The Mac's disk is nearly full: one push per episode. Only a beat from THIS bridge connection counts (an old stored one
   * says nothing about now), the quiet window holds it (re-checked every poll, so it goes out at the window's end if it
   * still holds), and the episode ends only when free space is back above DISK_RECOVERED_BYTES, so a disk hovering at the
   * line cannot push twice. A bridge too old to report free space never raises it.
   */
  private diskRule(quiet: boolean): void {
    const free = this.lastBeat()?.disk_free_bytes
    if (!this.beatLive || free === undefined) return
    if (free >= DISK_RECOVERED_BYTES) {
      if (this.st.disk_notified) this.update({ disk_notified: false })
      return
    }
    if (free >= DISK_LOW_BYTES || this.st.disk_notified || quiet) return
    this.update({ disk_notified: true })
    this.fire('disk_low')
  }

  /** Bridge online, a live beat, the mod expected and silent for longer than MOD_QUIET_MIN. */
  private modQuiet(now: number): boolean {
    const beat = this.lastBeat()
    if (!beat || !this.beatLive || !beat.mod.expected || beat.mod.state === 'alive') return false
    // the quiet spell counts from the mod's last sync OR the first beat of this connection, whichever is later: a Mac that
    // slept, or a bridge that restarted, has not had MOD_QUIET_MIN minutes of silence yet
    const heard = beat.mod.last_seen ? Date.parse(beat.mod.last_seen) : null
    const since = Math.max(heard ?? 0, this.beatLiveAt ?? this.beatAt() ?? 0)
    return since > 0 && now - since > this.d.env.MOD_QUIET_MIN * 60_000
  }

  /**
   * When the bridge went away. Never earlier than this process' start: a redeploy stops the hub before it can write the
   * close time, and the bridge needs its reconnect backoff to come back. The bridge gets BRIDGE_GONE_MS from our start.
   */
  private downSince(): number | null {
    const v = this.rawDownSince()
    return v === null ? null : Math.max(v, this.upSince)
  }
  private rawDownSince(): number | null {
    const v = Number(this.d.store.getState('bridge_last_seen') ?? 0)
    return v > 0 ? v : null
  }

  // ---- state ------------------------------------------------------------------------------------------------------

  private load(): Persisted {
    try {
      const v = JSON.parse(this.d.store.getState(STATE_KEY) ?? 'null') as Partial<Persisted> | null
      return {
        last_mac_alert_at: typeof v?.last_mac_alert_at === 'number' ? v.last_mac_alert_at : null,
        down_handled: v?.down_handled === true,
        heard:
          v?.heard === 'down' || v?.heard === 'up'
            ? v.heard
            : (v as { down_pushed?: boolean } | null)?.down_pushed
              ? 'down'
              : null,
        mod_notified: v?.mod_notified === true,
        disk_notified: v?.disk_notified === true,
      }
    } catch {
      return { ...FRESH }
    }
  }

  private update(patch: Partial<Persisted>): void {
    this.st = { ...this.st, ...patch }
    this.d.store.setState(STATE_KEY, JSON.stringify(this.st))
  }

  private lastBeat(): HealthBeatT | null {
    try {
      const p = HealthBeat.safeParse(JSON.parse(this.d.store.getState(BEAT_KEY) ?? 'null'))
      return p.success ? p.data : null
    } catch {
      return null
    }
  }
  private beatAt(): number | null {
    const v = Number(this.d.store.getState(BEAT_AT_KEY) ?? 0)
    return v > 0 ? v : null
  }

  // ---- GET /api/status --------------------------------------------------------------------------------------------

  status(): HealthStatusT {
    const now = this.d.clock.now()
    const online = this.noteOnline()
    const subs = this.d.store.listSubs(() => {}).length
    const ntfy = this.d.push.hasNtfy
    const out = this.d.push.outcome()
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
    const relayProblems: RelayProblemT[] = []
    if (this.d.storageBytes() > this.d.env.VOLUME_SOFT_CAP_MB * 1024 * 1024) relayProblems.push('storage_full')
    if (subs === 0 && !ntfy) relayProblems.push('no_alert_path')
    const beat = this.lastBeat()
    const downSince = online ? null : this.rawDownSince()
    const macProblems: MacProblemT[] = []
    if (!online && downSince !== null && now - downSince > BRIDGE_GONE_MS) macProblems.push('bridge_offline')
    if (online && this.modQuiet(now)) macProblems.push('mod_quiet')
    // A refusal counts only if it came after the bridge went away: a stray bad hello while the real bridge was online must
    // not show up later as "the server turned away its key" the first time the Mac sleeps.
    const refusedAt = online ? null : bridgeAuthRefusedAt()
    const refused = refusedAt !== null && (downSince === null || refusedAt > downSince) ? refusedAt : null
    const modBase = beat?.mod ?? { state: 'absent' as const, last_seen: null, expected: false }
    const mod =
      online && (this.beatLive || beat === null)
        ? beat
          ? modBase
          : { state: 'unknown' as const, last_seen: null, expected: false }
        : { ...modBase, state: 'unknown' as const }
    return {
      at: new Date(now).toISOString(),
      relay_ok: relayProblems.length === 0,
      relay_problems: relayProblems,
      relay: { version: VERSION, up_since: new Date(this.upSince).toISOString() },
      mac_problems: macProblems,
      bridge: {
        online,
        last_seen: online ? new Date(now).toISOString() : iso(this.rawDownSince()),
        down_since: iso(downSince),
        ...(refused !== null ? { auth_refused_at: iso(refused) } : {}),
      },
      mod,
      push: { subscriptions: subs, last_ok_at: iso(out.last_ok_at), last_error_at: iso(out.last_error_at) },
      ntfy,
      limits: {
        buffer_days: this.d.env.BUFFER_DAYS,
        upload_max_mb: this.d.env.MEDIA_MAX_MB,
        voice_daily_max_min: this.d.env.VOICE_DAILY_MAX_MIN,
        voice_session_max_min: this.d.env.VOICE_SESSION_MAX_MIN,
      },
      ...(beat
        ? {
            beat: {
              mod: beat.mod,
              tts: beat.tts,
              stt: beat.stt,
              sqlite: beat.sqlite,
              ...(beat.disk_free_bytes !== undefined ? { disk_free_bytes: beat.disk_free_bytes } : {}),
              // only from a beat on this bridge connection: the previous process's answer says nothing about the running session
              ...(beat.permission_relay_declared !== undefined && this.beatLive
                ? { permission_relay_declared: beat.permission_relay_declared }
                : {}),
              ...(beat.search ? { search: beat.search } : {}),
              ...(beat.memory ? { memory: beat.memory } : {}),
            },
          }
        : {}),
    }
  }
}
