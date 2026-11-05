// HB1b: no card ever offers an unreadable or unknown-kind heartbeat for approval. The rule sits in the one place every way of
// changing a job passes through (prepareCard): the agent's schedule_propose, the owner's schedule.patch frame, and an adopt.
// The bridge, relay and app frames are the real ones; Chronos is a replay of its recorded output.
import { afterEach, describe, expect, test } from 'bun:test'
import { HEARTBEAT_META_KEY, heartbeatConfigHashOf } from '@talos-app/protocol'
import { recordPass } from '../../src/heartbeat/tested.ts'
import { longTimeouts, type Req, type SchedHarness, startSched } from './harness.ts'
import { fixture, ReplayBox } from './replay-box.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const gh = { id: 'gh-main', kind: 'github', enabled: true, args: { repos: ['acme/widgets'] }, timeout_s: 30 }
const good = {
  schema: 'talos.heartbeat/1',
  mode: 'shadow',
  sources: [gh],
  mutes: [],
  wake_cap_per_day: 3,
  run_timeout_s: 120,
}
const SLOTS = ['09:45', '12:15', '14:45', '17:15']
const propose = (meta: unknown, over: Record<string, unknown> = {}) => ({
  op: 'create',
  thread_id: 'general',
  reason: 'a heartbeat',
  name: 'New Beat',
  when: { type: 'times', days: 'weekdays', times: SLOTS },
  meta,
  prompt: 'Check.\n',
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  ...over,
})
const V2 = { relayFeatures: ['schedules/1', 'schedules/2'] }
const start = (box: ReplayBox) => startSched({ box, relay: V2, now: box.now })
const createDraft = (meta: unknown, when: unknown = { type: 'times', days: 'weekdays', times: SLOTS }) => ({
  id: 'new-beat',
  name: 'New Beat',
  description: '',
  when,
  catchup_min: 60,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: 'general',
  prompt: 'Check.\n',
  meta,
})
const unknownKind = { ...good, sources: [gh, { id: 'chat', kind: 'slack', enabled: true, args: {}, timeout_s: 10 }] }
const unreadable = { sources: 'x' }
const bad: Array<[string, unknown, string]> = [
  ['an unknown source kind', { [HEARTBEAT_META_KEY]: unknownKind }, `kind this Talos doesn't know ("slack")`],
  ['an unreadable config', { [HEARTBEAT_META_KEY]: unreadable }, 'not valid'],
  ['an unknown key', { [HEARTBEAT_META_KEY]: { ...good, future: 1 } }, 'not valid'],
  [
    'argv[0] that is not absolute',
    {
      [HEARTBEAT_META_KEY]: {
        ...good,
        sources: [{ id: 'ww', kind: 'command', enabled: true, args: { argv: ['python3'] }, timeout_s: 10 }],
      },
    },
    'absolute',
  ],
]

