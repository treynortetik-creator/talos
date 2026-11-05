// SETTINGS-MAP M4 and M34: two optional additions to the health frames. Both must be invisible to an older peer and must
// never be a new value in a strict list (an older app would drop the whole status for one new enum value).
import { describe, expect, it } from 'vitest'
import { HealthStatus, MacProblem, RelayLimits, RelayProblem } from '../src/health.ts'

const _beat = {
  bridge: { version: '0.4.1', started_at: '2026-10-29T12:00:00.000Z' },
  mod: { state: 'alive', last_seen: null, expected: true },
  tts: true,
  stt: false,
  sqlite: { fts5: true },
}
const status = {
  at: '2026-10-29T12:00:00.000Z',
  relay_ok: true,
  relay_problems: [],
  relay: { version: '1', up_since: '2026-10-29T11:00:00.000Z' },
  mac_problems: [],
  bridge: { online: true, last_seen: null, down_since: null },
  mod: { state: 'alive', last_seen: null, expected: true },
  push: { subscriptions: 1, last_ok_at: null, last_error_at: null },
  ntfy: false,
}

describe('HealthStatus.limits', () => {
  it('is optional: a status from an older relay parses without it', () => {
    expect(HealthStatus.parse(status).limits).toBeUndefined()
  })
  it('carries the relay’s numbers; any one may be missing', () => {
    expect(HealthStatus.parse({ ...status, limits: { buffer_days: 7, upload_max_mb: 50 } }).limits).toEqual({
      buffer_days: 7,
      upload_max_mb: 50,
    })
    expect(RelayLimits.parse({})).toEqual({})
  })
  it('junk in limits drops limits, not the status; an extra key from a newer relay is ignored', () => {
    expect(HealthStatus.parse({ ...status, limits: 'seven days' }).limits).toBeUndefined()
    expect(HealthStatus.parse({ ...status, limits: { buffer_days: -1 } }).limits).toBeUndefined()
    expect(HealthStatus.parse({ ...status, limits: { buffer_days: 7, future: 1 } }).limits).toEqual({ buffer_days: 7 })
  })
  it('did not add a value to the strict problem lists', () => {
    expect(RelayProblem.options).toEqual(['storage_full', 'no_alert_path'])
    expect(MacProblem.options).toEqual(['bridge_offline', 'mod_quiet'])
  })
})
