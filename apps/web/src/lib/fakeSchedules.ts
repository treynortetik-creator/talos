// In-memory SchedulesClient for fakeClient (VITE_FAKE=1 and the web tests). Seeded from the protocol fixtures, which are
// generated from the real Chronos goldens (never hand-written). Every call signs its owner frame through the client, so
// tests can verify what would go on the wire. Cards come from composeScheduleCard(), the same function the bridge uses.
import {
  composeScheduleCard,
  configHash,
  type HeartbeatConfigT,
  newId,
  newUlid,
  SCHEDULES_FEATURE_V2,
  ScheduleCardBindingError,
  type ScheduleChangeT,
  ScheduleDetail,
  type ScheduleDetailT,
  ScheduleSnapshot,
  type ScheduleSnapshotT,
} from '@talos-app/protocol'
import detailFixture from '@talos-app/protocol/fixtures/frames/schedule.detail.json'
import snapshotFixture from '@talos-app/protocol/fixtures/frames/schedules.snapshot.json'
import { TalosClientError } from './client.ts'
import type { SchedulesClient, SchedulesSlice } from './schedulesClient.ts'

export type FakeSchedulesDeps = {
  /** Signs and records an owner frame (fakeClient's `owner`). */
  sign(frame: Record<string, unknown>): Promise<Record<string, unknown>>
  getSlice(): SchedulesSlice
  setSlice(next: Partial<SchedulesSlice>): void
  macOnline(): boolean
  /** Adds a card to the store as if `card.create` arrived. */
  addCard(card: ReturnType<typeof composeScheduleCard>): void
  /** Pushes a frame to onFrame listeners. */
  emit(type: string, fields: Record<string, unknown>): void
  agentName(): string
  now(): string
}

export function seedSchedules(): { snapshot: ScheduleSnapshotT; details: Record<string, ScheduleDetailT> } {
  const snapshot = ScheduleSnapshot.parse((snapshotFixture as { snapshot: unknown }).snapshot)
  const detail = ScheduleDetail.parse((detailFixture as { detail: unknown }).detail)
  return { snapshot, details: { [detail.schedule.id]: detail } }
}

/** What the fake "Mac" answers to a Heartbeat test: the raw `result`, or a rejection. It may take as long as it likes. */
export type FakeHeartbeatTest = (
  config: HeartbeatConfigT,
  opts: { windowH: number; withAgent: boolean },
) => unknown | Promise<unknown>

/** The fake's test hooks: replace what the "Mac" holds (health variants, extra jobs), then the next list returns it. */
export type FakeSchedulesClient = SchedulesClient & {
  /** `reports` are the run reports `schedule.get` returns for a run id. */
  setData(
    snapshot: ScheduleSnapshotT,
    details?: Record<string, ScheduleDetailT>,
    reports?: Record<string, string>,
  ): void
  /** Replace how the Mac answers `heartbeat.test`. The default passes every enabled source with nothing found. */
  setHeartbeatTest(fn: FakeHeartbeatTest | null): void
  readonly sentCount: { list: number; heartbeatTest: number }
}

/** A passing test for exactly this config: every enabled source ok, nothing found. */
export function passingTestResult(config: HeartbeatConfigT, windowH: number, at: string): Record<string, unknown> {
  return {
    config_hash: configHash(config),
    at,
    window_h: windowH,
    with_agent: false,
    sources: config.sources
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, ok: true, ms: 800, read: 0, act: 0, fyi: 0, dropped: 0, held: 0, unreadable: 0 })),
    would_wake: [],
    would_post: [],
    held: 0,
    est_wakes: 0,
    est_tokens: 0,
  }
}

