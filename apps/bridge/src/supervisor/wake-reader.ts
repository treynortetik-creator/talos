// The Linux reader of a thread's wake and control (workers/<id>/wake, workers/<id>/control; control first), on the shared decision (packages/protocol wake-decision.ts; the Mac's
// WorkerWakes.takeWakes reads the same way). A wake is a request the bridge writes; any code running as the same user could write
// one too, so the reader does not trust it for what it claims: it takes it once (renamed aside to a name nobody can guess, read
// with one open that refuses a link, a small regular file only; anything dropped is audited), drops one too old or from the
// future, refuses a fresh start while the session is busy and a restart or fresh start past its own gap and hourly cap, and has
// the rest carried out. Parks, resumes and pointers are never refused but as stale.
// The notice of record (the bridge's own is de-duplicated against it) says what was carried out, judged from what changed once it
// ran, never from the request alone (Fable R1-1): a start held or refused, or a park of a session already resting, says nothing
// and is audited `wake_no_effect`. Its post is retried on later ticks while the relay refuses it (R1-2).
// Its own state per thread (workers/<id>/wake-state.json, 0600, the shared WakeState shape: the bridge reads it to refuse up front).
import { randomBytes } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  WAKE_STATE_TAKEN_MAX,
  type WakeCappedActionT,
  WakeFile,
  type WakeFileT,
  WakeState,
  type WakeStateT,
  WORKER_FILES,
  wakeAudit,
  wakeDecision,
  wakeHeldDroppedText,
  wakeHeldText,
} from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import { workerDir } from '../worker/files.ts'
import { readSmallFile } from './worker-dialogs.ts'
import type { PostOutcome } from './worker-notices.ts'

const WAKE_MAX_BYTES = 4096
const STATE_MAX_BYTES = 4096
/** A notice of record the relay refused is tried again on later ticks, at most this many times in all. */
export const WAKE_NOTICE_TRIES = 5

export type WakeDropWhy = 'unreadable' | 'not_json' | 'bad_shape' | 'other_thread'
export type WakeTake = { wake: WakeFileT } | { dropped: WakeDropWhy; fields?: string } | null

/**
 * Takes this thread's wake, once: renamed aside to a random name first (a wake the hub writes meanwhile is a new file, kept for the
 * next take), then read (no link, a regular file of at most 4096 bytes) and deleted. One that cannot be read, does not parse or
 * names another thread is dropped and never acted on, with why (for a bad shape, the names of the fields at fault, never values).
 */
export function takeWakeFile(
  home: string,
  threadId: string,
  file: typeof WORKER_FILES.wake | typeof WORKER_FILES.control = WORKER_FILES.wake,
): WakeTake {
  const dir = workerDir(home, threadId)
  const taken = join(dir, `${file}.taken.${randomBytes(8).toString('hex')}`)
  try {
    renameSync(join(dir, file), taken)
  } catch {
    return null // no wake
  }
  const f = readSmallFile(taken, WAKE_MAX_BYTES)
  rmSync(taken, { recursive: true, force: true })
  if (f.kind !== 'data') return { dropped: 'unreadable' }
  let raw: unknown
  try {
    raw = JSON.parse(f.text)
  } catch {
    return { dropped: 'not_json' }
  }
  const r = WakeFile.safeParse(raw)
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? 'file')))].slice(0, 5).join(',')
    return { dropped: 'bad_shape', fields: fields.replace(/[^A-Za-z0-9_,]/g, '').slice(0, 80) }
  }
  if (file === WORKER_FILES.control && r.data.action === 'pointer') return { dropped: 'bad_shape', fields: 'action' } // a tap, never a message
  return r.data.thread_id === threadId ? { wake: r.data } : { dropped: 'other_thread' }
}

/** The reader's state for a thread: none when missing, and, as the protocol says, none when it does not parse (audited). */
function readState(home: string, threadId: string): { st: WakeStateT; unreadable: boolean } {
  const f = readSmallFile(join(workerDir(home, threadId), WORKER_FILES.wakeState), STATE_MAX_BYTES)
  const none = { v: 1 as const, taken: [] }
  if (f.kind === 'absent') return { st: none, unreadable: false }
  try {
    if (f.kind === 'data') {
      const r = WakeState.safeParse(JSON.parse(f.text))
      if (r.success) return { st: r.data, unreadable: false }
    }
  } catch {
    // unreadable, below
  }
  return { st: none, unreadable: true }
}

/**
 * What the reader needs of a thread's session: its state, a park waiting for its turn (and its deadline), a start queued after a
 * park, a start held for a session slot.
 */
