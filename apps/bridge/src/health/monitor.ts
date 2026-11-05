// The bridge's half of the health alarms (docs/V2-FEATURES.md V2.2). Every 60 s, and within 2 s of a change, the live
// bridge tells the relay what it is: version, whether the Talos mod is reporting, whether a TTS / STT command is set, and
// whether this Mac's SQLite has FTS5, and how many bytes are free on its disk. The relay watchdog decides what is worth a push; this side only reports.
//
// No content, ever: no thread names, no paths (free space is a bare number), no text. A test pins the beat's keys.
//
// Mod liveness is read from the existing mod link (`ModLink.live`, MOD_LIVE_WINDOW_MS = 30 s) once a second, so the link
// itself stays untouched. `expected` = the mod synced at some point in the last 7 days (kv `mod_seen_at`, written at most
// once a minute): it survives a restart, which is what lets "quiet" and "never installed" be told apart.
import type { Database } from 'bun:sqlite'
import { statfsSync } from 'node:fs'
import { DISK_LOW_BYTES, type Frame, type HealthBeatT, newUlid } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import type { HealthService } from '../v2-seams.ts'
import { BRIDGE_VERSION } from '../version.ts'

export const BEAT_EVERY_MS = 60_000
export const POLL_MS = 1_000
export const MOD_SEEN_KEY = 'mod_seen_at'
const MOD_EXPECTED_MS = 7 * 24 * 3600_000
const KV_WRITE_EVERY_MS = 60_000

/** FTS5 in the SQLite this process loaded (macOS's system library under Bun). A probe in a throwaway temp table. */
export function probeFts5(db: Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.talos_fts5_probe USING fts5(x)')
    db.exec('DROP TABLE temp.talos_fts5_probe')
    return true
  } catch {
    return false
  }
}

/** Free disk is read at most this often: it is a syscall, and the beat only needs it to the minute. */
const DISK_READ_EVERY_MS = 30_000

/**
 * Free bytes the bridge's volume has for an ordinary process (`bavail`, not `bfree`), or null when it cannot be read. A
 * number only: the path it was read from never leaves this function.
 */
export function readFreeBytes(path: string, statfs: typeof statfsSync = statfsSync): number | null {
  try {
    const s = statfs(path)
    const free = Number(s.bavail) * Number(s.bsize)
    return Number.isSafeInteger(free) && free >= 0 ? free : null
  } catch {
    return null
  }
}

export class HealthMonitor implements HealthService {
  readonly available = true
  private timer: unknown = null
  private stopped = true
  private readonly startedAt: number
  private lastModSeen: number | null = null
  private lastKvWrite = Number.NEGATIVE_INFINITY
  private lastSentAt = Number.NEGATIVE_INFINITY
  private lastKey = ''
  private fts5: boolean | null = null
  private disk: { at: number; free: number | null } | null = null

  constructor(
    private readonly ctx: BridgeContext,
    private readonly dep: { connected: () => boolean; freeBytes?: () => number | null },
  ) {
    this.startedAt = ctx.clock.now()
  }

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.ctx.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** The relay socket just became ready: tell it who we are at once. */
  onReady(): void {
    if (this.stopped) return
    this.observeMod()
    this.send()
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.ctx.clock.setTimeout(() => {
      this.timer = null
      try {
        this.tick()
      } catch (e) {
        this.ctx.log.warn('health tick failed', { error: (e as Error).message })
      }
      this.arm()
    }, POLL_MS)
  }

  private tick(): void {
    this.observeMod()
    if (!this.dep.connected()) {
      this.lastKey = '' // a reconnect starts with a fresh beat (onReady), whatever changed meanwhile
      return
    }
    const beat = this.build()
    const changed = this.keyOf(beat) !== this.lastKey
    if (changed || this.ctx.clock.now() - this.lastSentAt >= BEAT_EVERY_MS) this.send(beat)
  }

  /** Records that the mod is alive right now, and (rarely) persists that it has ever been. */
  private observeMod(): void {
    const now = this.ctx.clock.now()
    if (!this.ctx.mod.live) return
    this.lastModSeen = now
    if (now - this.lastKvWrite >= KV_WRITE_EVERY_MS) {
      this.lastKvWrite = now
      try {
        this.ctx.store.kvSet(MOD_SEEN_KEY, new Date(now).toISOString())
      } catch {
        // a locked store must not stop the beat
      }
    }
  }

  private seenFromKv(): number | null {
    const v = this.ctx.store.kvGet(MOD_SEEN_KEY)
    const t = v ? Date.parse(v) : Number.NaN
    return Number.isFinite(t) ? t : null
  }

  /** Free bytes, read at most every 30 s (null = unreadable: the field is then left out, never guessed). */
  private freeBytes(): number | null {
    const now = this.ctx.clock.now()
    if (this.disk && now - this.disk.at < DISK_READ_EVERY_MS) return this.disk.free
    const free = this.dep.freeBytes ? this.dep.freeBytes() : readFreeBytes(this.ctx.paths.home)
    this.disk = { at: now, free }
    return free
  }

  build(): HealthBeatT {
    const now = this.ctx.clock.now()
    const iso = (t: number) => new Date(t).toISOString()
    const kv = this.seenFromKv()
    const seen = this.lastModSeen ?? kv
    const live = this.ctx.mod.live
    const expected = live || (seen !== null && now - seen <= MOD_EXPECTED_MS)
    if (this.fts5 === null) this.fts5 = this.ctx.search ? this.ctx.search.available : probeFts5(this.ctx.store.db)
    const free = this.freeBytes()
    return {
      bridge: { version: BRIDGE_VERSION.slice(0, 40), started_at: iso(this.startedAt) },
      mod: {
        state: live ? 'alive' : expected ? 'quiet' : 'absent',
        last_seen: live ? iso(now) : expected && seen !== null ? iso(seen) : null,
        expected,
      },
      tts: Boolean(this.ctx.env.ttsCmd?.length),
      stt: Boolean(this.ctx.env.sttCmd?.length),
      sqlite: { fts5: this.fts5 },
      ...(free !== null ? { disk_free_bytes: free } : {}),
      ...this.relayDeclaredField(),
    }
  }

  /** Whether this session declared the permission relay at start (see PermissionRelay.markDeclared); left out until known. */
  private relayDeclaredField(): { permission_relay_declared?: boolean } {
    const d = this.ctx.permission?.declared
    return d === undefined ? {} : { permission_relay_declared: d }
  }

  /**
   * What counts as a change: everything but the clock-like `last_seen` of a live mod and the exact free bytes (they move
   * every second and would turn the 60 s beat into a beat per tick). Crossing the low line IS a change, so it goes out
   * within a poll, not at the next minute.
   */
  private keyOf(b: HealthBeatT): string {
    const { disk_free_bytes: free, ...rest } = b
    return JSON.stringify({
      ...rest,
      mod: { ...b.mod, last_seen: b.mod.state === 'alive' ? 'now' : b.mod.last_seen },
      disk_low: free !== undefined && free < DISK_LOW_BYTES,
    })
  }

  private send(beat: HealthBeatT = this.build()): void {
    const frame = {
      v: 1 as const,
      id: newUlid(),
      ts: new Date(this.ctx.clock.now()).toISOString(),
      type: 'health.beat' as const,
      beat,
    }
    const sent = this.ctx.transport.sendEphemeral(frame as Frame)
    if (!sent) return
    this.lastSentAt = this.ctx.clock.now()
    this.lastKey = this.keyOf(beat)
  }
}
