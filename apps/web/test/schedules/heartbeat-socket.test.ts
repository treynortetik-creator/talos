// The socket client's testHeartbeat (HB5): the gate on both ends' features, what goes on the wire, the 200 s wait, and that a
// failed test never turns the whole list into an error page.
import { HEARTBEAT_FEATURE, HEARTBEAT_TEST_WAIT_MS, newUlid, SCHEDULES_FEATURE } from '@talos-app/protocol'
import { describe, expect, it, vi } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { initialSchedulesSlice, type SchedulesSlice } from '../../src/lib/schedulesClient.ts'
import { createSocketSchedules, NO_ANSWER_MS } from '../../src/lib/socketSchedules.ts'
import { hbConfig } from './variants.ts'

function rig(over: { features?: string[]; relayFeatures?: string[]; online?: boolean } = {}) {
  let slice: SchedulesSlice = initialSchedulesSlice()
  const sent: Array<Record<string, unknown>> = []
  const listeners = new Map<string, Set<(f: Record<string, unknown>) => void>>()
  const online = new Set<() => void>()
  const d = {
    sendAndWait: vi.fn(async (frame: Record<string, unknown>) => void sent.push(frame)),
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
    features: () => over.features ?? [SCHEDULES_FEATURE, HEARTBEAT_FEATURE],
    relayFeatures: () => over.relayFeatures ?? [HEARTBEAT_FEATURE],
    macOnline: () => over.online ?? true,
    onOnline: (cb: () => void) => {
      online.add(cb)
      return () => void online.delete(cb)
    },
  }
  const c = createSocketSchedules(d as never)
  const emit = (type: string, f: Record<string, unknown>) => {
    for (const l of listeners.get(type) ?? []) l(f)
  }
  const reconnect = () => {
    for (const cb of [...online]) cb()
  }
  return { c, d, sent, emit, reconnect, slice: () => slice }
}

describe('testHeartbeat on the socket', () => {
  it('sends a frame the relay schema accepts, and resolves on the result with the same request_id', async () => {
    const r = rig()
    const p = r.c.testHeartbeat(hbConfig(), { windowH: 24, withAgent: false })
    await vi.waitFor(() => expect(r.sent).toHaveLength(1))
    const f = r.sent[0] as Record<string, unknown>
    expect(f).toMatchObject({ type: 'heartbeat.test', window_h: 24, with_agent: false })
    r.emit('heartbeat.test_result', { request_id: newUlid(), result: { wrong: true } }) // another request: ignored
    r.emit('heartbeat.test_result', { request_id: f.request_id, result: { ok: 1 } })
    await expect(p).resolves.toEqual({ ok: 1 })
  })

  it('does not send to a Mac or a relay that does not list heartbeat/1', async () => {
    const oldMac = rig({ features: [SCHEDULES_FEATURE] })
    await expect(oldMac.c.testHeartbeat(hbConfig(), { windowH: 24, withAgent: false })).rejects.toMatchObject({
      code: 'scheduler_unavailable',
      message: expect.stringMatching(/Mac/),
    })
    const oldRelay = rig({ relayFeatures: [] })
    await expect(oldRelay.c.testHeartbeat(hbConfig(), { windowH: 24, withAgent: false })).rejects.toMatchObject({
      code: 'scheduler_unavailable',
      message: expect.stringMatching(/relay/),
    })
    expect(oldMac.sent).toHaveLength(0)
    expect(oldRelay.sent).toHaveLength(0)
  })

  it('offline is mac_offline and sends nothing', async () => {
    const r = rig({ online: false })
    await expect(r.c.testHeartbeat(hbConfig(), { windowH: 24, withAgent: false })).rejects.toMatchObject({
      code: 'mac_offline',
    })
    expect(r.sent).toHaveLength(0)
  })

  it('waits past the ordinary 20 s for a slow test, then gives up at 200 s without poisoning the list', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      const p = r.c.testHeartbeat(hbConfig(), { windowH: 24, withAgent: false }).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(NO_ANSWER_MS + 1)
      expect(r.slice().status).not.toBe('error')
      await vi.advanceTimersByTimeAsync(HEARTBEAT_TEST_WAIT_MS)
      const e = await p
      expect(e).toBeInstanceOf(TalosClientError)
      expect((e as Error).message).toBe('no_answer')
      expect(r.slice().status).not.toBe('error')
      expect(r.slice().error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a slow test still resolves at 150 s', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      const p = r.c.testHeartbeat(hbConfig(), { windowH: 8, withAgent: false })
      await vi.advanceTimersByTimeAsync(150_000)
      r.emit('heartbeat.test_result', {
        request_id: (r.sent[0] as { request_id: string }).request_id,
        result: { late: 1 },
      })
      await expect(p).resolves.toEqual({ late: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('R1-4: when the socket comes back mid-test it asks again with the SAME request_id (new frame id) and still gets the result', async () => {
    const r = rig()
    const p = r.c.testHeartbeat(hbConfig(), { windowH: 24, withAgent: false })
    await vi.waitFor(() => expect(r.sent).toHaveLength(1))
    r.reconnect()
    await vi.waitFor(() => expect(r.sent).toHaveLength(2))
    const [a, b] = r.sent as Array<{ id?: string; request_id: string; config: unknown }>
    expect(b?.request_id).toBe(a?.request_id)
    expect(b?.config).toEqual(a?.config)
    r.emit('heartbeat.test_result', { request_id: a?.request_id, result: { back: 1 } })
    await expect(p).resolves.toEqual({ back: 1 })
    r.reconnect() // nothing in flight any more: no third frame
    await Promise.resolve()
    expect(r.sent).toHaveLength(2)
  })

  it('R1-4: a reconnect before the first frame was sent, or after the answer, sends nothing extra', async () => {
    const r = rig()
    r.reconnect()
    expect(r.sent).toHaveLength(0)
  })
})
