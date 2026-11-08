// Job memory travels on schedules/2, like several fire times and meta: an older relay checks detail and card frames against the
// protocol it was built with, and an older app reads a whole snapshot against its strict schema, so one memory-on row (or a patch
// carrying `memory`) would cost the whole frame. The bridge sends the field only where both ends read it.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  Schedule,
  ScheduleSnapshot,
  type ScheduleSnapshotT,
} from '@talos-app/protocol'
import { z } from 'zod'
import { draft, longTimeouts, MON_0700_EDT, type Req, type SchedHarness, startSched, tempHome } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const V1 = { relayFeatures: [SCHEDULES_FEATURE] }
const V2 = { relayFeatures: [SCHEDULES_FEATURE, SCHEDULES_FEATURE_V2] }

/** A home where daily-digest already has memory on, as the sidecar would hold it. */
function homeWithMemory() {
  const home = tempHome('talos-job-memory-rollout-')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'schedules-meta.json'),
    JSON.stringify({
      adapter: 'chronos',
      jobs: { 'daily-digest': { thread_id: null, memory: true, epoch: 'e-test' } },
      offers: {},
      inflight: {},
      runs: {},
      notified: {},
    }),
  )
  return home
}
const start = (relay = V2) =>
  startSched({
    now: MON_0700_EDT,
    jobs: [draft(), draft({ id: 'plain-job', name: 'Plain' })],
    home: homeWithMemory(),
    relay,
  })

async function snapshotOf(reads: string[] | null = [SCHEDULES_FEATURE_V2]) {
  const f = await h.app.listSchedules(reads)
  const s = await h.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
    direction: 'in',
    timeoutMs: 10_000,
  })
  return s.snapshot as ScheduleSnapshotT
}

/** What an app from before job memory does with a snapshot: the strict schema, whose rows have no `memory`. */
const OldSnapshot = ScheduleSnapshot.extend({ schedules: z.array(Schedule.omit({ memory: true })) })

const wireDraft = (over: Record<string, unknown> = {}) => ({
  id: 'nightly-sync',
  name: 'Nightly Sync',
  description: '',
  when: { type: 'weekdays', time: '22:00' },
  catchup_min: 120,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: 'inbox',
  prompt: 'Sync the notes folder.\n',
  ...over,
})

describe('the snapshot', () => {
  test('relay and app both read schedules/2: the memory-on row arrives with memory:true', async () => {
    h = await start(V2)
    const snap = await snapshotOf()
    expect(snap.schedules.find((s) => s.id === 'daily-digest')?.memory).toBe(true)
    expect(snap.schedules.find((s) => s.id === 'plain-job')?.memory).toBeUndefined()
  })

  test('an older relay: the memory-on row is an unreadable entry that says what to update; every other job still shows', async () => {
    h = await start(V1)
    const snap = await snapshotOf()
    expect(snap.schedules.map((s) => s.id)).toEqual(['plain-job'])
    const held = snap.unreadable.find((u) => u.id === 'daily-digest')
    expect(held?.unreadable).toContain('schedules/2')
    expect(held?.unreadable).toContain('Update the relay')
  })

  test('an older app (does not say schedules/2), even behind a current relay, gets the same', async () => {
    h = await start(V2)
    for (const reads of [null, [SCHEDULES_FEATURE]]) {
      const snap = await snapshotOf(reads)
      expect(snap.schedules.map((s) => s.id)).toEqual(['plain-job'])
      expect(snap.unreadable.map((u) => u.id)).toContain('daily-digest')
    }
  })

  test('what that older app does with it: the gated frame parses against the schema from before memory; the open one would not', async () => {
    h = await start(V1)
    expect(OldSnapshot.safeParse(await snapshotOf()).success).toBe(true)
    await h.stop()
    h = await start(V2)
    const open = await snapshotOf()
    expect(OldSnapshot.safeParse(open).success).toBe(false)
    expect(Schedule.safeParse(open.schedules.find((s) => s.id === 'daily-digest')).success).toBe(true)
  })
})

describe('the detail', () => {
  test('schedule.get for a memory-on job: the detail with schedules/2, a plain error without it', async () => {
    h = await start(V2)
    const f = await h.app.getSchedule('daily-digest')
    const d = await h.app.expectFrame('schedule.detail', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    expect((d.detail as { schedule: { memory?: boolean } }).schedule.memory).toBe(true)
    const g = await h.app.getSchedule('daily-digest', null, null)
    const e = await h.app.expectFrame('error', (r) => r.ref === g.id, { direction: 'in' })
    expect(e.code).toBe('scheduler_unavailable')
    expect(e.message).toContain('schedules/2')
  })

  test('a job without memory is unaffected: its detail goes to an app that reads only schedules/1', async () => {
    h = await start(V2)
    const f = await h.app.getSchedule('plain-job', null, null)
    const d = await h.app.expectFrame('schedule.detail', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    expect((d.detail as { schedule: { id: string } }).schedule.id).toBe('plain-job')
  })
})

describe('a change that carries memory', () => {
  test('is refused to the owner and to the agent when the relay lacks schedules/2, and no card is made', async () => {
    h = await start(V1)
    const before = h.app.rec.frames.length
    for (const change of [
      { op: 'create', draft: wireDraft({ memory: true }) },
      { op: 'create', draft: wireDraft({ memory: false }) },
      { op: 'update', id: 'plain-job', base_etag: `sha256:${'0'.repeat(64)}`, set: { memory: true } },
      { op: 'update', id: 'daily-digest', base_etag: `sha256:${'0'.repeat(64)}`, set: { memory: false } },
    ]) {
      const f = await h.app.patchSchedule(change, 'general')
      const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in' })
      expect(e.code).toBe('scheduler_unavailable')
      expect(e.message).toContain('schedules/2')
    }
    const t = await h.bridge.callTool('schedule_propose', {
      op: 'create',
      thread_id: 'general',
      reason: 'x',
      name: 'Nightly Sync',
      when: { type: 'weekdays', time: '22:00' },
      prompt: 'Sync.\n',
      memory: true,
    })
    expect(t.isError).toBe(true)
    expect(t.content[0]?.text).toContain('schedules/2')
    expect(h.app.rec.frames.slice(before).some((r) => r.direction === 'in' && r.raw.type === 'card.create')).toBe(false)
  })

  test('is accepted when the relay has schedules/2', async () => {
    h = await start(V2)
    const f = await h.app.patchSchedule({ op: 'create', draft: wireDraft({ memory: true }) }, 'general')
    await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
  })

  test('one that does not mention memory still works on an older relay', async () => {
    h = await start(V1)
    const f = await h.app.patchSchedule({ op: 'create', draft: wireDraft() }, 'general')
    await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
  })
})