export type WakeSession =
  | { entry: { state: string }; turnWait?: unknown; afterPark?: unknown; held?: unknown }
  | undefined
const look = (w: WakeSession) => ({
  state: w?.entry.state ?? 'off',
  // the whole wait, its deadline too: a tap that shortens a governor park's wait is carried out (Fable R2-3)
  turnWait: JSON.stringify(w?.turnWait ?? null),
  afterPark: JSON.stringify(w?.afterPark ?? null),
  // what the hold will start, not when it began: a control that joins a hold changes it (fresh, or no longer only the pointer's)
  held: w?.held
    ? JSON.stringify({
        fresh: (w.held as { fresh?: unknown }).fresh,
        forPointer: (w.held as { forPointer?: unknown }).forPointer,
      })
    : '',
})
type Look = ReturnType<typeof look>
/** Something was carried out (or is under way): the session moved, a park began (or changed) its wait, a start was queued. */
function carriedOut(before: Look, after: Look): boolean {
  if (after.state === 'failed') return false // a start that failed has its own line (startRefused) and audit
  return before.state !== after.state || before.turnWait !== after.turnWait || before.afterPark !== after.afterPark
}
const STARTED = ['starting', 'live', 'busy']

/** A notice the relay refused is tried again after these waits (ms), then given up: WAKE_NOTICE_TRIES in all (Fable R2-2). */
export const WAKE_NOTICE_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]
/** At most one refusal line per thread in this time; the rest are audited only (a writer dropping one a tick floods nothing). */
export const WAKE_REFUSAL_LINE_GAP_MS = 60_000

/** A restart, resume or fresh start held for a session slot: said when it starts, or when the hold is dropped. */
type Waiting = { action: string; notice: string | undefined; dropped: string }
type Owed = { thread: string; action: string; text: string; tries: number; at: number }

export class WakeReader {
  /** Notices of record the relay refused, tried again once their wait is over. */
  private readonly owed: Owed[] = []
  private readonly waiting = new Map<string, Waiting>()
  private readonly refusalSaid = new Map<string, number>()
  constructor(
    private readonly d: {
      home: string
      audit: (e: string, f?: Record<string, string>) => void
      wallMs: () => number
      /** One line in the thread, the supervisor's own row; undefined: nothing posts (the line is audited unsent). */
      post: (thread: string, text: string) => Promise<PostOutcome> | undefined
    },
  ) {}

  /**
   * The thread's wake, if any: decided, carried out by `act` when it may be, and said. `session()`: the thread's session now, if
   * any; it is idle unless it is in a turn, or a park waits for its turn to end. Called for every thread each tick: a start held
   * for a slot is said once it runs (or is dropped), and refused lines are tried again. Two files, each taken by the same rename:
   * `control` (the owner's tap) first, then `wake` (a message pointer), so a tap and a message that landed before one tick are both
   * carried out, the tap first (BSUP-5). One that is dropped does not stop the other.
   */
  async take(threadId: string, session: () => WakeSession, act: (w: WakeFileT) => Promise<void>): Promise<void> {
    this.retryOwed()
    this.settleWaiting(threadId, session())
    await this.takeFile(WORKER_FILES.control, threadId, session, act)
    await this.takeFile(WORKER_FILES.wake, threadId, session, act)
  }

