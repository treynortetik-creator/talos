// The owner's "continue at the usage limit" setting (config.json `auto_continue_at_limit`): Claude Code's own wait-then-continue
// at a usage limit. Its default is ONE constant, and anything unreadable reads as that default.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { AGENT_RULES, AgentConfig, AUTO_CONTINUE_AT_LIMIT_DEFAULT, SETTINGS_TABLE } from '../src/index.ts'

const base = {
  version: 1,
  rev: 0,
  agent: {},
  owner: {},
  threads: defaultConfig.threads,
  default_thread: 'general',
  timezone: 'UTC',
  notifications: {},
  work: {},
  voice_notes: {},
}

describe('auto_continue_at_limit', () => {
  it('a file that leaves it out reads as the one default constant', () => {
    expect(AgentConfig.parse(base).auto_continue_at_limit).toBe(AUTO_CONTINUE_AT_LIMIT_DEFAULT)
    expect(typeof AUTO_CONTINUE_AT_LIMIT_DEFAULT).toBe('boolean')
  })

  it('true and false read as written', () => {
    expect(AgentConfig.parse({ ...base, auto_continue_at_limit: true }).auto_continue_at_limit).toBe(true)
    expect(AgentConfig.parse({ ...base, auto_continue_at_limit: false }).auto_continue_at_limit).toBe(false)
  })

  it.each([['yes'], [0], [1], [null], [{}], [[]]])('junk %j reads as the default, and the file still loads', (junk) => {
    const c = AgentConfig.parse({ ...base, auto_continue_at_limit: junk })
    expect(c.auto_continue_at_limit).toBe(AUTO_CONTINUE_AT_LIMIT_DEFAULT)
    expect(c.default_thread).toBe('general')
  })

  it('is an ordinary agent setting: no card (low), the app shows it, the table default is the constant', () => {
    const row = SETTINGS_TABLE.auto_continue_at_limit
    expect(row.agent).toBe(true)
    expect(row.risk).toBe('low')
    expect(row.phone).toBe('leaf')
    expect(row.default).toBe(AUTO_CONTINUE_AT_LIMIT_DEFAULT)
    const rule = AGENT_RULES.auto_continue_at_limit
    expect(rule.value.safeParse(true).success).toBe(true)
    expect(rule.value.safeParse(false).success).toBe(true)
    expect(rule.value.safeParse('on').success).toBe(false)
  })
})
