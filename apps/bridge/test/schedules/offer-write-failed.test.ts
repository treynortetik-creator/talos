// A due job is offered by recording the offer in schedules-meta.json FIRST and then sending the schedule_run notification.
// When that write fails for real (here: a directory sits where the file goes, so the rename fails), the notification
// must not be lost for good: once the disk problem is gone, the next runner tick offers the job.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RUNNER_EVERY_MS } from '../../src/schedules/service.ts'
import { draft, longTimeouts, nextRun, readSidecar, type SchedHarness, sleep, startSched, waitFor } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const BEFORE_0730 = '2026-10-05T11:29:00Z' // 07:29 EDT, Monday

describe('an offer whose write to schedules-meta.json failed', () => {
  test('is offered again on a later tick, once the file can be written, and exactly once', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    const blocker = join(h.home, 'schedules-meta.json')
    mkdirSync(join(blocker, 'in-the-way'), { recursive: true }) // rename(tmp -> blocker) now fails
    await h.advance(90_000) // 07:30:30: the job is due and the runner tries to record the offer
    await h.bridge.ctx.schedules?.idle()
    expect(h.notesOf('schedule_run')).toHaveLength(0) // nothing was sent: the offer could not be recorded first
    rmSync(blocker, { recursive: true, force: true }) // the disk problem is over
    await h.advance(RUNNER_EVERY_MS + 5_000)
    const n = await nextRun(h, 'daily-digest')
    await h.bridge.ctx.schedules?.idle()
    // recorded before it was sent, and sent once
    const side = readSidecar(h) as { offers: Record<string, { run_id: string }> }
    expect(Object.values(side.offers).map((o) => o.run_id)).toEqual([n.meta.run_id as string])
    await h.advance(3 * RUNNER_EVERY_MS)
    await sleep(200)
    expect(h.notesOf('schedule_run')).toHaveLength(1)
    expect(existsSync(blocker)).toBe(true)
  })

  test('a run finished while the file cannot be written still answers recorded; the file and the owner notice catch up later', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await h.advance(90_000)
    const n = await nextRun(h, 'daily-digest')
    const runId = n.meta.run_id as string
    expect(await h.agent.start(runId)).toBe('GO')
    const blocker = join(h.home, 'schedules-meta.json')
    rmSync(blocker, { force: true })
    mkdirSync(join(blocker, 'in-the-way'), { recursive: true })
    expect(await h.agent.done(runId, false, 'The API said no.')).toBe('recorded')
    expect(failureRows(h)).toHaveLength(0) // not told yet: the "already told" mark could not be saved
    rmSync(blocker, { recursive: true, force: true })
    await h.advance(RUNNER_EVERY_MS + 5_000)
    await waitFor(() => failureRows(h).length > 0, 10_000, 'the failure notice')
    await h.bridge.ctx.schedules?.idle()
    await sleep(300)
    expect(failureRows(h)).toHaveLength(1)
    const side = readSidecar(h) as { inflight: Record<string, { closed?: string }> }
    expect(side.inflight[runId]?.closed).toBe('failed')
  })
})

describe('a write that failed is retried by the runner', () => {
  test('a run that ended well while the file could not be written is on disk after the next tick; nothing else saves it', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await h.advance(90_000)
    const n = await nextRun(h, 'daily-digest')
    const runId = n.meta.run_id as string
    expect(await h.agent.start(runId)).toBe('GO')
    const blocker = join(h.home, 'schedules-meta.json')
    rmSync(blocker, { force: true })
    mkdirSync(join(blocker, 'in-the-way'), { recursive: true })
    expect(await h.agent.done(runId, true, 'Digest posted.')).toBe('recorded')
    rmSync(blocker, { recursive: true, force: true })
    expect(readSidecar(h)).toBeUndefined() // still nothing on disk: a good run tells the owner nothing, so no notice save follows
    await h.advance(RUNNER_EVERY_MS + 5_000)
    await h.bridge.ctx.schedules?.idle()
    const side = readSidecar(h) as { inflight: Record<string, { closed?: string }> } | undefined
    expect(side?.inflight[runId]?.closed).toBe('ok')
  })
})

const failureRows = (x: SchedHarness) =>
  x.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.frame.type === 'reply' &&
      r.frame.message?.author === 'system' &&
      String(r.frame.message?.text ?? '').includes("didn't finish"),
  )
