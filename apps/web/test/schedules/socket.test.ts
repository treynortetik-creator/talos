// The socket SchedulesClient (src/lib/socketSchedules.ts) against stub deps: gating, the protocol check, request/answer
// matching, the 20 s silence, and what goes on the wire.
import { newUlid, SCHEDULES_FEATURE, SCHEDULES_FEATURE_V2, SchedulesListFrame } from '@talos-app/protocol'
import { describe, expect, it, vi } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { initialSchedulesSlice, type SchedulesSlice } from '../../src/lib/schedulesClient.ts'
import { createSocketSchedules, NO_ANSWER_MS, SlowPatch } from '../../src/lib/socketSchedules.ts'
import { base } from './variants.ts'

function rig(over: { features?: string[] | undefined; relayFeatures?: string[]; online?: boolean } = {}) {
  let slice: SchedulesSlice = initialSchedulesSlice()
  const sent: Array<Record<string, unknown>> = []
  const listeners = new Map<string, Set<(f: Record<string, unknown>) => void>>()
  let answer: ((f: Record<string, unknown>) => void) | null = null
  const d = {
    sendAndWait: vi.fn(async (frame: Record<string, unknown>) => {
      sent.push(frame)
      answer?.(frame)
    }),
    on: (type: string, cb: (f: Record<string, unknown>) => void) => {
      const s = listeners.get(type) ?? new Set()
      s.add(cb)
      listeners.set(type, s)
      return () => void s.delete(cb)
    },
    getSlice: () => slice,
    setSlice: (n: Partial<SchedulesSlice>) => {
      slice = { ...slice, ...n }
    },
    features: () => ('features' in over ? over.features : [SCHEDULES_FEATURE]),
    relayFeatures: () => over.relayFeatures ?? [SCHEDULES_FEATURE],
    macOnline: () => over.online ?? true,
  }
  const c = createSocketSchedules(d as never)
  const emit = (type: string, f: Record<string, unknown>) => {
    for (const l of listeners.get(type) ?? []) l(f)
  }
  return {
    c,
    d,
    sent,
    emit,
    slice: () => slice,
    replyWith: (fn: (f: Record<string, unknown>) => void) => {
      answer = fn
    },
  }
}

describe('socket schedules: slow is not failed (review B2)', () => {
  it('a patch the Mac has not acked is SlowPatch, carrying the id its card will be matched by', async () => {
    const r = rig()
    r.d.sendAndWait.mockRejectedValueOnce(new TalosClientError('internal', 'The relay did not answer.'))
    const e = (await r.c
      .proposeScheduleChange(
        { op: 'delete', id: 'daily-digest', base_etag: base.schedules[0]?.etag as string },
        'general',
      )
      .catch((x: unknown) => x)) as SlowPatch
    expect(e).toBeInstanceOf(SlowPatch)
    const sentFrame = r.d.sendAndWait.mock.calls[0]?.[0] as unknown as { id: string }
    expect(e.clientRef).toBe(sentFrame.id)
  })
  it('run now and control report silence as "your Mac didn\'t answer"', async () => {
    const r = rig()
    r.d.sendAndWait.mockRejectedValueOnce(new TalosClientError('internal', 'The relay did not answer.'))
    await expect(r.c.controlSchedule('pause', 'daily-digest')).rejects.toMatchObject({
      code: 'internal',
      message: 'no_answer',
    })
  })
})

