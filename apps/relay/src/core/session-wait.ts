// A thread's session that has waited on the owner too long gets him one push (the owner's "stuck for hours with nothing
// telling me why", 2026-11-12). The bridge sends what each session waits on in `workers.status` (needs_you {kind, since}); this
// relay keeps the last one, and this watcher looks at it on each new status and once a minute.
//
//  * Due when `since` is SESSION_WAIT_PUSH_MS old, while the Mac's supervisor is reporting (a stale picture never pages him).
//  * Once per wait: `session_waited:<thread>:<since>` in core_state, so a relay restart repeats nothing and a new wait (a new
//    `since`) is a new notice. A key whose wait is over is dropped.
//  * Not for a thread with a pending card: the card already pushed "Needs you".
//  * Not for a usage limit that resets within SESSION_WAIT_PUSH_MS: it is about to clear by itself.
//  * Several sessions due in the same look (a usage limit hits them together): ONE push, "3 sessions are waiting on you",
//    and each wait is marked.
//  * Through CorePush: master switch, per-thread rules and the quiet window apply. Held back by a rule is not "sent": the next
//    look tries again, so a wait that is still on when the quiet window ends is told then, and one that ended is not.
//  * Every service refused: tried again after 1, 2, 4 and 8 minutes, MAX_TRIES sends in all, then given up.
import {
  type AgentConfigT,
  NEEDS_YOU_USAGE_LIMIT,
  type PushIntent,
  type StatusNeedsYouT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import type { Clock, Logger } from '../services.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import type { PushCounts } from './push.ts'
import type { Store } from './store.ts'

export const SESSION_WAIT_PUSH_MS = 10 * 60_000
export const SESSION_WAIT_TICK_MS = 60_000
const MAX_TRIES = 5
/** How long a push service keeps the push for a phone that is offline. */
export const PUSH_LIVES_MS = 2 * 60 * 60_000
const PREFIX = 'session_waited:'
/** Main's own wait: a key id no ThreadId can be (they never start with `@`). */
const MAIN_KEY = '@main'
/** How long a wait must be gone from the status before its mark is forgotten. */
const FORGET_MS = 2 * 60_000
const backoffMs = (tries: number) => 60_000 * 2 ** (tries - 1)

export type SessionWaitDeps = {
  store: Store
  clock: Clock
  log: Logger
  push: { notifyCounted(intent: PushIntent): Promise<PushCounts | null> }
  config: () => AgentConfigT | null
}

type Waiting = {
  thread: string
  key: string
  tries: number
  needs: StatusNeedsYouT
}

const keyOf = (thread: string, since: string) => `${PREFIX}${thread}:${since}`

export class SessionWait {
  private timer: unknown = null
  private stopped = true
  private running: Promise<void> | null = null
  private again = false
  private status: WorkersStatusT | undefined
  /** Keys absent from the latest status, and since when (in memory: a relay restart only waits a little longer). */
  private missing = new Map<string, number>()

  constructor(private d: SessionWaitDeps) {}

  start(): void {
    this.stopped = false
    this.arm()
    // one line at start, so a deploy can be checked from the relay's log
    this.d.log.info({ after_ms: SESSION_WAIT_PUSH_MS, tick_ms: SESSION_WAIT_TICK_MS }, 'session wait watcher started')
  }

  /** For /healthz: whether it is watching, and its two times. No thread, wait or count. */
  health(): { running: boolean; after_ms: number; tick_ms: number } {
    return {
      running: !this.stopped && this.timer !== null,
      after_ms: SESSION_WAIT_PUSH_MS,
      tick_ms: SESSION_WAIT_TICK_MS,
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** The bridge's latest `workers.status`, or undefined when the Mac went away. Looks at once. */
  update(status: WorkersStatusT | undefined): void {
    this.status = status
    void this.tick()
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.d.clock.setTimeout(() => {
      this.arm()
      void this.tick()
    }, SESSION_WAIT_TICK_MS)
  }

  /** One look. Never throws. A look asked for while one runs runs right after it; both callers get the same promise. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.scan()
        } while (this.again && !this.stopped)
      } catch (e) {
        this.d.log.error({ err: e instanceof Error ? e.name : 'error' }, 'session wait check failed')
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async scan(): Promise<void> {
    const { store, clock } = this.d
    const now = clock.now()
    const status = this.status
    // The Mac is not reporting: nothing is known to be waiting now, and nothing is forgotten either (it may come back still waiting).
    if (!status || !status.supervisor_online) return
    const cfg = this.d.config() ?? DEFAULT_AGENT_CONFIG
    const live = new Set<string>()
    const due: Waiting[] = []
    const carded = new Set(store.openCards(now).map((c) => c.thread_id))
    // Main's own wait counts like a thread's: its key is `@main`, and it answers in the default thread (where its push opens)
    const home = cfg.default_thread ?? 'general'
    const waits: Array<{ thread: string; keyId: string; needs: StatusNeedsYouT | undefined }> = [
      ...status.threads.map((t) => ({ thread: t.thread_id, keyId: t.thread_id, needs: t.needs_you })),
      { thread: home, keyId: MAIN_KEY, needs: status.main_needs_you },
    ]
    for (const w of waits) {
      const n = w.needs
      if (!n) continue
      const since = Date.parse(n.since)
      if (!Number.isFinite(since)) continue
      const key = keyOf(w.keyId, n.since)
      live.add(key)
      if (now - since < SESSION_WAIT_PUSH_MS) continue
      if (carded.has(w.thread)) continue
      // a thread whose notifications are off: the combined push carries no thread, so the rule is applied here
      if (cfg.threads.find((t) => t.id === w.thread)?.notify === 'off') continue
      if (n.kind === NEEDS_YOU_USAGE_LIMIT && n.resets_at) {
        const reset = Date.parse(n.resets_at)
        if (Number.isFinite(reset) && reset > now && reset - now < SESSION_WAIT_PUSH_MS) continue
      }
      const flag = store.getState(key)
      if (flag === 'sent') continue
      // refused before: `try:<sends so far>:<next try at, ms>`, backing off 1, 2, 4 and 8 minutes like the card reminder
      const [, triesText = '0', nextText = '0'] = flag?.split(':') ?? []
      const tries = Number(triesText) || 0
      if (now < (Number(nextText) || 0)) continue
      due.push({ thread: w.thread, key, tries, needs: n })
    }
    // A wait that is over leaves no key behind (a new wait has a new `since`), but only once it has been gone for FORGET_MS: one
    // look that misses it (the Mac app's status file read between writes, a wake) must not make the same wait a new notice.
    for (const key of store.stateKeys(PREFIX)) {
      if (live.has(key)) {
        this.missing.delete(key)
        continue
      }
      const gone = this.missing.get(key)
      if (gone === undefined) this.missing.set(key, now)
      else if (now - gone >= FORGET_MS) {
        store.deleteState(key)
        this.missing.delete(key)
      }
    }
    if (due.length === 0 || this.stopped) return

    const one = due.length === 1 ? due[0] : undefined
    // Kept by the push services at most PUSH_LIVES_MS (or until a usage limit resets, if sooner): a phone out of signal must
    // not get a time-sensitive "waiting on you" hours after the wait ended.
    let until = now + PUSH_LIVES_MS
    for (const w of due) {
      const reset = w.needs.resets_at ? Date.parse(w.needs.resets_at) : Number.NaN
      if (Number.isFinite(reset) && reset > now) until = Math.min(until, reset)
    }
    const expires_at = new Date(until).toISOString()
    const intent: PushIntent = one
      ? { template: 'session_waiting', thread_id: one.thread, expires_at }
      : { template: 'session_waiting', count: due.length, expires_at }
    // Fixed text only: a sealed copy reaches a phone for reply and card pushes, not for this kind.
    const res = await this.d.push.notifyCounted(intent)
    if (res === null) return // a rule held it back (quiet, master, thread off): look again next time
    const refused = res.sent > 0 && res.ok === 0
    for (const w of due)
      store.setState(
        w.key,
        refused && w.tries + 1 < MAX_TRIES ? `try:${w.tries + 1}:${now + backoffMs(w.tries + 1)}` : 'sent',
      )
  }
}
