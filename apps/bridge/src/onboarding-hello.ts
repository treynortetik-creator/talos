// The agent's first hello at the end of the Mac app's setup. A HIDDEN first turn: the owner sees one quiet row in the thread
// ("Setting up your agent…"), never a bubble that looks like they wrote it, and the agent gets a FIXED template from the bridge.
//
// How it is asked for: the Mac app writes `$TALOS_APP_HOME/onboarding/hello.json` (the same kind of local request file as
// `auto-update/check-now.json`, the other way round): `{"v":1,"action":"hello","phone":"connected"|"not_connected","ts":<ISO>}`. There is
// no network route and no frame for it: nothing from the relay, a page, the web app, a peer or a client message can reach this, and
// the file can choose only between the two templates below, never any text. The file is trusted only for what it is: a real file (not a
// link) this user owns, that nobody else can write, small, one known shape with no other keys, and recent.
//
// What it is not: the owner's words. The notification is kind `onboarding`, trust `system`; it goes through none of the owner-message
// paths, so `last_owner_ts`, `last_owner_device` (agent-cli's since-owner-spoke gates) and the owner rows never move for it. The row it
// posts is author `system`.
//
// Exactly once per install: the claim is written to kv BEFORE anything is sent (one process, no await between the check and the write,
// so two polls cannot both pass), so a crash after the claim means no hello rather than two. Never when the owner has already written in
// the thread: the request is then settled as skipped and never asked again.
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type BridgeContext, defaultThreadRef, postSystemNotice } from './context.ts'
import { onboardingNotification } from './notify.ts'
import { say } from './owner-words.ts'

export const HELLO_FILE = 'hello.json'
export const HELLO_KV = 'onboarding_hello'
export const HELLO_ROW = 'Setting up your agent…'
const MAX_BYTES = 512
const MAX_AGE_MS = 10 * 60_000
const MAX_AHEAD_MS = 60_000

export type PhoneState = 'connected' | 'not_connected'

const OFFERS = [
  "learn a few rules you'd like me to always follow,",
  'get to know how you like things (short answers or detailed ones, your working hours),',
  'ask for a permission only when a task needs it, never all at once.',
]
export const HELLO_CHIPS = ["Let's set up my rules", 'What can you do?', 'Later']
/** With no phone connected the first suggested reply is the phone. */
export const HELLO_CHIPS_NO_PHONE = ['Connect my phone', ...HELLO_CHIPS]

/** The fixed text. Two variants and nothing else; no input but the phone state ever reaches it. */
export function onboardingText(phone: PhoneState): string {
  const here = say({ mac: 'this Mac', linux: 'this computer' })
  const opening =
    phone === 'connected'
      ? `Hi, I'm Talos. I'm running on ${here}, and your phone is connected, so you can reach me from either.`
      : `Hi, I'm Talos. I'm running on ${here}. Your phone isn't connected yet, and I'll help you with that next.`
  const chips = phone === 'connected' ? HELLO_CHIPS : HELLO_CHIPS_NO_PHONE
  const lines = [
    "This note is from Talos's setup, not from the owner. Setup just finished.",
    'Greet the owner in this chat now, once, in your own voice, with the reply tool, and say these things in this order:',
    opening,
    "You can start right away: just tell me what you'd like done. Whenever you have a minute, I can also:",
    ...OFFERS.map((o) => `- ${o}`),
    'What should we do first?',
    `End with ${chips.length === 4 ? 'four' : 'three'} short lines the owner can answer with, in this order: ${chips.map((c) => `"${c}"`).join(', ')}.`,
  ]
  if (phone === 'not_connected')
    lines.push(
      "Their phone isn't connected. After the hello, lead them through connecting it one step at a time, with a card for each step, in plain words: no addresses, no servers, nothing technical.",
    )
  return lines.join('\n')
}

export type Verdict = { ok: true; phone: PhoneState } | { ok: false; why: string }

