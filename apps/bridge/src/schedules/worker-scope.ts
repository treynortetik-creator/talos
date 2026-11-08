// Thread-owned schedules (docs/OPTION-C.md "Thread schedules"). A thread's own session asks main's bridge, over the hub
// socket, to run the four Schedules tools. The hub knows which thread the connection proved (nonce + process group), so the
// scope is that thread and nothing the request says. The rules live here and in ScheduleService; the hub only dispatches.
import { HEARTBEAT_META_KEY, type ScheduleSnapshotT, type ScheduleT } from '@talos-app/protocol'
import type { WorkerStore } from '../worker/store.ts'
import { NOTEPAD_INPUT_MAX_CHARS } from './job-memory-run.ts'
import { startedKey } from './kv-prune.ts'
import type { ScheduleService } from './service.ts'

/** The thread whose session is asking. */
export type WorkerScope = { thread: string }

/** Open schedule cards one thread session may have waiting: the owner reads them one by one, and the global limits are main's too. */
export const MAX_PENDING_PER_SESSION = 3

type Out = { ok: boolean; text: string }
const fail = (text: string): Out => ({ ok: false, text })

/** A heartbeat belongs to main: its settings key marks it, whatever else the meta says. */
export function hasHeartbeatMeta(meta: unknown): boolean {
  return typeof meta === 'object' && meta !== null && HEARTBEAT_META_KEY in (meta as Record<string, unknown>)
}

export const notYourJob = (scope: WorkerScope, id: string): string =>
  `"${id}" is not one of this thread's jobs ("${scope.thread}"). A thread session lists, changes and deletes only jobs that run in its own thread; ask the main session for anything else. Nothing was proposed.`

/** The snapshot as the thread's session sees it: its own jobs, no unreadable files, no issues (they name other jobs). */
export function scopedSnapshot(
  snap: ScheduleSnapshotT,
  _scope: WorkerScope,
  keep: (j: ScheduleT) => boolean,
): ScheduleSnapshotT {
  return { ...snap, schedules: snap.schedules.filter(keep), unreadable: [], health: { ...snap.health, issues: [] } }
}

/** Why this thread session may not have another card waiting (it counts only the cards it proposed itself), or undefined. */
export function pendingFor(own: number, _scope: WorkerScope): string | undefined {
  return own >= MAX_PENDING_PER_SESSION
    ? `This thread already has ${MAX_PENDING_PER_SESSION} schedule cards waiting for the owner. Wait for them.`
    : undefined
}

/**
 * The arguments a thread session's `schedule_propose` may run with, or why not. `thread_id` (the card's thread) and
 * `result_thread_id` (where the job runs and posts) can only be the session's own thread; a create is pinned to it, so a job a
 * thread proposes always runs in that thread. A heartbeat is main's and is refused whole.
 */
export function scopedProposeArgs(
  args: Record<string, unknown>,
  scope: WorkerScope,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const own = (v: unknown) => v === undefined || v === scope.thread
  if (!own(args.thread_id) || !own(args.chat_id))
    return {
      ok: false,
      error: `This session belongs to thread "${scope.thread}" and can only propose schedules there. Nothing was proposed.`,
    }
  if (!own(args.result_thread_id))
    return {
      ok: false,
      error: `A thread session can only schedule jobs that run in its own thread ("${scope.thread}"). Nothing was proposed.`,
    }
  if (hasHeartbeatMeta(args.meta))
    return {
      ok: false,
      error: "A heartbeat is the main session's. Ask the owner to set it up from Schedules. Nothing was proposed.",
    }
  // A thread session's job runs in that session, as its own session does: nothing that moves it outside (a background or "both"
  // runner), widens its permissions or limits its tools is the session's to ask for.
  if (args.runner !== undefined && args.runner !== 'session')
    return {
      ok: false,
      error: `A thread session can only schedule jobs that run in its own session (runner "session"), not "${String(args.runner).slice(0, 20)}". Nothing was proposed.`,
    }
  if (args.permissions !== undefined && args.permissions !== 'full')
    return {
      ok: false,
      error:
        'A thread session cannot set permissions: its jobs run with the default (full) in its own session. Nothing was proposed.',
    }
  if (Array.isArray(args.allowed_tools) && args.allowed_tools.length > 0)
    return {
      ok: false,
      error: 'A thread session cannot limit tools: its jobs run in its own session. Nothing was proposed.',
    }
  const { chat_id: _drop, ...rest } = args
  return {
    ok: true,
    args: {
      ...rest,
      thread_id: scope.thread,
      ...(args.op === 'create' ? { result_thread_id: scope.thread, runner: 'session' } : {}),
    },
  }
}

