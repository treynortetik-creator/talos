// Regression: a runner tick that is still running when `advance()` ends must not cost the test its offer.
//
// The runner loop skips a timer that fires while its previous tick is still running (service.ts `queued`), and `advance()` fires
// ~150 timers in under 2 s of real time. A tick that began before a slot and ends after the clock stopped therefore leaves no
// tick at the final time, and a test that waits for that slot's offer waits for ever (it showed as a 60 s timeout in times-real).
// Here the first tick is made slow on purpose (it reads what is due first, then stays running until the fake clock reaches the
// end of the advance), so the straddle happens on any machine speed.
import { afterEach, describe, expect, test } from 'bun:test'
import { CHRONOS_SRC, ChronosBox, draft, longTimeouts, type SchedHarness, startSched, waitFor } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const MON = '2026-10-05'
const T0950 = `${MON}T13:50:00Z` // 09:50 EDT
const runs = (x: SchedHarness) => x.notes.filter((n) => n.meta.kind === 'schedule_run')

describe('advance() and a runner tick that straddles the end of the advance', () => {
  test('the slot reached by the advance is offered although the one tick of the advance began before it', async () => {
    const box = new ChronosBox(T0950, undefined, CHRONOS_SRC)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(
      draft({
        id: 'check-in',
        name: 'Check In',
        when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
        catchup_min: 60,
      }),
    )
    h = await startSched({ box, now: T0950 })
    await waitFor(() => runs(h).length === 1, 10_000, 'the 09:45 slot')
    await h.agent.run(runs(h)[0] as never)
    // The first tick of the advance reads what is due (nothing yet), then stays running until the FAKE clock has reached the end
    // of the advance, so it ends after the last step on any machine speed and every later timer of the advance is skipped.
    const advanceMs = 150 * 60_000 + 30_000 // 12:20:30 EDT: the 12:15 slot is due
    const target = h.clock.now() + advanceMs
    const svc = h.bridge.ctx.schedules as unknown as { runnerTick: () => Promise<void> }
    const real = svc.runnerTick.bind(svc)
    let slowed = false
    svc.runnerTick = async () => {
      await real()
      if (!slowed) {
        slowed = true
        await waitFor(() => h.clock.now() >= target, 10_000, 'the end of the advance')
      }
    }
    await h.advance(advanceMs)
    await waitFor(() => runs(h).length === 2, 5_000, 'the 12:15 slot after the advance')
    expect(runs(h)[1]?.meta.ds).toBe(`${MON}T1215`)
  })
})
