// The app request router (core/apps.ts) on its own, with a fake host and a fake clock: clock jumps, forced errors,
// the 15-minute map, the per-socket cap. The wire behaviour is in app-frames.test.ts.
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { APP_MAX_IN_FLIGHT_PER_SOCKET, APP_REQUEST_MAP_MS, AppRouter, type AppsHost } from '../../src/core/apps.ts'

type Sent = { to: string; raw: Record<string, unknown> }

function rig(opts: { online?: boolean } = {}) {
  const clock: FakeClock = fakeClock()
  const state = { online: opts.online ?? true, live: new Set(['s1', 's2']), throwOnBridge: false }
  const toApp: Sent[] = []
  const toBridge: Array<Record<string, unknown>> = []
  const errors: Array<{ id: string; code: string; ref: string }> = []
  const host: AppsHost = {
    clock,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    bridgeOnline: () => state.online,
    sendBridge: (raw) => {
      if (state.throwOnBridge) throw new Error('socket exploded')
      toBridge.push(raw)
    },
    sendToApp: (id, raw) => {
      if (!state.live.has(id)) return false
      toApp.push({ to: id, raw })
      return true
    },
    socketLive: (id) => state.live.has(id),
    appError: (id, code, _m, ref) => void errors.push({ id, code, ref }),
  }
  const router = new AppRouter(host)
  let n = 0
  const req = (socket: string, over: Partial<{ id: string; view_id: string; request_id: string }> = {}) => {
    n++
    const f = { id: over.id ?? `f${n}`, view_id: over.view_id ?? 'av_1', request_id: over.request_id ?? `ar_${n}` }
    router.onRequest(socket, f, { type: 'app.request', ...f })
    return f
  }
  const resp = (request_id: string, over: Record<string, unknown> = {}) =>
    router.onResponse(
      { view_id: 'av_1', request_id, state: 'done' },
      { type: 'app.response', view_id: 'av_1', request_id, state: 'done', ...over },
    )
  return { clock, state, toApp, toBridge, errors, router, req, resp }
}

describe('clock jumps', () => {
  it('forward past 15 minutes: the route is gone and the late answer is dropped', () => {
    const t = rig()
    const f = t.req('s1')
    t.clock.advance(APP_REQUEST_MAP_MS + 1)
    t.resp(f.request_id)
    expect(t.toApp).toEqual([])
    expect(t.router.pending()).toBe(0)
  })

  it('forward by just under 15 minutes: still routed', () => {
    const t = rig()
    const f = t.req('s1')
    t.clock.advance(APP_REQUEST_MAP_MS - 1000)
    t.resp(f.request_id)
    expect(t.toApp).toHaveLength(1)
  })

  it('a step back by a day does not kill an in-flight request, and it still expires 15 minutes later (never lives forever)', () => {
    const t = rig()
    const f = t.req('s1')
    t.clock.advance(-24 * 3600_000)
    t.router.prune()
    expect(t.router.pending()).toBe(1)
    t.clock.advance(APP_REQUEST_MAP_MS - 1000)
    t.router.prune()
    expect(t.router.pending()).toBe(1)
    t.clock.advance(2000)
    t.router.prune()
    expect(t.router.pending()).toBe(0)
    t.resp(f.request_id)
    expect(t.toApp).toEqual([])
  })

  it('a step back does not refill or drain the rate budget; a step forward refills it', () => {
    const t = rig()
    for (let i = 0; i < 60; i++) t.req('s1')
    t.req('s1') // 61st
    expect(t.toApp.at(-1)?.raw.error).toMatchObject({ code: 'rate_limited' })
    t.clock.advance(-3600_000)
    t.req('s1')
    expect(t.toApp.filter((x) => (x.raw.error as { code: string } | undefined)?.code === 'rate_limited')).toHaveLength(
      2,
    )
    t.clock.advance(3600_000 + 61_000)
    const before = t.toBridge.length
    t.req('s1')
    expect(t.toBridge.length).toBe(before + 1)
  })
})

