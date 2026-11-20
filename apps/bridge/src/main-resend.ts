// The second delivery of an owner message to Main, asked for by the Mac's stall watchdog (apps/desktop Sources/TalosSupervisor/
// SupervisorUnstick.swift). When Main's model request hangs on a message, the Mac presses Esc in Main's pane and writes
// `main-resend.json` ({"v":1,"unseen_at":"<ISO time>"}) in the Talos home. The next poll of the live bridge reads it, removes it,
// and delivers again the owner messages Main was told about and has not read since: the same channel notification, by the same
// path (`Bridge.deliver`), never typed into the pane.
//
// There is no authenticated channel from the Mac to this bridge (status.json goes the other way), and the request file can be written by
// any process of the same user. So the bridge never takes the file's word that Main is stuck: it acts only when its own record shows the
// oldest unseen message has waited with no tool call from Main for `STALL_MIN_MS` (model_stall_s, or the shorter model_stall_blank_s only when the Mac's request says `blank: true`; a forged flag is the same accepted residual, but the default window stays narrow). A forged or early file
// can then at most re-deliver the owner messages already stalled, once. It answers every request it understood in `main-resend-result.json`
// (outcome sent or failed) so the Mac's line says only what happened.
//
// What it will not do:
//   - Act on a request for a message that is no longer the oldest unseen one (Main read it, or another is now oldest): stale.
//   - Act before the message has waited `STALL_MIN_MS`, or deliver anything but the owner messages told to Main since its last tool
//     call (`SeenTracker.unseenIds`): never one Main already took in.
//   - Act twice for one message: `unseen_oldest_at` stays the same while the message waits, so a second request for it is ignored.
//   - Act on anything it did not hold itself: only owner text and file notices of this process are kept (a bounded list), so
//     a request cannot make the bridge deliver anything but what the owner sent.
//   - Hide a failure: a request it cannot read, a message it no longer holds, and a delivery that fails each leave a log line.
import { readFileSync, unlinkSync } from 'node:fs'
import { MAIN_RESTART } from '@talos-app/protocol'
import type { Clock } from './clock.ts'
import type { BridgePaths } from './config.ts'
import { writeJsonAtomic } from './fsutil.ts'
import type { Logger } from './log.ts'
import type { Notification } from './notify.ts'

/** How many owner notices are held for a second delivery (the newest; a message older than that is not re-sent). */
export const HELD_MAX = 64
const RESENT_MEMORY = 256
/** How long the oldest unseen message must have waited before the bridge acts on a request: the spinner stall wait by default. */
export const STALL_MIN_MS = MAIN_RESTART.model_stall_s * 1000
/**
 * Only when the Mac says the stall is the blank-pane case (`blank: true`: no working line, the model's turn pending) or the missed turn
 * (`missed: true`: Main idle at its prompt after an empty thinking block, nothing pressed) the shorter wait.
 */
export const STALL_BLANK_MIN_MS = MAIN_RESTART.model_stall_blank_s * 1000
const KINDS = new Set(['text', 'file'])

export type ResendRequest = { unseenAt: number; blank: boolean; missed: boolean }

/** The request file's content, or null when it is not one (wrong shape, wrong version, a time that does not parse). */
export function parseRequest(raw: string): ResendRequest | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.v !== 1 || typeof o.unseen_at !== 'string') return null
  const at = Date.parse(o.unseen_at)
  return Number.isNaN(at) ? null : { unseenAt: at, blank: o.blank === true, missed: o.missed === true }
}

/** What `SeenTracker` keeps for a second delivery: the owner's notices by message id (newest last), and the messages already re-sent. */
export type ResendMemory = { held: Map<string, Notification>; done: number[] }
export const newResendMemory = (): ResendMemory => ({ held: new Map(), done: [] })

/** Every notice on its way to Main: the owner's own are kept (bounded to `HELD_MAX`). */
export function holdOwnerNotice(m: ResendMemory, n: Notification): void {
  if (n.meta.redelivered) return // a copy we made ourselves is never the original that a later resend would be built from
  const id = n.meta.message_id
  const trust = n.meta.trust
  if (!id || trust !== 'owner' || !KINDS.has(n.meta.kind ?? '')) return
  m.held.set(id, n)
  if (m.held.size > HELD_MAX) {
    const oldest = m.held.keys().next().value
    if (oldest !== undefined) m.held.delete(oldest)
  }
}

