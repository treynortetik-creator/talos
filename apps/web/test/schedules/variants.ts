// Snapshot variants for the Schedules specs. Every one is derived from the golden-derived `schedules.snapshot` fixture
// (which comes from real Chronos output), changing only the fields a state needs. Hashes are opaque, as in Chronos.
import {
  type HealthIssueT,
  type SchedulerHealthT,
  ScheduleSnapshot,
  type ScheduleSnapshotT,
  type ScheduleT,
} from '@talos-app/protocol'
import snapshotFixture from '@talos-app/protocol/fixtures/frames/schedules.snapshot.json'

import { NOW_ISO } from './clock.ts'

export { NOW_ISO, NOW_MS } from './clock.ts'

export const base: ScheduleSnapshotT = ScheduleSnapshot.parse((snapshotFixture as { snapshot: unknown }).snapshot)
export const baseJob: ScheduleT = base.schedules[0] as ScheduleT

let n = 0
const sha = () => `sha256:${(++n).toString(16).padStart(64, 'a')}`
export const job = (over: Partial<ScheduleT> & { id: string }): ScheduleT => ({
  ...baseJob,
  etag: sha(),
  state_rev: sha(),
  content_hash: sha(),
  ...over,
})
export const health = (over: Partial<SchedulerHealthT> = {}): SchedulerHealthT => ({
  ...base.health,
  state: 'ok',
  issues: [],
  ...over,
})
export const issue = (
  code: HealthIssueT['code'],
  text: string,
  fix: string | null = null,
  severity: HealthIssueT['severity'] = 'error',
  schedule_id: string | null = null,
): HealthIssueT => ({ code, severity, text, fix, schedule_id, since: NOW_ISO })
export const snap = (over: Partial<ScheduleSnapshotT> = {}): ScheduleSnapshotT => ({ ...base, unreadable: [], ...over })

const ranToday = job({
  id: 'daily-summary',
  name: 'Daily summary',
  when_text: 'Weekdays at 7:30 AM',
  today: 'ran',
  wait_reason: null,
  window_ends: null,
  runner: 'session',
  next_run: '2026-10-06T07:30:00-04:00',
  last_run: {
    run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
    ds: '2026-10-05',
    started_at: '2026-10-05T07:31:00-04:00',
    runner: 'session',
    trigger: 'clock',
    status: 'ok',
    duration_s: 42,
    has_report: true,
    summary: 'Posted the summary.',
  },
})
const waiting = job({
  id: 'weekly-review',
  name: 'Weekly review',
  when_text: 'Mondays at 7:30 AM',
  today: 'waiting',
  wait_reason: 'agent_busy',
  window_ends: '2026-10-05T12:00:00-04:00',
  next_run: '2026-10-12T07:30:00-04:00',
})
const later = job({
  id: 'remind-me',
  name: 'Remind me once',
  when: { type: 'once', at: '2026-11-12T15:00' },
  when_text: 'Once on Thu Nov 12 at 3:00 PM',
  today: 'not_due',
  wait_reason: null,
  window_ends: null,
  next_run: '2026-11-12T15:00:00-05:00',
})
const events = job({
  id: 'pdf-digest',
  name: 'PDF digest',
  when: { type: 'events' },
  when_text: 'On events',
  today: 'not_due',
  wait_reason: null,
  window_ends: null,
  next_run: null,
  editable: false,
  read_only_reason: 'Runs on events. Edit it at the Mac.',
})
const restricted = job({
  id: 'weekly-cleanup',
  name: 'Weekly cleanup',
  runner: 'headless',
  permissions: 'restricted',
  allowed_tools: ['Read', 'Grep'],
  when_text: 'Fridays at 5:00 PM',
  today: 'not_due',
  wait_reason: null,
  window_ends: null,
  next_run: '2026-10-09T17:00:00-04:00',
})
const stalled = job({
  id: 'nightly-sync',
  name: 'Nightly sync',
  runner: 'headless',
  when_text: 'Every day at 7:00 AM',
  today: 'stalled',
  wait_reason: null,
  window_ends: '2026-10-05T10:00:00-04:00',
  next_run: '2026-10-06T07:00:00-04:00',
})
export const heldJob = job({
  id: 'held-job',
  name: 'Held job',
  today: 'held',
  wait_reason: null,
  changed_outside: true,
  window_ends: null,
})
export const disabledJob = job({
  id: 'old-report',
  name: 'Old report',
  enabled: false,
  today: 'not_due',
  wait_reason: null,
  window_ends: null,
})

