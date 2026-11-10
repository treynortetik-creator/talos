// Constants and small helpers the Schedules service modules share (service.ts and the service-*.ts files cut from it).
import { type Frame, REPORT_MAX_BYTES, type toChronosChange } from '@talos-app/protocol'

export type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
export type ToolOut = { ok: boolean; text: string }
export const fail = (text: string): ToolOut => ({ ok: false, text })
export const yes = (text: string): ToolOut => ({ ok: true, text })

export const FAILURE_WORDS: Record<string, string> = {
  failed: 'it reported a failure',
  timed_out: 'it ran out of time',
  launch_stalled: 'it never started (macOS may be waiting for permission)',
  session_ended: 'the session restarted mid-run',
  missed: 'no session was running in its window',
}

export const FAILURE_STATUSES = new Set(['failed', 'timed_out', 'launch_stalled', 'session_ended'])
/** One notice per cause: the run id when Chronos has one, and the job's day, so the two paths can't both fire. */
export const failKeys = (id: string, runId: string | undefined, ds: string, status: string) => [
  ...(runId ? [`fail|${id}|${runId}|${status}`] : []),
  `fail|${id}|${ds}|${status}`,
]

export const SKIP_WORDS: Record<string, string> = {
  already_done: 'already done',
  running_elsewhere: 'running elsewhere',
  not_due: 'not due',
  window_passed: 'window passed',
  held: 'on hold',
  paused: 'paused',
  failed_today: 'failed today',
  schedule_invalid: 'not runnable in a session',
  schedule_not_found: 'no such job',
}

export const STALE_MS = 2 * 60_000
/** How long a card waits for Chronos to say which thread is a heartbeat's (HB4 R2-5). */
export const HB_THREAD_LOOKUP_MS = 2000
export const THREAD_MAP_SCHEMA = 'talos.heartbeat-threads/1'
/** The proposer row of a card main (or the owner's form) made: recorded so that a missing row is never read as "main". */
export const MAIN_PROPOSER = 'main'
export const RUN_NOW_GAP_MS = 2 * 60_000
export const PROPOSALS_PER_HOUR = 10
export const MAX_PENDING_SCHEDULE_CARDS = 20
/** A failure older than this (by its job date) is history, not news, when the bridge first sees it. */
export const NOTICE_MAX_AGE_MS = 48 * 3600_000
export const OWNER_SPOKE_MS = 30 * 60_000

/** An update whose only changes are Talos-only (the result thread, the memory switch): the Chronos part is empty. */
export function isTalosOnly(split: ReturnType<typeof toChronosChange>): boolean {
  const c = split.chronos
  return c.op === 'update' && Object.keys(c.set).length === 0 && (split.threadId.set || split.memory?.set === true)
}

export function zodText(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const parts = err.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  return `invalid schedule: ${parts.join('; ')}`
}

/** Plain text, controls stripped, at most 4 KiB (S2.4). */
export function excerptOf(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
  const enc = new TextEncoder()
  let out = clean
  while (enc.encode(out).length > REPORT_MAX_BYTES) out = out.slice(0, Math.floor(out.length * 0.9))
  return out
}

/** Words for a job the app can't be sent yet. */
export const NEEDS_V2 =
  'This job has several fire times or settings that need schedules/2. Update the relay and the app, then it shows here.'
