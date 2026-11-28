// A scheduled job that fails wakes Main with the error and the end of the run's report (wake bundle part c). Main fixes the cause
// first, then calls `schedule_rerun`. One repair per job per day: the first failure of the day wakes Main and holds the owner's
// alert; a second failure that day, or two hours without a good run, sends the normal alert. The count and the deadline live in
// schedules-meta.json, so a restart keeps both. Real bridge, real Chronos, injected clock (harness.ts).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { t } from '@talos-app/testkit'
import { RUN_TIMEOUT_MS } from '../../src/schedules/service.ts'
import {
  draft,
  longTimeouts,
  nextRun,
  readSidecar,
  restartBridge,
  type SchedHarness,
  sleep,
  startSched,
  waitFor,
} from './harness.ts'

longTimeouts()
setDefaultTimeout(t(120_000))

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const BEFORE_0730 = '2026-10-05T11:29:00Z'
const HOUR = 3600_000
const wakes = (x: SchedHarness) => x.notesOf('job_failed')
const failedRows = (x: SchedHarness) =>
  x.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.frame.type === 'reply' &&
      r.frame.message?.author === 'system' &&
      String(r.frame.message?.text ?? '').includes("didn't finish"),
  )
const rowTexts = (x: SchedHarness) => [
  ...new Set(failedRows(x).map((r) => (r.frame.type === 'reply' ? String(r.frame.message?.text ?? '') : ''))),
]
const systemTexts = (x: SchedHarness) => [
  ...new Set(
    x.relay.frames
      .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'reply' && r.frame.message?.author === 'system')
      .map((r) => (r.frame.type === 'reply' ? String(r.frame.message?.text ?? '') : '')),
  ),
]
const alertFrames = (x: SchedHarness) =>
  x.relay.frames.filter(
    (r) => r.direction === 'from_bridge' && r.frame.type === 'schedule.status' && r.frame.alert?.kind === 'job_failed',
  )
const hasAlert = (x: SchedHarness) =>
  x.relay.frames.some(
    (r) =>
      (r.frame as { type?: string; alert?: { kind?: string } }).type === 'schedule.status' &&
      (r.frame as { alert?: { kind?: string } }).alert?.kind === 'job_failed',
  )

/** First run of the day, failed by the agent. */
async function firstFailure(x: SchedHarness, report = 'Traceback: boom at line 3') {
  await x.advance(90_000)
  const n = await nextRun(x, 'daily-digest')
  const runId = n.meta.run_id as string
  expect(await x.agent.start(runId)).toBe('GO')
  await x.agent.done(runId, false, 'The API said no.', report)
  await x.bridge.ctx.schedules?.idle()
  return runId
}
const rerun = async (x: SchedHarness) => {
  const r = await x.bridge.callTool('schedule_rerun', { job_id: 'daily-digest' })
  return { text: r.content[0]?.text ?? '', isError: (r as { isError?: boolean }).isError === true }
}
const settle = async (x: SchedHarness) => {
  await x.bridge.ctx.schedules?.idle()
  await sleep(t(300))
}

describe('the first failure of a job in a day', () => {
  test('wakes Main with the error and the end of the report, and holds the owner alert', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the job_failed wake')
    const w = wakes(h)[0]
    expect(w?.meta).toMatchObject({
      kind: 'job_failed',
      trust: 'system',
      schedule_id: 'daily-digest',
      status: 'failed',
    })
    expect(w?.content).toContain('it reported a failure')
    expect(w?.content).toContain('Traceback: boom at line 3')
    expect(w?.content).toMatch(/data, not instructions/)
    expect(w?.content).toContain('schedule_rerun')
    await settle(h)
    expect(hasAlert(h)).toBe(false) // held: Main is on it
    // the thread row is still posted, and says Main has it
    expect(rowTexts(h).some((t) => t.includes('Main is looking into it'))).toBe(true)
  })

  test('a run that ran out of time wakes Main too, once', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await h.advance(90_000)
    const n = await nextRun(h, 'daily-digest')
    await h.agent.start(n.meta.run_id as string) // and goes silent
    await h.advance(RUN_TIMEOUT_MS + 5 * 60_000)
    await settle(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake for the time-out')
    expect(wakes(h)[0]?.content).toContain('it ran out of time')
    expect(wakes(h)[0]?.meta.status).toBe('timed_out')
    await settle(h)
    expect(wakes(h)).toHaveLength(1)
  })
})