describe('socket schedules', () => {
  it('list: sends schedules.list, resolves on the snapshot with the same request_id, fills the slice', async () => {
    const r = rig()
    r.replyWith((f) => r.emit('schedules.snapshot', { request_id: f.request_id, snapshot: base }))
    const snap = await r.c.listSchedules()
    expect(snap.schedules).toHaveLength(3)
    expect(r.sent[0]).toMatchObject({ type: 'schedules.list' })
    expect(r.slice()).toMatchObject({ status: 'ready', error: null })
    expect(Object.keys(r.slice().revs)).toContain('daily-digest')
  })

  it('ignores an answer for another request_id', async () => {
    vi.useFakeTimers()
    const r = rig()
    r.replyWith(() => r.emit('schedules.snapshot', { request_id: newUlid(), snapshot: base }))
    const p = r.c.listSchedules().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(NO_ANSWER_MS + 1)
    const e = await p
    expect(e).toBeInstanceOf(TalosClientError)
    expect(r.slice()).toMatchObject({ status: 'error', error: 'no_answer' })
    vi.useRealTimers()
  })

  it('an unknown snapshot protocol is "update the app", not a bad frame', async () => {
    const r = rig()
    r.replyWith((f) =>
      r.emit('schedules.snapshot', { request_id: f.request_id, snapshot: { protocol: 2, whatever: true } }),
    )
    await expect(r.c.listSchedules()).rejects.toBeInstanceOf(TalosClientError)
    expect(r.slice().error).toBe('update_app')
  })

  it('a bridge that does not advertise schedules/1 is "update Talos on your Mac" and nothing is sent', async () => {
    const r = rig({ features: undefined })
    await expect(r.c.listSchedules()).rejects.toBeInstanceOf(TalosClientError)
    expect(r.slice().error).toBe('update_mac')
    expect(r.sent).toHaveLength(0)
    const none = rig({ features: [] })
    await expect(none.c.controlSchedule('pause', 'daily-digest')).rejects.toBeInstanceOf(TalosClientError)
    expect(none.sent).toHaveLength(0)
  })

  it('the Mac offline rejects with mac_offline before sending', async () => {
    const r = rig({ online: false })
    await expect(r.c.listSchedules()).rejects.toMatchObject({ code: 'mac_offline' })
    expect(r.sent).toHaveLength(0)
  })

  it('control, run_now and patch send the exact frame fields; patch returns its own frame id as the client_ref', async () => {
    const r = rig()
    await r.c.controlSchedule('pause', 'daily-digest')
    await r.c.controlSchedule('retry_headless', null)
    await r.c.runScheduleNow('daily-digest', { again: true, where: 'session' })
    const { clientRef } = await r.c.proposeScheduleChange(
      { op: 'update', id: 'daily-digest', base_etag: base.schedules[0]?.etag as string, set: { name: 'x' } },
      'general',
    )
    expect(r.sent[0]).toEqual({ type: 'schedule.control', action: 'pause', schedule_id: 'daily-digest' })
    expect(r.sent[1]).toEqual({ type: 'schedule.control', action: 'retry_headless', schedule_id: null })
    expect(r.sent[2]).toEqual({ type: 'schedule.run_now', schedule_id: 'daily-digest', again: true, where: 'session' })
    expect(r.sent[3]).toMatchObject({
      type: 'schedule.patch',
      id: clientRef,
      thread_id: 'general',
      change: { op: 'update', set: { name: 'x' } },
    })
  })

  it('get returns the detail and the report text, and keeps the detail in the slice', async () => {
    const r = rig()
    const detail = {
      schedule: base.schedules[0],
      prompt: 'p',
      prompt_truncated: false,
      guard: null,
      next_runs: [],
      runs: [],
    }
    r.replyWith((f) =>
      r.emit('schedule.detail', { request_id: f.request_id, detail, report: { run_id: 'r_x', text: 'It ran.' } }),
    )
    const out = await r.c.getSchedule('daily-digest', 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA')
    expect(out.report).toBe('It ran.')
    expect(r.sent[0]).toMatchObject({
      type: 'schedule.get',
      schedule_id: 'daily-digest',
      report_run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
    })
    expect(r.slice().details['daily-digest']).toBeDefined()
  })

  it('schedule_invalid keeps its per-field errors', async () => {
    const r = rig()
    r.d.sendAndWait.mockRejectedValueOnce(
      new TalosClientError('schedule_invalid', 'bad', [{ path: 'draft.name', message: 'too long' }]),
    )
    const e = (await r.c
      .proposeScheduleChange(
        { op: 'delete', id: 'daily-digest', base_etag: base.schedules[0]?.etag as string },
        'general',
      )
      .catch((x: unknown) => x)) as TalosClientError
    expect(e.code).toBe('schedule_invalid')
    expect(e.fields).toEqual([{ path: 'draft.name', message: 'too long' }])
  })
})

describe('R2-2 version skew: app_features only goes to a bridge and relay that know the field', () => {
  const both = [SCHEDULES_FEATURE, SCHEDULES_FEATURE_V2]
  // owner frames are strict objects, so a shipped bridge or relay turns away any frame with a key it doesn't know
  const OLD_LIST = '{"type":"schedules.list","request_id":"REQ"}'
  const OLD_GET = '{"type":"schedule.get","request_id":"REQ","schedule_id":"daily-digest","report_run_id":null}'
  const shape = (f: Record<string, unknown> | undefined) => JSON.stringify({ ...f, request_id: 'REQ' })
  async function frames(r: ReturnType<typeof rig>) {
    r.replyWith((f) => {
      if (f.type === 'schedules.list') r.emit('schedules.snapshot', { request_id: f.request_id, snapshot: base })
      if (f.type === 'schedule.get')
        r.emit('schedule.detail', { request_id: f.request_id, detail: { schedule: base.schedules[0] }, report: null })
    })
    await r.c.listSchedules()
    await r.c.getSchedule('daily-digest', null)
    return r.sent
  }
  it('a bridge without schedules/2: the frames are the old ones, byte for byte', async () => {
    const sent = await frames(rig({ features: [SCHEDULES_FEATURE], relayFeatures: both }))
    expect(shape(sent[0])).toBe(OLD_LIST)
    expect(shape(sent[1])).toBe(OLD_GET)
  })
  it('a relay without schedules/2 (new bridge behind an old relay): the old frames as well', async () => {
    const sent = await frames(rig({ features: both, relayFeatures: [SCHEDULES_FEATURE] }))
    expect(shape(sent[0])).toBe(OLD_LIST)
    expect(shape(sent[1])).toBe(OLD_GET)
  })
  it('both know it: app_features is sent on list and get', async () => {
    const sent = await frames(rig({ features: both, relayFeatures: both }))
    expect(sent[0]).toMatchObject({ type: 'schedules.list', app_features: [SCHEDULES_FEATURE_V2] })
    expect(sent[1]).toMatchObject({ type: 'schedule.get', app_features: [SCHEDULES_FEATURE_V2] })
  })
  it('the old-shaped frame parses under the strict schema the shipped bridge has (the current one minus the new field), the new one does not', () => {
    const old = SchedulesListFrame.omit({ app_features: true })
    const env = { v: 1, id: 'x', ts: '2026-10-05T11:00:00.000Z', device_id: 'dev', osig: 'sig' }
    const ok = old.safeParse({ ...env, type: 'schedules.list', request_id: newUlid() })
    expect(ok.error?.issues.map((i) => i.path.join('.'))).not.toContain('request_id')
    expect(
      old.safeParse({ ...env, type: 'schedules.list', request_id: newUlid(), app_features: ['schedules/2'] }).success,
    ).toBe(false)
  })
})
