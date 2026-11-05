// HB1 on the bridge: what the real bridge does with the answers Chronos 0.4 really prints (times + meta). The Chronos
// side is a REPLAY of recorded CLI output (replay-box.ts, fixtures in packages/testkit/fixtures/chronos-0.4/); the bridge,
// the relay and the app frames are the real ones. Item numbers are HB1-TALOS-TOLERATES.md's.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  Schedule,
  ScheduleSnapshot,
  type ScheduleSnapshotT,
  ScheduleWhen,
} from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { z } from 'zod'
import { ChronosAdapter } from '../../src/schedules/chronos-adapter.ts'
import { longTimeouts, type Req, type SchedHarness, sleep, startSched, waitFor } from './harness.ts'
import { fixture, ReplayBox } from './replay-box.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const V1 = { relayFeatures: [SCHEDULES_FEATURE] }
const V2 = { relayFeatures: [SCHEDULES_FEATURE, SCHEDULES_FEATURE_V2] }

async function snapshotOf(x: SchedHarness, reads: string[] | null = [SCHEDULES_FEATURE_V2]) {
  const f = await x.app.listSchedules(reads)
  const s = await x.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
    direction: 'in',
    timeoutMs: 10_000,
  })
  return s.snapshot as ScheduleSnapshotT
}

/** What an app from before HB1 does with a snapshot: the strict schema, whose `when` has no `times` and whose rows have no `meta`. */
const OldWhen = z.discriminatedUnion(
  'type',
  ScheduleWhen.options.filter((o) => o.shape.type.value !== 'times') as never,
)
const OldSchedule = Schedule.omit({ meta: true }).extend({ when: OldWhen })
const OldSnapshot = ScheduleSnapshot.extend({
  schedules: z.array(OldSchedule),
  unreadable: ScheduleSnapshot.shape.unreadable,
})

const start = (box: ReplayBox, relay = V2) => startSched({ box, relay, now: box.now })

describe('item 1: the version answer carries features', () => {
  test('the scheduler is found (ready), not closed: detect() used to throw on the extra key', async () => {
    const box = ReplayBox.times()
    h = await start(box)
    expect(h.bridge.ctx.schedules?.discoveryNote()).toContain('discovery=ready')
    const snap = await snapshotOf(h)
    expect(snap.health.state).not.toBe('not_installed')
    expect(snap.schedules.map((s) => s.id)).toContain('check-in')
  })
})

