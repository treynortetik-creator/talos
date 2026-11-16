// `thread_session` (docs/OPTION-C.md "Main controls a thread's session"): the main session reads how a thread's own session
// stands and wakes or restarts one that is asleep, parked or stuck. It goes through the same check and wake file as the
// owner's button (router/session-control.ts). It keeps the conversation: `fresh` and `park` stay the owner's.
import { supervisorFresh, threadSessionMode, WORKER_TIMING, type WorkerEntryT } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { say } from '../owner-words.ts'
import { controlThreadSession } from '../router/session-control.ts'
import { ownerAskedIn, SETTINGS_LOCKED } from '../trust.ts'
import { WorkersReader } from '../worker/files.ts'
import { cleanHandoffText } from '../worker/handoff.ts'
import { MAIN_RESTARTS_PER_HOUR, MainRestartLedger } from '../worker/main-restarts.ts'
import { fail, ok, str } from './common.ts'
import { NOT_FOR_WORKERS, type ToolRecord } from './define.ts'
import { clockText, minutesText, supervisorStatus, threadStatus } from './session-status.ts'

const THREAD_SESSION_WHY_MAX = 80

/**
 * How a restart of a busy session ends: both supervisors let the turn end, and cut it at the owner's stop limit (the Mac's
 * `stopLimit`, Linux `WORKER_TIMING.owner_stop_s`), because a restart wake is a control the owner's button also sends.
 */
const BUSY_RESTART = `when its turn ends, or after ${WORKER_TIMING.owner_stop_s / 60} minutes if it does not`

/**
 * What a resume wake does in each state on both supervisors (Mac WorkerWakes.swift `case "resume"`, Linux workers.ts
 * onWake): off or parked starts; parking or stopping starts again after the park; starting, live or busy is ignored; failed
 * is not started by it on the Mac. The ignored ones are refused here, so no notice says something that will not happen.
 */
function wakeRefusal(e: WorkerEntryT | undefined): string | undefined {
  const s = e?.state
  if (s === 'starting' || s === 'live' || s === 'busy')
    return "This thread's session is already running, so there is nothing to wake. Use restart if it is stuck."
  if (s === 'failed')
    return `This thread's session failed (${e?.error?.code ?? 'no reason recorded'}), and a wake does not start a failed session. Use restart to clear the failure and start it again.`
  return undefined
}

const readers = new WeakMap<BridgeContext, WorkersReader>()
const readerOf = (ctx: BridgeContext): WorkersReader => {
  let r = readers.get(ctx)
  if (!r) {
    r = new WorkersReader(ctx.paths.home)
    readers.set(ctx, r)
  }
  return r
}
const ledgers = new WeakMap<BridgeContext, MainRestartLedger>()
const ledgerOf = (ctx: BridgeContext): MainRestartLedger => {
  let l = ledgers.get(ctx)
  if (!l) {
    l = new MainRestartLedger(ctx.store.db)
    ledgers.set(ctx, l)
  }
  return l
}

