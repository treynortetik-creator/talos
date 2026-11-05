// Schedules seam for the UI (docs/SCHEDULES.md S5, WP-S0). FROZEN after WP-S0 (WP-S3 may extend, not change).
//   `lib/fakeSchedules.ts` implements it in memory from the protocol fixtures (generated from real Chronos goldens) and
//   is wired into fakeClient. WP-S3 implements the socket version and makes `TalosClient.schedules` required.
// Every method sends one signed owner frame (S2.2) and rejects with `TalosClientError` on `error{code}`
// (`mac_offline`, `schedule_not_found`, `schedule_invalid` with `fields`, `stale`, `held`, ...).
import type {
  HeartbeatConfigT,
  ScheduleChangeT,
  ScheduleControlActionT,
  ScheduleDetailT,
  ScheduleSnapshotT,
} from '@talos-app/protocol'

export type SchedulesSlice = {
  /** Last snapshot (also cached in IndexedDB by WP-S3). */
  snapshot: ScheduleSnapshotT | null
  /** Details by schedule id. */
  details: Record<string, ScheduleDetailT>
  status: 'idle' | 'loading' | 'ready' | 'error'
  /**
   * Why the last load failed: an ErrorCode, 'no_answer' (nothing within 20 s), 'update_app' (unknown
   * `snapshot.protocol`) or 'update_mac' (the bridge doesn't advertise 'schedules/1').
   */
  error: string | null
  /** etag|state_rev per id as of the last snapshot; a `schedule.status` that differs triggers a re-fetch. */
  revs: Record<string, string>
}

export function initialSchedulesSlice(): SchedulesSlice {
  return { snapshot: null, details: {}, status: 'idle', error: null, revs: {} }
}

export interface SchedulesClient {
  /** `schedules.list` -> `schedules.snapshot`. Also updates `ClientState.schedules`. */
  listSchedules(): Promise<ScheduleSnapshotT>
  /** `schedule.get` -> `schedule.detail` (with a report when `runId` is set). */
  getSchedule(id: string, runId: string | null): Promise<{ detail: ScheduleDetailT; report: string | null }>
  /**
   * `schedule.patch`. Writes nothing: the bridge answers with a `card.create` (kind 'schedule') whose
   * `payload.client_ref` is the returned `clientRef`. `set` must hold only the fields the owner touched.
   */
  proposeScheduleChange(change: ScheduleChangeT, threadId: string): Promise<{ clientRef: string }>
  runScheduleNow(id: string, opts: { again: boolean; where: 'default' | 'session' }): Promise<void>
  /** `schedule_id` is required for pause, resume and disable, and must be null for the global actions. */
  controlSchedule(action: ScheduleControlActionT, id: string | null): Promise<void>
  /**
   * `heartbeat.test` -> `heartbeat.test_result` (docs/HEARTBEAT.md). Runs the sources for real on the Mac with nothing
   * written, posted or woken. Resolves with the raw `result` (read it with parseHeartbeatTestResult). Waits up to
   * HEARTBEAT_TEST_WAIT_MS for it; the Mac acks at once. Rejects like the other calls (`mac_offline`, `scheduler_unavailable`
   * when the Mac or the relay is too old, `rate_limited`, `no_answer`).
   */
  testHeartbeat(config: HeartbeatConfigT, opts: { windowH: number; withAgent: boolean }): Promise<unknown>
}