describe('rollout: the bridge sends a times/meta job to the app only when the relay lists schedules/2', () => {
  test('relay with schedules/2: the times job, its meta and its read-only reason arrive', async () => {
    h = await start(ReplayBox.times(), V2)
    const snap = await snapshotOf(h)
    const ci = snap.schedules.find((s) => s.id === 'check-in')
    expect(ci?.when).toEqual({ type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] })
    expect(ci?.meta).toEqual({ sources: ['inbox', 'tracker'], wake_limit: 3 })
    expect(ci?.editable).toBe(false)
    expect(snap.schedules.find((s) => s.id === 'mon-wed')?.when).toMatchObject({ type: 'times', days: ['mon', 'wed'] })
  })

  test('relay without it: those rows become unreadable entries that say what to update; every other job still shows', async () => {
    h = await start(ReplayBox.times(), V1)
    const snap = await snapshotOf(h)
    const shown = snap.schedules.map((s) => s.id)
    expect(shown).toEqual(['daily-digest', 'swapped'])
    const gated = snap.unreadable.filter((u) => u.unreadable.includes('schedules/2'))
    expect(gated.map((u) => u.id).sort()).toEqual(['check-in', 'hostile', 'mon-wed', 'tight'])
    expect(gated[0]?.unreadable).toContain('Update the relay')
    // Chronos's own broken-record row is still there, with Chronos's reason
    expect(snap.unreadable.find((u) => u.id === 'big-meta')?.unreadable).toContain('4 KiB')
  })

  test('an app from before HB1 (strict schema, no times) reads that frame whole; it would have lost the frame without the gate', async () => {
    h = await start(ReplayBox.times(), V1)
    const gated = await snapshotOf(h)
    expect(OldSnapshot.safeParse(gated).success).toBe(true)
    h = await (async () => {
      await h.stop()
      return start(ReplayBox.times(), V2)
    })()
    const open = await snapshotOf(h)
    const old = OldSnapshot.safeParse(open)
    expect(old.success).toBe(false) // the same snapshot, unfiltered, is exactly what that app rejects
    // ... and the app of today degrades the one row instead (the second half of the same promise)
    const { parseScheduleSnapshot } = await import('@talos-app/protocol')
    const withUnknown = {
      ...open,
      schedules: open.schedules.map((s) => (s.id === 'check-in' ? { ...s, when: { type: 'fortnightly' } } : s)),
    }
    const r = parseScheduleSnapshot(withUnknown)
    expect(r.ok && r.snapshot.schedules.map((s) => s.id)).toContain('daily-digest')
    expect(r.ok && r.snapshot.unreadable.map((u) => u.id)).toContain('check-in')
  })

  test('R1-3: the gate is what the APP can read: an app that does not say schedules/2 gets unreadable rows even from a relay that lists it', async () => {
    const box = ReplayBox.times()
    box.answer('detail', fixture('chronos-0.4', 'detail-times-meta'))
    h = await start(box, V2)
    const old = await snapshotOf(h, null)
    expect(old.schedules.map((s) => s.id)).toEqual(['daily-digest', 'swapped'])
    expect(
      old.unreadable
        .filter((u) => u.unreadable.includes('schedules/2'))
        .map((u) => u.id)
        .sort(),
    ).toEqual(['check-in', 'hostile', 'mon-wed', 'tight'])
    expect(OldSnapshot.safeParse(old).success).toBe(true) // a parse failure is what it would have been
    expect(OldSnapshot.safeParse(await snapshotOf(h, ['schedules/1'])).success).toBe(true) // saying only schedules/1 is the same
    expect((await snapshotOf(h)).schedules.map((s) => s.id)).toContain('check-in') // a current app gets them
    const g = await h.app.getSchedule('check-in', null, null)
    const e = await h.app.expectFrame('error', (r) => r.ref === g.id, { direction: 'in' })
    expect(e.code).toBe('scheduler_unavailable')
  })

  test('schedule.get for a times job: the detail with schedules/2, a plain error without it (not a dead frame)', async () => {
    const box = ReplayBox.times()
    box.answer('detail', fixture('chronos-0.4', 'detail-times-meta'))
    h = await start(box, V2)
    const f = await h.app.getSchedule('check-in')
    const d = await h.app.expectFrame('schedule.detail', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    expect((d.detail as { schedule: { meta?: unknown } }).schedule.meta).toBeDefined()
    await h.stop()
    h = await start(box, V1)
    const g = await h.app.getSchedule('check-in')
    const e = await h.app.expectFrame('error', (r) => r.ref === g.id, { direction: 'in' })
    expect(e.code).toBe('scheduler_unavailable')
    expect(e.message).toContain('schedules/2')
  })

  test('the agent still sees every job: the gate is for the app', async () => {
    h = await start(ReplayBox.times(), V1)
    const list = await h.bridge.callTool('schedules_list', {})
    const text = list.content[0]?.text ?? ''
    expect(text).toContain('check-in')
    expect(text).toContain('Weekdays at 9:45 AM, 12:15 PM, 2:45 PM and 5:15 PM')
  })

  test('a change that needs schedules/2 is refused to the owner and the agent when the relay lacks it, and nothing is validated', async () => {
    const box = ReplayBox.times()
    h = await start(box, V1)
    const change = {
      op: 'create',
      draft: {
        id: 'new-beat',
        name: 'New Beat',
        description: '',
        when: { type: 'times', days: 'weekdays', times: ['09:00', '12:00'] },
        catchup_min: 60,
        enabled: true,
        runner: 'headless',
        permissions: 'restricted',
        allowed_tools: ['Read'],
        model: null,
        notify: 'failure',
        thread_id: 'general',
        prompt: 'Check.\n',
      },
    }
    const f = await h.app.patchSchedule(change, 'general')
    const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in' })
    expect(e.code).toBe('scheduler_unavailable')
    const t = await h.bridge.callTool('schedule_propose', {
      ...change.draft,
      op: 'create',
      thread_id: 'general',
      reason: 'x',
    })
    expect(t.isError).toBe(true)
    expect(t.content[0]?.text).toContain('schedules/2')
    expect(box.callsOf('validate')).toEqual([])
  })
})

