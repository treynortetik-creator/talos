// The scheduler adapter seam (docs/SCHEDULES.md S3.1). FROZEN after WP-S0. The type lives here so the testkit's
// FakeScheduler and the bridge's Chronos adapter implement the same thing; apps/bridge/src/schedules/adapter.ts
// re-exports it at the path the spec names.
//
// Rules (S3.1): the scheduler owns its files; the adapter spawns `chronos api <verb>` with an argv array, JSON on stdin
// and stdout, under the S2.4 timeout; there is no schedule maths in TypeScript; output is parsed with the protocol
// schemas (`CHRONOS_API`) and a parse failure is a `registry_unreadable` issue, never a crash.

import type { ScheduleDetailT, SchedulePreviewT, SchedulerHealthT, ScheduleSnapshotT } from './schedules.ts'
import type { ChronosChangeT } from './schedules-chronos.ts'

/** `ds` is the date Chronos claimed (its own `date_key` when the caller passed `ds: null` for Run now). */
export type ClaimResult =
  | { ok: true; runId: string; ds: string }
  | {
      ok: false
      reason:
        | 'already_done'
        | 'running_elsewhere'
        | 'not_due'
        | 'window_passed'
        | 'held'
        | 'paused'
        | 'failed_today'
        // errors, not refusals: the job may never run in a session (restricted, command, events), or doesn't exist
        | 'schedule_invalid'
        | 'schedule_not_found'
    }

export type DueForSession = { id: string; ds: string; fire_at: string; window_ends: string }

export type ValidateResult =
  | { ok: true; normalized: ChronosChangeT; preview: SchedulePreviewT; expectedEtag: string | null }
  // Chronos's validate runs the same plan as apply: a stale base_etag or content_hash (schedule_conflict), an update
  // of a held job (held) and an unknown id (schedule_not_found) are refused here already.
  | {
      ok: false
      code: 'schedule_invalid' | 'schedule_not_found' | 'held' | 'schedule_conflict'
      errors: { path: string; message: string }[]
    }

export type ApplyResult =
  | { ok: true; etag: string | null }
  // `held`: Chronos refuses an update on a held job (its files changed outside); only an `adopt` clears it
  | { ok: false; code: 'schedule_conflict' | 'schedule_invalid' | 'held' | 'schedule_not_found'; message: string }

/** `held`: the files no longer match the approved record (S6.3); the bridge sends `schedule_held` instead. */
export type SessionPromptResult =
  | { ok: true; guard: string | null; prompt: string; contentHash: string }
  | { ok: false; code: 'held' | 'schedule_invalid' | 'schedule_not_found' }

export interface SchedulerAdapter {
  readonly id: 'chronos' | 'none' | (string & {})
  detect(): Promise<{
    installed: boolean
    supported: boolean
    version?: string
    api?: number
    sessionRunner?: 'talos' | 'hook'
    /** What the scheduler supports beyond api 1: Chronos 0.4 says `times` and `meta`. */
    features?: string[]
    reason?: string
  }>
  snapshot(): Promise<ScheduleSnapshotT>
  detail(id: string, reportRunId: string | null): Promise<{ detail: ScheduleDetailT; report: string | null } | null>
  /** Dry run: strip nothing (caller already stripped Talos fields), normalize, validate, preview, expected etag. Never writes. */
  validate(change: ChronosChangeT): Promise<ValidateResult>
  /**
   * One writer under the scheduler's lock: re-validates, refuses if normalized != change, base_etag (or the adopt's
   * content_hash) moved, or the write would not produce `expectedEtag` (validate's answer, bound in the card; null for
   * delete). Returns the new etag.
   */
  apply(change: ChronosChangeT, expectedEtag: string | null): Promise<ApplyResult>
  setPaused(scope: { id: string } | 'all', paused: boolean): Promise<void>
  disable(id: string): Promise<{ etag: string }>
  /** The last approved prompt/guard text, for the Adopt diff (N7). Read-only; the scheduler owns the record. */
  approved(
    id: string,
  ): Promise<{ contentHash: string; prompt: string; guard: string | null; approvedAt: string } | null>
  /** Jobs a live session may take now (no grace). Also refreshes the session heartbeat (S7.4). */
  dueForSession(): Promise<DueForSession[]>
  /**
   * `ds: null` (Run now only) lets the scheduler pick the job's own date (`date_key`), so no date maths happens in TS.
   * A manual claim ignores the job's pause (Run now is the owner's explicit act) but not a hold.
   */
  claim(
    id: string,
    a: {
      runId: string
      ds: string | null
      fireAt: string | null
      manual: boolean
      again: boolean
      bridgeInstance: string
    },
  ): Promise<ClaimResult>
  /**
   * `status` alone decides the outcome. Chronos stores no summary: S6.1's one-line `summary` stays with the bridge
   * (sidecar, shown as ScheduleRun.summary). `ok` is accepted for compatibility and ignored.
   */
  finish(
    id: string,
    a: { runId: string; status: 'ok' | 'failed' | 'timed_out' | 'session_ended'; report: string; ok?: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: 'not_owner' | 'late' }>
  /** Session claims whose owner file names a bridge_instance other than `current` (N11). `bridgeInstance` is that owner ('' when the owner file does not say). */
  orphanedSessionClaims(
    current: string,
  ): Promise<Array<{ id: string; ds: string; runId: string; bridgeInstance: string }>>
  startHeadless(
    id: string,
    a: { again: boolean },
  ): Promise<
    | { ok: true; runId: string; ds: string }
    | {
        ok: false
        code: 'already_running' | 'headless_blocked' | 'held' | 'schedule_invalid' | 'schedule_not_found'
        message: string
      }
  >
  /** What the session is told (S6.3). Refuses with `held` when the files don't match the approved record. */
  sessionPrompt(id: string): Promise<SessionPromptResult>
  health(): Promise<SchedulerHealthT>
  retryHeadless(): Promise<{ ok: boolean; text: string }>
  watchPaths(): string[]
}
