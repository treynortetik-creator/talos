// The one way the bridge wakes Main on its own account (a bug report, a failed job). `fire(key, notification)` tells Main once
// per key. The wake is written down before it is sent, so a bridge that stops in between, or a channel that refuses, leaves it
// waiting: the bridge's poll (`tick`) sends it again, at most MAIN_WAKE_MAX_TRIES times. A crash between the send and the
// "delivered" mark can send one second copy (at least once, as `wake_me` is); the notice names its id so Main can tell.
// The same key never wakes twice while its row is kept (MAIN_WAKE_KEEP_MS), which is what makes a re-queued report quiet.
import type { Database } from 'bun:sqlite'
import type { Logger } from '../log.ts'
import type { Notification } from '../notify.ts'
import { MainWakeStore } from './store.ts'

export const MAIN_WAKE_MAX_TRIES = 5
export const MAIN_WAKE_KEEP_MS = 14 * 24 * 3600_000

export type FireResult = 'sent' | 'duplicate' | 'kept'

export type MainWakeDeps = {
  db: Database
  now: () => number
  emit: (n: Notification) => Promise<void>
  log: Pick<Logger, 'warn'>
  /** True once the bridge has begun to stop: nothing is sent, and no try is used up. */
  closing: () => boolean
  /** Called once when a wake is given up after MAIN_WAKE_MAX_TRIES, so what was lost is not lost silently. */
  onGiveUp?: (key: string, n: Notification) => void
}

export class MainWake {
  private readonly store: MainWakeStore
  /** Keys being sent right now, so two calls at the same moment cannot both send. */
  private readonly busy = new Set<string>()

  constructor(private readonly d: MainWakeDeps) {
    this.store = new MainWakeStore(d.db)
  }

  /**
   * Wakes Main with `n`, once for `key`. 'sent': handed to Main's channel now. 'duplicate': this key was already told (or is being
   * sent). 'kept': written down but not delivered (channel refused, or the bridge is stopping); `tick` sends it later.
   */
  async fire(key: string, n: Notification): Promise<FireResult> {
    if (this.busy.has(key)) return 'duplicate'
    const isNew = this.store.add(key, n, this.d.now())
    if (!isNew && this.store.get(key)?.delivered_at != null) return 'duplicate'
    // an old undelivered row for this key is sent with its own words, not the new ones
    const words = isNew ? n : (this.store.get(key)?.notification ?? n)
    return (await this.send(key, words)) ? 'sent' : 'kept'
  }

  /** The bridge's poll: sends what is still waiting, forgets what is old. Returns how many it delivered. */
  async tick(): Promise<number> {
    let sent = 0
    for (const row of this.store.pending()) {
      if (this.busy.has(row.key)) continue
      if (await this.send(row.key, row.notification)) sent++
    }
    this.store.pruneDelivered(this.d.now() - MAIN_WAKE_KEEP_MS)
    return sent
  }

  private async send(key: string, n: Notification): Promise<boolean> {
    if (this.d.closing()) return false
    this.busy.add(key)
    try {
      await this.d.emit(n)
    } catch (e) {
      if (this.d.closing()) return false
      const tries = this.store.bumpTries(key)
      if (tries >= MAIN_WAKE_MAX_TRIES) {
        this.d.log.warn('main wake not delivered; given up', { key, tries, error: (e as Error).message })
        this.store.remove(key)
        try {
          this.d.onGiveUp?.(key, n)
        } catch (err) {
          this.d.log.warn('main wake give-up not announced', { key, error: (err as Error).message })
        }
      } else
        this.d.log.warn('main wake not delivered; kept for the next poll', { key, tries, error: (e as Error).message })
      return false
    } finally {
      this.busy.delete(key)
    }
    this.store.markDelivered(key, this.d.now())
    return true
  }
}
