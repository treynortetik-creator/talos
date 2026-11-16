// What a reader does with one wake file it has taken (`workers/<thread>/wake`, thread-sessions.ts WakeFile). Any code running as
// the owner's user can write that file, so the bridge's checks before it writes are not enough: the reader (the Mac's
// WorkerWakes.takeWakes, the Linux supervisor's takeWake) is the place of record. For a control wake (park, resume, restart,
// fresh) it refuses a stale one, a restart or fresh start past the reader's gap or hourly cap, and a fresh start while the
// session is busy; it posts a notice in the thread for every control it carries out. A pointer wake (a message for the session
// to read) keeps its own rules (PointerTyper.longestClaim on the Mac, owed-pointer.ts on Linux) and none of these.
//
// No replay counter: `at` within WAKE_MAX_AGE_MS (and not ahead by more than WAKE_MAX_FUTURE_MS), plus the reader taking the file
// by renaming it aside, is what keeps an old wake from being carried out again. Against code running as the owner's user a
// counter adds nothing (it can write a fresh one), and a counter pinned ahead by a wrong clock locked every control out.
//
// Pure: the reader passes in its own state and the time. The vectors in fixtures/wake-decision/ pin every branch for the Swift
// copy. The reader keeps its taken capped wakes per thread in WORKER_FILES.wakeState (WakeState below: 0600, its own file; the
// guards deny it to sessions) and appends `{ at: <the wake's at, ms>, action }` when the decision says `counted`. The bridge
// reads that file to refuse a capped wake up front (wakeCapCheck, wakeLimitText).
import { z } from 'zod'
import type { WakeFileT } from './thread-sessions.ts'

/** A control wake older than this by its own `at` when the reader decides is refused as stale (`wake_stale`, `too_old`). */
export const WAKE_MAX_AGE_MS = 5 * 60_000
/** Dated further ahead than this is a wrong or forged clock: refused as stale (`in_future`). Writer and reader share a machine. */
export const WAKE_MAX_FUTURE_MS = 5_000
/**
 * The reader's own limits on capped wakes, per thread, for every caller. Set so a person tapping cannot reach them and a loop
 * cannot run away. Not the restart rules for Main itself (AGENT_REQUEST_MIN_GAP_MS, AGENT_RESTARTS_PER_HOUR in main-restart.ts,
 * 120 s and 3 an hour), and not Main's own ledger for thread restarts (MAIN_RESTARTS_PER_HOUR): those stay as they are.
 */
export const WAKE_MIN_GAP_MS = 20_000
/** Capped wakes taken per thread in any rolling hour. */
export const WAKE_CAPPED_PER_HOUR = 12
/** The rolling window for WAKE_CAPPED_PER_HOUR, counted as the restart ledger counts: an entry dated up to this far ahead still counts. */
export const WAKE_CAP_WINDOW_MS = 3_600_000
/**
 * The actions the gap and the cap limit: the ones that end a running conversation or start over. `park` only stops (the usage
 * governor's park is never refused unless stale) and `resume` is what any message's pointer wake does anyway: neither is capped.
 */
export const WAKE_CAPPED_ACTIONS = ['restart', 'fresh'] as const
export type WakeCappedActionT = (typeof WAKE_CAPPED_ACTIONS)[number]
/**
 * Taken only while the session is not in a turn. A busy `fresh` is refused, not held: a held request would be a forgeable one
 * waiting to fire later. `restart` stays allowed while busy: the reader parks first and never cuts a turn (spec 6.4), and its
 * notice says it waits for the turn.
 */
export const WAKE_IDLE_ONLY_ACTIONS = ['fresh'] as const

/** The names a reader logs a refusal under. */
export const WAKE_AUDIT_EVENTS = ['wake_refused', 'wake_stale'] as const
export type WakeAuditEventT = (typeof WAKE_AUDIT_EVENTS)[number]
/** Every audit record carries exactly these keys, in this order. */
export const WAKE_AUDIT_FIELDS = ['thread', 'action', 'reason', 'at', 'why'] as const

/** Why a wake was refused: one per branch. */
export const WAKE_REFUSAL_WHYS = ['too_old', 'in_future', 'busy', 'gap', 'hour'] as const
export type WakeRefusalWhyT = (typeof WAKE_REFUSAL_WHYS)[number]

/**
 * The one-line notices the reader posts in the thread. `{what}`, `{done}`, `{reason}`, `{transcript}` are filled by
 * wakeDoneNotice and wakeLimitText; the numbers come from the constants above. A wake dated ahead is audit only: it has no
 * innocent cause the owner could act on. A wake too old does get a notice: a Mac that slept through the owner's tap is innocent,
 * and the owner should hear the tap did nothing.
 */
