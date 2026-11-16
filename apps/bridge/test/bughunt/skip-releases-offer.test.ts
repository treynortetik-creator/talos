// Bug hunt 2026-11-10 #3: a scheduled-job offer that ended in SKIP (the owner paused the job, then resumed it) blocked
// every later offer of that job and day. The job never ran, and the owner was told "no session was running", which was
// false. Real bridge, real Chronos, injected clock.
import { afterEach, describe, expect, test } from 'bun:test'
import { eventually } from '../helpers.ts'
import {
  draft,
  longTimeouts,
  nextRun,
  readSidecar,
  type SchedHarness,
  sleep,
  startSched,
} from '../schedules/harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const BEFORE_0730 = '2026-10-05T11:29:00Z' // 07:29 EDT, Monday
const job = () => draft({ catchup_min: 30 })
const pause = (paused: boolean) => h.box.api(['pause'], { scope: { id: 'daily-digest' }, paused })
// One row per message id, as the app keeps them: the bridge's durable send waits for an ack on the injected clock, so an advance
// that jumps past ACK_WAIT_MS while a notice is in flight sends the same frame again over HTTP (Titan: 4 of 12 under load). The
// relay and the app key the row by its id, so the owner sees it once; counting frames here counted it twice.
const systemRows = () => [
  ...new Map(
    h.relay.rec
      .of('reply', 'from_bridge')
      .filter((f) => f.message.author === 'system')
      .map((f) => [f.message.id, f.message.text ?? ''] as const),
  ).values(),
]

describe('bug hunt #3: a SKIP gives the offer back', () => {
  test('pause, SKIP, resume: the job is offered again with a new run id, runs, and nobody is told it was missed', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [job()] })
    await h.advance(90_000)
    const first = await nextRun(h, 'daily-digest')
    pause(true)
    expect(await h.agent.start(first.meta.run_id as string)).toBe('SKIP: paused')
    pause(false)
    await h.advance(10 * 60_000) // 07:41, well inside the 30 min window
    await eventually(() => expect(h.notesOf('schedule_run').length).toBe(2))
    const second = h.notesOf('schedule_run')[1]
    expect(second?.meta.schedule_id).toBe('daily-digest')
    expect(second?.meta.run_id).not.toBe(first.meta.run_id)
    const r = await h.agent.run(second as never, { summary: 'Posted.' })
    expect(r).toEqual({ started: 'GO', done: 'recorded' })
    // the skipped run id stays dead: it cannot be used to run the job a second time
    expect(await h.agent.start(first.meta.run_id as string)).toContain('unknown run')
    await h.advance(30 * 60_000)
    await h.bridge.ctx.schedules?.refresh(true)
    await sleep(200)
    expect(h.notesOf('schedule_run').length).toBe(2)
    expect(systemRows().filter((t) => t.includes('missed'))).toEqual([])
  })

  test('a job that keeps answering SKIP is offered at most a few times, never once a minute for the whole window', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [job()] })
    await h.advance(90_000)
    for (let i = 0; i < 12; i++) {
      const notes = h.notesOf('schedule_run')
      const last = notes[notes.length - 1]
      // the owner pauses just before each start and resumes just after: every offer ends in SKIP and the job is due again
      pause(true)
      if (last) await h.agent.start(last.meta.run_id as string)
      pause(false)
      await h.advance(61_000)
    }
    expect(h.notesOf('schedule_run').length).toBe(3) // three offers, three SKIPs, then no more
    const side = readSidecar(h) as { offers: Record<string, { skips?: number }> }
    expect(Object.values(side.offers).map((o) => o.skips)).toEqual([3])
  })

  test('skipped and never due again in its window: the missed notice says it was skipped, not that no session was running', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [job()] })
    await h.advance(90_000)
    const first = await nextRun(h, 'daily-digest')
    pause(true)
    expect(await h.agent.start(first.meta.run_id as string)).toBe('SKIP: paused')
    const side = readSidecar(h) as { offers: Record<string, { released?: { why: string } }> }
    expect(Object.values(side.offers).map((o) => o.released?.why)).toEqual(['paused'])
    await h.advance(31 * 60_000) // the window closes while the job is still paused
    pause(false)
    await h.advance(5 * 60_000)
    await h.bridge.ctx.schedules?.refresh(true)
    await eventually(() => expect(systemRows().some((t) => t.includes('was missed'))).toBe(true))
    const missed = systemRows().filter((t) => t.includes('was missed'))
    expect(missed).toEqual([
      'Scheduled job "Daily Digest" was missed: it was skipped at its time (paused) and did not come due again in its window. Open Schedules.',
    ])
  })

  test('offered and never started: the missed notice says the session was asked and did not start it', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [job()] })
    await h.advance(90_000)
    await nextRun(h, 'daily-digest')
    await h.advance(40 * 60_000)
    await h.bridge.ctx.schedules?.refresh(true)
    await eventually(() => expect(systemRows().some((t) => t.includes('was missed'))).toBe(true))
    expect(systemRows().filter((t) => t.includes('was missed'))).toEqual([
      'Scheduled job "Daily Digest" was missed: the session was asked to run it and never started it. Open Schedules.',
    ])
  })
})