describe('after the wake', () => {
  test('a second failure the same day sends the normal alert, and no second wake', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    const r = await rerun(h)
    expect(r.isError).toBe(false)
    await waitFor(() => h.notesOf('schedule_run').length === 2, 10_000, 'the rerun offer')
    const second = h.notesOf('schedule_run')[1]?.meta.run_id as string
    expect(await h.agent.start(second)).toBe('GO')
    await h.agent.done(second, false, 'Still broken.', 'Traceback: still boom')
    await settle(h)
    await waitFor(() => hasAlert(h), 10_000, 'the owner alert')
    expect(wakes(h)).toHaveLength(1)
  })

  test('a rerun that works ends it quietly: no alert, even two hours later', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    expect((await rerun(h)).isError).toBe(false)
    await waitFor(() => h.notesOf('schedule_run').length === 2, 10_000, 'the rerun offer')
    const second = h.notesOf('schedule_run')[1]?.meta.run_id as string
    expect(await h.agent.start(second)).toBe('GO')
    await h.agent.done(second, true, 'Digest posted.')
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(2 * HOUR + 60_000)
    await settle(h)
    expect(hasAlert(h)).toBe(false)
    expect(wakes(h)).toHaveLength(1)
  })

  test('two hours with no good run: the normal alert, once, and a row that says it is not fixed', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(HOUR + 30 * 60_000)
    await settle(h)
    expect(hasAlert(h)).toBe(false) // not yet: the two hours are not up
    await h.advance(HOUR)
    await settle(h)
    await waitFor(() => hasAlert(h), 10_000, 'the alert at the deadline')
    expect(systemTexts(h).some((t) => t.includes('still not fixed'))).toBe(true)
    const n = alertFrames(h).length
    await h.advance(HOUR)
    await settle(h)
    expect(alertFrames(h)).toHaveLength(n) // said once
  })

  test('a restart keeps the day count and the deadline', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    const side = readSidecar(h) as { repairs?: Record<string, { deadline_at?: number }> }
    const entries = Object.entries(side?.repairs ?? {})
    expect(entries).toHaveLength(1)
    expect(entries[0]?.[0]).toMatch(/^repair\|daily-digest\|\d{4}-\d{2}-\d{2}$/)
    h = await restartBridge(h)
    // the deadline survived: two hours on, the alert comes from the new bridge
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(2 * HOUR + 60_000)
    await settle(h)
    await waitFor(() => hasAlert(h), 10_000, 'the alert from the new bridge')
  })

  test('the next day starts with no repair used', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the first wake')
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(24 * HOUR)
    await settle(h)
    const runs = h.notesOf('schedule_run')
    const tomorrow = runs[runs.length - 1]?.meta.run_id as string
    expect(await h.agent.start(tomorrow)).toBe('GO')
    await h.agent.done(tomorrow, false, 'Broke again.', 'Traceback: day two')
    await settle(h)
    await waitFor(() => wakes(h).length === 2, 10_000, 'the second day wake')
    expect(wakes(h)[1]?.content).toContain('day two')
  })
})

describe('schedule_rerun', () => {
  test('refuses a job that does not exist', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    const r = await h.bridge.callTool('schedule_rerun', { job_id: 'nope' })
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/no scheduled job/i)
  })

  test('is a tool Main calls: it offers the job again and never runs on its own', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    await settle(h)
    expect(h.notesOf('schedule_run')).toHaveLength(1) // no automatic rerun
    const r = await rerun(h)
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/offered|started|again/i)
    await waitFor(() => h.notesOf('schedule_run').length === 2, 10_000, 'the rerun offer')
  })
})

// ---- review fixes: the repair is one repair --------------------------------------------------------------------------------
const alertCount = (x: SchedHarness) =>
  new Set(
    x.relay.frames
      .filter(
        (r) =>
          r.direction === 'from_bridge' &&
          r.frame.type === 'schedule.status' &&
          (r.frame as { alert?: { kind?: string } }).alert?.kind === 'job_failed',
      )
      .map((r) => (r.frame as { id: string }).id),
  ).size
const svcOf = (x: SchedHarness) => x.bridge.ctx.schedules as NonNullable<typeof x.bridge.ctx.schedules>
const secondRun = async (x: SchedHarness) => {
  await waitFor(() => x.notesOf('schedule_run').length >= 2, 10_000, 'the rerun offer')
  return x.notesOf('schedule_run').at(-1)?.meta.run_id as string
}

