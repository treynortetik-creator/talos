// HB1 against the REAL Chronos CLI with `times` (PR #6). Chronos's own decisions (which slot is due, what Run now claims,
// when a slot is superseded) are not something a replay can make, so this suite runs the bridge on a real checkout.
//
//   TALOS_CHRONOS_TIMES_SRC=/path/to/chronos-checkout bun test test/schedules/times-real.test.ts
//
// Without that variable the suite is skipped and says so; CI for this repo has no such checkout until Chronos tags the
// release and `third_party/chronos` is re-vendored (HEARTBEAT-SPEC 15, HB1 "re-vendor"). The always-on coverage of the
// same answers is times.test.ts, from recorded output of this CLI.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { ChronosBox, draft, longTimeouts, type SchedHarness, startSched, waitFor } from './harness.ts'

longTimeouts()

const SRC = process.env.TALOS_CHRONOS_TIMES_SRC
const real = SRC && existsSync(`${SRC}/bin/chronos`) ? describe : describe.skip
if (!SRC) console.warn('times-real.test.ts: TALOS_CHRONOS_TIMES_SRC not set, the real-Chronos times suite is skipped')

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const MON = '2026-10-05'
// 09:50 EDT
const T0950 = `${MON}T13:50:00Z`
const SLOTS = ['09:45', '12:15', '14:45', '17:15']
const job = () =>
  draft({
    id: 'check-in',
    name: 'Check In',
    when: { type: 'times', days: 'weekdays', times: SLOTS },
    catchup_min: 60,
    meta: { sources: ['inbox'] },
  })

const runs = (x: SchedHarness) => x.notes.filter((n) => n.meta.kind === 'schedule_run')

real('Chronos with times, through the real bridge', () => {
  test('the slots of one day are offered, claimed and finished one at a time, each under its own key', async () => {
    const box = new ChronosBox(T0950, undefined, SRC)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(job())
    h = await startSched({ box, now: T0950 })
    await waitFor(() => runs(h).length === 1, 30_000, 'the 09:45 slot')
    const first = runs(h)[0]
    expect(first?.meta.ds).toBe(`${MON}T0945`)
    expect((await h.agent.run(first as never)).done).toBe('recorded')
    // 12:20 EDT: the 12:15 slot, a different key; the first slot's marker does not make it "already done"
    await h.advance(150 * 60_000 + 30_000)
    await waitFor(() => runs(h).length === 2, 30_000, 'the 12:15 slot')
    const second = runs(h)[1]
    expect(second?.meta.ds).toBe(`${MON}T1215`)
    expect((await h.agent.run(second as never)).done).toBe('recorded')
    const snap = (await h.bridge.ctx.schedules?.refresh(true)) ?? null
    expect(snap?.schedules.find((s) => s.id === 'check-in')?.last_run?.ds).toBe(`${MON}T1215`)
    expect(snap?.schedules.find((s) => s.id === 'check-in')?.meta).toEqual({ sources: ['inbox'] })
  })

  test('Run now takes an ad-hoc key that is none of the slots, and the next slot is still offered', async () => {
    const box = new ChronosBox(T0950, undefined, SRC)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(job())
    h = await startSched({ box, now: T0950 })
    await waitFor(() => runs(h).length === 1, 30_000, 'the 09:45 slot')
    const slot = runs(h)[0]
    await h.agent.run(slot as never)
    await h.app.runScheduleNow('check-in')
    await waitFor(() => runs(h).length === 2, 30_000, 'the Run now offer')
    const now = runs(h)[1]
    expect((await h.agent.run(now as never)).started).toStartWith('GO')
    const side = JSON.parse(await Bun.file(`${h.home}/schedules-meta.json`).text()) as {
      inflight: Record<string, { ds: string }>
    }
    const keys = Object.values(side.inflight).map((f) => f.ds)
    const adhoc = keys.find((k) => !SLOTS.some((s) => k === `${MON}T${s.replace(':', '')}`))
    expect(adhoc).toMatch(/^2026-10-05T\d{4}$/)
    await h.advance(150 * 60_000 + 30_000)
    await waitFor(() => runs(h).length === 3, 30_000, 'the 12:15 slot after a Run now')
    expect(runs(h)[2]?.meta.ds).toBe(`${MON}T1215`)
  })
})
