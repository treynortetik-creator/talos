// Thread sessions are allowed by default (the owner, 2026-11-19): a config that never wrote the master switch shows it on, so
// every thread offers its own switch, which stays off. Nothing runs until a thread is turned on; that change writes the switch
// on (the Mac app reads a missing one as off), and threads left `dedicated` from before, shown off, go back to shared.
import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  canBeDedicated,
  clearUnswitchedSessions,
  dedicatedSettings,
  NEVER_DEDICATED_THREADS,
  SETTINGS_TABLE,
  threadSessionMode,
  threadSessionsAllowed,
  writeSwitchOnFirstUse,
} from '../src/index.ts'
import { loadExample } from './helpers.ts'

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'fixed',
  order: 9,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

function config(threads: unknown[] = [], dedicated?: unknown) {
  const cfg = AgentConfig.parse(loadExample('default'))
  const { dedicated: _d, ...rest } = cfg
  return AgentConfig.parse({ ...rest, threads: [...cfg.threads, ...threads], ...(dedicated ? { dedicated } : {}) })
}

describe('the master switch as shown', () => {
  it('a config that never wrote it shows it on; routing still reads it as off', () => {
    const c = config([thread('trip', { session: 'dedicated' })])
    expect(c.dedicated).toBeUndefined()
    expect(threadSessionsAllowed(c)).toBe(true)
    expect(dedicatedSettings(c).enabled).toBe(false)
    expect(threadSessionMode(c, 'trip')).toBe('shared')
  })

  it('an explicit value is what it says; junk inside it is off', () => {
    expect(threadSessionsAllowed(config([], { enabled: true }))).toBe(true)
    expect(threadSessionsAllowed(config([], { enabled: false }))).toBe(false)
    expect(threadSessionsAllowed({ dedicated: { enabled: 'yes' } })).toBe(false)
  })

  it("the agent's settings row reads the switch as the owner sees it", () => {
    const row = SETTINGS_TABLE.dedicated as { agentRule: { read: (c: unknown) => unknown } }
    expect(row.agentRule.read(config())).toBe(true)
    expect(row.agentRule.read(config([], { enabled: false }))).toBe(false)
  })

  it('general, inbox and the default thread still never offer their own session', () => {
    const c = config([thread('general'), thread('inbox')])
    for (const id of [...NEVER_DEDICATED_THREADS, c.default_thread]) expect(canBeDedicated(c, id), id).toBe(false)
    expect(canBeDedicated(config([thread('trip')]), 'trip')).toBe(true)
  })
})

describe('clearUnswitchedSessions', () => {
  it('with no switch written, no thread is on its own session: a leftover reads shared', () => {
    const c = config([thread('trip', { session: 'dedicated' }), thread('garden')])
    const cleared = clearUnswitchedSessions(c)
    expect(cleared.threads.find((t) => t.id === 'trip')?.session).toBe('shared')
    expect(clearUnswitchedSessions(cleared)).toBe(cleared) // nothing left: the same object
  })

  it('a written switch, on or off, keeps every thread as it is', () => {
    for (const enabled of [true, false]) {
      const c = config([thread('trip', { session: 'dedicated' })], { enabled })
      expect(clearUnswitchedSessions(c)).toBe(c)
    }
  })
})

describe('writeSwitchOnFirstUse', () => {
  it('turning a thread on writes the switch on: that thread is routed to its own session', () => {
    const before = config([thread('trip'), thread('garden')])
    const after = writeSwitchOnFirstUse(before, config([thread('trip', { session: 'dedicated' }), thread('garden')]))
    expect(dedicatedSettings(after).enabled).toBe(true)
    expect(threadSessionMode(after, 'trip')).toBe('dedicated')
    expect(threadSessionMode(after, 'garden')).toBe('shared')
  })

  it('a change that writes only a limit keeps the shown switch on', () => {
    const before = config([thread('trip')])
    const after = writeSwitchOnFirstUse(before, config([thread('trip')], { max_live: 4 }), {
      dedicated: { max_live: 4 },
    })
    expect(dedicatedSettings(after).enabled).toBe(true)
    expect(dedicatedSettings(after).max_live).toBe(4)
  })

  it('an explicit off stays off', () => {
    const before = config([thread('trip')])
    const after = config([thread('trip')], { enabled: false })
    expect(writeSwitchOnFirstUse(before, after, { dedicated: { enabled: false } })).toBe(after)
  })

  it('a change that turns nothing on writes nothing: the same object', () => {
    const before = config([thread('trip')])
    const after = config([thread('trip', { name: 'Trip' })])
    expect(writeSwitchOnFirstUse(before, after)).toBe(after)
  })

  it('a thread that may never have its own session does not write the switch', () => {
    const before = config([thread('general')])
    const after = config([thread('general', { session: 'dedicated' })])
    expect(writeSwitchOnFirstUse(before, after)).toBe(after)
  })

  it('once the switch is written, this rule never touches a change again', () => {
    const before = config([thread('trip')], { enabled: false })
    const after = config([thread('trip', { session: 'dedicated' })], { enabled: true })
    expect(writeSwitchOnFirstUse(before, after, { dedicated: { enabled: true } })).toBe(after)
  })
})
