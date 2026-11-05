// Pins who may change each setting, exactly as it behaves today: the phone path (checkConfigPatch), the agent path
// (resolveConfigChanges / verifyConfigPayload) and which fields need step-up. The expectations below are written out by
// hand and do not read the settings table, so moving a field from one side to the other turns a line red here.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_CONFIG_ALLOWLIST,
  AgentConfig,
  CONFIG_PATCH_ALLOWLIST,
  CONFIG_SESSION_STEPUP_FIELDS,
  checkConfigPatch,
  resolveConfigChanges,
  STOCK_THEMES,
  verifyConfigPayload,
} from '../src/index.ts'

const config = AgentConfig.parse(defaultConfig)

/** `a.b` becomes `{ a: { b: value } }`; a top-level name becomes `{ name: value }`. */
function patchFor(path: string, value: unknown): Record<string, unknown> {
  const [top, sub] = path.split('.')
  return sub === undefined ? { [top as string]: value } : { [top as string]: { [sub]: value } }
}

const PLAIN = { ok: true, touchesWorkEnabled: false } as const
const WORK = { ok: true, touchesWorkEnabled: true } as const
const SESSION = { ok: true, touchesWorkEnabled: false, stepupPurpose: 'config:session' } as const
const TRUST_ON = { ok: true, touchesWorkEnabled: false, stepupPurpose: 'config:session', turnsOnTrust: true } as const
const refused = (path: string) => ({ ok: false, path }) as const

describe('phone path: checkConfigPatch result for every field', () => {
  // path -> [value sent, exact result]
  const cases: Array<[string, unknown, unknown]> = [
    ['version', 1, refused('version')],
    ['rev', 1, refused('rev')],
    ['agent', {}, PLAIN],
    ['agent.name', 'Atlas', PLAIN],
    ['agent.voice', 'marin', PLAIN],
    ['agent.voice_persona', 'calm', PLAIN],
    ['agent.unlisted_key', 1, PLAIN], // a whole-section entry lets any key through the walk; the schema judges it later
    ['owner', {}, PLAIN],
    ['owner.display_name', 'Alex Example', PLAIN],
    ['threads', [], PLAIN],
    ['default_thread', 'general', PLAIN],
    ['timezone', 'UTC', PLAIN],
    ['quiet_window', null, PLAIN],
    ['notifications', {}, PLAIN],
    ['notifications.master', false, PLAIN],
    ['notifications.show_thread_names', 'all', PLAIN],
    ['mirror', {}, refused('mirror')],
    ['mirror.telegram', 'on', refused('mirror')],
    ['work', {}, PLAIN],
    ['work.enabled', ['gmail'], WORK],
    ['work.thread', 'general', PLAIN],
    ['work.label', 'Work', PLAIN],
    ['work.ask_note', 'Ask first.', PLAIN],
    ['work.retention', 'buffer', WORK],
    ['work.unlisted_key', 1, refused('work.unlisted_key')],
    ['voice_notes', {}, PLAIN],
    ['voice_notes.reply_with_voice', 'never', PLAIN],
    ['voice_notes.driving_until', null, PLAIN],
    ['permission_relay', true, SESSION],
    ['session_models', ['default'], PLAIN],
    ['memory_browser', false, PLAIN],
    ['dedicated', {}, PLAIN],
    ['theme', 'paper', PLAIN],
    // trust mode: off is free, on needs the session step-up, anything else is refused (docs/SECURITY.md "Trust mode")
    ['trust_mode', true, TRUST_ON],
    ['trust_mode', false, PLAIN],
    ['trust_mode', null, PLAIN],
    ['trust_mode', 'yes', refused('trust_mode')],
    ['trust_mode', 1, refused('trust_mode')],
    ['trust_mode', { on: true }, refused('trust_mode')],
    ['permission_stepup', 'off', refused('permission_stepup')],
    ['sessions_view', true, refused('sessions_view')],
    ['no_such_setting', 1, refused('no_such_setting')],
  ]
  it.each(cases)('%s = %j', (path, value, expected) => {
    expect(checkConfigPatch(patchFor(path, value))).toEqual(expected)
  })

  it('a section that is only partly open refuses null and non-objects, naming the section', () => {
    expect(checkConfigPatch({ mirror: null })).toEqual(refused('mirror'))
    expect(checkConfigPatch({ work: null })).toEqual(refused('work'))
    expect(checkConfigPatch({ work: 'x' })).toEqual(refused('work'))
    expect(checkConfigPatch({ work: ['enabled'] })).toEqual(refused('work'))
  })
  it('a whole section accepts any value for the section itself', () => {
    expect(checkConfigPatch({ agent: null })).toEqual(PLAIN)
    expect(checkConfigPatch({ agent: 1 })).toEqual(PLAIN)
  })
  it('anything that is not an object is refused with an empty path', () => {
    for (const bad of [null, undefined, [], 'x', 3]) expect(checkConfigPatch(bad)).toEqual(refused(''))
  })
  it('two work step-up fields in one patch are one work step-up', () => {
    expect(checkConfigPatch({ work: { enabled: [], retention: 'buffer' } })).toEqual(WORK)
    expect(checkConfigPatch({ work: { label: 'x', retention: 'buffer' } })).toEqual(WORK)
  })
  it('the session step-up and the work step-up cannot share a patch; the session field is named', () => {
    expect(checkConfigPatch({ permission_relay: true, work: { enabled: [] } })).toEqual(refused('permission_relay'))
    expect(checkConfigPatch({ permission_relay: true, work: { retention: 'buffer' } })).toEqual(
      refused('permission_relay'),
    )
    expect(checkConfigPatch({ permission_relay: true, work: { label: 'x' } })).toEqual(SESSION)
    expect(checkConfigPatch({ permission_relay: true, timezone: 'UTC' })).toEqual(SESSION)
  })
  it('the first forbidden path is the one named', () => {
    expect(checkConfigPatch({ timezone: 'UTC', mirror: {}, bogus: 1 })).toEqual(refused('mirror'))
  })
  it('a hostile key name is refused like any other unlisted name', () => {
    expect(checkConfigPatch(JSON.parse('{"__proto__":{"x":1}}'))).toEqual(refused('__proto__'))
  })
})

