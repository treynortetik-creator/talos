// Scheduler adapter seam (docs/SCHEDULES.md S3.1). FROZEN after WP-S0. The types live in @talos-app/protocol so the
// testkit's FakeScheduler and this package's Chronos adapter (WP-S1) implement exactly the same interface; this file is
// the path the spec names. WP-S1 adds the Chronos implementation next to it, never by editing these types.
/** @public */
export type {
  ApplyResult,
  ChronosChangeT,
  ClaimResult,
  DueForSession,
  ScheduleDetailT,
  SchedulePreviewT as PreviewT,
  SchedulerAdapter,
  SchedulerHealthT,
  ScheduleSnapshotT,
  SessionPromptResult,
  ValidateResult,
} from '@talos-app/protocol'
