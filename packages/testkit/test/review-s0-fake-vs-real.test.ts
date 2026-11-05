// Review of PR #29 (Schedules S0): FakeScheduler vs the REAL Chronos CLI on the same inputs. Each expectation is what
// the real CLI answered (review-fixtures/probe/c2-*.json, chronos feat/0.3-runs in a temp HOME at 2026-10-05T07:45
// America/New_York). Every case FAILS on feat/schedules-s0: the fake answers differently, so S2/S3 built on the fake
// would be built on behaviour the real bridge will never show. defineSchedulerAdapterContract has no case for any of
// these, which is why the fake passes it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contractDraft } from '../src/contract/scheduler.ts'
import { FakeScheduler } from '../src/fake-scheduler.ts'

const real = (f: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'review-fixtures', 'probe', `c2-${f}.json`), 'utf8')) as {
    exit: number
    out: Record<string, unknown> & { error?: { code: string } }
  }
const RID = (n: number) => `r_0000000000000000000000000${n}`
const claimArgs = (n: number, o: Partial<{ ds: string; manual: boolean; again: boolean }> = {}) => ({
  runId: RID(n),
  ds: '2026-10-05',
  fireAt: null,
  manual: false,
  again: false,
  bridgeInstance: 'a',
  ...o,
})

async function fake() {
  const s = new FakeScheduler({ tz: 'America/New_York', now: '2026-10-05T07:45:00-04:00' })
  return s
}

describe('review S0: FakeScheduler answers what the real Chronos answers', () => {
  it('validate refuses a restricted job that asks for the live session (real: schedule_invalid; fake: rewrites the runner)', async () => {
    expect(real('validate-restricted-session').out.error?.code).toBe('schedule_invalid')
    const s = await fake()
    const v = await s.validate({
      op: 'create',
      draft: contractDraft({ id: 'r-sess', permissions: 'restricted', allowed_tools: ['Read'], runner: 'session' }),
    })
    expect(v.ok).toBe(false)
  })

  it('validate refuses an update with an empty set (real: schedule_invalid; fake: ok, so a "No visible change." card)', async () => {
    expect(real('validate-update-empty-set').out.error?.code).toBe('schedule_invalid')
    const s = await fake()
    const etag = await s.seed(contractDraft({ id: 'j-sess' }))
    expect((await s.validate({ op: 'update', id: 'j-sess', base_etag: etag, set: {} })).ok).toBe(false)
  })

  it('a session claim of a restricted job is refused (real: schedule_invalid; fake: GO)', async () => {
    expect(real('claim-restricted').out.error?.code).toBe('schedule_invalid')
    const s = await fake()
    await s.seed(
      contractDraft({ id: 'j-restricted', runner: 'headless', permissions: 'restricted', allowed_tools: ['Read'] }),
    )
    expect((await s.claim('j-restricted', claimArgs(3))).ok).toBe(false)
  })

  it('session-prompt of a restricted job is refused (real: schedule_invalid; fake: hands over the prompt)', async () => {
    expect(real('session-prompt-restricted').out.error?.code).toBe('schedule_invalid')
    const s = await fake()
    await s.seed(
      contractDraft({ id: 'j-restricted', runner: 'headless', permissions: 'restricted', allowed_tools: ['Read'] }),
    )
    expect((await s.sessionPrompt('j-restricted')).ok).toBe(false)
  })

  it('Run now (manual claim) on a paused job goes ahead (real: ok; fake: paused)', async () => {
    expect(real('claim-manual-paused').out.ok).toBe(true)
    const s = await fake()
    await s.seed(contractDraft({ id: 'j-sess' }))
    await s.setPaused({ id: 'j-sess' }, true)
    expect(await s.claim('j-sess', claimArgs(4, { manual: true }))).toMatchObject({ ok: true })
  })

  it('a clock claim after the window, on a day that already ran, is window_passed (fake: already_done)', async () => {
    expect(real('claim-after-window-ran').out).toEqual({ ok: false, reason: 'window_passed' })
    const s = await fake()
    await s.seed(contractDraft({ id: 'j-sess' }))
    await s.claim('j-sess', claimArgs(4, { manual: true }))
    await s.finish('j-sess', { runId: RID(4), ok: true, status: 'ok', report: 'done\n' })
    s.setNow('2026-10-05T12:00:00-04:00')
    expect(await s.claim('j-sess', claimArgs(7))).toEqual({ ok: false, reason: 'window_passed' })
  })

  it('a finished session run carries no summary: Chronos never stores one and the seam has no field for it', async () => {
    const r = real('detail-after-finish').out as { runs: Array<Record<string, unknown>> }
    expect(r.runs[0]?.summary).toBeUndefined()
    const s = await fake()
    await s.seed(contractDraft({ id: 'j-sess' }))
    await s.claim('j-sess', claimArgs(4, { manual: true }))
    await s.finish('j-sess', { runId: RID(4), ok: true, status: 'ok', report: 'done\n' })
    const d = await s.detail('j-sess', null)
    // Fake invents summary = first report line. S6.1's schedule_run_done `summary` has nowhere to go in the real seam.
    expect(d?.detail.runs[0]?.summary).toBeUndefined()
  })
})
