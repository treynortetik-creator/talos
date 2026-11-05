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
  it('on: the session step-up is required, and the result says it is trust being turned on', () => {
    expect(checkConfigPatch({ trust_mode: true })).toEqual({
      ok: true,
      touchesWorkEnabled: false,
      stepupPurpose: 'config:session',
      turnsOnTrust: true,
    })
  })
  it('off (false, or null which deletes the field): no step-up', () => {
    for (const v of [false, null])
      expect(checkConfigPatch({ trust_mode: v })).toEqual({ ok: true, touchesWorkEnabled: false })
  })
  it('a value that is not a boolean or null is refused, naming the field (it could never be read as on)', () => {
    for (const v of ['true', 1, 0, {}, [], ['x']])
      expect(checkConfigPatch({ trust_mode: v }), JSON.stringify(v)).toEqual({ ok: false, path: 'trust_mode' })
  })
  it('turning it on beside another setting still needs the step-up; beside permission_relay it is the one session token', () => {
    expect(checkConfigPatch({ trust_mode: true, timezone: 'UTC' })).toMatchObject({ stepupPurpose: 'config:session' })
    expect(checkConfigPatch({ trust_mode: true, permission_relay: true })).toMatchObject({
      stepupPurpose: 'config:session',
      turnsOnTrust: true,
    })
  })
  it('one token carries one purpose: trust on with a work step-up field is refused, naming trust_mode', () => {
    expect(checkConfigPatch({ trust_mode: true, work: { enabled: [] } })).toEqual({ ok: false, path: 'trust_mode' })
    expect(checkConfigPatch({ trust_mode: false, work: { enabled: [] } })).toMatchObject({
      ok: true,
      touchesWorkEnabled: true,
    })
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
  it('stepupOnTrue is only read on top-level rows: a dotted row with it is reported', () => {
    const bad = { ...SETTINGS_TABLE, 'work.label': { ...SETTINGS_TABLE['work.label'], stepupOnTrue: 'config:session' } }
    expect(settingsTableProblems(bad as never).join('\n')).toContain('work.label: stepupOnTrue')
  })
})
