// A failure the owner is told about exactly once, even when the relay socket is down at the moment the run ends.
// The sidecar refuses the "already told" mark while the socket is down; the old code posted anyway, and then
// noticesFor posted the same failure again after the reconnect (two "didn't finish" rows, two job_failed alerts).
import { afterEach, describe, expect, test } from 'bun:test'
import { RUN_TIMEOUT_MS } from '../../src/schedules/service.ts'
import { draft, longTimeouts, nextRun, type SchedHarness, sleep, startSched, waitFor } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const BEFORE_0730 = '2026-10-05T11:29:00Z'
const textOf = (r: ReturnType<typeof rows>[number]) =>
  r.frame.type === 'reply' ? String(r.frame.message?.text ?? '') : ''
const rows = (x: SchedHarness) =>
  x.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.frame.type === 'reply' &&
      r.frame.message?.author === 'system' &&
      String(r.frame.message?.text ?? '').includes("didn't finish"),
  )

const reconnect = async (x: SchedHarness) => {
  await x.advance(2_000) // past the first backoff step (1 s, +/-20%)
  await waitFor(() => x.bridge.client?.connected === true, 20_000, 'the bridge to reconnect')
  await x.advance(2_100)
  await x.bridge.ctx.schedules?.idle()
}
const advancePastTimeout = async (x: SchedHarness) => {
  await x.advance(RUN_TIMEOUT_MS + 5 * 60_000)
  await x.bridge.ctx.schedules?.idle()
  await sleep(300)
}

describe('a failure reported while the relay socket is down', () => {
  test('schedule_run_done ok:false with the socket down says "didn\'t finish" once, after the reconnect', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await h.advance(90_000)
    const n = await nextRun(h, 'daily-digest')
    const runId = n.meta.run_id as string
    expect(await h.agent.start(runId)).toBe('GO')
    h.relay.dropBridge()
    await waitFor(() => h.bridge.client?.connected === false, 10_000, 'the socket to drop')
    await h.agent.done(runId, false, 'The API said no.')
    // the owner must not have been told yet: the "already told" mark was refused
    expect(rows(h)).toHaveLength(0)
    await h.advance(2_000) // past the first backoff step (1 s, +/-20%): the injected clock drives the reconnect
    await waitFor(() => h.bridge.client?.connected === true, 20_000, 'the bridge to reconnect')
    await h.advance(2_100)
    await waitFor(() => rows(h).length > 0, 10_000, 'the failure notice after the reconnect')
    await h.bridge.ctx.schedules?.idle()
    await sleep(500) // the first row has landed: give a second one time to arrive
    expect(rows(h)).toHaveLength(1)
    // 40 minutes on: the run was closed while the socket was down, so the time-out must not tell the owner a second time
    await advancePastTimeout(h)
    expect(rows(h)).toHaveLength(1)
    expect(textOf(rows(h)[0] as ReturnType<typeof rows>[number])).toContain('it reported a failure')
  })

  test('schedule_run_done ok:true with the socket down never raises a false "ran out of time"', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await h.advance(90_000)
    const n = await nextRun(h, 'daily-digest')
    const runId = n.meta.run_id as string
    expect(await h.agent.start(runId)).toBe('GO')
    h.relay.dropBridge()
    await waitFor(() => h.bridge.client?.connected === false, 10_000, 'the socket to drop')
    await h.agent.done(runId, true, 'Digest posted.')
    await reconnect(h)
    await advancePastTimeout(h)
    expect(rows(h)).toHaveLength(0)
  })

  test('a run claimed while the socket is down and never reported still times out, with one notice', async () => {
    h = await startSched({ now: BEFORE_0730, jobs: [draft()] })
    await h.advance(90_000)
    const n = await nextRun(h, 'daily-digest')
    const runId = n.meta.run_id as string
    h.relay.dropBridge()
    await waitFor(() => h.bridge.client?.connected === false, 10_000, 'the socket to drop')
    await h.agent.start(runId) // the claim lands in memory only; the agent then goes silent
    await reconnect(h)
    await advancePastTimeout(h)
    await waitFor(() => rows(h).length > 0, 10_000, 'the time-out notice')
    await sleep(500)
    expect(rows(h)).toHaveLength(1)
    expect(textOf(rows(h)[0] as ReturnType<typeof rows>[number])).toContain('it ran out of time')
  })
})