describe('item 5: due, orphans and health read item by item', () => {
  test('a due list with one unreadable slot still offers the readable one, and the owner is told something was unreadable', async () => {
    const box = ReplayBox.times()
    const due = fixture('chronos-0.4', 'due-session-times')
    box.answer('session-prompt', fixture('chronos-0.3', 'session-prompt'))
    box.answer('due', { ...due, due: [{ ...due.due[0], ds: 'tuesday-ish', id: 'tight' }, ...due.due] })
    h = await start(box)
    await waitFor(() => h.notes.some((n) => n.meta.kind === 'schedule_run'), 8000, 'the readable slot to be offered')
    const offers = h.notes.filter((n) => n.meta.kind === 'schedule_run')
    expect(offers.map((n) => [n.meta.schedule_id, n.meta.ds])).toEqual([['check-in', '2026-10-05T1445']])
    await h.bridge.ctx.schedules?.refresh(true) // the 30 s refresh loop, now: health is rebuilt after the due tick
    const snap = await snapshotOf(h)
    expect(snap.health.issues.map((i) => i.code)).toContain('registry_unreadable')
    expect(snap.health.issues.find((i) => i.code === 'registry_unreadable')?.text).toContain('due')
  })

  test('a stalled slot in health no longer fails the whole health answer', async () => {
    const box = ReplayBox.times()
    box.answer('health', fixture('chronos-0.4', 'health-times-blocked-slot'))
    h = await start(box)
    const snap = await snapshotOf(h)
    expect(snap.health.headless).toBe('blocked')
    expect(snap.health.issues.map((i) => i.code)).toContain('headless_blocked')
    // the only unreadable thing in that snapshot is Chronos's own {id,error} row, and the issue says so (it is not "the answer didn't parse")
    const unreadable = snap.health.issues.find((i) => i.code === 'registry_unreadable')
    expect(unreadable?.text).toContain('big-meta')
    expect(unreadable?.text).not.toContain("couldn't be read (at")
  })
})

