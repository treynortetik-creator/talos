// The restart check the Mac app keeps fresh ($TALOS_APP_HOME/main-restart-check.json), read by the bridge's `restart_main`
// tool. A newer app's reason must not make an older bridge's read fail: it degrades to `unknown`, one item, never the file.
import { describe, expect, it } from 'vitest'
import {
  AGENT_REQUEST_FILE,
  AGENT_REQUEST_MIN_GAP_MS,
  AGENT_REQUEST_SIGNED_MAX,
  AgentRequestFile,
  MAIN_RESTART_CHECK_FILE,
  MAIN_RESTART_CHECK_STALE_MS,
  MAIN_RESTART_CHECK_WRITE_MS,
  MAIN_RESTART_OUTCOMES,
  MAIN_RESTART_REASONS,
  MainRestartCheckFile,
  SUPERVISOR_HEARTBEAT_MS,
  SUPERVISOR_STALE_MS,
} from '../src/index.ts'

const good = {
  v: 1,
  at: '2026-11-12T10:00:00Z', // what Swift's ISO8601DateFormatter writes: no fraction
  will_return: false,
  reasons: ['launch_changed', 'too_soon'],
}

describe('main-restart-check.json', () => {
  it('names sit beside the request file', () => {
    expect(MAIN_RESTART_CHECK_FILE).toBe('main-restart-check.json')
    expect(AGENT_REQUEST_FILE).toBe('agent-request.json')
  })

  it('freshness follows the supervisor heartbeat: written every 5 s, stale after 15 s', () => {
    expect(MAIN_RESTART_CHECK_WRITE_MS).toBe(SUPERVISOR_HEARTBEAT_MS)
    expect(MAIN_RESTART_CHECK_STALE_MS).toBe(SUPERVISOR_STALE_MS)
    expect(MAIN_RESTART_CHECK_STALE_MS).toBeGreaterThanOrEqual(3 * MAIN_RESTART_CHECK_WRITE_MS)
  })

  it('the request gap is the Mac app own: AgentRecovery.swift `requestMinGap: Double = 120` (seconds)', () => {
    expect(AGENT_REQUEST_MIN_GAP_MS).toBe(120_000)
  })

  it('every reason the brief names is in the closed list', () => {
    for (const r of [
      'launch_changed',
      'claude_path_changed',
      'auto_confirm_off',
      'budget_spent',
      'someone_typing',
      'takeover_held',
      'owner_stopped',
      'too_soon',
      'session_id_invalid',
      'unknown',
    ])
      expect(MAIN_RESTART_REASONS).toContain(r)
  })

  it('a good file parses, with or without fractional seconds or an offset', () => {
    expect(MainRestartCheckFile.parse(good)).toEqual(good)
    expect(MainRestartCheckFile.safeParse({ ...good, at: '2026-11-12T10:00:00.123Z' }).success).toBe(true)
    expect(MainRestartCheckFile.safeParse({ ...good, at: '2026-11-12T03:00:00-05:00' }).success).toBe(true)
  })

  it('an unknown reason reads as unknown and the rest of the file still reads', () => {
    const r = MainRestartCheckFile.parse({ ...good, reasons: ['launch_changed', 'moon_phase', 7, 'too_soon'] })
    expect(r.reasons).toEqual(['launch_changed', 'unknown', 'unknown', 'too_soon'])
    expect(r.will_return).toBe(false)
  })

  it('a newer app extra field is dropped, not refused', () => {
    expect(MainRestartCheckFile.parse({ ...good, detail: { x: 1 } })).toEqual(good)
  })

  it('missing or wrong-typed core fields are unreadable (the reader then answers no)', () => {
    for (const bad of [
      { ...good, v: 2 },
      { ...good, will_return: 'yes' },
      { ...good, at: 'yesterday' },
      { ...good, reasons: 'too_soon' },
      { ...good, reasons: Array(40).fill('too_soon') },
      { v: 1, at: good.at, reasons: [] },
    ])
      expect(MainRestartCheckFile.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('`last` is optional: an older app writes none, and the file reads the same', () => {
    expect(MainRestartCheckFile.parse(good).last).toBeUndefined()
    expect(MAIN_RESTART_OUTCOMES).toEqual(['came_back', 'stalled', 'refused'])
    for (const last of [
      { control_id: '01JD0000000000000000000000', at: good.at, outcome: 'came_back' },
      { control_id: 'c1', at: '2026-11-12T10:00:00.250Z', outcome: 'stalled', detail: 'folder trust' },
      { control_id: 'c-2_x', at: good.at, outcome: 'refused', detail: 'owner_stopped' },
    ])
      expect(MainRestartCheckFile.parse({ ...good, last }).last).toEqual(last)
  })

  it('a `last` this reader cannot read is dropped, never the whole file', () => {
    for (const last of [
      { control_id: 'c1', at: good.at, outcome: 'exploded' },
      { control_id: 'a/b', at: good.at, outcome: 'came_back' },
      { control_id: 'c1', at: 'yesterday', outcome: 'came_back' },
      { control_id: 'c1', at: good.at, outcome: 'stalled', detail: 'x'.repeat(81) },
      { control_id: 'c1', at: good.at, outcome: 'stalled', detail: 'line\nbreak' },
      'came_back',
      7,
    ]) {
      const r = MainRestartCheckFile.safeParse({ ...good, last })
      expect(r.success, JSON.stringify(last)).toBe(true)
      expect(r.data?.last, JSON.stringify(last)).toBeUndefined()
      expect(r.data?.reasons).toEqual(good.reasons)
    }
  })

  it('the request file no longer says who asked: an old file with asked_by still reads, and the field is dropped', () => {
    const base = { v: 1, control_id: '01JD0000000000000000000000', action: 'restart', ts: 1 }
    for (const legacy of ['owner', 'agent', 'root', 1, null]) {
      const r = AgentRequestFile.safeParse({ ...base, asked_by: legacy })
      expect(r.success, JSON.stringify(legacy)).toBe(true)
      expect(r.data && 'asked_by' in r.data, JSON.stringify(legacy)).toBe(false)
    }
    expect(AgentRequestFile.parse(base)).toEqual(base)
  })

  it('the proof: exactly device_id, osig and signed_b64url, each in its shape, signed text capped', () => {
    const base = { v: 1, control_id: '01JD0000000000000000000000', action: 'restart', ts: 1 }
    const proof = { device_id: 'd_rjxnk4xufxem5xago5zd', osig: 'A'.repeat(86), signed_b64url: 'eyJ2IjoxfQ' }
    expect(AgentRequestFile.parse({ ...base, proof }).proof).toEqual(proof)
    for (const bad of [
      { ...proof, extra: 1 },
      { device_id: proof.device_id, osig: proof.osig },
      { ...proof, osig: 'A'.repeat(85) },
      { ...proof, device_id: 'phone' },
      { ...proof, signed_b64url: 'eyJ2Ijox+Q==' },
      { ...proof, signed_b64url: 'A'.repeat(AGENT_REQUEST_SIGNED_MAX + 1) },
      'signed',
      null,
    ])
      expect(AgentRequestFile.safeParse({ ...base, proof: bad }).success, JSON.stringify(bad)).toBe(false)
  })

  it('who asked and why: by_thread a thread id, why plain-length text, both optional', () => {
    const base = { v: 1, control_id: '01JD0000000000000000000000', action: 'restart', ts: 1 }
    expect(AgentRequestFile.parse({ ...base, by_thread: 'trip', why: 'new hub code' })).toMatchObject({
      by_thread: 'trip',
      why: 'new hub code',
    })
    expect(AgentRequestFile.parse(base).why).toBeUndefined()
    for (const bad of [{ by_thread: '../x' }, { by_thread: 'all' }, { why: '' }, { why: 'x'.repeat(81) }, { why: 7 }])
      expect(AgentRequestFile.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false)
  })

  it('the request file schema is otherwise unchanged: the four fields, strict', () => {
    expect(
      AgentRequestFile.safeParse({ v: 1, control_id: '01JD0000000000000000000000', action: 'restart', ts: 1 }).success,
    ).toBe(true)
    expect(
      AgentRequestFile.safeParse({ v: 1, control_id: '01JD0000000000000000000000', action: 'restart', ts: 1, by: 'x' })
        .success,
    ).toBe(false)
  })
})
