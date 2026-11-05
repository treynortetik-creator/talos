import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Offer, Sidecar } from '../../src/schedules/sidecar.ts'

const offer: Offer = {
  id: 'daily-digest',
  ds: '2026-10-28T11:30',
  run_id: 'r_1',
  fire_at: null,
  window_ends: null,
  trigger: 'clock',
  again: false,
  instance: 'bi_a',
  at: 1,
}

describe('Sidecar with the liveness gate closed', () => {
  test('recordOffer leaves no offer behind, so the next tick offers the job again', () => {
    let open = false
    const sc = new Sidecar(mkdtempSync(join(tmpdir(), 'sidecar-gate-')), () => open)
    expect(sc.recordOffer(offer)).toBe(false)
    // service.runnerTick skips a job whose offer is on file for this instance; it must not be
    expect(sc.offerFor(offer.id, offer.ds)).toBeUndefined()
    open = true
    expect(sc.recordOffer(offer)).toBe(true)
    expect(sc.offerFor(offer.id, offer.ds)?.run_id).toBe('r_1')
  })

  test('markNotified leaves no key behind, so the owner is still told once the gate opens', () => {
    let open = false
    const sc = new Sidecar(mkdtempSync(join(tmpdir(), 'sidecar-gate-')), () => open)
    expect(sc.markNotified('fail|daily-digest', 5)).toBe(false)
    expect(sc.wasNotified('fail|daily-digest')).toBe(false)
    open = true
    expect(sc.markNotified('fail|daily-digest', 6)).toBe(true)
    expect(sc.wasNotified('fail|daily-digest')).toBe(true)
  })
})
