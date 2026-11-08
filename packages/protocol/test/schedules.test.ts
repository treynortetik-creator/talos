import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPushPayload,
  CHANNEL_KINDS,
  ChannelMeta,
  DIRECTION_TYPES,
  ErrorCode,
  OWNER_FRAME_TYPES,
  parseFrame,
  RunId,
  SCHEDULES_FEATURE,
  SCHEDULES_PROTOCOL,
  ScheduleCardPayload,
  ScheduleChange,
  ScheduleDetail,
  ScheduleDraft,
  ScheduleId,
  ScheduleWhenEditable,
  Sha256Ref,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const SCHEDULE_OWNER = ['schedules.list', 'schedule.get', 'schedule.patch', 'schedule.run_now', 'schedule.control']
const SCHEDULE_FROM_BRIDGE = ['schedules.snapshot', 'schedule.detail', 'schedule.status']

const draft = {
  id: 'daily-digest',
  name: 'Daily Digest',
  description: 'Example job',
  when: { type: 'weekdays', time: '07:30' },
  catchup_min: 180,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: 'general',
  prompt: "Summarise yesterday's activity and post it.\n",
}

describe('schedules: ids and versions', () => {
  it('protocol version and feature string', () => {
    expect(SCHEDULES_PROTOCOL).toBe(1)
    expect(SCHEDULES_FEATURE).toBe('schedules/1')
  })
  it('ScheduleId is Chronos ID_RE', () => {
    for (const ok of ['ab', 'daily-digest', 'a1-b2', 'x'.repeat(40)])
      expect(ScheduleId.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['a', 'Daily', 'a_b', 'x'.repeat(41), '../x', 'a b'])
      expect(ScheduleId.safeParse(bad).success, bad).toBe(false)
  })
  it('RunId is r_ + a ULID (no dots, so it can never be a path segment trick)', () => {
    expect(RunId.safeParse('r_01JBF3V7Q8K2M4N6P8R0S2T4AA').success).toBe(true)
    for (const bad of [
      'r_..',
      'r_01JBF3V7Q8K2M4N6P8R0S2T4A.',
      'r_01jbf3v7q8k2m4n6p8r0s2t4aa',
      '01JBF3V7Q8K2M4N6P8R0S2T4AA',
    ])
      expect(RunId.safeParse(bad).success, bad).toBe(false)
  })
  it('Sha256Ref is exported', () => {
    expect(Sha256Ref.safeParse(`sha256:${'a'.repeat(64)}`).success).toBe(true)
    expect(Sha256Ref.safeParse(`sha256:${'A'.repeat(64)}`).success).toBe(false)
  })
})