/** The line put before a re-delivered owner message, so Main can tell a resend from the owner repeating themselves. */
export const REDELIVERED_PREFIX =
  "(Talos sent this again because the last turn ended without an answer. If you already acted on it, don't do it twice.)"

/** The notice as it goes out the second time: the same owner trust and ids, marked in meta and in its first line. Never mutates the held one. */
export function redelivered(n: Notification, why: 'missed' | 'stall'): Notification {
  return { content: `${REDELIVERED_PREFIX}\n${n.content}`, meta: { ...n.meta, redelivered: why } }
}

export type ResendOutcome = 'sent' | 'failed'

/** One look at the request file (every poll of a live bridge). Returns how many notices were delivered again. */
export async function resendToMain(
  m: ResendMemory,
  seen: { oldestUnseenAt(): string | null; unseenIds(): string[]; lastStopAt(): string | null },
  ctx: { paths: Pick<BridgePaths, 'mainResend' | 'mainResendResult'>; log: Logger; clock: Clock },
  deliver: (n: Notification) => Promise<void>,
): Promise<number> {
  const { log } = ctx
  const file = ctx.paths.mainResend
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn('main resend request unreadable', { error: (e as Error).message })
    return 0
  }
  // gone before anything is done: a request is acted on once, whatever happens next
  try {
    unlinkSync(file)
  } catch (e) {
    log.warn('main resend request not removed, left alone', { error: (e as Error).message })
    return 0
  }
  const req = parseRequest(raw)
  if (!req) {
    log.warn('main resend request not understood, ignored')
    return 0
  }
  const answer = (outcome: ResendOutcome, delivered: number, why?: string) => {
    try {
      writeJsonAtomic(
        ctx.paths.mainResendResult,
        { v: 1, unseen_at: new Date(req.unseenAt).toISOString(), outcome, delivered, ...(why ? { why } : {}) },
        0o600,
      )
    } catch (e) {
      log.warn('main resend answer not written', { error: (e as Error).message })
    }
  }
  const refuse = (why: string, text: string) => {
    log.info(`main resend skipped: ${text}`)
    answer('failed', 0, why)
    return 0
  }
  const oldest = seen.oldestUnseenAt()
  if (oldest === null || Date.parse(oldest) !== req.unseenAt)
    return refuse('not_oldest', 'that message is no longer the oldest unseen one')
  if (ctx.clock.now() - req.unseenAt < (req.blank || req.missed ? STALL_BLANK_MIN_MS : STALL_MIN_MS))
    return refuse('too_early', 'the message has not waited long enough to be a stall')
  // The owner stopped the agent (a stop the mod answered ok) after this message reached Main: the turn ended because they ended it, not because a response went missing.
  const stop = seen.lastStopAt()
  if (req.missed && stop !== null && Date.parse(stop) >= req.unseenAt)
    return refuse('stopped', 'the owner stopped the agent after that message, so the turn did not go missing')
  if (m.done.includes(req.unseenAt)) return refuse('already', 'already delivered again for that message')
  m.done.push(req.unseenAt)
  if (m.done.length > RESENT_MEMORY) m.done.shift()
  let sent = 0
  let why: string | undefined
  for (const id of seen.unseenIds()) {
    const n = m.held.get(id)
    if (!n) {
      log.warn('main resend: a message Main was told about is no longer held, not sent again', { message_id: id })
      why = 'not_held'
      continue
    }
    try {
      await deliver(redelivered(n, req.missed ? 'missed' : 'stall'))
      sent++
    } catch (e) {
      log.warn('main resend: delivery failed', { message_id: id, error: (e as Error).message })
      why = 'delivery_failed'
      break
    }
  }
  log.info('main resend done', { delivered: sent })
  answer(sent > 0 && why === undefined ? 'sent' : 'failed', sent, why ?? (sent === 0 ? 'nothing_held' : undefined))
  return sent
}
