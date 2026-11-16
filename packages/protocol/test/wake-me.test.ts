// The wake_me shapes the app reads (docs/OPTION-C.md "Wake me"): pending wakes ride in `workers.status`, read one row at a
// time, so a row this build can't read costs that row and never the frame; an older bridge sends none; a cancel is one more
// `thread.session.control` action; and a fired wake is its own channel kind.
import { describe, expect, test } from 'vitest'
import {
  ChannelMeta,
  isWakeJobId,
  ScheduleId,
  ThreadSessionControlFrame,
  WAKE_STATUS_MAX,
  WakeId,
  WorkersStatus,
} from '../src/index.ts'

const base = {
  supported: true,
  supervisor_online: true,
  governor: { state: 'ok' },
  at: '2026-10-05T11:29:00.000Z',
}
const good = { id: 'talos-wake-abcdefghijkl', at: '2026-10-05T12:00:00.000Z', note: 'Check the build.' }

describe('pending wakes in workers.status', () => {
  test('one unreadable row is dropped, the rest and the frame are kept', () => {
    const s = WorkersStatus.parse({
      ...base,
      threads: [
        { thread_id: 'work', state: 'live', wakes: [{ id: 'nope', at: 'soon', note: 1 }, good], wakes_total: 2 },
      ],
      main_wakes: [good, { id: good.id }],
    })
    expect(s.threads[0]?.wakes).toEqual([good])
    expect(s.threads[0]?.state).toBe('live')
    expect(s.main_wakes).toEqual([good])
  })

  test('an older bridge sends none, and a list this build cannot read at all reads as none', () => {
    expect(WorkersStatus.parse({ ...base, threads: [{ thread_id: 'work', state: 'live' }] }).threads[0]?.wakes).toBe(
      undefined,
    )
    const s = WorkersStatus.parse({
      ...base,
      threads: [{ thread_id: 'work', state: 'live', wakes: 'later', wakes_total: -1 }],
      main_wakes: Array.from({ length: WAKE_STATUS_MAX * 3 }, () => good),
    })
    expect(s.threads[0]?.wakes).toBeUndefined()
    expect(s.threads[0]?.wakes_total).toBeUndefined()
    expect(s.main_wakes).toBeUndefined()
  })
})

describe('ids, the cancel and the channel kind', () => {
  test('a wake id is a valid scheduler job id, in a range of its own', () => {
    expect(ScheduleId.safeParse(good.id).success).toBe(true)
    expect(isWakeJobId(good.id)).toBe(true)
    expect(isWakeJobId('daily-digest')).toBe(false)
    expect(WakeId.safeParse('talos-wake-ABCDEFGHIJKL').success).toBe(false)
  })

  test('cancel_wake is a thread.session.control action carrying the wake id', () => {
    const f = {
      v: 1,
      type: 'thread.session.control',
      id: '01JBF3V7Q8K2M4N6P8R0S1T2V3',
      ts: '2026-10-05T11:29:00.000Z',
      device_id: 'd_abcdefghijklmnopqrst',
      osig: 'A'.repeat(86),
      control_id: '01JBF3V7Q8K2M4N6P8R0S1T2V4',
      thread_id: 'work',
      action: 'cancel_wake',
      wake_id: good.id,
    }
    const r = ThreadSessionControlFrame.safeParse(f)
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true)
  })

  test('a fired wake is kind=wake with its id and whose it is', () => {
    const m = ChannelMeta.safeParse({
      chat_id: 'work',
      thread_id: 'work',
      thread_name: 'Work',
      message_id: 'wk_01JBF3V7Q8K2M4N6P8R0S1T2U3',
      ts: '2026-10-05T12:00:00.000Z',
      kind: 'wake',
      trust: 'agent',
      wake_id: good.id,
      wake_for: 'thread',
    })
    expect(m.success).toBe(true)
  })
})