describe('phone path: the exported lists', () => {
  it('the allowlist is exactly this, in this order', () => {
    expect([...CONFIG_PATCH_ALLOWLIST]).toEqual([
      'agent',
      'owner',
      'threads',
      'default_thread',
      'timezone',
      'quiet_window',
      'notifications',
      'voice_notes',
      'work.enabled',
      'work.thread',
      'work.label',
      'work.ask_note',
      'work.retention',
      'permission_relay',
      'session_models',
      'memory_browser',
      'dedicated',
      'theme',
      'trust_mode',
    ])
  })
  it('only permission_relay needs the session step-up every time; trust_mode needs it only to turn on', () => {
    expect([...CONFIG_SESSION_STEPUP_FIELDS]).toEqual(['permission_relay'])
  })
})

describe('agent path: config_propose result for every field', () => {
  const ALLOWED_LIST =
    'agent.name, agent.voice, owner.display_name, timezone, quiet_window, voice_notes.reply_with_voice, theme'
  const NAMED = new Set([
    'permission_relay',
    'work',
    'notifications',
    'threads',
    'default_thread',
    'session_models',
    'dedicated',
    'memory_browser',
    'agent.voice_persona',
    'trust_mode',
  ])
  const named = (p: string) => NAMED.has(p) || NAMED.has(p.split('.')[0] as string)
  const refusal = (p: string) =>
    named(p)
      ? `${p} can't be changed by you. The owner changes it in Settings. Allowed: ${ALLOWED_LIST}.`
      : `${p} is not a setting you may propose. Allowed: ${ALLOWED_LIST}. Devices, keys, enrollment and security settings are never on the list.`

  // the seven the agent may propose (six settings and the theme), with a new value that is valid and different from the example config, and what is there now
  const allowed: Array<[string, unknown, unknown]> = [
    ['agent.name', 'Atlas', 'Talos'],
    ['agent.voice', 'marin', 'meridian'],
    ['owner.display_name', 'Alex Example', 'You'],
    ['timezone', 'Europe/Paris', 'UTC'],
    ['quiet_window', { start: '22:00', end: '07:00' }, null],
    ['voice_notes.reply_with_voice', 'always', 'when_voice'],
    ['theme', { ...structuredClone(STOCK_THEMES[1]), name: 'dusk' }, 'talos'],
  ]
  it.each(allowed)('%s is allowed', (path, value, old) => {
    expect(resolveConfigChanges([{ path, value }], config)).toEqual({
      ok: true,
      changes: [{ path, old, new: value }],
    })
  })

  const notAllowed = [
    'version',
    'rev',
    'agent',
    'agent.voice_persona',
    'owner',
    'threads',
    'default_thread',
    'notifications',
    'notifications.master',
    'notifications.show_thread_names',
    'work',
    'work.enabled',
    'work.thread',
    'work.label',
    'work.ask_note',
    'work.retention',
    'voice_notes',
    'voice_notes.driving_until',
    'permission_relay',
    'permission_stepup',
    'sessions_view',
    'session_models',
    'memory_browser',
    'dedicated',
    'trust_mode',
    'no_such_setting',
  ]
  it.each(notAllowed)('%s is refused with its exact words', (path) => {
    expect(resolveConfigChanges([{ path, value: 'anything' }], config)).toEqual({ ok: false, error: refusal(path) })
  })

  it('a card bound to an allowed path still applies; the same card naming any other path does not', () => {
    for (const [path, value, old] of allowed) {
      const r = verifyConfigPayload(
        { v: 1, base_rev: 0, reason: 'asked', changes: [{ path, old, new: value }] },
        config,
      )
      expect(r.ok, path).toBe(true)
    }
    for (const path of notAllowed) {
      const r = verifyConfigPayload(
        { v: 1, base_rev: 0, reason: 'asked', changes: [{ path, old: null, new: 'x' }] },
        config,
      )
      expect(r, path).toEqual({
        ok: false,
        error: 'The card could not be read, or names a setting you may not change.',
      })
    }
  })
  it('the proposable list is exactly this, in this order', () => {
    expect([...AGENT_CONFIG_ALLOWLIST]).toEqual([
      'agent.name',
      'agent.voice',
      'owner.display_name',
      'timezone',
      'quiet_window',
      'voice_notes.reply_with_voice',
      'theme',
    ])
  })
  it('a proposal for a field changes nothing about which fields need step-up: the agent path has no step-up of its own', () => {
    const r = resolveConfigChanges([{ path: 'permission_relay', value: true }], config)
    expect(r.ok).toBe(false)
  })
})
