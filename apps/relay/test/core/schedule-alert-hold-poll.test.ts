// SCHEDULE_ALERT_HOLD_POLL_S: a scheduler alert held by the quiet window is looked at again on this interval (default 60 s).
// The browser suite runs it every 5 s; it is never slower than 60 s nor under 5 s.
import type { PushIntent } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { type ScheduleHost, ScheduleRouter } from '../../src/core/schedules.ts'
import { RelayEnvSchema } from '../../src/env.ts'

function world(holdPollMs?: number) {
  const clock = fakeClock('2026-10-28T09:00:00.000Z')
  const sent: PushIntent[] = []
  let quiet = true
  const tracked = { n: 0 }
  const seen = new Map<string, number>()
  const host = {
    store: { seenAt: (k: string) => seen.get(k), rememberSeen: (k: string) => void seen.set(k, clock.now()) },
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    fanOut() {},
    notify: (i: PushIntent) => void sent.push(i),
    anyVisible: () => false,
    quietNow: () => quiet,
    track: () => void tracked.n++,
    ...(holdPollMs !== undefined ? { holdPollMs } : {}),
  } as unknown as ScheduleHost
  const router = new ScheduleRouter(host)
  const fail = () =>
    router.onStatus(
      { alert: { kind: 'job_failed', key: 'daily-digest:2026-10-28' } } as never,
      {} as Record<string, unknown>,
    )
  const endQuiet = () => {
    quiet = false
  }
  return { clock, sent, fail, endQuiet, router, tracked }
}

describe('a held scheduler alert after the quiet window', () => {
  it('goes out at the next look: within 5 s with a 5 s poll', () => {
    const w = world(5000)
    w.fail()
    expect(w.sent).toEqual([]) // held while quiet
    w.endQuiet()
    w.clock.advance(5000)
    expect(w.sent.map((i) => i.template)).toEqual(['schedule_failed'])
    w.router.stop()
  })

  it('waits for the default minute when nothing is set', () => {
    const w = world()
    w.fail()
    w.endQuiet()
    w.clock.advance(59_000)
    expect(w.sent).toEqual([])
    w.clock.advance(1000)
    expect(w.sent.map((i) => i.template)).toEqual(['schedule_failed'])
    w.router.stop()
  })
})

describe('a held scheduler alert across a same-process stop and start', () => {
  it('an alert arriving after stop then start is held and sent once the window ends', () => {
    const w = world(5000)
    w.router.stop()
    w.router.start()
    w.fail()
    expect(w.sent).toEqual([])
    w.endQuiet()
    w.clock.advance(5000)
    expect(w.sent.map((i) => i.template)).toEqual(['schedule_failed'])
    w.clock.advance(60_000)
    expect(w.sent).toHaveLength(1)
    w.router.stop()
  })

  it('an alert held before stop is sent once after start when the window ends', () => {
    const w = world(5000)
    w.fail()
    w.router.stop()
    w.router.start()
    const armed = w.tracked.n
    w.router.start() // a second start arms no second timer
    expect(w.tracked.n).toBe(armed)
    w.endQuiet()
    w.clock.advance(5000)
    expect(w.sent.map((i) => i.template)).toEqual(['schedule_failed'])
    w.clock.advance(60_000)
    expect(w.sent).toHaveLength(1)
    w.router.stop()
  })

  it('a stopped router that is not started arms no timer and sends nothing', () => {
    const w = world(5000)
    w.router.stop()
    w.fail()
    expect(w.tracked.n).toBe(0)
    w.endQuiet()
    w.clock.advance(120_000)
    expect(w.sent).toEqual([])
  })
})

describe('SCHEDULE_ALERT_HOLD_POLL_S', () => {
  const parse = (v?: string) =>
    RelayEnvSchema.shape.SCHEDULE_ALERT_HOLD_POLL_S.safeParse(v === undefined ? undefined : v)
  it('defaults to 60 and takes 5 to 60', () => {
    expect(parse().data).toBe(60)
    expect(parse('5').data).toBe(5)
    expect(parse('4').success).toBe(false)
    expect(parse('61').success).toBe(false)
  })
})
