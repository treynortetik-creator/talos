// A beta user's bug report is never silently lost while the owner's Mac is behind (Delphi 2026-11-15). A `problem.item` waits
// for a Mac that lists problems/1 (features.ts problemHeld); the 7-day buffer sweep used to delete it, and its screenshot,
// with the rest. Now a report the Mac has not taken stays (30 days, 500 reports as the backstop, with a log line), and at day
// 5 the owner's default thread gets ONE plain line, a system message the relay sends the apps itself.
import { newUlid, type ProblemT } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as held from '../../src/core/held-problems.ts'
import { PROBLEM_KEEP_ROWS } from '../../src/core/held-problems.ts'
import { HELD_PROBLEMS_TEXT } from '../../src/core/hub-undelivered.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
const DAY = 86_400_000
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

function problem(over: Partial<ProblemT> = {}): ProblemT {
  return {
    id: newUlid(),
    source: 'web',
    kind: 'owner',
    fingerprint: 'a'.repeat(32),
    at: new Date().toISOString(),
    name: 'Bug report',
    message: 'the send button does nothing',
    frames: [],
    versions: { app: '1.2.3' },
    device: 'browser',
    routes: ['thread'],
    truncated: false,
    ...over,
  }
}

async function world() {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  return { c, r: relay }
}
const file = (r: TestRelay, p: ProblemT) =>
  r.runtime.hub.toBridge({ type: 'problem.item', id: p.id, problem: p }, { durable: true })
const rows = (r: TestRelay) =>
  (
    r.relay.services.db.prepare("select count(*) n from core_events where type = 'problem.item'").get() as {
      n: number
    }
  ).n
const lines = (r: TestRelay) =>
  (
    r.relay.services.db.prepare("select count(*) n from core_events where type = 'message.stored'").get() as {
      n: number
    }
  ).n

describe('a held bug report outlives the buffer', () => {
  it('8 days with an older Mac: the report and its screenshot are still here, and a newer Mac gets them', async () => {
    const { c, r } = await world()
    const shot = await r.relay.services.media.put({ bytes: PNG, mime: 'image/png', name: 'bug-report.png' })
    const p = problem({ screenshot: shot })
    await file(r, p)
    // an unrelated old media file goes as before
    const other = await r.relay.services.media.put({ bytes: PNG.slice().reverse(), mime: 'image/png', name: 'x.png' })
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(rows(r)).toBe(1)
    expect(r.runtime.store.getMediaRow(shot.media_id)?.evicted).toBeFalsy()
    expect(r.runtime.store.getMediaRow(other.media_id)?.evicted).toBeTruthy()
    // still queued for the Mac (problems.test.ts shows a newer Mac's hello takes a held report)
    const row = r.runtime.store.outboxRow(p.id)
    expect(row?.delivered).toBe(0)
    expect(Number(row?.expires_at)).toBeGreaterThan(c.now())
  })

  it('a report queued before this rule (a 7-day outbox row) is kept all the same', async () => {
    const { c, r } = await world()
    const p = problem()
    await file(r, p)
    r.relay.services.db
      .prepare('update core_outbox set expires_at = created_at + ? where frame_id = ?')
      .run(7 * DAY, p.id)
    c.set(c.now() + 6 * DAY)
    r.runtime.hub.sweep()
    c.set(c.now() + 3 * DAY)
    r.runtime.hub.sweep()
    expect(rows(r)).toBe(1)
    expect(Number(r.runtime.store.outboxRow(p.id)?.expires_at)).toBeGreaterThan(c.now())
  })

  it('a report the Mac filed (consumed) is swept as before', async () => {
    const { c, r } = await world()
    const p = problem()
    await file(r, p)
    r.runtime.store.markDelivered(p.id)
    r.runtime.store.dropOutbox(p.id) // the Mac answered consumed: it is on its disk
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(rows(r)).toBe(0)
  })

  it('the backstop: past 30 days a held report goes, with a log line', async () => {
    const { c, r } = await world()
    await file(r, problem())
    const warn = vi.spyOn((r.runtime.hub as unknown as { d: { log: { warn: () => void } } }).d.log, 'warn')
    c.set(c.now() + 29 * DAY)
    r.runtime.hub.sweep()
    expect(rows(r)).toBe(1)
    c.set(c.now() + 2 * DAY)
    r.runtime.hub.sweep()
    expect(rows(r)).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ problems: 1 }), expect.stringMatching(/backstop/))
  })

  it(`the backstop: only the newest ${PROBLEM_KEEP_ROWS} held reports are kept`, async () => {
    const { c, r } = await world()
    for (let i = 0; i < PROBLEM_KEEP_ROWS + 3; i++) await file(r, problem())
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(rows(r)).toBe(PROBLEM_KEEP_ROWS)
  })
})

describe('the bytes backstop', () => {
  it('held reports past the byte cap go, oldest first, with the log line', async () => {
    const { c, r } = await world()
    const shot = await r.relay.services.media.put({ bytes: PNG, mime: 'image/png', name: 'bug-report.png' })
    const first = problem({ screenshot: { ...shot, size: 200 * 1024 * 1024 } }) // as the report says: 200 MB
    await file(r, first)
    c.set(c.now() + 1000)
    const second = problem({
      screenshot: { ...shot, media_id: `${shot.media_id.slice(0, -1)}x`, size: 100 * 1024 * 1024 },
    })
    await file(r, second)
    const warn = vi.spyOn((r.runtime.hub as unknown as { d: { log: { warn: () => void } } }).d.log, 'warn')
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(held.PROBLEM_KEEP_BYTES).toBe(250 * 1024 * 1024)
    // 200 + 100 MB is past 250: the newer one stays, the older one goes
    expect(rows(r)).toBe(1)
    expect(r.runtime.store.outboxRow(second.id)).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ problems: 1 }), expect.stringMatching(/backstop/))
  })
})

describe('the day-5 line', () => {
  it('once, in the default thread, from day 5; not before; not again while it holds', async () => {
    const { c, r } = await world()
    const app = await kit(r).connectedApp()
    await file(r, problem())
    c.set(c.now() + 4 * DAY)
    r.runtime.hub.sweep()
    expect(lines(r)).toBe(0)
    c.set(c.now() + 1 * DAY + 1000)
    r.runtime.hub.sweep()
    const f = await app.expectFrame('message.stored', (m) => m.message?.text === HELD_PROBLEMS_TEXT, {
      direction: 'in',
    })
    expect(f.message).toMatchObject({
      author: 'system',
      thread_id: (r.runtime.hub as unknown as { cfg(): { default_thread: string } }).cfg().default_thread,
    })
    c.set(c.now() + 1 * DAY)
    r.runtime.hub.sweep()
    r.runtime.hub.sweep()
    expect(lines(r)).toBe(1)
  })

  it('a report the Mac took is not waiting: nothing is said; once it clears, a later episode is told again', async () => {
    const { c, r } = await world()
    const a = problem()
    await file(r, a)
    r.runtime.store.markDelivered(a.id)
    c.set(c.now() + 6 * DAY)
    r.runtime.hub.sweep()
    expect(lines(r)).toBe(0)
    // an episode: told once; cleared (taken); a new held report five days later: told again
    const b = problem()
    await file(r, b)
    c.set(c.now() + 5 * DAY + 1000)
    r.runtime.hub.sweep()
    expect(lines(r)).toBe(1)
    r.runtime.store.markDelivered(b.id)
    r.runtime.hub.sweep()
    await file(r, problem())
    c.set(c.now() + 5 * DAY + 1000)
    r.runtime.hub.sweep()
    expect(lines(r)).toBe(2)
  })
})
