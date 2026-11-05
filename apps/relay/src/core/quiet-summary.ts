// Owner call O7: the quiet window drops chat and card pushes, so the owner wakes up to nothing. This counts what it
// dropped and sends ONE fixed-template push when the window is over: "3 replies, 1 card waiting".
//
// Counts only. `PushIntent` has no free-text field on purpose, and nothing here stores a name, a title or a message: the
// held state is a reply count per thread and the random ids of the cards. (Per thread so the summary can leave out what the
// owner read before the window ended.) What it does not cover, by design: webhook events (the hooks
// digest, `overnight`, owns them) and schedule failures (the health watch holds those to the window's end).
//
// State lives in `core_state.quiet_held`, so a relay restart neither loses the counts nor sends the summary twice (the
// counts are taken off the books after the send).
import { type AgentConfigT, isNeedsYouTemplate, isQuiet, ownValue, type PushIntent } from '@talos-app/protocol'
import type { Clock, Logger } from '../services.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import type { PushCounts } from './push.ts'
import type { Store } from './store.ts'

const KEY = 'quiet_held'
/** How often the relay asks "is the window over?". A restart, a sleep or a changed window are all just the next look. */
export const SUMMARY_TICK_MS = 60_000
/** A summary every push service refuses is tried this many times, then dropped. */
const MAX_TRIES = 5
const MAX_CARD_IDS = 200

/** `replies` is the total; `by` splits it per thread (older saved state has no `by`: its replies are all unattributed). */
export type QuietHeld = { replies: number; by: Record<string, number>; cards: string[]; tries: number }

const empty = (): QuietHeld => ({ replies: 0, by: {}, cards: [], tries: 0 })
/** The key for a reply that named no thread. It is not capped by unread, since there is nothing to compare it to. */
const NO_THREAD = '*'
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)

export function readQuietHeld(store: Store): QuietHeld {
  const raw = store.getState(KEY)
  if (!raw) return empty()
  try {
    const v = JSON.parse(raw) as Partial<QuietHeld>
    const by: Record<string, number> = {}
    if (v.by && typeof v.by === 'object' && !Array.isArray(v.by))
      for (const [k, n] of Object.entries(v.by).slice(0, 500)) if (whole(n) > 0) by[k] = whole(n)
    return {
      replies: whole(v.replies),
      by,
      cards: Array.isArray(v.cards)
        ? v.cards.filter((x): x is string => typeof x === 'string').slice(0, MAX_CARD_IDS)
        : [],
      tries: Number.isFinite(v.tries) ? Math.max(0, Math.trunc(v.tries as number)) : 0,
    }
  } catch {
    return empty() // unreadable state is "nothing held", never a crash in the push path
  }
}

function writeQuietHeld(store: Store, h: QuietHeld): void {
  if (h.replies === 0 && h.cards.length === 0) store.deleteState(KEY)
  else store.setState(KEY, JSON.stringify(h))
}

/**
 * The quiet rule just skipped `intent`. Remember it, unless the push would have been dropped anyway for another reason:
 * a thread set to off, or set to "needs you only" for a reply. (The master switch is checked before the quiet window, so
 * a switched-off owner never gets here.) Only chat replies and cards count; every other template has its own path.
 */
export function holdForSummary(store: Store, intent: PushIntent, cfg: AgentConfigT): void {
  const needsYou = isNeedsYouTemplate(intent.template)
  const reply = intent.template === 'reply' || intent.template === 'answer_ready'
  if (!needsYou && !reply) return
  const thread = intent.thread_id ? cfg.threads.find((t) => t.id === intent.thread_id) : undefined
  if (thread?.notify === 'off') return
  if (thread?.notify === 'needs_you' && !needsYou) return
  const h = readQuietHeld(store)
  if (reply) {
    h.replies += 1
    const key = intent.thread_id ?? NO_THREAD
    h.by[key] = (h.by[key] ?? 0) + 1
  } else if (intent.card_id && !h.cards.includes(intent.card_id) && h.cards.length < MAX_CARD_IDS)
    h.cards.push(intent.card_id)
  else return
  writeQuietHeld(store, h)
}

export type QuietSummaryDeps = {
  store: Store
  clock: Clock
  log: Logger
  push: { notifyCounted(intent: PushIntent): Promise<PushCounts | null> }
  config: () => AgentConfigT | null
}

export class QuietSummary {
  private timer: unknown = null
  private stopped = true
  private busy = false

  constructor(private d: QuietSummaryDeps) {}

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
    }, SUMMARY_TICK_MS)
  }

  /** One look: if the window is over and something is held, say so once. Never throws. */
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      await this.once()
    } catch (e) {
      this.d.log.error({ err: e instanceof Error ? e.name : 'error' }, 'quiet summary failed')
    } finally {
      this.busy = false
    }
  }

  private async once(): Promise<void> {
    const { store, clock } = this.d
    const cfg = this.d.config() ?? DEFAULT_AGENT_CONFIG
    const now = clock.now()
    if (isQuiet(new Date(now), cfg.quiet_window, cfg.timezone)) return
    const held = readQuietHeld(store)
    if (held.replies === 0 && held.cards.length === 0) return
    // Master switch off: nothing is sent, and what was held is dropped (a week-old summary is worse than none).
    if (!cfg.notifications.master) {
      writeQuietHeld(store, empty())
      return
    }
    // A card the owner decided, or that expired, during the night is not "waiting".
    const open = new Set(store.openCards(now).map((c) => c.id))
    const cards = held.cards.filter((id) => open.has(id))
    // The same for a reply the owner has since read (on any device), or whose thread was turned off or to needs-you-only
    // meanwhile: it is not "waiting". What is reported is at most what is unread in each thread right now.
    const replies = this.waitingReplies(held, cfg)
    if (replies === 0 && cards.length === 0) {
      this.settle(held)
      return
    }
    const res = await this.d.push.notifyCounted({
      template: 'quiet_summary',
      replies,
      cards: cards.length,
    })
    // A push service that took none of them: try again next look, a few times. Anything else (sent, or held back because
    // the owner is looking at the app, or nobody is subscribed) settles it.
    if (res && res.sent > 0 && res.ok === 0) {
      const cur = readQuietHeld(store)
      if (cur.tries + 1 >= MAX_TRIES) this.settle(held)
      else writeQuietHeld(store, { ...cur, tries: cur.tries + 1 })
      return
    }
    this.settle(held)
  }

  private waitingReplies(held: QuietHeld, cfg: AgentConfigT): number {
    const unread = this.d.store.unreadByThread()
    let total = Math.max(0, held.replies - Object.values(held.by).reduce((a, n) => a + n, 0)) // saved before `by` existed
    for (const [id, n] of Object.entries(held.by)) {
      if (id === NO_THREAD) {
        total += n
        continue
      }
      const t = cfg.threads.find((x) => x.id === id)
      if (t?.notify === 'off' || t?.notify === 'needs_you') continue
      total += Math.min(n, ownValue(unread, id) ?? 0)
    }
    return total
  }

  /** Takes what was reported off the books, and only that: a count added while the push was in flight stays. */
  private settle(sent: QuietHeld): void {
    const cur = readQuietHeld(this.d.store)
    const by: Record<string, number> = {}
    for (const [k, n] of Object.entries(cur.by)) if (n - (sent.by[k] ?? 0) > 0) by[k] = n - (sent.by[k] ?? 0)
    writeQuietHeld(this.d.store, {
      replies: Math.max(0, cur.replies - sent.replies),
      by,
      cards: cur.cards.filter((id) => !sent.cards.includes(id)),
      tries: 0,
    })
  }
}
