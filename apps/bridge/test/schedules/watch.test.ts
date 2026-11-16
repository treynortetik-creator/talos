// The schedule service's file watch (S3.2). Every other schedules test drives the watch itself (harness drivenWatch): a real
// fs.watch on a loaded Mac answers in 0.1-15 s or never, and each answer starts a refresh at a moment no test chose. Here:
// one smoke test on the real watch, and the catch-up pass that covers a change the watch cannot see.
import { afterEach, describe, expect, test } from 'bun:test'
import { utimesSync } from 'node:fs'
import type { SchedulerAdapter } from '../../src/schedules/adapter.ts'
import { draft, longTimeouts, type SchedHarness, sleep, startSched, waitFor } from './harness.ts'

longTimeouts()

let h: SchedHarness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const has = (x: SchedHarness, id: string) =>
  x.bridge.ctx.schedules?.lastGood?.schedules.some((s) => s.id === id) === true

describe('the schedule file watch', () => {
  test('smoke: a real fs.watch sees a job made outside the app, with no poll (the clock never moves)', async () => {
    h = await startSched({ jobs: [draft()], scheduleWatch: 'real' })
    const x = h
    expect(has(x, 'daily-digest')).toBe(true)
    x.box.create(draft({ id: 'made-outside', name: 'Made outside' }))
    // fseventsd can drop an event on a loaded Mac: touch the scheduler's files again, up to three times, before failing
    const paths = x.bridge.ctx.schedules?.disc?.adapter.watchPaths() ?? []
    expect(paths.length).toBeGreaterThan(0)
    for (let i = 0; i < 3 && !has(x, 'made-outside'); i++) {
      if (i > 0) for (const p of paths) utimesSync(p, new Date(), new Date())
      await waitFor(() => has(x, 'made-outside'), 10_000, 'the watch to report the new job').catch(() => {})
    }
    expect(has(x, 'made-outside')).toBe(true)
  })

  test('a change made after the snapshot was read and before the watch opened is caught up, not left to the 30 s poll', async () => {
    let injected = false
    let box: { create: (d: ReturnType<typeof draft>) => unknown } | undefined
    h = await startSched({
      jobs: [draft()],
      // a watch that never reports anything: only the catch-up pass can find the change
      scheduleWatchFn: () => ({ close: () => {} }),
      wrapAdapter: (a: SchedulerAdapter) =>
        new Proxy(a, {
          get(t, p) {
            const v = (t as unknown as Record<string | symbol, unknown>)[p]
            if (p === 'snapshot')
              return async (...args: unknown[]) => {
                const snap = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args)
                // the write lands between this read and the watch opening
                if (!injected && box) {
                  injected = true
                  box.create(draft({ id: 'in-the-window', name: 'In the window' }))
                }
                return snap
              }
            return typeof v === 'function' ? v.bind(t) : v
          },
        }),
      startBridge: false,
    })
    box = h.box
    const x = h
    x.bridge.start()
    await waitFor(() => x.bridge.client?.connected === true, 10_000, 'the bridge socket to be authed')
    x.clock.advance(300) // the post-ready settle timer, as startSched nudges it; the 30 s poll is far off
    await waitFor(() => x.bridge.ctx.schedules?.armed === true, 15_000, 'the schedule loops to arm')
    expect(injected).toBe(true)
    // no clock advance: the 30 s poll never runs. The catch-up refresh starts 300 ms after the watch opens.
    await waitFor(() => has(x, 'in-the-window'), 5000, 'the catch-up refresh').catch(() => {})
    await sleep(0)
    expect(has(x, 'in-the-window')).toBe(true)
  })
})
