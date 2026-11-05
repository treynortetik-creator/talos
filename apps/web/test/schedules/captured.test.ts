// WP-S3 acceptance re-run with the REAL bridge's captures (WP-S1) in place of S0's fakes: every frame the real bridge
// sent must parse, render without a crash, and mean what the UI says; every frame the UI sends must have the shape
// the real bridge received.
import { Card, ErrorFrame, parseScheduleSnapshot, ScheduleCardPayload, ScheduleDetail } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { isAltered } from '../../src/features/cards/logic.ts'
import {
  emptyKind,
  fixParts,
  groupSchedules,
  pickBanner,
  rowStatus,
  waitingOffline,
} from '../../src/features/schedules/logic.ts'
import { refusalWords } from '../../src/features/schedules/shared.tsx'
import { TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { allFrames, cards, cardUpdates, received, SCENARIOS, snapshots } from './captured.ts'

const status = (s: ReturnType<typeof snapshots>[number], id: string) => {
  const j = s.schedules.find((x) => x.id === id)
  if (!j) throw new Error(`no ${id}`)
  return rowStatus(j, { nowMs: Date.parse(s.as_of), tz: s.health.tz, macOnline: true })
}

describe('the captures are there', () => {
  it('17 files, 16 scenarios', () => {
    expect(Object.keys(SCENARIOS)).toHaveLength(16)
  })
})

describe('every real frame parses and renders', () => {
  const frames = allFrames()
  it('snapshots: protocol first, then the strict schema; logic never throws on any row', () => {
    let n = 0
    for (const { scenario, frame } of frames) {
      if (frame.type !== 'schedules.snapshot') continue
      n++
      const r = parseScheduleSnapshot(frame.snapshot)
      expect(r.ok, `${scenario}: ${JSON.stringify(r)}`).toBe(true)
      if (!r.ok) continue
      const s = r.snapshot
      groupSchedules(s, Date.parse(s.as_of))
      pickBanner(s)
      emptyKind(s, null)
      for (const j of s.schedules) {
        const st = rowStatus(j, { nowMs: Date.parse(s.as_of), tz: s.health.tz, macOnline: true })
        expect(st.word.length, `${scenario}/${j.id}`).toBeGreaterThan(0)
        waitingOffline(j, Date.parse(s.as_of), false)
      }
    }
    expect(n).toBeGreaterThanOrEqual(8)
  })
  it('details and cards parse; every schedule card is unaltered (its hash binds what it renders)', () => {
    let d = 0
    let c = 0
    for (const { scenario, frame } of frames) {
      if (frame.type === 'schedule.detail') {
        d++
        expect(ScheduleDetail.safeParse(frame.detail).success, scenario).toBe(true)
      }
      if (frame.type === 'card.create') {
        c++
        const card = Card.parse(frame.card)
        expect(ScheduleCardPayload.safeParse(card.payload).success, `${scenario}: payload`).toBe(true)
        expect(isAltered(card), `${scenario}: ${card.title}`).toBe(false)
      }
    }
    expect(d).toBeGreaterThan(0)
    expect(c).toBeGreaterThanOrEqual(6)
  })
  it('every error frame parses, and the UI words it', () => {
    for (const { scenario, frame } of frames) {
      if (frame.type !== 'error') continue
      const f = ErrorFrame.parse(frame)
      const e = new TalosClientError(f.code, f.message, f.fields)
      expect(refusalWords(e).length, `${scenario}/${f.code}`).toBeGreaterThan(0)
    }
  })
})

describe('what the statuses mean (13: a job through offered, agent_busy, no_session, running, failed, missed)', () => {
  const snaps = snapshots('13-states-and-health')
  const words = snaps.map((s) => status(s, 'daily-digest').word)
  it('walks the words in order', () => {
    expect(words).toEqual([
      'Waiting for the agent', // offered
      'Waiting for the agent', // agent_busy
      "Waiting: agent session isn't running", // no_session
      'Running…',
      'Failed',
    ])
  })
  it('the other job is Missed, and a banner names it with a way to the job', () => {
    const s = snaps[2] as (typeof snaps)[number]
    expect(status(s, 'missed-job').word).toBe('Missed')
    expect(pickBanner(s)).toMatchObject({ code: 'no_session' })
    const only = { ...s, schedules: s.schedules.filter((j) => j.id === 'missed-job') }
    expect(pickBanner(only)).toMatchObject({ code: 'missed_recently', button: 'show', scheduleId: 'missed-job' })
  })
})

describe('health issues as the real bridge words them', () => {
  const stalled = snapshots('15-background-stalled')[0] as ReturnType<typeof snapshots>[number]
  it('a stalled day is "Background run stuck"', () => {
    expect(status(stalled, 'bg-job').word).toBe('Background run stuck')
  })
  it('tcc_suspected and headless_blocked carry numbered steps INLINE: split into a lead-in and steps', () => {
    const tcc = stalled.health.issues.find((i) => i.code === 'tcc_suspected')
    const p = fixParts(tcc?.fix ?? null)
    expect(p.intro).toBe('macOS is probably waiting for permission.')
    expect(p.steps).toHaveLength(4)
    expect(p.steps[0]).toMatch(/^At the Mac, look for a dialog/)
    expect(p.steps[3]).toMatch(/^Tap Retry background runs/)
    const hb = fixParts(stalled.health.issues.find((i) => i.code === 'headless_blocked')?.fix ?? null)
    expect(hb.steps).toHaveLength(3)
  })
  it('the banner shows the worst issue first, with Retry for a real stall (tcc_suspected AND headless_blocked)', () => {
    const b = pickBanner(stalled)
    expect(b?.code).toBe('tcc_suspected')
    // its own steps end "Tap Retry background runs", so the sheet must have that button (B1)
    expect(b?.retry).toBe(true)
    const onlyHeadless = {
      ...stalled,
      health: { ...stalled.health, issues: stalled.health.issues.filter((i) => i.code === 'headless_blocked') },
    }
    expect(pickBanner(onlyHeadless)).toMatchObject({ code: 'headless_blocked', retry: true })
  })
  it('a hold: the row, the banner (Review, naming the job) and the Adopt card', () => {
    const held = snapshots('10-hold-and-adopt').find((s) => s.schedules[0]?.today === 'held') as typeof stalled
    expect(status(held, 'daily-digest').word).toBe('On hold: changed outside the app')
    expect(pickBanner(held)).toMatchObject({ code: 'held_jobs', button: 'review', scheduleId: 'daily-digest' })
    const adopt = cards('10-hold-and-adopt')[0]
    expect(ScheduleCardPayload.parse(adopt?.payload).change.op).toBe('adopt')
    expect(adopt?.risk).toBe('high')
  })
  it('session_runner_conflict with the real text and fix', () => {
    const all = allFrames()
      .flatMap(({ frame }) => (frame.type === 'schedules.snapshot' ? [frame.snapshot as typeof stalled] : []))
      .find((s) => s.health.issues.some((i) => i.code === 'session_runner_conflict'))
    expect(all ? (pickBanner(all)?.fix ?? []).join(' ') : '').toContain('talos-app schedules adopt')
  })
})

describe('the empty list and the three-job list (01, 02)', () => {
  it('01 is the "no jobs" screen', () => {
    expect(emptyKind(snapshots('01-list-empty')[0] as never, null)).toBe('no_jobs')
  })
  it('02 groups three jobs and never needs a missing field', () => {
    const s = snapshots('02-list-three-jobs')[0] as ReturnType<typeof snapshots>[number]
    const g = groupSchedules(s, Date.parse(s.as_of))
    expect(g.today.length + g.later.length + g.off.length).toBe(3)
    for (const j of s.schedules) expect(j.thread_id === null || typeof j.thread_id === 'string').toBe(true)
  })
})

describe('the card the real bridge mints for an update, a high-risk update, a delete and a create', () => {
  it('binds the revision and shows what is written', () => {
    const up = cards('05-patch-update')
    expect(up.map((c) => c.risk)).toEqual(['low', 'high'])
    const p = ScheduleCardPayload.parse(up[0]?.payload)
    expect(p.change.op).toBe('update')
    expect(p.expected_etag).toMatch(/^sha256:/)
    expect(p.proposed_by).toBe('owner_form')
    expect(up[0]?.destination.map((d) => d.label)).toContain('Proposed by')
    const del = ScheduleCardPayload.parse(cards('06-patch-delete')[0]?.payload)
    expect(del.change.op).toBe('delete')
    expect(del.expected_etag).toBeNull()
    expect(ScheduleCardPayload.parse(cards('04-patch-create')[0]?.payload).change.op).toBe('create')
  })
  it('the conflict arrives as a failed card.update with the bridge words', () => {
    const upd = cardUpdates('16-apply-conflict').at(-1)
    expect(upd).toMatchObject({ state: 'failed' })
    expect(JSON.stringify(upd?.result)).toMatch(/changed on your Mac/)
  })
})

describe('the frames the UI sends have the shape the real bridge received', () => {
  const keys = (o: Record<string, unknown>) =>
    Object.keys(o)
      .filter((k) => !['v', 'id', 'ts', 'device_id', 'osig'].includes(k))
      .sort()
  const real = (type: string) => received().find((r) => r.frame.type === type)?.frame as Record<string, unknown>
  it('list, get, patch, run_now, control', async () => {
    const c = createFakeClient()
    const snap = await c.schedules.listSchedules()
    const job = snap.schedules[0]
    if (!job) throw new Error('no job')
    await c.schedules.getSchedule(job.id, null)
    await c.schedules.proposeScheduleChange(
      { op: 'update', id: job.id, base_etag: job.etag, set: { name: 'x' } },
      'general',
    )
    await c.schedules.runScheduleNow(job.id, { again: false, where: 'default' })
    await c.schedules.controlSchedule('pause', job.id)
    const mine = (t: string) => c.sent.find((f) => f.type === t) as Record<string, unknown>
    for (const t of ['schedules.list', 'schedule.get', 'schedule.patch', 'schedule.run_now', 'schedule.control']) {
      expect(real(t), `no capture of ${t}`).toBeDefined()
      expect(keys(mine(t)), t).toEqual(keys(real(t)))
    }
    expect(real('schedule.run_now')).toMatchObject({ again: false, where: 'default' })
  })
})
