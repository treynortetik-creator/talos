// Trust mode (docs/SECURITY.md "Trust mode"): the setting itself, who may write it, and the passkey rule it changes.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_CONFIG_ALLOWLIST,
  AGENT_CONFIG_REFUSED,
  AgentConfig,
  CONFIG_PATCH_ALLOWLIST,
  checkConfigPatch,
  resolveConfigChanges,
  riskForTrust,
  trustOn,
} from '../src/index.ts'

describe('trust_mode in the config', () => {
  it('a config without the field parses to a config without the field (old files stay byte-identical)', () => {
    const c = AgentConfig.parse(defaultConfig)
    expect('trust_mode' in c).toBe(false)
    expect(trustOn(c)).toBe(false)
    expect(JSON.stringify(AgentConfig.parse(JSON.parse(JSON.stringify(c))))).toBe(JSON.stringify(c))
  })
  it('true turns it on; false, junk and a newer peer value never throw and never turn it on', () => {
    expect(trustOn(AgentConfig.parse({ ...defaultConfig, trust_mode: true }))).toBe(true)
    for (const v of [false, 'yes', 1, null, { on: true }, ['x']]) {
      const c = AgentConfig.parse({ ...defaultConfig, trust_mode: v })
      expect(trustOn(c)).toBe(false)
    }
  })
  it('trustOn treats a missing config as off', () => {
    expect(trustOn(undefined)).toBe(false)
    expect(trustOn(null)).toBe(false)
  })
})

describe('who writes trust_mode', () => {
  it('the owner may patch it from the app, the agent may not propose it', () => {
    expect(CONFIG_PATCH_ALLOWLIST as readonly string[]).toContain('trust_mode')
    expect(AGENT_CONFIG_ALLOWLIST as readonly string[]).not.toContain('trust_mode')
    expect(AGENT_CONFIG_REFUSED as readonly string[]).toContain('trust_mode')
  })
  it('turning it on from the app needs the session step-up; off does not', () => {
    const on = checkConfigPatch({ trust_mode: true })
    expect(on).toMatchObject({ ok: true, stepupPurpose: 'config:session', turnsOnTrust: true })
    const off = checkConfigPatch({ trust_mode: false })
    expect(off).toEqual({ ok: true, touchesWorkEnabled: false })
  })
  it('an agent proposal for it is refused, by name', () => {
    for (const value of [true, false]) {
      const r = resolveConfigChanges([{ path: 'trust_mode', value }], AgentConfig.parse(defaultConfig))
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).toContain("trust_mode can't be changed by you")
    }
  })
})

describe('riskForTrust', () => {
  it('off: whatever was asked', () => {
    expect(riskForTrust(false, 'deploy', 'high')).toBe('high')
    expect(riskForTrust(false, 'purchase', 'low')).toBe('low')
  })
  it('on: purchase is high, every other kind is low', () => {
    expect(riskForTrust(true, 'purchase', 'low')).toBe('high')
    for (const k of ['email', 'message', 'deploy', 'publish', 'decision', 'generic', 'schedule', 'app_action'])
      expect(riskForTrust(true, k, 'high')).toBe('low')
  })
})