  private async takeFile(
    file: typeof WORKER_FILES.wake | typeof WORKER_FILES.control,
    threadId: string,
    session: () => WakeSession,
    act: (w: WakeFileT) => Promise<void>,
  ): Promise<void> {
    const got = takeWakeFile(this.d.home, threadId, file)
    if (got === null) return
    if ('dropped' in got) {
      const f: Record<string, string> = { thread: threadId, why: got.dropped }
      if (got.fields) f.fields = got.fields
      return this.d.audit('wake_dropped', f)
    }
    const wake = got.wake
    if (wake.action === 'pointer') return act(wake) // always taken, never counted, no line (its staleness is onWake's)
    const w0 = session()
    const idle = w0?.entry.state !== 'busy' && !w0?.turnWait
    const { st, unreadable } = readState(this.d.home, threadId)
    if (unreadable) this.d.audit('wake_state_unreadable', { thread: threadId })
    const recentTaken = st.taken.map((t) => t.at)
    const dec = wakeDecision({ wake, now: this.d.wallMs(), recentTaken, threadIdle: idle })
    if (!dec.take) {
      this.d.audit(dec.audit, { ...wakeAudit(wake, dec.why) })
      if (dec.notice) this.sayRefusal(threadId, wake.action, dec.notice)
      return
    }
    if (dec.counted) {
      // recorded before it is carried out: a restart or fresh start whose count cannot be written down is not carried out (the
      // cap must hold). A park or resume writes nothing and is never refused but as stale (a lost governor park costs plan usage).
      // Counted whatever it then does: the count bounds a loop of requests, and a held start is part of one too.
      const taken = [...st.taken, { at: Date.parse(wake.at), action: wake.action as WakeCappedActionT }]
      const next: WakeStateT = { v: 1, taken: taken.slice(-WAKE_STATE_TAKEN_MAX) }
      try {
        writeFileAtomic(join(workerDir(this.d.home, threadId), WORKER_FILES.wakeState), JSON.stringify(next), 0o600)
      } catch (e) {
        this.d.audit('wake_state_not_written', {
          thread: threadId,
          action: wake.action,
          error: String((e as Error)?.message ?? e),
        })
        return
      }
    }
    const before = look(w0)
    await act(wake)
    const after = look(session())
    // held for a session slot (another session may be parked to make room), or a hold this control joined and changed (made it
    // fresh, or no longer only the pointer's): said now, and its line of record, the newest control's, when it runs (Fable R2-1,
    // R3-1). A hold the control left as it was (a restart joining a held resume) is no change.
    if (after.held && after.held !== before.held && wake.action !== 'park') {
      this.waiting.set(threadId, { action: wake.action, notice: dec.notice, dropped: wakeHeldDroppedText(wake.action) })
      this.d.audit('wake_held', { thread: threadId, action: wake.action })
      return this.say(threadId, wake.action, wakeHeldText({ ...wake, action: wake.action }), 1)
    }
    if (!carriedOut(before, after))
      return this.d.audit('wake_no_effect', { thread: threadId, action: wake.action, state: after.state })
    if (dec.notice) this.say(threadId, wake.action, dec.notice, 1)
  }

  /**
   * A held start that has now run says its line of record. One whose hold went without a start: a start that failed has its own
   * line (startRefused) and says nothing more here; any other (the hold ran out, the thread left the list) says it was dropped
   * (Fable R3-2).
   */
  private settleWaiting(threadId: string, w: WakeSession): void {
    const h = this.waiting.get(threadId)
    if (!h) return
    const l = look(w)
    if (STARTED.includes(l.state)) {
      this.waiting.delete(threadId)
      if (h.notice) this.say(threadId, h.action, h.notice, 1)
    } else if (!l.held) {
      this.waiting.delete(threadId)
      this.d.audit('wake_no_effect', { thread: threadId, action: h.action, state: l.state })
      if (l.state !== 'failed') this.say(threadId, h.action, h.dropped, 1)
    }
  }

  /** A refusal's line: at most one per thread per WAKE_REFUSAL_LINE_GAP_MS; the rest are audited only. */
  private sayRefusal(thread: string, action: string, text: string): void {
    const now = this.d.wallMs()
    const last = this.refusalSaid.get(thread)
    if (last !== undefined && now - last >= 0 && now - last < WAKE_REFUSAL_LINE_GAP_MS) {
      this.d.audit('wake_notice', { thread, action, outcome: 'not_said_again' })
      return
    }
    this.refusalSaid.set(thread, now)
    this.say(thread, action, text, 1)
  }

  /** Posts one notice; one the relay refused is tried again after its wait, up to WAKE_NOTICE_TRIES; `unknown` is never resent. */
  private say(thread: string, action: string, text: string, tries: number): void {
    const p = this.d.post(thread, text)
    if (!p) {
      this.d.audit('wake_notice', { thread, action, outcome: 'unsent' })
      return
    }
    const done = (outcome: PostOutcome) => this.posted({ thread, action, text, tries, at: 0 }, outcome)
    void p.then(done, () => done('failed'))
  }

  private posted(o: Owed, outcome: PostOutcome): void {
    this.d.audit('wake_notice', { thread: o.thread, action: o.action, outcome, tries: String(o.tries) })
    if (outcome !== 'failed' || o.tries >= WAKE_NOTICE_TRIES) return
    const wait = WAKE_NOTICE_BACKOFF_MS[o.tries - 1] ?? (WAKE_NOTICE_BACKOFF_MS.at(-1) as number)
    this.owed.push({ ...o, at: this.d.wallMs() + wait })
  }

  /** Every owed line whose wait is over, whichever thread is being taken (one whose thread has left the list is still said). */
  private retryOwed(): void {
    const now = this.d.wallMs()
    const due = this.owed.filter((o) => o.at <= now)
    if (!due.length) return
    this.owed.splice(0, this.owed.length, ...this.owed.filter((o) => o.at > now))
    for (const o of due) this.say(o.thread, o.action, o.text, o.tries + 1)
  }
}
