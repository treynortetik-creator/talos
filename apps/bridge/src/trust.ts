// Trust mode on the bridge (docs/SECURITY.md "Trust mode"). The setting lives in config.json. The owner writes it: `talos-app trust on|off` at the Mac, or a signed
// config.patch from the app (the relay asks for the passkey on `on`); the agent never does; everything that relaxes a check asks `trustOn` here, so there is one place to look.
import { type MessageT, riskForTrust, trustOn } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice } from './context.ts'
import { isShareOnly } from './share-only.ts'
import { handoffSince } from './worker/handoff.ts'

/** How long the owner's words (typed or spoken) count as "they just asked for this". */
export const OWNER_SPOKE_MS = 30 * 60_000

const VOICE_KEY = (thread: string) => `voice_ask_at:${thread}`
const SEEN_KEY = 'trust_mode_seen'

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
 * True when the owner (not a share) spoke in `threadId` in the last half hour, and no share landed in ANOTHER thread after
 * that (the agent chooses the thread it proposes into, so words in `general` must not vouch for a proposal that something
 * untrusted in `inbox` steered), and no hand-off between sessions was recorded after it (an agent's words, any thread). With trust mode on, a spoken question on a live call counts like typing. This is a
 * label-level check, not a guard: it cannot see text the agent read for itself (a web page, a file), which is why a
 * schedule change keeps its card even in trust mode.
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
  // An agent's hand-off after the owner's words is another session talking, not the owner: it cancels them like a share
  if (handoffSince(ctx.store.db, spoke, now)) return false
  return !rows.some((m) => m.thread_id !== threadId && isShareOnly(m) && Date.parse(m.created_at) > spoke)
}

/**
 * Says so in the default thread when trust mode is not what the owner was last told: a flip while the bridge ran, or one
 * made while it was down. The agent runs as the same user, so its shell can still edit the file; this note, which the owner
 * sees whether the flip came from the app, the Mac's shell or a file edit, is how the owner finds out.
 */
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