describe('BUG 6: the agent tool schedule_propose', () => {
  for (const [name, meta, words] of bad)
    test(`${name} is refused with a plain message, Chronos is never asked, no card is made`, async () => {
      const box = ReplayBox.times()
      h = await start(box)
      const r = await h.bridge.callTool('schedule_propose', propose(meta))
      expect(r.isError).toBe(true)
      expect(r.content[0]?.text).toContain(words)
      expect(r.content[0]?.text).toContain('Nothing was saved')
      expect(box.callsOf('validate')).toEqual([])
      expect(h.bridge.ctx.ledger.list('pending').filter((c) => c.binding.kind === 'schedule')).toEqual([])
    })
  test('a heartbeat on a job that is not a times job is refused', async () => {
    const box = ReplayBox.times()
    h = await start(box)
    const r = await h.bridge.callTool(
      'schedule_propose',
      propose({ [HEARTBEAT_META_KEY]: good }, { when: { type: 'daily', time: '09:00' } }),
    )
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('several times a day')
    expect(box.callsOf('validate')).toEqual([])
  })
  test('positive control: a good heartbeat on a times job passes the guard and reaches Chronos', async () => {
    const box = ReplayBox.times()
    const v = fixture<Record<string, unknown>>('chronos-0.4', 'validate-times-create')
    box.answer('validate', { ok: true, normalized: v.normalized, preview: v.preview, expected_etag: v.expected_etag })
    h = await start(box)
    recordPass(h.home, heartbeatConfigHashOf(good), h.clock.now()) // test_required has its own tests (heartbeat-test-required.test.ts)
    const r = await h.bridge.callTool(
      'schedule_propose',
      propose({ [HEARTBEAT_META_KEY]: good, other: 1 }, { result_thread_id: 'inbox' }),
    )
    expect(r.isError).toBeFalsy()
    expect(box.callsOf('validate')).toHaveLength(1)
  })
  test('an update that sets a bad heartbeat on an existing times job is refused too', async () => {
    const box = ReplayBox.times()
    box.answer('detail', fixture('chronos-0.4', 'detail-times-meta'))
    h = await start(box)
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'update',
      id: 'check-in',
      thread_id: 'general',
      reason: 'x',
      meta: { [HEARTBEAT_META_KEY]: unknownKind },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain(`kind this Talos doesn't know`)
    expect(box.callsOf('validate')).toEqual([])
  })
  test('an update that moves a heartbeat job off several times a day is refused', async () => {
    const box = ReplayBox.times()
    const detail = fixture<{ schedule: Record<string, unknown> }>('chronos-0.4', 'detail-times-meta')
    detail.schedule.meta = { [HEARTBEAT_META_KEY]: good }
    box.answer('detail', detail)
    h = await start(box)
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'update',
      id: 'check-in',
      thread_id: 'general',
      reason: 'x',
      when: { type: 'daily', time: '09:00' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('several times a day')
    expect(box.callsOf('validate')).toEqual([])
  })
})

describe('BUG 6: the owner form frame schedule.patch', () => {
  for (const [name, meta, words] of bad)
    test(`${name}: schedule_invalid with the meta field and the same words`, async () => {
      const box = ReplayBox.times()
      h = await start(box)
      const f = await h.app.patchSchedule({ op: 'create', draft: createDraft(meta) }, 'general')
      const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in' })
      expect(e.code).toBe('schedule_invalid')
      expect(JSON.stringify(e.fields)).toContain('"meta"')
      expect(String(e.message) + JSON.stringify(e.fields)).toContain(words)
      expect(box.callsOf('validate')).toEqual([])
    })
  test('a heartbeat on a daily job is refused', async () => {
    const box = ReplayBox.times()
    h = await start(box)
    const f = await h.app.patchSchedule(
      { op: 'create', draft: createDraft({ [HEARTBEAT_META_KEY]: good }, { type: 'daily', time: '09:00' }) },
      'general',
    )
    const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in' })
    expect(e.code).toBe('schedule_invalid')
    expect(JSON.stringify(e.fields)).toContain('several times a day')
  })
})

describe('BUG 6: adopting a job whose meta was edited outside the app', () => {
  test('an on-disk heartbeat with an unknown source kind cannot be offered for approval', async () => {
    const box = ReplayBox.times()
    const detail = fixture<{ schedule: { content_hash: string; meta: unknown } }>('chronos-0.4', 'detail-times-meta')
    detail.schedule.meta = { [HEARTBEAT_META_KEY]: unknownKind }
    box.answer('detail', detail)
    h = await start(box)
    const f = await h.app.patchSchedule(
      { op: 'adopt', id: 'check-in', content_hash: detail.schedule.content_hash },
      'general',
    )
    const e = await h.app.expectFrame('error', (r) => r.ref === (f as unknown as Req).id, { direction: 'in' })
    expect(e.code).toBe('schedule_invalid')
    expect(JSON.stringify(e.fields)).toContain(`kind this Talos doesn't know`)
  })
})

// HB2 review R1-4: a heartbeat is checked by the bridge. A job that runs headless, restricted or as a command would be
// started by Chronos itself with the job's prompt, which is an agent run on every slot.
describe('R1-4: a heartbeat job has to run in the live session', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['runner headless', { runner: 'headless' }],
    ['permissions restricted', { permissions: 'restricted', allowed_tools: ['Read'] }],
  ]
  for (const [name, over] of cases) {
    test(`the agent tool refuses ${name}; Chronos is never asked`, async () => {
      const box = ReplayBox.times()
      h = await start(box)
      const r = await h.bridge.callTool('schedule_propose', propose({ [HEARTBEAT_META_KEY]: good }, over))
      expect(r.isError).toBe(true)
      expect(r.content[0]?.text).toContain('live session')
      expect(box.callsOf('validate')).toEqual([])
    })
    test(`the owner form frame refuses ${name}`, async () => {
      const box = ReplayBox.times()
      h = await start(box)
      const f = await h.app.patchSchedule(
        { op: 'create', draft: { ...createDraft({ [HEARTBEAT_META_KEY]: good }), ...over } },
        'general',
      )
      const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in' })
      expect(e.code).toBe('schedule_invalid')
      expect(String(e.message) + JSON.stringify(e.fields)).toContain('live session')
    })
  }
  test('an update that moves a heartbeat job to headless is refused', async () => {
    const box = ReplayBox.times()
    const detail = fixture<{ schedule: Record<string, unknown> }>('chronos-0.4', 'detail-times-meta')
    detail.schedule.meta = { [HEARTBEAT_META_KEY]: good }
    detail.schedule.runner = 'session'
    detail.schedule.permissions = 'full'
    box.answer('detail', detail)
    h = await start(box)
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'update',
      id: 'check-in',
      thread_id: 'general',
      reason: 'x',
      runner: 'headless',
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('live session')
    expect(box.callsOf('validate')).toEqual([])
  })
  test('adopting a heartbeat that is a command job, or already headless, cannot be offered for approval', async () => {
    for (const bad of [{ kind: 'command' }, { runner: 'headless' }, { permissions: 'restricted' }]) {
      const box = ReplayBox.times()
      const detail = fixture<{ schedule: Record<string, unknown> & { content_hash: string } }>(
        'chronos-0.4',
        'detail-times-meta',
      )
      detail.schedule.meta = { [HEARTBEAT_META_KEY]: good }
      detail.schedule.runner = 'session'
      detail.schedule.permissions = 'full'
      Object.assign(detail.schedule, bad)
      box.answer('detail', detail)
      h = await start(box)
      const f = await h.app.patchSchedule(
        { op: 'adopt', id: 'check-in', content_hash: detail.schedule.content_hash },
        'general',
      )
      const e = await h.app.expectFrame('error', (r) => r.ref === (f as unknown as Req).id, { direction: 'in' })
      expect(e.code).toBe('schedule_invalid')
      expect(String(e.message) + JSON.stringify(e.fields)).toContain('live session')
      await h.stop()
      h = undefined as unknown as SchedHarness
    }
  })
  test('positive control: runner session with full permissions still reaches Chronos', async () => {
    const box = ReplayBox.times()
    const v = fixture<Record<string, unknown>>('chronos-0.4', 'validate-times-create')
    box.answer('validate', { ok: true, normalized: v.normalized, preview: v.preview, expected_etag: v.expected_etag })
    h = await start(box)
    recordPass(h.home, heartbeatConfigHashOf(good), h.clock.now())
    const r = await h.bridge.callTool(
      'schedule_propose',
      propose({ [HEARTBEAT_META_KEY]: good }, { result_thread_id: 'inbox' }),
    )
    expect(r.isError).toBeFalsy()
  })
})

