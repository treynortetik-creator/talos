// Same class as sidecar-gate.test.ts, with one split. Offers, notified keys, threads: memory must stay as it was when the
// save is refused. Run state (setInflight, closeInflight, setNote) is the opposite: it must keep moving while the socket
// is down, or a finished run stays open and expires as a false 'ran out of time'. The next gated save writes it all.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Inflight, Sidecar } from '../../src/schedules/sidecar.ts'

const inflight: Inflight = {
  id: 'daily-digest',
  ds: '2026-10-28T11:30',
  fire_at: null,
  instance: 'bi_a',
  claimed_at: 1,
}
// Nothing is on disk until a save succeeds: a refused save leaves no file at all.
const onDisk = (sc: Sidecar) =>
  existsSync(sc.path) ? JSON.parse(readFileSync(sc.path, 'utf8')) : { inflight: {}, runs: {} }
const fresh = (open: () => boolean) => new Sidecar(mkdtempSync(join(tmpdir(), 'sidecar-gate-w-')), open)

describe('Sidecar writers with the liveness gate closed', () => {
  test('setInflight keeps the claim in memory, reports the refused save, and persists it on the next open save', () => {
    let open = false
    const sc = fresh(() => open)
    expect(sc.setInflight('r_1', inflight)).toBe(false)
    expect(sc.inflightOf('r_1')?.id).toBe('daily-digest')
    expect(onDisk(sc).inflight.r_1).toBeUndefined()
    open = true
    expect(sc.setThread('daily-digest', 'general')).toBe(true)
    expect(onDisk(sc).inflight.r_1.id).toBe('daily-digest')
  })

  test('closeInflight closes the run in memory while the gate is shut, and persists the close on reconnect', () => {
    let open = true
    const sc = fresh(() => open)
    sc.setInflight('r_1', inflight)
    open = false
    expect(sc.closeInflight('r_1', 'failed')).toBe(false)
    expect(sc.inflightOf('r_1')?.closed).toBe('failed')
    expect(onDisk(sc).inflight.r_1.closed).toBeUndefined()
    open = true
    expect(sc.closeInflight('r_1', 'failed')).toBe(true)
    expect(onDisk(sc).inflight.r_1.closed).toBe('failed')
  })

  test('setNote keeps the note in memory while the gate is shut, and persists it on reconnect', () => {
    let open = false
    const sc = fresh(() => open)
    expect(sc.setNote('r_1', { id: 'daily-digest', ds: 'd', status: 'failed' }, 5)).toBe(false)
    expect(sc.note('r_1')?.status).toBe('failed')
    expect(onDisk(sc).runs).toEqual({})
    open = true
    expect(sc.setNote('r_1', { id: 'daily-digest', ds: 'd', status: 'failed' }, 6)).toBe(true)
    expect(onDisk(sc).runs.r_1.status).toBe('failed')
  })

  test('setThread keeps the old result thread, and forgetJob keeps the job', () => {
    let open = true
    const sc = fresh(() => open)
    sc.setThread('daily-digest', 'general')
    open = false
    expect(sc.setThread('daily-digest', 'inbox')).toBe(false)
    expect(sc.threadOf('daily-digest')).toBe('general')
    expect(sc.forgetJob('daily-digest')).toBe(false)
    expect(sc.threadOf('daily-digest')).toBe('general')
    open = true
    expect(sc.forgetJob('daily-digest')).toBe(true)
    expect(sc.threadOf('daily-digest')).toBeNull()
  })
})
