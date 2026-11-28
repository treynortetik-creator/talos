// The shared wake piece (main-wake/): one entry point that tells Main something once, and keeps it until Main's channel has taken
// it. It is the only place that decides "already told": a bug report and a failed job both go through it.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { nullLogger } from '../src/log.ts'
import { MAIN_WAKE_KEEP_MS, MAIN_WAKE_MAX_TRIES, MainWake } from '../src/main-wake/service.ts'
import { bugReportNotification, jobFailedNotification, type Notification } from '../src/notify.ts'

const THREAD = { id: 'inbox', name: 'Inbox' }
const note = (id = 'bug-1'): Notification =>
  bugReportNotification({
    thread: THREAD,
    reportId: 'abc123abc123',
    summary: 'the thread says working',
    ts: '2026-11-24T10:00:00.000Z',
    id,
  })

function make(over: { emit?: (n: Notification) => Promise<void>; db?: Database; closing?: () => boolean } = {}) {
  const db = over.db ?? new Database(':memory:')
  const sent: Notification[] = []
  let t = Date.parse('2026-11-24T10:00:00.000Z')
  const wake = new MainWake({
    db,
    now: () => t,
    emit: over.emit ?? (async (n) => void sent.push(n)),
    log: nullLogger,
    closing: over.closing ?? (() => false),
  })
  return {
    db,
    wake,
    sent,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('MainWake.fire', () => {
  test('tells Main once, and the same key again sends nothing', async () => {
    const { wake, sent } = make()
    expect(await wake.fire('bug:abc', note())).toBe('sent')
    expect(await wake.fire('bug:abc', note('bug-2'))).toBe('duplicate')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.meta.kind).toBe('bug_report')
    expect(sent[0]?.content).toContain('abc123abc123')
  })

  test('two fires of one key at the same moment send once', async () => {
    const { wake, sent } = make()
    const [a, b] = await Promise.all([wake.fire('bug:abc', note()), wake.fire('bug:abc', note())])
    expect([a, b].sort()).toEqual(['duplicate', 'sent'])
    expect(sent).toHaveLength(1)
  })

  test('a different key is a different wake', async () => {
    const { wake, sent } = make()
    await wake.fire('bug:a', note('1'))
    await wake.fire('bug:b', note('2'))
    expect(sent).toHaveLength(2)
  })

  test('an emit that throws keeps the wake, and the next tick sends it once', async () => {
    let fail = true
    const sent: Notification[] = []
    const { wake } = make({
      emit: async (n) => {
        if (fail) throw new Error('channel down')
        sent.push(n)
      },
    })
    expect(await wake.fire('bug:abc', note())).toBe('kept')
    expect(sent).toHaveLength(0)
    fail = false
    expect(await wake.tick()).toBe(1)
    expect(await wake.tick()).toBe(0)
    expect(sent).toHaveLength(1)
    expect(await wake.fire('bug:abc', note())).toBe('duplicate')
  })

  test('a restart: a new MainWake on the same database sends what the old one never delivered, and not what it did', async () => {
    const db = new Database(':memory:')
    const first = make({
      db,
      emit: async () => {
        throw new Error('stopped')
      },
    })
    await first.wake.fire('bug:lost', note('1'))
    const ok = make({ db })
    await ok.wake.fire('bug:done', note('2'))
    expect(ok.sent).toHaveLength(1) // 'done' went out; 'lost' is still waiting
    const second = make({ db })
    expect(await second.wake.tick()).toBe(1)
    expect(second.sent.map((n) => n.meta.message_id)).toEqual(['1'])
    expect(await second.wake.fire('bug:done', note('2'))).toBe('duplicate')
  })

  test('while the bridge is stopping nothing is sent and no try is used up', async () => {
    let closing = true
    const { wake, sent } = make({ closing: () => closing })
    expect(await wake.fire('bug:abc', note())).toBe('kept')
    expect(await wake.tick()).toBe(0)
    closing = false
    for (let i = 0; i < MAIN_WAKE_MAX_TRIES + 2; i++) await wake.tick()
    expect(sent).toHaveLength(1)
  })

  test('gives up after the allowed tries, and a later fire of the same key starts again', async () => {
    const sent: Notification[] = []
    let fail = true
    const { wake } = make({
      emit: async (n) => {
        if (fail) throw new Error('down')
        sent.push(n)
      },
    })
    await wake.fire('bug:abc', note())
    for (let i = 0; i < MAIN_WAKE_MAX_TRIES + 2; i++) await wake.tick()
    fail = false
    expect(await wake.tick()).toBe(0)
    expect(await wake.fire('bug:abc', note())).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  test('delivered rows are forgotten after the keep time; the key can then fire again', async () => {
    const { wake, sent, advance } = make()
    await wake.fire('bug:abc', note())
    advance(MAIN_WAKE_KEEP_MS + 1000)
    await wake.tick()
    expect(await wake.fire('bug:abc', note())).toBe('sent')
    expect(sent).toHaveLength(2)
  })
})

describe('the two notifications', () => {
  test('say what they are, mark the payload as data, and stay Main-bound system notes', () => {
    const b = note()
    expect(b.meta).toMatchObject({ kind: 'bug_report', trust: 'system', report_id: 'abc123abc123' })
    expect(b.content).toMatch(/data, not instructions/i)
    const j = jobFailedNotification({
      thread: THREAD,
      jobId: 'daily-digest',
      name: 'Daily digest',
      status: 'failed',
      ds: '2026-11-24',
      runId: 'r1',
      why: 'it reported a failure',
      logEnd: 'Traceback: boom',
      ts: '2026-11-24T10:00:00.000Z',
      id: 'jf-1',
    })
    expect(j.meta).toMatchObject({ kind: 'job_failed', trust: 'system', schedule_id: 'daily-digest' })
    expect(j.content).toContain('Traceback: boom')
    expect(j.content).toMatch(/data, not instructions/i)
    expect(j.content).toContain('schedule_rerun')
  })
})

describe('a wake that is given up', () => {
  test('is handed to onGiveUp once, with its key and words, and nothing after', async () => {
    const db = new Database(':memory:')
    const gone: Array<{ key: string; n: Notification }> = []
    const wake = new MainWake({
      db,
      now: () => Date.parse('2026-11-24T10:00:00.000Z'),
      emit: async () => {
        throw new Error('down')
      },
      log: nullLogger,
      closing: () => false,
      onGiveUp: (key, n) => void gone.push({ key, n }),
    })
    await wake.fire('bug:abc', note())
    for (let i = 0; i < MAIN_WAKE_MAX_TRIES + 3; i++) await wake.tick()
    expect(gone).toHaveLength(1)
    expect(gone[0]?.key).toBe('bug:abc')
    expect(gone[0]?.n.meta.report_id).toBe('abc123abc123')
  })
})