describe('items 6 and 7: a run key is a key, not a date and not a slot', () => {
  test('a slot offer, then the claim: the in-flight run keeps the slot key Chronos answered with', async () => {
    const box = ReplayBox.times()
    box.answer('session-prompt', fixture('chronos-0.3', 'session-prompt'))
    box.answer('due', fixture('chronos-0.4', 'due-session-times'))
    h = await start(box)
    await waitFor(() => h.notes.some((n) => n.meta.kind === 'schedule_run'), 8000, 'the offer')
    const note = h.notes.find((n) => n.meta.kind === 'schedule_run')
    expect(note?.meta.ds).toBe('2026-10-05T1445')
    box.answer('claim', fixture('chronos-0.4', 'claim-times-slot'))
    expect(await h.agent.start(note?.meta.run_id as string)).toStartWith('GO')
    const claim = JSON.parse(box.callsOf('claim')[0]?.stdin ?? '{}')
    expect(claim.ds).toBe('2026-10-05T1445')
    const side = JSON.parse((await Bun.file(`${h.home}/schedules-meta.json`).text()) as string)
    expect(Object.values(side.inflight as Record<string, { ds: string }>).map((f) => f.ds)).toEqual(['2026-10-05T1445'])
  })

  test('Run now on a times job claims with ds:null and records the ad-hoc key Chronos picked; no slot offer is consumed', async () => {
    const box = ReplayBox.times()
    box.answer('session-prompt', fixture('chronos-0.3', 'session-prompt'))
    h = await start(box)
    await h.app.runScheduleNow('check-in')
    await waitFor(() => h.notes.some((n) => n.meta.kind === 'schedule_run'), 8000, 'the run-now offer')
    const note = h.notes.find((n) => n.meta.kind === 'schedule_run')
    box.answer('claim', fixture('chronos-0.4', 'claim-times-run-now-adhoc'))
    expect(await h.agent.start(note?.meta.run_id as string)).toStartWith('GO')
    const claim = JSON.parse(box.callsOf('claim')[0]?.stdin ?? '{}')
    expect(claim.ds).toBeNull()
    expect(claim.manual).toBe(true)
    const side = JSON.parse(await Bun.file(`${h.home}/schedules-meta.json`).text())
    expect(Object.values(side.inflight as Record<string, { ds: string }>).map((f) => f.ds)).toEqual(['2026-10-05T1001'])
    // 10:01 is in none of the job's slots: nothing about the key made it a slot
    expect(Object.keys(side.offers).filter((k) => k.includes('T1001'))).toEqual([])
    box.answer('finish', fixture('chronos-0.4', 'finish-times-adhoc'))
    const done = await h.agent.done(note?.meta.run_id as string, true, 'Done by hand.')
    expect(done).toBe('recorded')
    expect(box.callsOf('finish')).toHaveLength(1)
    // R1-7: finishing keeps the key Chronos answered the claim with, not the date the offer showed
    const after = JSON.parse(await Bun.file(`${h.home}/schedules-meta.json`).text())
    expect(Object.values(after.runs as Record<string, { ds: string }>).map((n) => n.ds)).toEqual(['2026-10-05T1001'])
  })
})

describe('R1-7: finishing a Run now keeps the ad-hoc key', () => {
  test('even when the in-flight entry is gone and only the offer (which showed a date) is left', async () => {
    const box = ReplayBox.times()
    box.answer('session-prompt', fixture('chronos-0.3', 'session-prompt'))
    h = await start(box)
    await h.app.runScheduleNow('check-in')
    await waitFor(() => h.notes.some((n) => n.meta.kind === 'schedule_run'), 8000, 'the run-now offer')
    const runId = h.notes.find((n) => n.meta.kind === 'schedule_run')?.meta.run_id as string
    box.answer('claim', fixture('chronos-0.4', 'claim-times-run-now-adhoc'))
    expect(await h.agent.start(runId)).toStartWith('GO')
    const svc = h.bridge.ctx.schedules
    if (!svc) throw new Error('no schedule service')
    delete (svc.sidecar.all.inflight as Record<string, unknown>)[runId]
    box.answer('finish', fixture('chronos-0.4', 'finish-times-adhoc'))
    expect(await h.agent.done(runId, true, 'Done by hand.')).toBe('recorded')
    expect(svc.sidecar.note(runId)?.ds).toBe('2026-10-05T1001')
  })
})

describe('R2-3: a late done keeps the ad-hoc key too', () => {
  test('the note of a run closed before its done arrived still names the key Chronos gave the claim', async () => {
    const box = ReplayBox.times()
    box.answer('session-prompt', fixture('chronos-0.3', 'session-prompt'))
    h = await start(box)
    await h.app.runScheduleNow('check-in')
    await waitFor(() => h.notes.some((n) => n.meta.kind === 'schedule_run'), 8000, 'the run-now offer')
    const runId = h.notes.find((n) => n.meta.kind === 'schedule_run')?.meta.run_id as string
    box.answer('claim', fixture('chronos-0.4', 'claim-times-run-now-adhoc'))
    expect(await h.agent.start(runId)).toStartWith('GO')
    const svc = h.bridge.ctx.schedules
    if (!svc) throw new Error('no schedule service')
    delete (svc.sidecar.all.inflight as Record<string, unknown>)[runId]
    box.answer('finish', { ok: false, reason: 'late' })
    expect(await h.agent.done(runId, true, 'Too late.')).toBe('late: noted on the closed run')
    expect(svc.sidecar.note(runId)?.ds).toBe('2026-10-05T1001')
  })
})