describe('rate limit and caps', () => {
  it('60 pass, the 61st fails rate_limited to its sender; a second socket shares the same 60', () => {
    const t = rig()
    for (let i = 0; i < 60; i++) t.req('s1')
    expect(t.toBridge).toHaveLength(60)
    const f = t.req('s1')
    expect(t.toBridge).toHaveLength(60)
    expect(t.toApp.at(-1)).toMatchObject({
      to: 's1',
      raw: { state: 'failed', request_id: f.request_id, error: { code: 'rate_limited' } },
    })
    t.req('s2') // one budget for the owner: a second socket does not get its own 60
    expect(t.toBridge).toHaveLength(60)
    expect(t.toApp.at(-1)).toMatchObject({ to: 's2', raw: { error: { code: 'rate_limited' } } })
  })

  it('the budget refills over a minute', () => {
    const t = rig()
    for (let i = 0; i < 60; i++) t.req('s1')
    t.clock.advance(30_000)
    t.req('s1')
    expect(t.toBridge.length).toBeGreaterThan(60)
  })

  it('the per-socket cap on requests in flight answers too_many_pending (needs a window wide enough to reach it)', () => {
    const t = rig()
    for (let i = 0; i < APP_MAX_IN_FLIGHT_PER_SOCKET; i++) {
      if (i % 50 === 0) t.clock.advance(60_000) // refill the 60/min bucket so only the in-flight cap can bite
      t.req('s1')
    }
    t.clock.advance(60_000)
    const f = t.req('s1')
    expect(t.toApp.at(-1)?.raw).toMatchObject({ request_id: f.request_id, error: { code: 'too_many_pending' } })
    expect(t.toBridge).toHaveLength(APP_MAX_IN_FLIGHT_PER_SOCKET)
    t.clock.advance(60_000)
    t.req('s2') // another socket is not held back by s1's in-flight cap
    expect(t.toBridge).toHaveLength(APP_MAX_IN_FLIGHT_PER_SOCKET + 1)
  })
})

describe('frame ids', () => {
  it('a reused frame id (other socket, or same socket with a new request_id) is refused and cannot steal the error route', () => {
    const t = rig()
    const a = t.req('s1', { id: 'dup', request_id: 'ar_a' })
    t.req('s2', { id: 'dup', request_id: 'ar_b' })
    t.req('s1', { id: 'dup', request_id: 'ar_c' })
    expect(t.errors.map((e) => e.code)).toEqual(['bad_frame', 'bad_frame'])
    expect(t.toBridge).toHaveLength(1)
    expect(t.router.onError({ ref: a.id, code: 'bad_frame' })).toBe(true)
    expect(t.toApp.at(-1)).toMatchObject({ to: 's1', raw: { request_id: 'ar_a', state: 'failed' } })
  })
})

describe('forced errors and off mid-work', () => {
  it('the bridge socket throwing on send leaves no route behind', () => {
    const t = rig()
    t.state.throwOnBridge = true
    expect(() => t.req('s1')).toThrow('socket exploded')
    expect(t.router.pending()).toBe(0)
  })

  it('offline: a failed mac_offline to the sender, no route, nothing sent to the bridge', () => {
    const t = rig({ online: false })
    const f = t.req('s1')
    expect(t.toApp).toHaveLength(1)
    expect(t.toApp[0]).toMatchObject({
      to: 's1',
      raw: { state: 'failed', request_id: f.request_id, error: { code: 'mac_offline' } },
    })
    expect(t.toBridge).toEqual([])
    expect(t.router.pending()).toBe(0)
  })

  it('an answer for a socket that is gone is dropped quietly; dropSocket clears its routes', () => {
    const t = rig()
    const f = t.req('s1')
    t.state.live.delete('s1')
    t.resp(f.request_id)
    expect(t.toApp).toEqual([])
    const g = t.req('s2')
    t.router.dropSocket('s2')
    expect(t.router.pending()).toBe(0)
    t.resp(g.request_id)
    expect(t.toApp).toEqual([])
  })

  it('a dead socket frees its request_id for a reconnecting tab; a live one does not', () => {
    const t = rig()
    const f = t.req('s1', { request_id: 'ar_same' })
    t.req('s2', { request_id: 'ar_same' })
    expect(t.errors).toEqual([{ id: 's2', code: 'bad_frame', ref: 'f2' }])
    t.state.live.delete('s1')
    t.req('s2', { request_id: 'ar_same', id: 'f3' })
    expect(t.toBridge.map((x) => x.id)).toEqual([f.id, 'f3'])
    t.resp('ar_same')
    expect(t.toApp.at(-1)?.to).toBe('s2')
  })

  it('onError for an unknown ref is not ours (false); for ours it is handled once and the route is gone', () => {
    const t = rig()
    expect(t.router.onError({ ref: 'nope', code: 'bad_frame' })).toBe(false)
    expect(t.router.onError({ code: 'bad_frame' })).toBe(false)
    const f = t.req('s1')
    expect(t.router.onError({ ref: f.id, code: 'bad_frame' })).toBe(true)
    expect(t.toApp.at(-1)?.raw).toMatchObject({ state: 'failed', error: { code: 'tool_failed' } })
    expect(t.router.pending()).toBe(0)
    expect(t.router.onError({ ref: f.id, code: 'bad_frame' })).toBe(true) // a repeat is swallowed, not answered twice
    expect(t.toApp.filter((x) => x.raw.type === 'app.response')).toHaveLength(1)
  })

  it('an error ref after the 15-minute memory is no longer ours', () => {
    const t = rig()
    const f = t.req('s1')
    t.clock.advance(APP_REQUEST_MAP_MS + 1)
    expect(t.router.onError({ ref: f.id, code: 'bad_frame' })).toBe(false)
  })
})
