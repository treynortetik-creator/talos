// Restarting Main without a mouse (the bridge's `restart_main` tool). Two files in $TALOS_APP_HOME:
// - agent-request.json (frames.ts, AGENT_REQUEST_FILE): the request. The bridge writes it, the Mac app acts on it. The tool
//   writes exactly what the phone's Restart agent writes, so the Mac app needs no change to act on it.
// - main-restart-check.json (MAIN_RESTART_CHECK_FILE, below): the answer to "would Main come back?". Only the Mac app can
//   tell (it alone reads the launch seal), so it writes this file and keeps it fresh; the bridge only reads it. A missing,
//   unreadable, stale or future-dated file means no.
import { z } from 'zod'
import { IsoTs } from './ids.ts'
import { SUPERVISOR_HEARTBEAT_MS, SUPERVISOR_STALE_MS, WorkerNeedsYou } from './thread-sessions.ts'

/** The status file's name under $TALOS_APP_HOME, beside AGENT_REQUEST_FILE. */
export const MAIN_RESTART_CHECK_FILE = 'main-restart-check.json'
/** The Mac app rewrites the status file at least this often while it runs: the supervisor heartbeat (workers.json). */
export const MAIN_RESTART_CHECK_WRITE_MS = SUPERVISOR_HEARTBEAT_MS
/** Older than this by its own `at` = the Talos app is not running: the supervisor's own staleness limit, three missed writes. */
export const MAIN_RESTART_CHECK_STALE_MS = SUPERVISOR_STALE_MS
/** Dated further ahead than this = a skewed or forged clock: it says nothing, so no. */
export const MAIN_RESTART_CHECK_MAX_FUTURE_MS = 5_000
/** A real status file is a few hundred bytes; a bigger one is not read. */
export const MAIN_RESTART_CHECK_MAX_BYTES = 4096
export const MAIN_RESTART_MAX_REASONS = 32

/**
 * The Mac app's minimum gap between restart requests it acts on (AgentRecovery.swift, `requestMinGap: Double = 120`). The
 * Mac discards a sooner one; the bridge refuses a sooner agent `go` up front so the agent hears why instead of nothing.
 */
export const AGENT_REQUEST_MIN_GAP_MS = 120_000
/** Agent-asked restarts of Main, any caller, per rolling hour (history.sqlite `main_restarts`, MAIN_RESTARTS_PER_HOUR in the
 * bridge's ledger enforces it and must equal this). The phone is not counted. */
export const AGENT_RESTARTS_PER_HOUR = 3
/** `restart_main go`'s `why`, in characters. */
export const MAIN_RESTART_WHY_MAX = 80

/** Why Main would not come back. Closed: a value this list lacks reads as `unknown`. */
export const MAIN_RESTART_REASONS = [
  /** The would-be launch (folder, args, env) differs from the one the owner sealed at the Mac. */
  'launch_changed',
  /** The resolved claude program differs from the sealed one. */
  'claude_path_changed',
  /** Answering the startup warning automatically is off. */
  'auto_confirm_off',
  /** The auto-confirm budget for this hour is spent. */
  'budget_spent',
  /** Someone typed in Main's pane just now. */
  'someone_typing',
  /** A takeover holds Main's pane. */
  'takeover_held',
  /** The owner pressed Stop at the Mac. */
  'owner_stopped',
  /** A restart request was acted on within AGENT_REQUEST_MIN_GAP_MS. */
  'too_soon',
  /** desktop.json's saved conversation id is not a UUID: the start refuses it, so a restart would leave Main stopped. */
  'session_id_invalid',
  /**
   * Main was already restarted on request AGENT_RESTARTS_PER_HOUR times in the rolling hour (the Linux supervisor's own count of
   * the requests it acted on; the Mac does not write it). Not `budget_spent`, which is the startup warning's confirmations.
   */
  'restart_limit',
  'unknown',
] as const
export type MainRestartReasonT = (typeof MAIN_RESTART_REASONS)[number]
/** One reason, as read: anything outside the list is `unknown`, never a failed file. */
export const MainRestartReason = z.enum(MAIN_RESTART_REASONS).catch('unknown')

/** What came of the newest restart request the Mac app read (`last`). */
export const MAIN_RESTART_OUTCOMES = [
  /** The restarted Main reached its ready state (its startup warning answered, Claude's input box up). */
  'came_back',
  /** The restart waits at the Mac: `detail` names the dialog or what holds it. */
  'stalled',
  /** The app did not restart: `detail` is the reason, from MAIN_RESTART_REASONS. */
  'refused',
] as const
/** `last.detail`, in characters. */
export const MAIN_RESTART_DETAIL_MAX = 80
/**
 * `last`: one request (`control_id`, as written in agent-request.json) and what the app recorded for it at `at`. A stall that
 * the owner then answers is rewritten as `came_back`.
 */
export const MainRestartLast = z.object({
  control_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  at: IsoTs,
  outcome: z.enum(MAIN_RESTART_OUTCOMES),
  detail: z
    .string()
    .regex(/^[\x20-\x7e]*$/)
    .max(MAIN_RESTART_DETAIL_MAX)
    .optional(),
})
export type MainRestartLastT = z.infer<typeof MainRestartLast>

/**
 * The status file. `at` is when the app last wrote it; `will_return` is the app's whole answer and `reasons` the why (empty
 * when yes; the reader does not second-guess `will_return` from them). Fields a newer app adds are dropped, not refused.
 */
export const MainRestartCheckFile = z.object({
  v: z.literal(1),
  at: IsoTs,
  will_return: z.boolean(),
  reasons: z.array(MainRestartReason).max(MAIN_RESTART_MAX_REASONS),
  /** Optional, and a `last` this reader cannot read is dropped (never the whole file): an older app writes none. */
  last: MainRestartLast.optional().catch(undefined),
  /**
   * Main sits on a dialog at the Mac (one Talos does not answer, or its startup warning held), and since when. Optional and
   * added late: an older app writes none, an older bridge drops it, and one this reader cannot read is none, never the file.
   */
  needs_you: WorkerNeedsYou.optional().catch(undefined),
})
export type MainRestartCheckFileT = z.infer<typeof MainRestartCheckFile>