describe('items 8 and 9: a plain job with a slot-shaped last run; missed on a slot key', () => {
  test('the plain-time job with a slot-key last_run shows as it is, with its summary overlaid by exact key', async () => {
    const box = ReplayBox.times()
    box.answer('snapshot', fixture('chronos-0.4', 'snapshot-times-after-runs'))
    h = await start(box)
    const snap = await snapshotOf(h)
    const swapped = snap.schedules.find((s) => s.id === 'swapped')
    expect(swapped?.when.type).toBe('daily')
    expect(swapped?.last_run?.ds).toBe('2026-10-05T0945')
    expect(swapped?.last_run).not.toHaveProperty('run_id')
  })

  test('a missed times job is announced once a day, not once per slot', async () => {
    const box = ReplayBox.times('2026-10-05T23:00:00-04:00')
    const missed = fixture('chronos-0.4', 'snapshot-times-missed-superseded')
    box.answer('snapshot', missed)
    h = await start(box)
    await waitFor(
      () => Object.keys(h.bridge.ctx.schedules?.sidecar.all.notified ?? {}).length > 0,
      8000,
      'the missed notices',
    )
    const keysOf = () =>
      Object.keys(h.bridge.ctx.schedules?.sidecar.all.notified ?? {}).filter((k) => k.includes('|check-in|'))
    expect(keysOf()).toEqual(['fail|check-in|2026-10-05|missed']) // the date, not the 17:15 slot
    // the next slot of the same day goes missed too (another key, same date): no second notice
    const later = JSON.parse(JSON.stringify(missed))
    for (const s of later.schedules)
      if (s.id === 'check-in') Object.assign(s, { ds: '2026-10-05T2000', date_key: '2026-10-05T2000' })
    box.answer('snapshot', later)
    await h.bridge.ctx.schedules?.refresh(true)
    expect(keysOf()).toEqual(['fail|check-in|2026-10-05|missed'])
    expect(
      h.relay.frames.filter((r) => r.frame.type === 'message' && JSON.stringify(r.frame).includes('Check In')).length,
    ).toBeLessThanOrEqual(1)
  })

  test('a failed slot is announced once per slot (two slots, two keys), the run key kept whole', async () => {
    const box = ReplayBox.times('2026-10-05T13:00:00-04:00')
    const snap = fixture('chronos-0.4', 'snapshot-times-after-runs') // check-in: last_run failed at T1215
    box.answer('snapshot', snap)
    h = await start(box)
    await waitFor(
      () => Object.keys(h.bridge.ctx.schedules?.sidecar.all.notified ?? {}).some((k) => k.includes('|check-in|')),
      8000,
      'the failure notice',
    )
    expect(
      Object.keys(h.bridge.ctx.schedules?.sidecar.all.notified ?? {}).filter((k) => k.includes('|check-in|')),
    ).toEqual(['fail|check-in|2026-10-05T1215|failed'])
  })
})

