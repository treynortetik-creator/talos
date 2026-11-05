// The pure part of the Health screen: status -> rows, notes and banner (docs/V2-FEATURES.md V2.5).
import { DISK_LOW_BYTES, DISK_RECOVERED_BYTES, HealthBeat, HealthStatus } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { bannerFor, formatFree, healthNotes, healthRows } from '../../src/features/health/rows.ts'
import { statusOf } from './status.ts'

const quiet = (on: boolean) => on

describe('healthRows', () => {
  it('has relay, bridge, mod, alerts, and no external check', () => {
    const r = healthRows(statusOf(), { scheduler: undefined })
    expect(r.map((x) => x.id)).toEqual(['relay', 'bridge', 'mod', 'alerts'])
  })
  it('adds the scheduler row when schedules are on: the cached state, or "not checked yet"', () => {
    const on = healthRows(statusOf(), { scheduler: { state: 'ok' } })
    expect(on.find((x) => x.id === 'scheduler')).toMatchObject({ tone: 'ok', detail: 'ok' })
    const cold = healthRows(statusOf(), { scheduler: { state: null } })
    expect(cold.find((x) => x.id === 'scheduler')).toMatchObject({ tone: 'idle', detail: 'not checked yet' })
    const stuck = healthRows(statusOf(), { scheduler: { state: 'stuck' } })
    expect(stuck.find((x) => x.id === 'scheduler')?.tone).toBe('bad')
  })
  it('bridge offline is amber, red after 12 h', () => {
    const base = statusOf({
      bridge: { online: false, last_seen: '2026-10-29T19:00:00.000Z', down_since: '2026-10-29T19:00:00.000Z' },
    })
    expect(healthRows(base, { scheduler: undefined }).find((x) => x.id === 'bridge')?.tone).toBe('warn')
    const old = statusOf({
      bridge: { online: false, last_seen: '2026-10-29T07:00:00.000Z', down_since: '2026-10-29T07:00:00.000Z' },
    })
    expect(healthRows(old, { scheduler: undefined }).find((x) => x.id === 'bridge')?.tone).toBe('bad')
  })
  it('mod: absent is idle, quiet is warn, unknown is idle', () => {
    const tone = (mod: ReturnType<typeof statusOf>['mod']) =>
      healthRows(statusOf({ mod }), { scheduler: undefined }).find((x) => x.id === 'mod')?.tone
    expect(tone({ state: 'absent', last_seen: null, expected: false })).toBe('idle')
    expect(tone({ state: 'quiet', last_seen: '2026-10-29T19:00:00.000Z', expected: true })).toBe('warn')
    expect(tone({ state: 'unknown', last_seen: null, expected: true })).toBe('idle')
  })
})

describe('healthNotes', () => {
  it('lists the two beat notes and nothing else', () => {
    const s = statusOf({
      beat: {
        mod: { state: 'alive', last_seen: null, expected: true },
        tts: false,
        stt: true,
        sqlite: { fts5: false },
      },
    })
    expect(healthNotes(s)).toEqual([
      'Voice replies need a TTS command on your Mac',
      "Search is off: this Mac's SQLite has no FTS5",
    ])
    expect(healthNotes(statusOf())).toEqual([])
  })
})

describe('bannerFor', () => {
  it('mod_quiet always; bridge_offline only outside the quiet window', () => {
    expect(bannerFor(statusOf({ mac_problems: ['mod_quiet'] }), quiet(true))).toEqual({
      kind: 'mod_quiet',
      text: 'Your mod stopped reporting.',
      next: expect.stringContaining('Talos mod'),
    })
    expect(bannerFor(statusOf({ mac_problems: ['bridge_offline'] }), quiet(true))).toBeNull()
    expect(bannerFor(statusOf({ mac_problems: ['bridge_offline'] }), quiet(false))?.kind).toBe('bridge_offline')
    expect(bannerFor(statusOf(), quiet(false))).toBeNull()
  })
})

describe('Mac disk row (D11)', () => {
  const GB = 1024 ** 3
  const withFree = (free: number | undefined, over: Partial<ReturnType<typeof statusOf>> = {}) => {
    const base = statusOf(over)
    return statusOf({ ...over, beat: { ...base.beat, ...(free !== undefined ? { disk_free_bytes: free } : {}) } })
  }
  const row = (s: ReturnType<typeof statusOf>) => healthRows(s, { scheduler: undefined }).find((x) => x.id === 'disk')

  it('shows free space: green when comfortable, amber until clearly clear of the line, red below it', () => {
    expect(row(withFree(120 * GB))).toMatchObject({ tone: 'ok', detail: '120.0 GB free' })
    expect(row(withFree(DISK_RECOVERED_BYTES - 1))?.tone).toBe('warn')
    expect(row(withFree(DISK_LOW_BYTES))?.tone).toBe('warn')
    expect(row(withFree(DISK_LOW_BYTES - 1))).toMatchObject({
      tone: 'bad',
      detail: expect.stringContaining('nearly full'),
    })
    expect(row(withFree(0))).toMatchObject({ tone: 'bad', detail: 'nearly full · 0 MB free' })
  })
  it('is absent for an older bridge that does not report it, and while the Mac is offline (an old number is history)', () => {
    expect(row(withFree(undefined))).toBeUndefined()
    expect(row(withFree(1 * GB, { bridge: { online: false, last_seen: null, down_since: null } }))).toBeUndefined()
  })
  it('never rounds a low number up into a comfortable one', () => {
    expect(formatFree(1.99 * GB)).toBe('1.9 GB')
    expect(formatFree(999 * 1024 ** 2)).toBe('999 MB')
  })
  it('an older web client (schema without the field) still parses the new status; the problem enums are unchanged', () => {
    const body = JSON.parse(JSON.stringify(withFree(3 * GB)))
    const OldBeat = HealthBeat.omit({ bridge: true, disk_free_bytes: true }).partial().optional()
    const OldStatus = HealthStatus.extend({ beat: OldBeat })
    expect(OldStatus.parse(body).beat).not.toHaveProperty('disk_free_bytes')
    expect(HealthStatus.parse(body).beat?.disk_free_bytes).toBe(3 * GB)
  })
})