export const WAKE_NOTICE = {
  done: 'Talos {done} ({reason}).',
  restart_after_turn: "Talos will restart this thread's session after its current turn ({reason}).",
  /** A restart, resume or fresh start held for a session slot (another session may be parked to make room). */
  held: 'Talos will {what} once a session slot is free ({reason}).',
  /** A held start dropped before it ran (its hold ran out, or its thread left the list); a start that failed has its own line. */
  held_dropped: 'Talos did not {what}: it was dropped before it could start. Nothing was changed.',
  fresh_done:
    'Talos started a fresh conversation for this thread ({reason}). The old conversation is no longer loaded; its transcript is kept at {transcript}.',
  fresh_done_no_path:
    'Talos started a fresh conversation for this thread ({reason}). The old conversation is no longer loaded; its transcript is kept on this computer.',
  limit: `Talos did not {what}: at most ${WAKE_CAPPED_PER_HOUR} restarts or fresh starts an hour, at least ${WAKE_MIN_GAP_MS / 1000} seconds apart. Nothing was changed.`,
  busy: 'Talos did not start a fresh conversation for this thread: its session is busy. Nothing was discarded; ask again when it is idle.',
  stale: `Talos did not {what}: the request was more than ${WAKE_MAX_AGE_MS / 60_000} minutes old when it was read. Ask again if it is still needed.`,
} as const

export type WakeControlActionT = Exclude<WakeFileT['action'], 'pointer'>
type ControlAction = WakeControlActionT
/** `{done}`: what was carried out. */
export const WAKE_DONE: Record<Exclude<ControlAction, 'fresh'>, string> = {
  park: "parked this thread's session",
  resume: "resumed this thread's session",
  restart: "restarted this thread's session",
}
/** `{what}`: what was not carried out. */
export const WAKE_WHAT: Record<ControlAction, string> = {
  park: "park this thread's session",
  resume: "resume this thread's session",
  restart: "restart this thread's session",
  fresh: 'start a fresh conversation for this thread',
}
/** `{reason}`, from the wake's own `reason`. It says what the request claimed to be; the file proves nothing about who wrote it. */
export const WAKE_REASON_TEXT: Record<WakeFileT['reason'], string> = {
  message: 'a new message',
  card_action: 'a card answer',
  control: 'a session control',
  governor: 'plan limits are close',
}

/**
 * The reader's own state for one thread, WORKER_FILES.wakeState (0600; the reader writes it, the bridge only reads it to refuse a
 * restart or fresh start up front with the reader's own count). `taken`: the capped wakes it carried out, by the wake's own `at`
 * in ms and its action, newest kept (at most WAKE_STATE_TAKEN_MAX). A file that does not parse reads as none.
 */
export const WAKE_STATE_TAKEN_MAX = 16
export const WakeTaken = z.object({ at: z.number().finite(), action: z.enum(WAKE_CAPPED_ACTIONS) })
export type WakeTakenT = z.infer<typeof WakeTaken>
export const WakeState = z.object({
  v: z.literal(1),
  taken: z.array(WakeTaken).max(WAKE_STATE_TAKEN_MAX),
})
export type WakeStateT = z.infer<typeof WakeState>

export type WakeDecisionInputT = {
  wake: WakeFileT
  /** The reader's clock, ms since the epoch. */
  now: number
  /** The `at` (ms) of each capped wake (WAKE_CAPPED_ACTIONS) this reader took for the thread: WakeState.taken; any order. */
  recentTaken: readonly number[]
  /** The session is not in a turn (off, parked, or live and waiting for input). */
  threadIdle: boolean
  /** For a `fresh`: where the conversation being set aside is kept, when the reader knows. Shown in the notice. */
  transcriptPath?: string
}

export type WakeDecisionT =
  | {
      take: true
      /** Append `{ at: Date.parse(wake.at), action }` to WakeState.taken: a capped action was taken. */
      counted: boolean
      /** Post this in the thread. None for a pointer wake. */
      notice?: string
    }
  | {
      take: false
      audit: WakeAuditEventT
      why: WakeRefusalWhyT
      /** Post this in the thread as well as auditing; absent = audit only. */
      notice?: string
    }

const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ')
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)

/**
 * The notice for a control the reader carried out. A restart of a session in a turn waits for the turn to end (`busy`), and says
 * so instead of "restarted".
 */
export function wakeDoneNotice(
  wake: WakeFileT,
  o: { transcriptPath?: string; busy?: boolean } = {},
): string | undefined {
  if (wake.action === 'pointer') return undefined
  const reason = WAKE_REASON_TEXT[wake.reason]
  if (wake.action === 'restart' && o.busy) return fill(WAKE_NOTICE.restart_after_turn, { reason })
  if (wake.action !== 'fresh') return fill(WAKE_NOTICE.done, { done: WAKE_DONE[wake.action], reason })
  return o.transcriptPath
    ? fill(WAKE_NOTICE.fresh_done, { reason, transcript: oneLine(o.transcriptPath) })
    : fill(WAKE_NOTICE.fresh_done_no_path, { reason })
}