describe('the 60-minute floor at its three doors', () => {
  const draft45 = {
    id: 'beat-45',
    name: 'Beat 45',
    description: '',
    when: { type: 'times', days: 'weekdays', times: ['09:00', '09:45'] },
    catchup_min: 60,
    enabled: true,
    runner: 'headless',
    permissions: 'restricted',
    allowed_tools: ['Read'],
    model: null,
    notify: 'failure',
    thread_id: 'general',
    prompt: 'Check.\n',
  }
  test('1. the owner form: schedule.patch with a 45-minute gap is refused with the field path; Chronos is never asked', async () => {
    const box = ReplayBox.times()
    h = await start(box)
    // the relay checks frames with the same schema and turns a bad one away first: the app is told bad_frame
    const viaRelay = await h.app.patchSchedule({ op: 'create', draft: draft45 }, 'general')
    expect((await h.app.expectFrame('error', (r) => r.ref === viaRelay.id, { direction: 'in' })).code).toBe('bad_frame')
    // a frame that reaches the bridge anyway (signed, so it is the owner's) is answered schedule_invalid with the field path
    const f = await h.app.sign({
      ...mkFrame('schedule.patch'),
      change: { op: 'create', draft: draft45 },
      thread_id: 'general',
    })
    h.relay.sendToBridge(f)
    const e = await h.relay.expectFrame('error', (r) => r.ref === f.id, { direction: 'from_bridge' })
    expect(e.code).toBe('schedule_invalid')
    expect(JSON.stringify(e.fields)).toContain('60 minutes')
    expect(box.callsOf('validate')).toEqual([])
  })
  test('2. the agent tool: the same change comes back as an error the agent can read', async () => {
    const box = ReplayBox.times()
    h = await start(box)
    const { id, ...rest } = draft45
    const r = await h.bridge.callTool('schedule_propose', {
      ...rest,
      op: 'create',
      thread_id: 'general',
      reason: 'x',
      id,
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('60 minutes')
    expect(box.callsOf('validate')).toEqual([])
  })
  test('3. the adapter: a change built any other way is refused in words, before Chronos is called, and after (what Chronos normalized)', async () => {
    const box = ReplayBox.times()
    const calls: string[] = []
    const a = new ChronosAdapter({ bin: box.bin, timeoutMs: 15_000, onProblem: (e) => calls.push(e.message) })
    const bad = { op: 'create', draft: draft45 } as never
    const v = await a.validate(bad)
    expect(v.ok).toBe(false)
    expect(!v.ok && v.code).toBe('schedule_invalid')
    expect(!v.ok && v.errors[0]?.message).toContain('60 minutes')
    expect(box.callsOf('validate')).toEqual([])
    // Chronos itself accepts 45 minutes (its floor is 15). If it normalizes one back, the answer is a refusal, not an unreadable answer.
    box.answer('validate', fixture('chronos-0.4', 'validate-times-45-minutes'))
    const ok = {
      op: 'create',
      draft: { ...draft45, when: { type: 'times', days: 'weekdays', times: ['09:00', '11:00'] } },
    } as never
    const v2 = await a.validate(ok)
    expect(v2.ok).toBe(false)
    expect(!v2.ok && v2.errors[0]?.message).toContain('60 minutes')
    expect(calls).toEqual([]) // no parse problem was raised
  })
})

describe('meta on the card the owner approves', () => {
  test('an update to a job with meta mints a card that shows the meta, unchanged, and binds the job it read', async () => {
    const box = ReplayBox.times()
    const detail = fixture('chronos-0.4', 'detail-times-meta')
    box.answer('detail', detail)
    h = await start(box)
    const etag = detail.schedule.etag
    box.answer('validate', {
      ok: true,
      normalized: { op: 'update', id: 'check-in', base_etag: etag, set: { name: 'Check In Now' } },
      preview: {
        when_text: 'Weekdays at 9:45 AM, 12:15 PM, 2:45 PM and 5:15 PM',
        next_runs: [],
        tz: 'America/New_York',
      },
      expected_etag: `sha256:${'3'.repeat(64)}`,
    })
    const f = await h.app.patchSchedule(
      { op: 'update', id: 'check-in', base_etag: etag, set: { name: 'Check In Now' } },
      'general',
    )
    const cc = await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    expect(f.id).toBeDefined()
    const body = String(cc.card.body)
    expect(body).toContain('Meta (approved with the job, unchanged):')
    expect(body).toContain('"wake_limit": 3')
    expect(body).toContain('Times: 4 a day: 09:45, 12:15, 14:45, 17:15 (weekdays)')
  })
})

void sleep

describe('R1-2: the agent tool can write a times job and meta', () => {
  test('schedule_propose says so in its schema and help, with the example shape', async () => {
    h = await start(ReplayBox.times())
    const tool = h.bridge.tools.find((t) => t.name === 'schedule_propose')
    type Props = Record<string, { type?: string | string[]; description?: string }>
    const props = ((tool?.inputSchema ?? { properties: {} }) as { properties: Props }).properties
    expect(props.when?.description).toContain(
      '{"type":"times","days":"weekdays","times":["09:45","12:15","14:45","17:15"]}',
    )
    expect(props.when?.description).toContain('60 minutes')
    expect(props.meta?.type).toEqual(['object', 'null']) // null clears it on an update
    expect(props.meta?.description).toContain('4 KiB')
  })
  test('a proposal with times and meta reaches Chronos as written', async () => {
    const box = ReplayBox.times()
    box.answer('validate', {
      ok: true,
      normalized: fixture('chronos-0.4', 'validate-times-create').normalized,
      preview: fixture('chronos-0.4', 'validate-times-create').preview,
      expected_etag: fixture('chronos-0.4', 'validate-times-create').expected_etag,
    })
    h = await start(box)
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'create',
      thread_id: 'general',
      reason: 'a beat',
      name: 'New Times',
      when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
      meta: { sources: ['inbox'] },
      prompt: 'Check.\n',
      runner: 'headless',
      permissions: 'restricted',
      allowed_tools: ['Read'],
    })
    expect(r.isError).toBeFalsy()
    const sent = JSON.parse(box.callsOf('validate')[0]?.stdin ?? '{}')
    expect(sent.draft.when.times).toHaveLength(4)
    expect(sent.draft.meta).toEqual({ sources: ['inbox'] })
  })
})

