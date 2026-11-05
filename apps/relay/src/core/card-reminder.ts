// Owner call O2: a card that waits on the owner must not die unseen. About an hour before a card expires, one reminder
// push (`card_expiring`, fixed text, no card title).
//
//  * Only a card that was given at least 2 hours to live: a card made to be short (an app card, `expires_in_s: 600`) is not
//    nagged about.
//  * Once. The "already reminded" flag is `core_state.card_reminded:<card id>`, so a relay restart repeats nothing.
//  * The push goes through `CorePush`, so the master switch, the quiet window and per-thread rules all apply (a thread set
//    to "needs you only" still gets it). Held back by a rule is not "reminded": the next look tries again while the card
//    lives, so a reminder that landed in the quiet window goes out when it ends, if the card still has time.
//  * A card whose expiry falls inside the quiet window gets its reminder BEFORE the window starts, not an hour before expiry
//    (that hour is quiet, so the push would be held and the card would die in the dark). Cards that expire when it is quiet
//    are 7 h 45 of every 24 on the default window, so this is common, not rare.
//  * Timers are the injected clock's, cleared by `stop()` (the runtime calls it), so nothing fires on a closed database.
import { type AgentConfigT, isQuiet, type PushIntent } from '@talos-app/protocol'
import type { Clock, Logger } from '../services.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import type { PushCounts } from './push.ts'
import type { Store } from './store.ts'

export const REMIND_LEAD_MS = 3_600_000
export const REMIND_MIN_LIFETIME_MS = 7_200_000
export const REMINDER_TICK_MS = 60_000
/** Pushes every service refused: tried this many times, then given up on. */
const MAX_TRIES = 5
const PREFIX = 'card_reminded:'
/** How far before the window starts an early reminder goes out: clear of the boundary and of the one-minute tick. */
const BEFORE_QUIET_MS = 600_000

export type CardReminderDeps = {
  store: Store
  clock: Clock
  log: Logger
  push: { notifyCounted(intent: PushIntent): Promise<PushCounts | null> }
  config: () => AgentConfigT | null
}

/**
 * When the reminder for a card that expires at `expires` is due. Normally one hour before. When the expiry itself is inside
 * the quiet window, the last stretch before it is quiet too, so the reminder is due shortly before that window began (found
 * by walking back minute by minute, at most a day). Never later than the normal time.
 */
export function reminderDueAt(expires: number, cfg: AgentConfigT): number {
  const normal = expires - REMIND_LEAD_MS
  const at = (t: number) => isQuiet(new Date(t), cfg.quiet_window, cfg.timezone)
  if (!at(expires)) return normal
  const step = 60_000
  for (let i = 1; i <= 24 * 60; i++) {
    const t = expires - i * step
    if (!at(t)) return Math.min(normal, t - BEFORE_QUIET_MS)
  }
  return normal
}

export class CardReminder {
  private timer: unknown = null
  private stopped = true
  private busy = false
  /** Due times already worked out, keyed by what they depend on, so a tick does not walk the window for every card. */
  private dueCache = new Map<string, number>()

  constructor(private d: CardReminderDeps) {}

  start(): void {
    this.stopped = false
    this.arm()
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.d.clock.setTimeout(() => {
      this.arm()
      void this.tick()
    }, REMINDER_TICK_MS)
  }

  /** One look at the open cards. Never throws. */
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      await this.scan()
    } catch (e) {
      this.d.log.error({ err: e instanceof Error ? e.name : 'error' }, 'card reminder failed')
    } finally {
      this.busy = false
    }
  }

  private async scan(): Promise<void> {
    const { store, clock } = this.d
    const now = clock.now()
    const cfg = this.d.config() ?? DEFAULT_AGENT_CONFIG
    const cfgKey = `${JSON.stringify(cfg.quiet_window)}|${cfg.timezone}`
    // A flag for a card that is no longer pending is dead weight (decided, superseded, swept).
    const pending = new Set(store.allPendingCards().map((c) => c.id))
    for (const key of store.stateKeys(PREFIX)) if (!pending.has(key.slice(PREFIX.length))) store.deleteState(key)

    for (const card of store.openCards(now)) {
      if (this.stopped) return
      const expires = Date.parse(card.expires_at)
      const created = Date.parse(card.created_at)
      if (!Number.isFinite(expires) || !Number.isFinite(created)) continue
      if (expires - created < REMIND_MIN_LIFETIME_MS) continue
      if (expires - now <= 0) continue
      const cacheKey = `${card.id}|${expires}|${cfgKey}`
      let due = this.dueCache.get(cacheKey)
      if (due === undefined) {
        due = reminderDueAt(expires, cfg)
        if (this.dueCache.size > 500) this.dueCache.clear()
        this.dueCache.set(cacheKey, due)
      }
      if (now < due) continue
      const key = `${PREFIX}${card.id}`
      const flag = store.getState(key)
      if (flag === 'sent') continue
      const tries = flag?.startsWith('try:') ? Number(flag.slice(4)) || 0 : 0
      const res = await this.d.push.notifyCounted({
        template: 'card_expiring',
        thread_id: card.thread_id,
        card_id: card.id,
        expires_at: card.expires_at,
      })
      if (res === null) continue // a rule held it back (quiet, master, thread off): look again next time
      if (res.sent > 0 && res.ok === 0) {
        store.setState(key, tries + 1 >= MAX_TRIES ? 'sent' : `try:${tries + 1}`)
        continue
      }
      store.setState(key, 'sent')
    }
  }
}
