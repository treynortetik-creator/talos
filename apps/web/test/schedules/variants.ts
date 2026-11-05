// Snapshot variants for the Schedules specs. Every one is derived from the golden-derived `schedules.snapshot` fixture
// (which comes from real Chronos output), changing only the fields a state needs. Hashes are opaque, as in Chronos.
import {
  HEARTBEAT_META_KEY,
  type HealthIssueT,
  HeartbeatConfig,
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

// ---- Heartbeat (HB5). The configs go through the real strict HeartbeatConfig, so a variant can never hold a config the
// protocol would refuse.
export const hbConfig = (over: Record<string, unknown> = {}) =>
  HeartbeatConfig.parse({
    schema: 'talos.heartbeat/1',
    mode: 'shadow',
    sources: [
      {
        id: 'github',
        kind: 'github',
        enabled: true,
        class: 'own',
        args: { repos: ['example-org/example-repo'] },
        timeout_s: 30,
      },
      { id: 'inbox', kind: 'inbox', enabled: true, args: {}, timeout_s: 30 },
      {
        id: 'disk',
        kind: 'command',
        enabled: true,
        class: 'own',
        args: { argv: ['/home/alex/bin/check disk', '--quiet', '$HOME'], cwd: '/home/alex', env: { MODE: 'brief' } },
        timeout_s: 30,
      },
    ],
    mutes: [{ source: 'github', key: 'pr:example-org/example-repo#12', until: '2026-10-12T12:00:00.000Z' }],
    wake_cap_per_day: 3,
    run_timeout_s: 120,
    ...over,
  })
const hbRun = (status: 'ok' | 'failed', summary: string, over: object = {}) => ({
  run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4HB',
  ds: '2026-10-05T0945',
  started_at: '2026-10-05T09:45:30-04:00',
  runner: 'session' as const,
  trigger: 'clock' as const,
  status,
  duration_s: 12,
  has_report: true,
  summary,
  ...over,
})
export const hbJob = (over: Partial<ScheduleT> = {}, config = hbConfig()): ScheduleT =>
  job({
    id: 'heartbeat',
    name: 'Heartbeat',
    when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
    when_text: 'Weekdays, 4 times a day',
    today: 'ran',
    wait_reason: null,
    window_ends: null,
    next_run: '2026-10-05T12:15:00-04:00',
    thread_id: 'general',
    meta: { [HEARTBEAT_META_KEY]: config } as unknown as ScheduleT['meta'],
    last_run: hbRun('ok', 'Nothing new'),
    ...over,
  })
const HB_REPORT_OK =
  'silent: Nothing new\ngithub: ok, 1200 ms\ninbox: ok, 800 ms\ndisk: ok, 300 ms\nseen 0 (act 0, fyi 0, silent 0); new 0'
const HB_REPORT_PARTIAL =
  'partial: Some items could not be read\ngithub: failed, 900 ms\ninbox: ok, 800 ms, 2 unreadable\ndisk: ok, 300 ms\nseen 3 (act 1, fyi 1, silent 1); new 2'
export const REPORTS: Record<string, Record<string, string>> = {
  heartbeatOn: { r_01JBF3V7Q8K2M4N6P8R0S2T4HB: HB_REPORT_OK },
  heartbeatPartial: { r_01JBF3V7Q8K2M4N6P8R0S2T4HB: HB_REPORT_PARTIAL },
}

/** Jobs that run in a thread (docs/OPTION-C.md "Thread schedules"): the trip and garden threads, a shared thread, and Main's. */
const inThread = (id: string, name: string, thread: string | null, over: Partial<ScheduleT> = {}) =>
  job({
    id,
    name,
    thread_id: thread,
    when_text: 'Weekdays at 8:00 AM',
    today: 'not_due',
    wait_reason: null,
    window_ends: null,
    next_run: '2026-10-06T08:00:00-04:00',
    ...over,
  })

export const VARIANTS = {
  /** Jobs in two threads with their own sessions, one shared thread and Main. */
  byThread: () =>
    snap({
      health: health(),
      schedules: [
        ranToday,
        inThread('packing-check', 'Packing check', 'trip'),
        inThread('hotel-watch', 'Hotel watch', 'trip', { enabled: false }),
        inThread('trip-backup', 'Trip backup', 'trip', { runner: 'headless' }),
        inThread('trip-both', 'Trip both', 'trip', { runner: 'both' }),
        inThread('water-plants', 'Water plants', 'garden'),
        inThread('rota-nudge', 'Rota nudge', 'shared_one'),
        inThread('gone-thread-job', 'Orphan job', 'archived_one'),
      ],
    }),
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
  /** A heartbeat that is on and quiet, next to an ordinary job. */
  heartbeatOn: () => snap({ health: health(), schedules: [ranToday, hbJob()] }),
  /** Only a heartbeat: no ordinary jobs at all. */
  heartbeatOnly: () => snap({ health: health(), schedules: [hbJob()] }),
  /** Not set up yet: the [+ New] menu offers Heartbeat. */
  heartbeatNone: () => snap({ health: health(), schedules: [ranToday] }),
  /** A source failed and some items could not be read. */
  heartbeatPartial: () =>
    snap({
      health: health(),
      schedules: [hbJob({ last_run: hbRun('ok', "Couldn't check github") })],
    }),
  heartbeatFailed: () =>
    snap({ health: health(), schedules: [hbJob({ today: 'failed', last_run: hbRun('failed', 'Check failed') })] }),
  heartbeatBusy: () =>
    snap({ health: health(), schedules: [hbJob({ last_run: hbRun('ok', 'Busy: the last wake is still open') })] }),
  /** An outcome word from a newer Mac. */
  heartbeatUnknown: () =>
    snap({ health: health(), schedules: [hbJob({ last_run: hbRun('ok', 'Reticulating splines') })] }),
  heartbeatWoke: () => snap({ health: health(), schedules: [hbJob({ last_run: hbRun('ok', 'Checked in, 2 items') })] }),
  /** Built but not turned on. */
  heartbeatOff: () =>
    snap({ health: health(), schedules: [hbJob({ enabled: false, today: 'not_due', last_run: null })] }),
  /** A command source whose argv, cwd and env values hold bidi and zero-width characters. */
  heartbeatHostile: () =>
    snap({
      health: health(),
      schedules: [
        hbJob(
          {},
          hbConfig({
            sources: [
              {
                id: 'disk',
                kind: 'command',
                enabled: true,
                class: 'own',
                args: {
                  argv: ['/bin/echo', 'safe\u202eevil', 'a\u200bb'],
                  cwd: '/home/alex/\u2066x',
                  env: { MODE: 'br\u202eief' },
                },
                timeout_s: 30,
              },
            ],
            mutes: [],
          }),
        ),
      ],
    }),
  /** A heartbeat with a source kind from a newer Talos. */
  heartbeatNewerSource: () =>
    snap({
      health: health(),
      schedules: [
        hbJob({
          meta: {
            [HEARTBEAT_META_KEY]: {
              ...hbConfig(),
              sources: [
                ...hbConfig().sources,
                { id: 'cal', kind: 'calendar-v9', enabled: true, args: {}, timeout_s: 30 },
              ],
            },
          } as unknown as ScheduleT['meta'],
        }),
      ],
    }),
} satisfies Record<string, () => ScheduleSnapshotT>
export type VariantName = keyof typeof VARIANTS
