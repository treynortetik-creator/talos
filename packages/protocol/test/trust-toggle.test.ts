// The trust mode toggle in the app (docs/SECURITY.md "Trust mode", "Who can change it"): off is free, on needs the session
// step-up, the agent can never write it, and a value this build cannot read never turns it on.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AgentConfig,
  checkConfigPatch,
  resolveConfigChanges,
  SETTINGS_TABLE,
  settingsTableProblems,
  trustOn,
  verifyConfigPayload,
} from '../src/index.ts'

describe('checkConfigPatch for trust_mode', () => {
  it('on: a plain patch since 2026-11-14 (a signed tap, no passkey)', () => {
    expect(checkConfigPatch({ trust_mode: true })).toEqual({ ok: true })
  })
  it('off (false, or null which deletes the field): no step-up', () => {
    for (const v of [false, null]) expect(checkConfigPatch({ trust_mode: v })).toEqual({ ok: true })
  })
  it('a value that is not a boolean or null is refused, naming the field (it could never be read as on)', () => {
    for (const v of ['true', 1, 0, {}, [], ['x']])
      expect(checkConfigPatch({ trust_mode: v }), JSON.stringify(v)).toEqual({ ok: false, path: 'trust_mode' })
  })
  it('turning it on beside other settings is one plain patch', () => {
    expect(checkConfigPatch({ trust_mode: true, timezone: 'UTC' })).toEqual({ ok: true })
    expect(checkConfigPatch({ trust_mode: true, permission_relay: true })).toEqual({ ok: true })
  })
  it('trust on beside a work field: one plain patch (there are no step-up tokens to keep apart)', () => {
    expect(checkConfigPatch({ trust_mode: true, work: { enabled: [] } })).toEqual({ ok: true })
    expect(checkConfigPatch({ trust_mode: false, work: { enabled: [] } })).toEqual({ ok: true })
  })
})

describe('the agent still cannot write it', () => {
  const cfg = AgentConfig.parse(defaultConfig)
  it('config_propose refuses both values, by name, and a bound card naming it does not verify', () => {
    for (const value of [true, false]) {
      expect(resolveConfigChanges([{ path: 'trust_mode', value }], cfg).ok).toBe(false)
      const v = verifyConfigPayload(
        { v: 1, base_rev: 0, reason: 'asked', changes: [{ path: 'trust_mode', old: undefined, new: value }] },
        cfg,
      )
      expect(v.ok).toBe(false)
    }
  })
})

describe('read tolerance', () => {
  it('a config from a newer peer with a value this build cannot read is off, never on, and never throws', () => {
    for (const v of ['on', 2, { until: 'tomorrow' }, ['x']])
      expect(trustOn(AgentConfig.parse({ ...defaultConfig, trust_mode: v }))).toBe(false)
  })
  it('the table is sound with the new row', () => {
    expect(settingsTableProblems(SETTINGS_TABLE as never)).toEqual([])
  })
  it('no row carries stepupOnTrue any more (the step-up is gone)', () => {
    for (const [p, r] of Object.entries(SETTINGS_TABLE)) expect('stepupOnTrue' in r, p).toBe(false)
  })
})