describe('ScheduleDraft (strict, no defaults, owner-editable fields only)', () => {
  it('accepts a full draft and returns it unchanged', () => {
    const res = ScheduleDraft.safeParse(draft)
    expect(res.success).toBe(true)
    if (res.success) expect(res.data).toEqual(draft)
  })
  it.each([
    ['permissions command', { permissions: 'command' }],
    ['when events', { when: { type: 'events' } }],
    ['runner both', { runner: 'both' }],
    ['a 17 KiB prompt', { prompt: 'x'.repeat(17 * 1024) }],
    ['an unknown field', { kind: 'claude' }],
    ['an empty prompt', { prompt: '' }],
    ['a C0 control in the prompt', { prompt: 'run\u0007 this' }],
    ['catch-up under 15', { catchup_min: 14 }],
    ['a missing field (no defaults)', { notify: undefined }],
  ])('rejects %s', (_name, patch) => {
    const d: Record<string, unknown> = { ...draft, ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete d[k]
    expect(ScheduleDraft.safeParse(d).success).toBe(false)
  })
  it('counts the 16 KiB cap in UTF-8 bytes, not characters', () => {
    expect(ScheduleDraft.safeParse({ ...draft, prompt: 'x'.repeat(16 * 1024) }).success).toBe(true)
    // 6000 three-byte characters = 18000 bytes, under 16384 characters
    expect(ScheduleDraft.safeParse({ ...draft, prompt: '€'.repeat(6000) }).success).toBe(false)
  })
  it('allows newline and tab in the prompt', () => {
    expect(ScheduleDraft.safeParse({ ...draft, prompt: 'a\n\tb\r\n' }).success).toBe(false) // \r is a C0 control
    expect(ScheduleDraft.safeParse({ ...draft, prompt: 'a\n\tb\n' }).success).toBe(true)
  })
  it('ScheduleWhenEditable has no events', () => {
    expect(ScheduleWhenEditable.safeParse({ type: 'events' }).success).toBe(false)
    expect(ScheduleWhenEditable.safeParse({ type: 'once', at: '2026-11-12T15:00' }).success).toBe(true)
    expect(ScheduleWhenEditable.safeParse({ type: 'once', at: '2026-11-12T24:00' }).success).toBe(false)
  })
})

describe('ScheduleChange', () => {
  const etag = `sha256:${'1'.repeat(64)}`
  it('update holds only changed fields and never the id', () => {
    expect(
      ScheduleChange.safeParse({ op: 'update', id: 'daily-digest', base_etag: etag, set: { name: 'X' } }).success,
    ).toBe(true)
    expect(
      ScheduleChange.safeParse({ op: 'update', id: 'daily-digest', base_etag: etag, set: { id: 'other' } }).success,
    ).toBe(false)
    expect(
      ScheduleChange.safeParse({ op: 'update', id: 'daily-digest', base_etag: etag, set: { runner: 'both' } }).success,
    ).toBe(false)
  })
  it('delete and adopt carry their binding hash', () => {
    expect(ScheduleChange.safeParse({ op: 'delete', id: 'daily-digest', base_etag: etag }).success).toBe(true)
    expect(ScheduleChange.safeParse({ op: 'delete', id: 'daily-digest' }).success).toBe(false)
    expect(ScheduleChange.safeParse({ op: 'adopt', id: 'daily-digest', content_hash: etag }).success).toBe(true)
  })
  it('the card payload names its schema', () => {
    const p = {
      schema: 'talos.schedule-change/1',
      change: { op: 'create', draft },
      expected_etag: etag,
      proposed_by: 'owner_form',
      client_ref: null,
      preview: { when_text: 'Weekdays at 7:30 AM', next_runs: ['2026-10-06T07:30:00-04:00'], tz: 'UTC' },
    }
    expect(ScheduleCardPayload.safeParse(p).success).toBe(true)
    expect(ScheduleCardPayload.safeParse({ ...p, schema: 'talos.schedule-change/2' }).success).toBe(false)
    expect(ScheduleCardPayload.safeParse({ ...p, preview: { ...p.preview, tz: 'Not/AZone' } }).success).toBe(false)
  })
  it('a detail prompt may be up to 64 KiB', () => {
    const fx = fixtures['schedule.detail'] as { detail: Record<string, unknown> }
    expect(ScheduleDetail.safeParse({ ...fx.detail, prompt: 'x'.repeat(64 * 1024) }).success).toBe(true)
    expect(ScheduleDetail.safeParse({ ...fx.detail, prompt: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false)
  })
})

describe('schedule frames (S2.2)', () => {
  it('owner schedule frames are owner frames, routed app -> relay -> bridge', () => {
    for (const t of SCHEDULE_OWNER) {
      expect(OWNER_FRAME_TYPES as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.app_to_relay as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.relay_to_bridge as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.relay_to_app as readonly string[], t).not.toContain(t)
    }
  })
  it('bridge schedule frames are routed bridge -> relay -> app only', () => {
    for (const t of SCHEDULE_FROM_BRIDGE) {
      expect(DIRECTION_TYPES.bridge_to_relay as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.relay_to_app as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.app_to_relay as readonly string[], t).not.toContain(t)
    }
  })
  it('every schedule frame has a fixture that parses', () => {
    for (const t of [...SCHEDULE_OWNER, ...SCHEDULE_FROM_BRIDGE]) {
      expect(fixtures[t], t).toBeDefined()
      expect(parseFrame(fixtures[t]).ok, t).toBe(true)
    }
  })
  it('schedule.control needs a schedule id for pause, resume and disable, and none for the global actions', () => {
    const f = fixtures['schedule.control'] as Record<string, unknown>
    expect(parseFrame({ ...f, action: 'pause', schedule_id: null }).ok).toBe(false)
    expect(parseFrame({ ...f, action: 'disable', schedule_id: null }).ok).toBe(false)
    expect(parseFrame({ ...f, action: 'pause_all', schedule_id: null }).ok).toBe(true)
    expect(parseFrame({ ...f, action: 'retry_headless', schedule_id: 'daily-digest' }).ok).toBe(false)
    expect(parseFrame({ ...f, action: 'reboot', schedule_id: null }).ok).toBe(false)
  })
  it('schedule.run_now: where is default or session, again is required', () => {
    const f = fixtures['schedule.run_now'] as Record<string, unknown>
    expect(parseFrame({ ...f, where: 'headless' }).ok).toBe(false)
    const { again: _a, ...noAgain } = f
    expect(parseFrame(noAgain).ok).toBe(false)
  })
  it('schedule.status carries ids and hashes only: no job name or prompt text (property over the goldens)', () => {
    const status = fixtures['schedule.status'] as { changed: Array<Record<string, unknown>> }
    const snap = fixtures['schedules.snapshot'] as {
      snapshot: { schedules: Array<{ name: string; prompt_preview: string; description: string }> }
    }
    expect(status.changed.length).toBeGreaterThan(0)
    const text = JSON.stringify(status)
    for (const s of snap.snapshot.schedules) {
      expect(text).not.toContain(s.name)
      expect(text).not.toContain(s.prompt_preview.trim())
      expect(text).not.toContain(s.description)
    }
    for (const c of status.changed) expect(Object.keys(c).sort()).toEqual(['etag', 'id', 'state_rev'])
    expect(parseFrame({ ...status, changed: [{ ...status.changed[0], name: 'Daily Digest' }] }).ok).toBe(false)
  })
  it('schedule.detail report text is capped at 4 KiB', () => {
    const f = fixtures['schedule.detail'] as Record<string, unknown>
    const report = { run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA', text: 'x'.repeat(4096) }
    expect(parseFrame({ ...f, report }).ok).toBe(true)
    expect(parseFrame({ ...f, report: { ...report, text: 'x'.repeat(4097) } }).ok).toBe(false)
  })
  it('error frames may carry field paths (up to 20)', () => {
    const f = fixtures.error as Record<string, unknown>
    const fields = [{ path: 'draft.catchup_min', message: 'must be between 15 and 1440' }]
    expect(parseFrame({ ...f, code: 'schedule_invalid', fields }).ok).toBe(true)
    expect(parseFrame({ ...f, fields: Array.from({ length: 21 }, () => fields[0]) }).ok).toBe(false)
    expect(parseFrame({ ...f, fields: [{ path: 'x'.repeat(81), message: 'm' }] }).ok).toBe(false)
  })
  it('hello (bridge) may advertise features; presence and ready echo them', () => {
    const hello = fixtures['hello.bridge'] as { client: Record<string, unknown> }
    expect(parseFrame({ ...hello, client: { ...hello.client, features: [SCHEDULES_FEATURE] } }).ok).toBe(true)
    const presence = fixtures.presence as Record<string, unknown>
    expect(parseFrame({ ...presence, features: [SCHEDULES_FEATURE] }).ok).toBe(true)
    const ready = fixtures.ready as Record<string, unknown>
    expect(parseFrame({ ...ready, features: [SCHEDULES_FEATURE] }).ok).toBe(true)
  })
})

describe('error codes, channel kinds and tools', () => {
  it('has the schedule error codes', () => {
    for (const c of [
      'scheduler_unavailable',
      'schedule_invalid',
      'schedule_conflict',
      'schedule_not_found',
      'schedule_read_only',
      'already_running',
      'headless_blocked',
      'held',
      'not_owner',
      'stale',
    ])
      expect(ErrorCode.options, c).toContain(c)
  })
  it('has schedule_run and schedule_held channel kinds with string meta', () => {
    expect(CHANNEL_KINDS).toContain('schedule_run')
    expect(CHANNEL_KINDS).toContain('schedule_held')
    const meta = {
      chat_id: 'general',
      thread_id: 'general',
      thread_name: 'General',
      message_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
      ts: '2026-10-05T11:45:00.000Z',
      kind: 'schedule_run',
      trust: 'owner',
      schedule_id: 'daily-digest',
      run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
      ds: '2026-10-05',
      fire_at: '2026-10-05T07:30:00-04:00',
      window_ends: '2026-10-05T10:30:00-04:00',
    }
    expect(ChannelMeta.safeParse(meta).success).toBe(true)
  })
})

describe('push templates (S2.2)', () => {
  const config = { agent: { name: 'Talos' }, notifications: { show_thread_names: 'fixed_only' as const }, threads: [] }
  it.each([
    ['schedule_failed', 'A scheduled job failed'],
    ['scheduler_stuck', 'Your scheduler needs you'],
  ] as const)('%s is a fixed system template that opens /schedules and names no job', (template, body) => {
    const p = buildPushPayload({ template }, config)
    expect(p.notification.body).toBe(body)
    expect(p.notification.navigate).toBe('/schedules')
    expect(p.talos.kind).toBe('system')
  })
})

describe('review fixes: protocol-first snapshot read, per-row Chronos parse, safe names', async () => {
  const { parseScheduleSnapshot, parseChronosSnapshot, scheduleFromChronos, ChronosJob } = await import(
    '../src/index.ts'
  )
  const fx = fixtures['schedules.snapshot'] as { snapshot: Record<string, unknown> }
  const threeJobs = () =>
    JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'testkit', 'fixtures', 'chronos-0.3', 'snapshot-three-jobs.json'),
        'utf8',
      ),
    )

  it('a newer snapshot protocol is "update the app", never a bad frame (F10)', () => {
    const newer = { ...fx.snapshot, protocol: 2, some_new_field: true }
    expect(parseFrame({ ...fx, snapshot: newer }).ok).toBe(true)
    expect(parseScheduleSnapshot(newer)).toMatchObject({ ok: false, reason: 'update_app' })
    expect(parseScheduleSnapshot(fx.snapshot)).toMatchObject({ ok: true })
    expect(parseScheduleSnapshot({ ...fx.snapshot, schedules: 'x' })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('one bad row is one unreadable entry, the rest of the list survives (F1)', () => {
    const golden = threeJobs()
    const rows = [
      ...golden.schedules,
      { id: 'bad-time', error: 'time must be HH:MM, 24 hour' },
      { id: 'weird', name: 5 },
    ]
    const p = parseChronosSnapshot({ ...golden, schedules: rows })
    if (!p.ok) throw new Error(p.message)
    expect(p.jobs.map((j) => j.id)).toEqual(golden.schedules.map((j: { id: string }) => j.id))
    expect(p.unreadable.map((u) => u.id)).toEqual(['bad-time', 'weird'])
    expect(parseChronosSnapshot({ nope: 1 }).ok).toBe(false)
  })

  it('a job beyond the edit limits is shown read-only, clamped, with controls and bidi marks made safe (F1, F11)', () => {
    const golden = threeJobs()
    const job = ChronosJob.parse({
      ...golden.schedules[0],
      name: `line1\nline2‮${'n'.repeat(300)}`,
      catchup_min: 5000,
      allowed_tools: Array.from({ length: 250 }, (_, i) => `T${i}`),
    })
    const s = scheduleFromChronos(job, { thread_id: null, offerAgeS: null })
    expect(s.editable).toBe(false)
    expect(s.read_only_reason).toMatch(/Edit it at the Mac/)
    expect(s.name.length).toBeLessThanOrEqual(200)
    expect(s.name).not.toMatch(/[\n‮]/)
    expect(s.allowed_tools.length).toBe(200)
    expect(s.catchup_min).toBe(5000)
  })

  it('ScheduleDraft refuses control and bidi characters in the name and description (F11)', () => {
    expect(ScheduleDraft.safeParse({ ...draft, name: 'a‮b' }).success).toBe(false)
    expect(ScheduleDraft.safeParse({ ...draft, name: 'a\nb' }).success).toBe(false)
    expect(ScheduleDraft.safeParse({ ...draft, description: 'x⁦y' }).success).toBe(false)
    expect(ScheduleDraft.safeParse({ ...draft, name: 'Morning digest ☕' }).success).toBe(true)
  })
})