// HB2 review R2-3: a heartbeat that is already headless or restricted must still be switchable off and movable.
describe('R2-3: turning off or moving a bad heartbeat is not blocked by the session guard', () => {
  const badJob = () => {
    const box = ReplayBox.times()
    const v = fixture<Record<string, unknown>>('chronos-0.4', 'validate-times-create')
    box.answer('validate', { ok: true, normalized: v.normalized, preview: v.preview, expected_etag: v.expected_etag })
    const detail = fixture<{ schedule: Record<string, unknown> }>('chronos-0.4', 'detail-times-meta')
    detail.schedule.meta = { [HEARTBEAT_META_KEY]: good }
    detail.schedule.runner = 'headless'
    detail.schedule.permissions = 'restricted'
    box.answer('detail', detail)
    return box
  }
  const update = (set: Record<string, unknown>) => ({
    op: 'update',
    id: 'check-in',
    thread_id: 'general',
    reason: 'x',
    ...set,
  })

  test('enabled:false, and a move to another thread, reach Chronos', async () => {
    // a move of the result thread is Talos-only and never reaches Chronos; switching off does
    for (const [set, validates] of [
      [{ enabled: false }, 1],
      [{ result_thread_id: 'inbox' }, 0],
    ] as const) {
      const box = badJob()
      h = await start(box)
      const r = await h.bridge.callTool('schedule_propose', update(set))
      expect(r.content[0]?.text ?? '').not.toContain('live session')
      expect(r.isError, r.content[0]?.text).toBeFalsy()
      expect(box.callsOf('validate')).toHaveLength(validates)
      await h.stop()
      h = undefined as unknown as SchedHarness
    }
  })
  test('anything that keeps it enabled still needs the guard: enabled:true, a new prompt, a new time', async () => {
    for (const set of [{ enabled: true }, { prompt: 'x\n' }, { enabled: false, name: 'Renamed' }]) {
      const box = badJob()
      h = await start(box)
      const r = await h.bridge.callTool('schedule_propose', update(set))
      expect(r.isError, JSON.stringify(set)).toBe(true)
      expect(r.content[0]?.text).toContain('live session')
      expect(box.callsOf('validate')).toEqual([])
      await h.stop()
      h = undefined as unknown as SchedHarness
    }
  })
})
