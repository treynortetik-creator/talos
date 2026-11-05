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

describe('nobody but the Mac writes trust_mode', () => {
  it('is on neither allowlist and a patch naming it is refused', () => {
    expect(CONFIG_PATCH_ALLOWLIST as readonly string[]).not.toContain('trust_mode')
    expect(AGENT_CONFIG_ALLOWLIST as readonly string[]).not.toContain('trust_mode')
    expect(AGENT_CONFIG_REFUSED as readonly string[]).toContain('trust_mode')
    expect(checkConfigPatch({ trust_mode: true }).ok).toBe(false)
    expect(checkConfigPatch({ trust_mode: false }).ok).toBe(false)
  })
  it('an agent proposal for it is refused', () => {
    const r = resolveConfigChanges([{ path: 'trust_mode', value: true }], AgentConfig.parse(defaultConfig))
    expect(r.ok).toBe(false)
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
