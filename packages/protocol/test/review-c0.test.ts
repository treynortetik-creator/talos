// Adversarial review of PR #32 (Claude Code C0). Each `it` here is a bug the review found; it FAILS on feat/cc-c0 and
// passes once the fix lands. See the review file for the reasoning and sources.
import { describe, expect, it } from 'vitest'
import {
  CardResolveFrame,
  ConfigPatchFrame,
  checkConfigPatch,
  newUlid,
  SessionControlFrame,
  sessionStateFromEngine,
} from '../src/index.ts'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const AT = new Date(NOW).toISOString()

// R2. `$.session.usage()` returns `rateLimits` as `{ kind, percentUsed, resetsAt }` (mods reference, "Mods API methods",
// $.session row). sessionStateFromEngine reads `percent`, so every real rate-limit bar is empty.
describe('R2: lenient engine parsing reads the documented usage() field names', () => {
  it('keeps percentUsed from $.session.usage().rateLimits', () => {
    const r = sessionStateFromEngine(
      { id: 's1', usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: AT }] } },
      { source: 'mod', capabilities: [], at: AT },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state.rate_limits[0]?.percent).toBe(31)
  })
})

// R4 (withdrawn 2026-11): config.patch no longer carries a step-up assertion; permission_stepup is gone.
describe('R4: config.patch has no step-up assertion field any more', () => {
  it('ConfigPatchFrame refuses a stepup key (the frame is strict)', () => {
    const f = {
      v: 1,
      type: 'config.patch',
      id: newUlid(),
      ts: AT,
      base_rev: 1,
      patch: { agent: { name: 'x' } },
      device_id: 'd_abcdefghijklmnopqrst',
      osig: 'a'.repeat(86),
    }
    expect(ConfigPatchFrame.safeParse(f).success).toBe(true)
    const stepup = { credential_id: 'abc', authenticator_data: 'abc', client_data_json: 'abc', signature: 'abc' }
    expect(ConfigPatchFrame.safeParse({ ...f, stepup }).success).toBe(false)
  })
})

describe('what stays when the config-side step-up goes (SETTINGS-MAP O3)', () => {
  const assertion = { credential_id: 'abc', authenticator_data: 'abc', client_data_json: 'abc', signature: 'abc' }
  const owner = { device_id: 'd_abcdefghijklmnopqrst', osig: 'a'.repeat(86) }
  it('card.resolve and session.control still carry a StepupAssertion', () => {
    const card = {
      v: 1,
      type: 'card.resolve',
      id: newUlid(),
      ts: AT,
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      action: 'primary',
      payload_hash: `sha256:${'0'.repeat(64)}`,
      ...owner,
    }
    expect(CardResolveFrame.safeParse({ ...card, stepup: assertion }).success).toBe(true)
    const control = {
      v: 1,
      type: 'session.control',
      id: newUlid(),
      ts: AT,
      control_id: newUlid(),
      thread_id: 'general',
      action: 'compact',
      ...owner,
    }
    expect(SessionControlFrame.safeParse({ ...control, stepup: assertion }).success).toBe(true)
  })
  it('permission_relay keeps its config:session step-up; the removed fields are config_field_forbidden', () => {
    expect(checkConfigPatch({ permission_relay: true })).toMatchObject({ ok: true, stepupPurpose: 'config:session' })
    expect(checkConfigPatch({ permission_stepup: 'high' })).toEqual({ ok: false, path: 'permission_stepup' })
    expect(checkConfigPatch({ sessions_view: true })).toEqual({ ok: false, path: 'sessions_view' })
    // a patch that mixes an allowed field with a removed one is refused whole
    expect(checkConfigPatch({ agent: { name: 'x' }, permission_stepup: 'off' }).ok).toBe(false)
  })
})
