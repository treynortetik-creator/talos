// Trust mode on the bridge (docs/SECURITY.md "Trust mode"). The setting lives in config.json. The owner writes it: `talos-app trust on|off` at the Mac, or a signed
// config.patch from the app (the relay asks for the passkey on `on`); the agent never does; everything that relaxes a check asks `trustOn` here, so there is one place to look.
import { riskForTrust, trustOn } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice } from './context.ts'
import { isShareOnly } from './share-only.ts'
import { leadSpokeSince } from './worker/handoff.ts'

/** The one sentence the agent is given while the owner keeps "Lock Talos settings" on. */
export const SETTINGS_LOCKED =
  "Talos settings are locked, so I can't change them myself; the owner can unlock them in Settings."

/**
 * How long the owner's words (typed or spoken) count as "they just asked for this": two hours (owner ruling 2026-11-14: he should
 * not have to repeat himself), cut short by untrusted text arriving after them (see `ownerAskedIn`).
 */
export const OWNER_SPOKE_MS = 2 * 3600_000

const VOICE_KEY = (thread: string) => `voice_ask_at:${thread}`
const SEEN_KEY = 'trust_mode_seen'
const OUTSIDE_KEY = (thread: string) => `outside_text_at:${thread}`

/**
 * Records that outside text (`trust=external`: a hook event or digest, a share, an app's message or tool call, an integration
 * event, a call's tail) reached the agent in a thread: from then on the owner's earlier words there no longer count as his ask.
 * A `wake_me` note firing (`kind=wake`) counts the same way: it is the agent's own earlier words, which may carry what it read,
 * and the turn it starts is the agent's, not an answer to the owner. Called for every notification the bridge emits; the
 * agent's own replies are never emitted, so they never count.
 */
export function noteOutsideText(ctx: Pick<BridgeContext, 'store' | 'clock'>, n: { meta: Record<string, string> }) {
  const thread = n.meta.thread_id
  if ((n.meta.trust !== 'external' && n.meta.kind !== 'wake') || !thread) return
  try {
    ctx.store.kvSet(OUTSIDE_KEY(thread), String(ctx.clock.now()))
  } catch {
    // a store that refuses the write: the ask is judged on the rows alone, as before
  }
}
const LOCK_SEEN_KEY = 'settings_lock_seen'

/**
 * The passkey rule for a card this bridge mints. Off: `requested` goes through untouched (a bad value still fails the
 * card schema as before). On: only a `purchase` card is high.
 */
export function mintRisk<T>(config: Parameters<typeof trustOn>[0], kind: string, requested: T): T | 'low' | 'high' {
  return trustOn(config) ? riskForTrust(true, kind, 'low') : requested
}

/** A live call asked something in `thread`: calls are not stored as message rows, so the time is kept here. */
export function recordVoiceAsk(ctx: Pick<BridgeContext, 'store' | 'clock'>, thread: string) {
  ctx.store.kvSet(VOICE_KEY(thread), String(ctx.clock.now()))
}

/**
 * True when the owner (not a share) spoke in `threadId` in the last two hours, and no untrusted text arrived in THIS thread
 * after his words: no share here, and no hand-off from this thread's lead (its words may carry what it read). A share or a
 * hand-off in another thread does not wipe a request he just made here (Pantheon, 2026-11-14: that was the "you haven't
 * asked" friction, and outside text reaches the agent wrapped as data wherever it lands); main's own TASK to a lead is not
 * outside text at all. With
 * trust mode on, a spoken question on a live call counts like typing. This is a label-level check, not a guard: it cannot see
 * text the agent read for itself (a web page, a file). That is covered by outside text reaching the agent wrapped as data, and
 * by every change made this way being told to the owner at once with how to undo it.
 */
export function ownerAskedIn(ctx: Pick<BridgeContext, 'store' | 'clock' | 'config'>, threadId: string): boolean {
  const now = ctx.clock.now()
  const rows = ctx.store.ownerRowsSince(new Date(now - OWNER_SPOKE_MS).toISOString(), 200)
  let spoke = Number.NEGATIVE_INFINITY
  for (const m of rows) {
    if (m.thread_id !== threadId || isShareOnly(m)) continue
    const t = Date.parse(m.created_at)
    if (now - t < OWNER_SPOKE_MS && t > spoke) spoke = t
  }
  if (trustOn(ctx.config.config)) {
    const v = Number(ctx.store.kvGet(VOICE_KEY(threadId)))
    if (Number.isFinite(v) && v <= now && now - v < OWNER_SPOKE_MS && v > spoke) spoke = v
  }
  if (spoke === Number.NEGATIVE_INFINITY) return false
  // this thread's lead talking to main after the owner's words is another session's text, not the owner: it cancels them
  if (leadSpokeSince(ctx.store.db, threadId, spoke, now)) return false
  // and so does any outside text that reached the agent in this thread after them (noteOutsideText)
  const outside = Number(ctx.store.kvGet(OUTSIDE_KEY(threadId)))
  if (Number.isFinite(outside) && outside >= spoke) return false
  return !rows.some((m) => m.thread_id === threadId && isShareOnly(m) && Date.parse(m.created_at) > spoke)
}