/** Judges the request file by what it is. Pure of the bridge; `uid` and `now` are seams for a test. */
export function readRequest(path: string, now: number, uid: number | undefined = process.getuid?.()): Verdict {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return { ok: false, why: 'missing' }
  }
  if (!st.isFile() || st.isSymbolicLink()) return { ok: false, why: 'not a plain file' }
  if (uid !== undefined && st.uid !== uid) return { ok: false, why: 'not this user’s file' }
  if ((st.mode & 0o022) !== 0) return { ok: false, why: 'others can write it' }
  if (st.size > MAX_BYTES) return { ok: false, why: 'too big' }
  let o: unknown
  try {
    o = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ok: false, why: 'not JSON' }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, why: 'not an object' }
  const r = o as Record<string, unknown>
  // exactly these keys: a request that carries anything else (a `text`, say) is not ours
  if (Object.keys(r).some((k) => !['v', 'action', 'phone', 'ts'].includes(k)))
    return { ok: false, why: 'unknown field' }
  if (r.v !== 1 || r.action !== 'hello') return { ok: false, why: 'wrong version or action' }
  if (r.phone !== 'connected' && r.phone !== 'not_connected') return { ok: false, why: 'unknown phone state' }
  const at = typeof r.ts === 'string' ? Date.parse(r.ts) : Number.NaN
  if (!Number.isFinite(at)) return { ok: false, why: 'no time' }
  if (at > now + MAX_AHEAD_MS) return { ok: false, why: 'from the future' }
  if (now - at > MAX_AGE_MS) return { ok: false, why: 'stale' }
  return { ok: true, phone: r.phone }
}

export type HelloOutcome = 'none' | 'sent' | 'already' | 'owner_wrote' | 'refused' | 'not_live'

/**
 * Looks for the request and, when it is good and the hello was never made, makes it. Called from the bridge's poll (and a few
 * seconds after it starts). Never throws.
 */
export async function pollOnboardingHello(ctx: BridgeContext, dir: string): Promise<HelloOutcome> {
  // only the live main bridge talks to main; a thread's worker or a headless one leaves the request where it is
  if (ctx.mode !== 'live' || ctx.worker) return 'not_live'
  const file = join(dir, HELLO_FILE)
  let verdict: Verdict
  try {
    lstatSync(file)
  } catch {
    return 'none'
  }
  try {
    const now = ctx.clock.now()
    verdict = readRequest(file, now)
    // the request is read once: whatever it said, it is not read again
    try {
      unlinkSync(file)
    } catch {
      // already gone
    }
    if (!verdict.ok) {
      ctx.log.warn('onboarding request refused', { why: verdict.why })
      return 'refused'
    }
    if (ctx.store.kvGet(HELLO_KV) !== undefined) return 'already'
    const thread = defaultThreadRef(ctx)
    const iso = new Date(now).toISOString()
    // the owner already wrote here: no hello, now or ever (settled, so a later request cannot sneak it in)
    const wrote = ctx.store.previousOwnerAt(thread.id, new Date(now + 1000).toISOString()) !== undefined
    if (wrote) {
      ctx.store.kvSet(HELLO_KV, JSON.stringify({ state: 'owner_wrote', at: iso }))
      return 'owner_wrote'
    }
    // the claim, before anything goes out: no await between the check above and this write
    ctx.store.kvSet(HELLO_KV, JSON.stringify({ state: 'sent', phone: verdict.phone, at: iso }))
    await postSystemNotice(ctx, HELLO_ROW, { thread, silent: true })
    await ctx.emit(
      onboardingNotification({
        thread,
        text: onboardingText(verdict.phone),
        ts: iso,
        id: `onb_${now.toString(36)}`,
      }),
    )
    return 'sent'
  } catch (e) {
    ctx.log.warn('onboarding hello failed', { error: (e as Error).message })
    return 'refused'
  }
}