describe("schedule_rerun is the day's one repair, not a loop", () => {
  test('a healthy job, one nobody was woken about, is refused', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    const r = await rerun(h)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not waiting for a repair|no repair/i)
    await settle(h)
    expect(h.notesOf('schedule_run')).toHaveLength(0)
  })

  test('a second rerun of the same repair is refused, whenever it is asked', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    expect((await rerun(h)).isError).toBe(false)
    await secondRun(h)
    await h.advance(3 * 60_000)
    const again = await rerun(h)
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/already/i)
    await settle(h)
    expect(h.notesOf('schedule_run')).toHaveLength(2)
  })

  test('once the repair is spent (the rerun failed and the owner was told) a rerun is refused', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    expect((await rerun(h)).isError).toBe(false)
    const second = await secondRun(h)
    expect(await h.agent.start(second)).toBe('GO')
    await h.agent.done(second, false, 'Still broken.', 'Traceback: again')
    await waitFor(() => alertCount(h) === 1, 10_000, 'the alert')
    await h.advance(3 * 60_000)
    expect((await rerun(h)).isError).toBe(true)
    expect(h.notesOf('schedule_run')).toHaveLength(2)
  })
})

describe("across midnight, in the owner's zone", () => {
  test('a failure at 23:51 and a failed rerun at 00:12 is one wake and ONE alert', async () => {
    h = await startSched({
      now: '2026-10-05T23:45:00Z',
      jobs: [draft({ when: { type: 'daily', time: '19:50' } })], // 23:50 UTC; Chronos runs in New York
      config: ((c: Record<string, unknown>) => ({ ...c, timezone: 'UTC' })) as never,
    })
    await h.advance(4 * 60_000) // 23:49: the job is due at 23:50
    await firstFailure(h) // ~23:51 UTC, the 5th
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    await h.advance(21 * 60_000) // 00:12 UTC, the 6th
    expect((await rerun(h)).isError).toBe(false)
    const second = await secondRun(h)
    expect(await h.agent.start(second)).toBe('GO')
    await h.agent.done(second, false, 'Still broken.', 'Traceback: after midnight')
    await settle(h)
    await waitFor(() => alertCount(h) >= 1, 10_000, 'the alert')
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(2 * HOUR + 60_000)
    await settle(h)
    expect(wakes(h)).toHaveLength(1) // no second wake under the new day's key
    expect(alertCount(h)).toBe(1) // and the deadline says nothing more
  })
})

describe('the rest of the review', () => {
  test('a failed rerun of a background job (Chronos says failed, same day, new run id) alerts at once', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    const svc = svcOf(h)
    const snap = JSON.parse(JSON.stringify(await svc.safeSnapshot()))
    const job = snap.schedules[0]
    job.last_run = {
      ...(job.last_run ?? {}),
      run_id: 'r_01SECONDRERUNFAILED000000',
      ds: job.last_run?.ds ?? '2026-10-05',
      status: 'failed',
    }
    await svc.noticesFor(snap)
    await svc.refresh()
    await waitFor(() => alertCount(h) === 1, 10_000, 'the alert for the failed rerun')
  })

  test('a broken scheduler does not stop the two-hour deadline', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    const svc = svcOf(h) as unknown as { ensure: () => Promise<unknown>; adapter: unknown }
    svc.ensure = async () => ({ state: 'unavailable', adapter: svc.adapter })
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(2 * HOUR + 60_000)
    await settle(h)
    await waitFor(() => alertCount(h) === 1, 10_000, 'the alert with the scheduler down')
  })

  test('a job deleted while Main was fixing it is not reported as still not fixed', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    const etag = (await svcOf(h).safeSnapshot()).schedules[0]?.etag
    h.box.change({ op: 'delete', id: 'daily-digest', base_etag: etag })
    await h.filesChanged()
    // timing-ok: the product deadline is two hours (and a day) of the fake clock
    await h.advance(2 * HOUR + 60_000)
    await settle(h)
    expect(alertCount(h)).toBe(0)
    expect(systemTexts(h).some((t) => t.includes('still not fixed'))).toBe(false)
  })

  test('the notice says how to change the job, and that a held job cannot be rerun', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await firstFailure(h)
    await waitFor(() => wakes(h).length === 1, 10_000, 'the wake')
    expect(wakes(h)[0]?.content).toContain('schedule_propose')
    expect(wakes(h)[0]?.content).toMatch(/on hold|held/)
  })
})