describe('R1-8: the installed Chronos has to report the feature', () => {
  const draftOf = (over: Record<string, unknown>) => ({
    op: 'create',
    thread_id: 'general',
    reason: 'x',
    name: 'New Times',
    prompt: 'Check.\n',
    runner: 'headless',
    permissions: 'restricted',
    allowed_tools: ['Read'],
    when: { type: 'daily', time: '09:00' },
    ...over,
  })
  test('a Chronos with no times feature: a times proposal is refused in plain words and Chronos is not asked to validate', async () => {
    const box = ReplayBox.times()
    box.answer('version', fixture('chronos-0.3', 'version'))
    h = await start(box)
    const r = await h.bridge.callTool(
      'schedule_propose',
      draftOf({ when: { type: 'times', days: 'weekdays', times: ['09:00', '12:00'] } }),
    )
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('your Chronos is too old for several times a day; update Chronos')
    const f = await h.app.patchSchedule(
      {
        op: 'create',
        draft: {
          ...draftOf({ when: { type: 'times', days: 'weekdays', times: ['09:00', '12:00'] } }),
          id: 'new-times',
          description: '',
          catchup_min: 60,
          enabled: true,
          model: null,
          notify: 'failure',
          thread_id: 'general',
          op: undefined,
          reason: undefined,
        },
      },
      'general',
    )
    const e = await h.app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(e.message).toContain('too old for several times a day')
    expect(box.callsOf('validate')).toEqual([])
  })
  test('a Chronos with times but no meta refuses meta, and still takes a times job', async () => {
    const box = ReplayBox.times()
    box.answer('version', { ...fixture<Record<string, unknown>>('chronos-0.4', 'version'), features: ['times'] })
    h = await start(box)
    const r = await h.bridge.callTool('schedule_propose', draftOf({ meta: { a: 1 } }))
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('your Chronos is too old for meta; update Chronos')
    expect(box.callsOf('validate')).toEqual([])
  })
})