/**
 * The thread the owner spoke in most recently (a share is not the owner speaking), within the same half hour, or undefined. A tool
 * the agent calls with no thread of its own (`create_thread`) asks in that thread, not always in the default one.
 */
export function lastOwnerThread(ctx: Pick<BridgeContext, 'store' | 'clock' | 'config'>): string | undefined {
  const now = ctx.clock.now()
  let best: { at: number; thread: string } | undefined
  for (const m of ctx.store.ownerRowsSince(new Date(now - OWNER_SPOKE_MS).toISOString(), 200)) {
    if (isShareOnly(m) || !ctx.config.thread(m.thread_id) || ctx.config.thread(m.thread_id)?.archived) continue
    const at = Date.parse(m.created_at)
    if (now - at < OWNER_SPOKE_MS && (!best || at > best.at)) best = { at, thread: m.thread_id }
  }
  return best?.thread
}

/**
 * Says so in the default thread when trust mode is not what the owner was last told: a flip while the bridge ran, or one
 * made while it was down. The agent runs as the same user, so its shell can still edit the file; this note, which the owner
 * sees whether the flip came from the app, the Mac's shell or a file edit, is how the owner finds out.
 */
/**
 * Like `noteTrustFlip`, for "Lock Talos settings": the owner is told when it changes, whatever changed it (the app, the agent
 * when he asked, or a hand edit of config.json the agent's shell could make). No new rule, only the notice.
 */
export async function noteLockFlip(ctx: BridgeContext): Promise<boolean> {
  if (ctx.mode !== 'live' || ctx.worker) return false
  const on = ctx.config.config.settings_lock === true
  const seen = ctx.store.kvGet(LOCK_SEEN_KEY)
  if (seen === undefined) {
    ctx.store.kvSet(LOCK_SEEN_KEY, on ? 'on' : 'off') // the first start knows nothing earlier: no notice
    return false
  }
  if (on === (seen === 'on')) return false
  ctx.store.kvSet(LOCK_SEEN_KEY, on ? 'on' : 'off')
  await postSystemNotice(
    ctx,
    on
      ? 'Lock Talos settings is on: your agent proposes setting changes on a card and changes nothing itself. Turn it off in Settings.'
      : 'Lock Talos settings is off: when you ask your agent to change a setting, it makes the change and tells you how to undo it.',
    { toAgent: true },
  )
  return true
}

/**
 * Like `noteLockFlip`, for the developer thread fence (protocol dev.ts): the owner is told in the default thread when it changes,
 * whatever changed it (Settings → Developer, the agent when he asked, a card, a hand edit of config.json). It takes effect at each
 * thread session's next start, and the line says so.
 */
export async function noteFenceFlip(ctx: BridgeContext): Promise<boolean> {
  if (ctx.mode !== 'live' || ctx.worker) return false
  const on = ctx.config.config.dev?.thread_fence !== false
  const seen = ctx.store.kvGet(FENCE_SEEN_KEY)
  if (seen === undefined) {
    ctx.store.kvSet(FENCE_SEEN_KEY, on ? 'on' : 'off') // the first start knows nothing earlier: no notice
    return false
  }
  if (on === (seen === 'on')) return false
  ctx.store.kvSet(FENCE_SEEN_KEY, on ? 'on' : 'off')
  await postSystemNotice(ctx, on ? FENCE_ON_TEXT : FENCE_OFF_TEXT, { toAgent: true })
  return true
}
export const FENCE_OFF_TEXT =
  "Thread fence off (Settings → Developer): a thread's own session and its sub-agents get the same access the main session has, the Talos home included, from their next start. Turn it back on there."
export const FENCE_ON_TEXT =
  "Thread fence on: a thread's own session and its sub-agents are kept out of the Talos home again, from their next start."
const FENCE_SEEN_KEY = 'dev_thread_fence_seen'

export async function noteTrustFlip(ctx: BridgeContext): Promise<boolean> {
  if (ctx.mode !== 'live' || ctx.worker) return false
  const on = trustOn(ctx.config.config)
  const seen = ctx.store.kvGet(SEEN_KEY) === 'on'
  if (on === seen) return false
  ctx.store.kvSet(SEEN_KEY, on ? 'on' : 'off')
  await postSystemNotice(
    ctx,
    on
      ? 'Trust mode is on. Your own messages now run without a card or passkey unless they send as you, spend money or delete for good. Turn it off in the app (Settings) or with: talos-app trust off'
      : 'Trust mode is off. Cards and passkey steps are back to the standard rules.',
    { toAgent: true },
  )
  return true
}
