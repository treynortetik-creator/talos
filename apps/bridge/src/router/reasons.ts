// Why a thread's own session did not take a message, in the words of the system row that tells the owner Main answered.
import {
  type ErrorCodeT,
  SUPERVISOR_STALE_MS,
  supervisorFresh,
  threadSessionMode,
  WORKER_LIVE_STATES,
  type WorkerEntryT,
  type WorkersFileT,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { say } from '../owner-words.ts'
import type { RouteRow } from '../worker/store.ts'

export const failureReason = (e: WorkerEntryT): ErrorCodeT =>
  e.error?.code === 'needs_mac'
    ? 'needs_mac'
    : e.error?.code === 'folder_claimed'
      ? 'worker_folder_claimed'
      : 'worker_unavailable'

export const REASON_TEXT: Partial<Record<ErrorCodeT, string>> = {
  worker_unavailable: 'its session is not available',
  worker_cap: 'every thread session is busy',
  usage_governor: 'plan limits are close, so thread sessions are paused',
  worker_folder_claimed: 'another session is working in its folder',
  get needs_mac() {
    return say({ mac: 'its session needs you at the Mac', linux: 'its session needs you at your computer' })
  },
}

/**
 * Has the run that claimed a message at `at` definitely ended? Only states that say so count; `stopping` and `parking` are
 * still finishing that turn, and a missing or unreadable date proves nothing.
 */
export function runEnded(e: WorkerEntryT, at: number): boolean {
  if (e.state === 'parked' || e.state === 'failed' || e.state === 'off') return true
  if (!e.started_at || !WORKER_LIVE_STATES.includes(e.state)) return false
  return Date.parse(e.started_at) > at
}

/** A supervisor whose heartbeat is stale this long beyond SUPERVISOR_STALE_MS is gone; sooner may be a restart in progress. */
export const SUPERVISOR_GONE_GRACE_MS = 30_000

/**
 * The waiting messages whose session is now dead: routing a new message to its thread would go straight to Main (failed,
 * stopping, unavailable, the supervisor gone), with the reason that would give. A cold start (`off`, `parked`) is expected before
 * the start and is not dead; a paused governor is not a dead session; a heartbeat only just stale, or a file not readable now,
 * proves nothing yet. A hand-off has no deadline and is never handed to Main this way.
 */
export function goneRows(
  file: WorkersFileT | null,
  now: number,
  rows: RouteRow[],
  reach: (thread: string) => { to: string; reason?: ErrorCodeT },
  staleSeenBefore = false,
): [RouteRow, ErrorCodeT][] {
  if (!file) return []
  const beat = Date.parse(file.supervisor.heartbeat_at)
  // a stale heartbeat counts only when this same one was also stale at an earlier poll: one slow read of the file proves nothing
  if (!supervisorFresh(file, now) && !(now - beat > SUPERVISOR_STALE_MS + SUPERVISOR_GONE_GRACE_MS && staleSeenBefore))
    return []
  const out: [RouteRow, ErrorCodeT][] = []
  for (const row of rows) {
    if (row.notification.meta.kind === 'handoff') continue
    const d = reach(row.thread_id)
    if (d.to === 'fallback' && d.reason && d.reason !== 'usage_governor') out.push([row, d.reason])
  }
  return out
}

/** Why a thread session's own wake timer was dropped instead of given to Main (it is only ever that session's). */
export function wakeDropReason(ctx: BridgeContext, thread: string, reason: ErrorCodeT): string {
  const t = ctx.config.thread(thread)
  if (!t) return 'its thread was deleted'
  if (t.archived) return 'its thread was archived'
  if (threadSessionMode(ctx.config.config, thread) !== 'dedicated') return 'its thread no longer has its own session'
  return REASON_TEXT[reason] ?? `its session did not take it (${reason})`
}