export function createFakeSchedules(d: FakeSchedulesDeps): FakeSchedulesClient {
  const seed = seedSchedules()
  let snapshot = seed.snapshot
  let details = seed.details
  let reports: Record<string, string> = {}
  let hbTest: FakeHeartbeatTest | null = null
  const sentCount = { list: 0, heartbeatTest: 0 }
  const offline = () => {
    if (!d.macOnline()) throw new TalosClientError('mac_offline', 'Your Mac is offline.')
  }
  const job = (id: string) => {
    const s = snapshot.schedules.find((x) => x.id === id)
    if (!s) throw new TalosClientError('schedule_not_found', 'No such scheduled job.')
    return s
  }
  const publish = () => {
    d.setSlice({
      snapshot,
      status: 'ready',
      error: null,
      revs: Object.fromEntries(snapshot.schedules.map((s) => [s.id, `${s.etag}|${s.state_rev}`])),
    })
  }
  return {
    setData(next, nextDetails, nextReports) {
      snapshot = next
      if (nextDetails) details = nextDetails
      if (nextReports) reports = nextReports
    },
    setHeartbeatTest(fn) {
      hbTest = fn
    },
    sentCount,
    async listSchedules() {
      sentCount.list++
      await d.sign({ type: 'schedules.list', request_id: newUlid(), app_features: [SCHEDULES_FEATURE_V2] })
      offline()
      publish()
      return snapshot
    },
    async getSchedule(id, runId) {
      await d.sign({
        type: 'schedule.get',
        request_id: newUlid(),
        schedule_id: id,
        report_run_id: runId,
        app_features: [SCHEDULES_FEATURE_V2],
      })
      offline()
      const s = job(id)
      const detail: ScheduleDetailT = details[id] ?? {
        schedule: s,
        prompt: s.prompt_preview,
        prompt_truncated: false,
        guard: null,
        next_runs: s.next_run ? [s.next_run] : [],
        runs: s.last_run ? [s.last_run] : [],
      }
      d.setSlice({ details: { ...d.getSlice().details, [id]: detail } })
      return {
        detail,
        report: runId ? (reports[runId] ?? 'Fake report: the job ran and posted its result.') : null,
      }
    },
    async proposeScheduleChange(change: ScheduleChangeT, threadId) {
      const f = await d.sign({ type: 'schedule.patch', change, thread_id: threadId })
      offline()
      const base = change.op === 'create' ? null : job(change.id)
      const detail = base ? details[base.id] : undefined
      let card: ReturnType<typeof composeScheduleCard>
      try {
        card = composeScheduleCard(
          change,
          {
            when_text: base?.when_text ?? 'As set in the form',
            next_runs: base?.next_run ? [base.next_run] : [],
            tz: snapshot.health.tz,
          },
          null,
          {
            cardId: newId('c'),
            threadId,
            now: d.now(),
            origin: 'chat',
            proposedBy: 'owner_form',
            agentName: d.agentName(),
            expectedEtag: change.op === 'delete' ? null : (base?.etag ?? null),
            clientRef: String(f.id),
            threadName: (t) => t ?? 'the default thread',
            base: base
              ? { schedule: base, prompt: detail?.prompt ?? base.prompt_preview, guard: detail?.guard ?? null }
              : null,
          },
        )
      } catch (e) {
        // the change was drawn against another revision than the one on the Mac (review F4)
        if (e instanceof ScheduleCardBindingError) throw new TalosClientError('schedule_conflict', e.message)
        throw e
      }
      d.addCard(card)
      return { clientRef: String(f.id) }
    },
    async runScheduleNow(id, opts) {
      await d.sign({ type: 'schedule.run_now', schedule_id: id, again: opts.again, where: opts.where })
      offline()
      const s = job(id)
      if (s.today === 'held') throw new TalosClientError('held', 'On hold: review the change first')
      if (s.today === 'running') throw new TalosClientError('already_running', 'Already running')
    },
    async testHeartbeat(config, opts) {
      sentCount.heartbeatTest++
      await d.sign({
        type: 'heartbeat.test',
        request_id: newUlid(),
        config,
        window_h: opts.windowH,
        with_agent: opts.withAgent,
      })
      offline()
      return hbTest ? await hbTest(config, opts) : passingTestResult(config, opts.windowH, d.now())
    },
    async controlSchedule(action, id) {
      await d.sign({ type: 'schedule.control', action, schedule_id: id })
      offline()
      if (id) job(id)
      snapshot = {
        ...snapshot,
        health: {
          ...snapshot.health,
          paused_all: action === 'pause_all' ? true : action === 'resume_all' ? false : snapshot.health.paused_all,
          // Chronos stops reporting `paused_all` once everything is resumed
          issues:
            action === 'resume_all'
              ? snapshot.health.issues.filter((i) => i.code !== 'paused_all')
              : snapshot.health.issues,
          state: action === 'resume_all' && snapshot.health.state === 'paused' ? 'ok' : snapshot.health.state,
        },
        schedules: snapshot.schedules.map((s) =>
          s.id !== id
            ? s
            : {
                ...s,
                paused: action === 'pause' ? true : action === 'resume' ? false : s.paused,
                enabled: action === 'disable' ? false : s.enabled,
              },
        ),
      }
      publish()
      d.emit('schedule.status', {
        health: snapshot.health,
        changed: snapshot.schedules
          .filter((s) => s.id === id)
          .map((s) => ({ id: s.id, etag: s.etag, state_rev: s.state_rev })),
        removed: [],
        alert: null,
      })
    },
  }
}
