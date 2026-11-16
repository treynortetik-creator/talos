// `thread_session status` in words (docs/OPTION-C.md "Main controls a thread's session"): what workers.json and main's own
// restart ledger say about each thread's session, with the times the supervisor recorded. Nothing here writes or posts.
import {
  needsYouStep,
  supervisorFresh,
  threadSessionMode,
  type WorkerEntryT,
  type WorkersReadT,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { say } from '../owner-words.ts'
import { ownerPlace } from '../router/status-line.ts'
import { cleanHandoffText } from '../worker/handoff.ts'
import type { MainRestartLedger } from '../worker/main-restarts.ts'

/** Who keeps the thread sessions, in this computer's words. */
const TALOS_THERE = () => say({ mac: 'The Talos app on your Mac', linux: 'Talos on your computer' })

/** The newest restarts listed per thread: the supervisor keeps 10 crash restarts, the ledger a week of main's. */
const RESTARTS_SHOWN = 10

export function clockText(ms: number, zone: string): string {
  const fmt = (z: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
      new Date(ms),
    )
  try {
    return `${fmt(zone)} (${zone})`
  } catch {
    return `${fmt('UTC')} (UTC)`
  }
}

export const minutesText = (ms: number): string => {
  const mins = Math.max(1, Math.ceil(ms / 60_000))
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`
}

/** A recorded time as the owner's clock reads it, with the day when it is not today there. A time that does not parse is said so. */
export function sinceText(iso: string, nowMs: number, zone: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'an unreadable time'
  const day = (ms: number, z: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: z, day: 'numeric', month: 'short' }).format(new Date(ms))
  let z = zone
  try {
    day(at, z)
  } catch {
    z = 'UTC'
  }
  const clock = clockText(at, z)
  return day(at, z) === day(nowMs, z) ? clock : `${day(at, z)}, ${clock}`
}

const RUNNING = new Set(['starting', 'live', 'busy'])

const WHY_WORDS: Record<string, string> = {
  idle: 'idle',
  cap: 'the live cap (another thread needed the slot)',
  owner: 'the owner',
  crash: 'a crash',
  get interrupted() {
    return say({
      mac: 'interrupted (the Mac or the app went away mid-turn)',
      linux: 'interrupted (this computer or the supervisor went away mid-turn)',
    })
  },
  restart: 'a restart',
  governor: 'plan limits (the usage governor)',
  unknown: 'a reason this bridge does not know',
}

/** Why a session is not running: its error, else the reason the supervisor stored, else "not recorded". Null while it runs. */
function stoppedWhy(e: WorkerEntryT): unknown {
  if (RUNNING.has(e.state)) return null
  if (e.error) return { code: e.error.code, ...(e.error.detail ? { detail: e.error.detail } : {}), at: e.error.at }
  return e.stopped_why ?? 'not recorded'
}

/** The one line that says how the session stands, from the fields the supervisor wrote. */
function summary(e: WorkerEntryT, kind: string | undefined, now: number, zone: string): string {
  const at = (iso: string | null | undefined) => (iso ? ` since ${sinceText(iso, now, zone)}` : '')
  if (kind && e.needs_you) {
    // a screen that must never read as "answer it" (computer use, the usage limit) says the one step there is
    const step = needsYouStep(e.needs_you.kind, ownerPlace())
    return `waiting on ${kind}${at(e.needs_you.since)}${step ? `; to go on, ${step}` : ''}`
  }
  if (e.state === 'failed') return `failed: ${e.error?.code ?? 'no reason recorded'}${at(e.error?.at)}`
  if (RUNNING.has(e.state)) {
    if (e.turn_started_at) return `in a turn${at(e.turn_started_at)}`
    if (e.state === 'starting') return `starting${at(e.started_at)}`
    return e.last_turn_at
      ? `running, between turns; the last one ended ${sinceText(e.last_turn_at, now, zone)}`
      : 'running, no turn yet'
  }
  const why = e.stopped_why ? WHY_WORDS[e.stopped_why] : 'reason not recorded'
  if (e.state === 'stopping' || e.state === 'parking') return `${e.state}: ${why}`
  return `${e.state}: ${why}${at(e.parked_at)}`
}

/** Crash restarts the supervisor recorded and the restarts main asked for, newest last. The owner's own button is in neither. */
function restarts(e: WorkerEntryT, id: string, ledger: MainRestartLedger) {
  const all = [
    ...e.restarts.map((at) => ({ at, by: 'crash' as const })),
    ...ledger.recent(id).map((r) => ({ at: new Date(r.at).toISOString(), by: 'main' as const, why: r.why })),
  ]
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-RESTARTS_SHOWN)
}

export function threadStatus(ctx: BridgeContext, id: string, file: WorkersReadT | null, ledger: MainRestartLedger) {
  const name = ctx.config.thread(id)?.name ?? id
  if (threadSessionMode(ctx.config.config, id) !== 'dedicated')
    return { thread_id: id, name, state: null, summary: 'answered by Main, no session of its own' }
  if (file?.unavailable.includes(id))
    return {
      thread_id: id,
      name,
      state: 'unreadable',
      stopped_why: say({
        mac: 'The Mac can’t read this thread’s saved session; the Talos app on the Mac says how to fix it.',
        linux:
          'This computer can’t read this thread’s saved session; `talos-app supervise status` there says how to fix it.',
        windows:
          'This computer can’t read this thread’s saved session; on the PC, click the Talos icon by the clock and choose Open the log folder: the newest supervisor log says why.',
      }),
    }
  const e = file?.threads[id]
  if (!e) return { thread_id: id, name, state: null, summary: 'no session yet (never started)' }
  const now = ctx.clock.now()
  const zone = ctx.config.config.timezone || 'UTC'
  // the kind is the pane's own words (a prompt's title): one safe line before an agent reads it
  const kind = e.needs_you ? cleanHandoffText(e.needs_you.kind) || 'a prompt' : undefined
  return {
    thread_id: id,
    name,
    state: kind ? 'needs_you' : e.state,
    ...(kind
      ? {
          session_state: e.state,
          needs_you: {
            kind,
            since: e.needs_you?.since,
            ...(needsYouStep(e.needs_you?.kind, ownerPlace())
              ? { step: needsYouStep(e.needs_you?.kind, ownerPlace()) }
              : {}),
          },
        }
      : {}),
    summary: summary(e, kind, now, zone),
    ...(e.turn_started_at ? { turn_started_at: e.turn_started_at } : {}),
    last_turn_at: e.last_turn_at,
    ...(e.last_active_at ? { last_active_at: e.last_active_at } : {}),
    parked_at: e.parked_at,
    restarts: restarts(e, id, ledger),
    stopped_why: stoppedWhy(e),
  }
}

export function supervisorStatus(ctx: BridgeContext, file: WorkersReadT | null) {
  const now = ctx.clock.now()
  if (!file)
    return {
      running: false,
      heartbeat_at: null,
      note: `${TALOS_THERE()} isn’t running (no workers.json it wrote could be read), so nothing can be woken.`,
    }
  const fresh = supervisorFresh(file, now)
  if (fresh && file.supervisor.workers_supported) return { running: true, heartbeat_at: file.supervisor.heartbeat_at }
  return {
    running: false,
    heartbeat_at: file.supervisor.heartbeat_at,
    note: fresh
      ? `${TALOS_THERE()} doesn’t host thread sessions, so nothing can be woken.`
      : `${TALOS_THERE()} isn’t running (last heartbeat ${minutesText(now - Date.parse(file.supervisor.heartbeat_at))} ago), so these states may be out of date and nothing can be woken.`,
  }
}