export type WorkerRpcDeps = {
  schedules: ScheduleService
  store: WorkerStore
  thread: string
  now: () => number
  kv: { get(key: string): string | undefined; set(key: string, value: string): void }
}

const runIdOf = (args: Record<string, unknown>): string | undefined =>
  typeof args.run_id === 'string' && args.run_id.length > 0 && args.run_id.length <= 64 ? args.run_id : undefined

/**
 * Why this thread session may not act on `runId`: only a run the router handed to THIS thread's session, and that the
 * session itself claimed, is its to start or finish. Main's run (a fallback), another thread's run, a heartbeat's wake and an
 * unknown id are all refused here, before the Schedules service sees them.
 */
function runProblem(d: WorkerRpcDeps, runId: string): string | undefined {
  const route = d.store.route(runId)
  if (!route || route.thread_id !== d.thread) return 'that run was not handed to this thread session'
  if (route.notification.meta.kind !== 'schedule_run') return 'that is not a scheduled run'
  return d.store.claimedBy(runId) === `worker:${d.thread}` ? undefined : 'the main session took that run'
}

/** Starts in progress, by run id (one process, one hub: the claim itself is the service's). */
const startsInFlight = new Map<string, Promise<Out>>()

async function startRun(d: WorkerRpcDeps, runId: string): Promise<Out> {
  // Asking again for a run this same session already started (its answer was lost, or it asked twice) is GO, not "running
  // elsewhere": the claim is its own. Once the run is closed the service says so.
  const open = d.schedules.sidecar.inflightOf(runId)
  if (d.kv.get(startedKey(runId)) === d.thread && open && !open.closed) return { ok: true, text: 'GO' }
  const r = await d.schedules.toolRunStart(runId)
  if (r.ok && r.text === 'GO') d.kv.set(startedKey(runId), d.thread)
  return r
}

/** Runs one of the four Schedules tools for a thread session. Never throws: a failure is an answer the agent can read. */
export async function workerScheduleTool(d: WorkerRpcDeps, tool: string, args: Record<string, unknown>): Promise<Out> {
  const scope: WorkerScope = { thread: d.thread }
  switch (tool) {
    case 'schedules_list':
      return d.schedules.toolList(typeof args.id === 'string' ? args.id : undefined, scope)
    case 'schedule_propose': {
      const a = scopedProposeArgs(args, scope)
      return a.ok ? d.schedules.toolPropose(a.args, scope) : fail(a.error)
    }
    case 'schedule_run_start': {
      const runId = runIdOf(args)
      if (!runId) return fail('run_id is required')
      const why = runProblem(d, runId)
      if (why) return { ok: true, text: `SKIP: ${why}` }
      // A retry while the first start is still waiting in the schedule queue joins it: one start per run, one answer for both.
      const inFlight = startsInFlight.get(startedKey(runId))
      if (inFlight) return inFlight
      const first = startRun(d, runId).finally(() => startsInFlight.delete(startedKey(runId)))
      startsInFlight.set(startedKey(runId), first)
      return first
    }
    case 'schedule_run_done': {
      const runId = runIdOf(args)
      if (!runId) return fail('run_id is required')
      if (typeof args.ok !== 'boolean') return fail('ok must be true or false')
      if (typeof args.summary !== 'string' || !args.summary) return fail('summary is required')
      const why = runProblem(d, runId)
      if (why) return { ok: true, text: `not yours: ${why}` }
      if (args.notepad !== undefined && typeof args.notepad !== 'string') return fail('notepad must be text')
      const r = await d.schedules.toolRunDone({
        runId,
        ok: args.ok,
        summary: args.summary.slice(0, 280),
        ...(typeof args.report === 'string' ? { report: args.report.slice(0, 64 * 1024) } : {}),
        ...(typeof args.notepad === 'string' ? { notepad: args.notepad.slice(0, NOTEPAD_INPUT_MAX_CHARS) } : {}),
      })
      // A finished run is an answer: without this the session parking afterwards would read as "stopped before it finished",
      // because a job's work need not post a reply.
      if (r.ok && r.text.startsWith('recorded')) d.store.settleClaims([runId], d.now())
      return r
    }
    default:
      return fail(`unknown tool ${tool.slice(0, 40)}`)
  }
}
