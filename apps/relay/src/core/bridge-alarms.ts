// The owner's alarms about the bridge key in use somewhere else: "another Mac took over" at once, and "your bridge key may be
// in use" after three replaces in an hour. Kept out of hub.ts, which only reports the replaces and the standby hellos.
import type { PushIntent } from '@talos-app/protocol'
import type { Clock } from '../services.ts'

export type BridgeAlarmDeps = {
  clock: Clock
  notify: (intent: PushIntent) => void
  /** The owner's configured time zone, if a config has arrived. */
  timezone: () => string | undefined
}

export class BridgeAlarms {
  private supersedes: number[] = []
  private lastSupersedeAlarm = 0
  private lastTakeoverAlarm = Number.NEGATIVE_INFINITY
  /** The last replace: when, and from which address. */
  private lastReplace: { at: number; by: string } | null = null

  constructor(private d: BridgeAlarmDeps) {}

  /**
   * A replaced bridge asked to come back (a verified standby hello), so it is alive. If the bridge that replaced it, still
   * holding the slot or gone within the last 10 minutes, came from another address, that is another Mac with this key, and
   * the owner is told at once with the time of the replace, at most once in 10 minutes (the replace window is 10 minutes too,
   * so one takeover is told once). A replace alone proves nothing: a Mac whose old socket died silently (a VPN or Wi-Fi
   * change) redials from a new address before the relay drops the old socket, and that same Mac never asks to come back. Two
   * bridges behind one address (the same NAT or VPN exit) are left to the three-in-an-hour bridge_key push below.
   */
  noteStandby(standby: string): void {
    const now = this.d.clock.now()
    const r = this.lastReplace
    if (!r || now - r.at > 10 * 60_000) return
    if (r.by === standby || now - this.lastTakeoverAlarm < 10 * 60_000) return
    this.lastTakeoverAlarm = now
    this.d.notify({ template: 'bridge_takeover', time: this.ownerClock(r.at) })
  }

  /** A hello from `by` replaced the connected bridge. Three in an hour raise the "bridge key may be in use" push, at most once an hour. */
  noteSupersede(by: string): void {
    const now = this.d.clock.now()
    this.lastReplace = { at: now, by }
    this.supersedes = this.supersedes.filter((t) => now - t < 3_600_000)
    this.supersedes.push(now)
    if (this.supersedes.length >= 3 && now - this.lastSupersedeAlarm > 3_600_000) {
      this.lastSupersedeAlarm = now
      this.d.notify({ template: 'bridge_key' })
    }
  }

  /** `HH:MM` in the owner's configured time zone, or undefined when there is no config or the zone cannot be read. */
  private ownerClock(nowMs: number): string | undefined {
    const tz = this.d.timezone()
    if (!tz) return undefined
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: tz,
      }).format(new Date(nowMs))
    } catch {
      return undefined
    }
  }
}
