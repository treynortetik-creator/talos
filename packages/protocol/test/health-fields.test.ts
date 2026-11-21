// SETTINGS-MAP M4 and M34: two optional additions to the health frames. Both must be invisible to an older peer and must
// never be a new value in a strict list (an older app would drop the whole status for one new enum value).
import { describe, expect, it } from 'vitest'
import { HealthStatus, MacProblem, RelayLimits, RelayProblem } from '../src/health.ts'

const _beat = {
  bridge: { version: '0.4.1', started_at: '2026-10-29T12:00:00.000Z' },
  mod: { state: 'alive', last_seen: null, expected: true },
  tts: true,
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

describe('relay.release (which release the relay is on)', () => {
  it('is optional: a status from an older relay parses without it, and a newer one keeps it', () => {
    expect(HealthStatus.parse(status).relay.release).toBeUndefined()
    const withRelease = { ...status, relay: { ...status.relay, release: '0.1.8' } }
    expect(HealthStatus.parse(withRelease).relay.release).toBe('0.1.8')
  })
  it('junk degrades that one field, never the status', () => {
    for (const junk of [5, 'x'.repeat(200), { a: 1 }]) {
      const parsed = HealthStatus.parse({ ...status, relay: { ...status.relay, release: junk } })
      expect(parsed.relay.release).toBeUndefined()
      expect(parsed.relay.version).toBe('1')
    }
  })
  it('an older client (the schema before the field) still parses a status that has it', () => {
    const before = HealthStatus.shape.relay.omit({ release: true })
    expect(before.parse({ version: '1', up_since: status.relay.up_since, release: '0.1.8' })).toEqual({
      version: '1',
      up_since: status.relay.up_since,
    })
  })
})