export function wakeDecision(i: WakeDecisionInputT): WakeDecisionT {
  const w = i.wake
  if (w.action === 'pointer') return { take: true, counted: false }
  const action: ControlAction = w.action
  const what = WAKE_WHAT[action]

  const at = Date.parse(w.at)
  if (!Number.isFinite(at) || i.now - at > WAKE_MAX_AGE_MS)
    return { take: false, audit: 'wake_stale', why: 'too_old', notice: fill(WAKE_NOTICE.stale, { what }) }
  if (at - i.now > WAKE_MAX_FUTURE_MS) return { take: false, audit: 'wake_stale', why: 'in_future' }

  if ((WAKE_IDLE_ONLY_ACTIONS as readonly string[]).includes(action) && !i.threadIdle)
    return { take: false, audit: 'wake_refused', why: 'busy', notice: WAKE_NOTICE.busy }

  const capped = (WAKE_CAPPED_ACTIONS as readonly string[]).includes(action)
  if (capped) {
    const cap = wakeCapCheck(i.recentTaken, i.now)
    if (!cap.ok) return { take: false, audit: 'wake_refused', why: cap.why, notice: wakeLimitText(action) }
  }

  return {
    take: true,
    counted: capped,
    notice: wakeDoneNotice(w, { transcriptPath: i.transcriptPath, busy: !i.threadIdle }),
  }
}

/**
 * The gap and the hourly cap alone, for the reader (inside wakeDecision) and for the bridge before it writes a wake. Counts as
 * the restart ledger does: the last hour, plus entries dated up to an hour ahead (a clock set back hands out nothing).
 * `next_at`: when the next capped wake would be allowed.
 */
export function wakeCapCheck(
  recentTaken: readonly number[],
  now: number,
): { ok: true } | { ok: false; why: 'gap' | 'hour'; next_at: number } {
  const counted = recentTaken.filter((t) => t > now - WAKE_CAP_WINDOW_MS && t <= now + WAKE_CAP_WINDOW_MS)
  if (!counted.length) return { ok: true }
  const last = Math.max(...counted)
  if (last > now - WAKE_MIN_GAP_MS) return { ok: false, why: 'gap', next_at: last + WAKE_MIN_GAP_MS }
  if (counted.length >= WAKE_CAPPED_PER_HOUR) {
    const sorted = [...counted].sort((a, b) => a - b)
    return {
      ok: false,
      why: 'hour',
      next_at: (sorted[counted.length - WAKE_CAPPED_PER_HOUR] as number) + WAKE_CAP_WINDOW_MS,
    }
  }
  return { ok: true }
}

/** The over-the-limit words for one action: the reader's notice, and the bridge's answer when it refuses up front. */
export const wakeLimitText = (action: ControlAction): string => fill(WAKE_NOTICE.limit, { what: WAKE_WHAT[action] })
/** The line for a control held for a session slot, and for one dropped before it could start (the readers' notices of record). */
export const wakeHeldText = (wake: WakeFileT & { action: ControlAction }): string =>
  fill(WAKE_NOTICE.held, { what: WAKE_WHAT[wake.action], reason: WAKE_REASON_TEXT[wake.reason] })
export const wakeHeldDroppedText = (action: ControlAction): string =>
  fill(WAKE_NOTICE.held_dropped, { what: WAKE_WHAT[action] })

export type WakeAuditT = {
  thread: string
  action: WakeFileT['action']
  reason: WakeFileT['reason']
  at: string
  why: WakeRefusalWhyT
}
/** One audit record, keys in WAKE_AUDIT_FIELDS order. */
export function wakeAudit(wake: WakeFileT, why: WakeRefusalWhyT): WakeAuditT {
  return { thread: wake.thread_id, action: wake.action, reason: wake.reason, at: wake.at, why }
}

/**
 * The owner's one line in the default thread once an update's restarts are done (restart-on-update; the Mac posts the same
 * words): the threads restarted, those that restart when their turn ends, those whose restart failed, and those given up
 * because they did not start again, by their display names (shared cases: apps/desktop/Tests/Fixtures/update-restart-line.json).
 * A thread is listed when Talos was updated or its own instructions changed since its launch (Pantheon). Null when there is
 * nothing to say.
 */
export function updateRestartLine(o: {
  restarted: readonly string[]
  waiting: readonly string[]
  failed: readonly string[]
  /** Given up: stopped for its restart and never started again (optional: callers from before it say none). */
  notRestarted?: readonly string[]
}): string | null {
  const list = (names: readonly string[]) => names.map(oneLine).join(', ')
  const parts = [
    ...(o.restarted.length ? [`restarted ${list(o.restarted)}`] : []),
    ...(o.waiting.length
      ? [
          `${list(o.waiting)} ${o.waiting.length === 1 ? 'restarts when its turn ends' : 'restart when their turns end'}`,
        ]
      : []),
    ...(o.failed.length ? [`${list(o.failed)} failed`] : []),
    ...(o.notRestarted?.length
      ? [
          o.notRestarted.length === 1
            ? `${list(o.notRestarted)} was not restarted (it did not start again)`
            : `${list(o.notRestarted)} were not restarted (they did not start again)`,
        ]
      : []),
  ]
  return parts.length ? `Updated or instructions changed: ${parts.join('; ')}.` : null
}