const standup = job({
  id: 'standup-prep',
  name: 'Standup prep',
  when_text: 'Weekdays at 7:30 AM',
  today: 'not_due',
  wait_reason: null,
  window_ends: null,
  next_run: '2026-10-05T07:30:00-04:00',
  catchup_min: 180,
})
/** The weekly review has now run (its state_rev moved). */
const reviewRan = {
  ...waiting,
  state_rev: sha(),
  today: 'ran' as const,
  wait_reason: null,
  window_ends: null,
  last_run: { ...(ranToday.last_run as NonNullable<ScheduleT['last_run']>), run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4BB' },
}

export const VARIANTS = {
  /** The fixture as it is: three jobs, `session_runner_conflict` (stuck). */
  stuck: () => base,
  healthy: () =>
    snap({
      health: health(),
      schedules: [ranToday, waiting, later, events, stalled, restricted],
    }),
  /** The same Mac a moment later: the weekly review ran. */
  healthyRan: () => snap({ health: health(), schedules: [ranToday, reviewRan, later, events, stalled, restricted] }),
  /** A job whose fire time (7:30) has passed while the Mac is away; its window runs to 10:30. */
  cachedPast: () => snap({ health: health(), schedules: [ranToday, standup] }),
  /** Waiting with no session -> the "agent session isn't running" banner. */
  nosession: () =>
    snap({
      health: health({ state: 'degraded' }),
      schedules: [ranToday, { ...waiting, wait_reason: 'no_session' }, later],
    }),
  tcc: () =>
    snap({
      health: health({
        state: 'stuck',
        headless: 'blocked',
        issues: [
          issue(
            'tcc_suspected',
            'Background runs are stuck. macOS is probably waiting for your permission.',
            '1. On the Mac, open System Settings > Privacy & Security.\n2. Allow Terminal under Full Disk Access.\n3. Tap Retry background runs.',
          ),
        ],
      }),
      schedules: [ranToday, stalled],
    }),
  headlessBlocked: () =>
    snap({
      health: health({
        state: 'degraded',
        headless: 'blocked',
        issues: [
          issue(
            'headless_blocked',
            'Background runs are off until this is fixed. Session jobs are unaffected.',
            'Run `claude` once in a Terminal on the Mac to approve it.',
            'warn',
          ),
        ],
      }),
      schedules: [ranToday, { ...stalled, today: 'not_due' }],
    }),
  pausedAll: () =>
    snap({
      health: health({
        state: 'paused',
        paused_all: true,
        issues: [issue('paused_all', 'Scheduler paused. Nothing runs on its own.', null, 'warn')],
      }),
      schedules: [ranToday, later],
    }),
  held: () =>
    snap({
      health: health({
        state: 'degraded',
        issues: [issue('held_jobs', '1 job changed outside the app and is on hold.', null, 'warn', 'held-job')],
      }),
      schedules: [ranToday, heldJob, disabledJob],
    }),
  /** Scheduler in London, owner in New York. */
  otherZone: () =>
    snap({
      health: health({ tz: 'Europe/London' }),
      schedules: [{ ...ranToday, next_run: '2026-10-06T07:30:00+01:00' }],
    }),
  empty: () => snap({ health: health(), schedules: [] }),
  notInstalled: () =>
    snap({
      health: health({
        state: 'not_installed',
        adapter: { id: 'none', version: null, api: null },
        issues: [issue('not_installed', 'No scheduler found.', null, 'info')],
      }),
      schedules: [],
    }),
  oldChronos: () =>
    snap({
      health: health({
        state: 'unsupported',
        adapter: { id: 'chronos', version: '0.2.1', api: null },
        issues: [issue('version_unsupported', 'Chronos 0.2.1 is too old.', null, 'info')],
      }),
      schedules: [],
    }),
  off: () => snap({ health: health({ state: 'off' }), schedules: [] }),
  unreadable: () =>
    snap({
      health: health({
        state: 'error',
        issues: [issue('registry_unreadable', 'jobs.json is not valid JSON.', null, 'error')],
      }),
      schedules: [],
      unreadable: [{ id: 'jobs.json', unreadable: 'not valid JSON' }],
    }),
  newerProtocol: () => ({ ...base, protocol: 2 }),
} satisfies Record<string, () => ScheduleSnapshotT>
export type VariantName = keyof typeof VARIANTS