/** At most `max` UTF-16 units, never ending on half of a pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const last = cut.charCodeAt(max - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, max - 1) : cut
}

export const threadSession: ToolRecord = {
  name: 'thread_session',
  group: 'sessions',
  headless: false,
  ...NOT_FOR_WORKERS,
  instructions: `\`thread_session\` shows how each thread's own session stands (\`status\`) and wakes or restarts one that is asleep, parked or stuck. Both keep its conversation. Say why in a few words: the owner sees it in that thread. A busy session is restarted ${BUSY_RESTART}. At most ${MAIN_RESTARTS_PER_HOUR} restarts a thread an hour; starting a fresh conversation stays the owner's.`,
  told: ['main'],
  // read when asked, so the computer in force says it (Fable)
  get description() {
    return `For a thread with its own session. status, for one thread or all: state (needs_you when it waits on a dialog at ${say({ mac: 'the Mac', linux: "the owner's computer" })}), a one-line summary ("waiting on <kind> since <time>", "in a turn since <time>", "parked: idle since <time>"), turn_started_at, last_turn_at (the end of the last finished turn), restarts (crashes and main's own) and why it stopped. wake: resume a session that is off or parked. restart: restart it with the same conversation, for one that is stuck (a busy one restarts ${BUSY_RESTART}). wake and restart need why (up to ${THREAD_SESSION_WHY_MAX} characters), shown to the owner in that thread. At most ${MAIN_RESTARTS_PER_HOUR} restarts per thread an hour. fresh (a new conversation; the old one is kept) and park: only when the owner asked you to, in that thread or in yours, and his settings are not locked.`
  },
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'wake', 'restart', 'fresh', 'park'] },
      thread_id: {
        type: 'string',
        description: 'The thread. Required for wake and restart; status without it lists all.',
      },
      why: { type: 'string', description: `Why, in a few words (up to ${THREAD_SESSION_WHY_MAX} characters).` },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (ctx.worker) return fail('Only the main session can control a thread’s session.')
    const action = str(args.action)
    if (action !== 'status' && action !== 'wake' && action !== 'restart' && action !== 'fresh' && action !== 'park')
      return fail('action must be status, wake, restart, fresh or park')
    ctx.config.refresh()
    const cfg = ctx.config.config
    const asked = str(args.thread_id)
    if (asked !== undefined) {
      if (!ctx.config.thread(asked))
        return fail(`Unknown thread "${asked}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
      if (asked === cfg.default_thread)
        return fail('That is the main session’s own thread; thread_session is for a thread with its own session.')
    }
    const reader = readerOf(ctx)

    if (action === 'status') {
      const ids =
        asked !== undefined
          ? [asked]
          : cfg.threads.filter((t) => !t.archived && threadSessionMode(cfg, t.id) === 'dedicated').map((t) => t.id)
      const file = reader.read()
      return ok(
        JSON.stringify(
          {
            supervisor: supervisorStatus(ctx, file),
            threads: ids.map((id) => threadStatus(ctx, id, file, ledgerOf(ctx))),
          },
          null,
          2,
        ),
      )
    }

    if (asked === undefined) return fail('thread_id is required')
    // fresh and park are the owner's buttons; main presses them only when he asked it to (owner ruling 2026-11-14), in that
    // thread or in main's own, and the settings are not locked. ownerAskedIn: his own words, no outside text since.
    let askedIn: string | undefined
    if (action === 'fresh' || action === 'park') {
      if (cfg.settings_lock === true) return fail(SETTINGS_LOCKED)
      askedIn = ownerAskedIn(ctx, asked)
        ? asked
        : ownerAskedIn(ctx, cfg.default_thread)
          ? cfg.default_thread
          : undefined
      if (askedIn === undefined)
        return fail(
          `Only when the owner asks: ${action === 'fresh' ? 'a fresh conversation drops the one this thread has (use restart to keep it)' : 'it parks itself when idle'}. Ask him, or let him use the button in the thread.`,
        )
    }
    const raw = typeof args.why === 'string' ? args.why.trim() : ''
    if (!raw) return fail(`why is required: what you saw, in up to ${THREAD_SESSION_WHY_MAX} characters`)
    if (raw.length > THREAD_SESSION_WHY_MAX) return fail(`why is over ${THREAD_SESSION_WHY_MAX} characters`)
    const why = clip(cleanHandoffText(raw), THREAD_SESSION_WHY_MAX)
    if (!why) return fail(`why is required: what you saw, in up to ${THREAD_SESSION_WHY_MAX} characters`)

    const now = ctx.clock.now()
    let leaving = false
    if (action === 'wake') {
      // only a state the supervisor really publishes: a stale or missing file is the shared check's to refuse
      const file = reader.read()
      const e =
        threadSessionMode(cfg, asked) === 'dedicated' && supervisorFresh(file, now) ? file?.threads[asked] : undefined
      const no = wakeRefusal(e)
      if (no) return fail(no)
      leaving = e?.state === 'parking' || e?.state === 'stopping'
    }
    const control = (a: 'resume' | 'restart' | 'fresh' | 'park') => () =>
      controlThreadSession(ctx, { thread_id: asked, action: a, by: 'main' }, reader)
    // a fresh start counts against the same hourly limit as a restart; a park starts nothing
    const res =
      action === 'wake'
        ? control('resume')()
        : action === 'park'
          ? control('park')()
          : ledgerOf(ctx).attempt(asked, now, why, control(action))
    if ('next_at' in res)
      return fail(
        `Restart limit reached: ${MAIN_RESTARTS_PER_HOUR} restarts an hour for this thread. The next is allowed at ${clockText(res.next_at, cfg.timezone || 'UTC')}, in ${minutesText(res.next_at - now)}. Tell the owner if it is still stuck.`,
      )
    if (!res.ok) return fail(res.text)

    ctx.log.info('thread session control by main', { thread: asked, action, why })
    let posted = true
    try {
      const did = { wake: 'woke', restart: 'restarted', fresh: 'started a fresh conversation for', park: 'parked' }[
        action
      ]
      // the line in the thread itself says it was the owner's request when he asked (Pantheon 2026-11-14)
      await postSystemNotice(ctx, `Main ${did} this thread's session${askedIn ? ' at your request' : ''}: ${why}`, {
        thread: threadRef(ctx, asked),
      })
      // and where he asked, when that was main's thread: the change is announced in the thread he spoke in
      if (askedIn !== undefined && askedIn !== asked)
        await postSystemNotice(
          ctx,
          `Main ${did} the session of thread "${threadRef(ctx, asked).name}", as you asked.`,
          {
            thread: threadRef(ctx, askedIn),
          },
        )
    } catch (e) {
      posted = false
      ctx.log.warn('thread session notice not posted', { thread: asked, error: (e as Error).message })
    }
    const later =
      action === 'restart'
        ? ` If it is busy, it restarts ${BUSY_RESTART}.`
        : leaving
          ? ' It is stopping now and starts again once it has stopped.'
          : ''
    const missing = posted ? '' : ' The notice in the thread could not be posted; tell the owner yourself.'
    return ok(`${res.text}${later}${missing}`)
  },
}
