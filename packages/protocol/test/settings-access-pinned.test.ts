// Pins who may change each setting, exactly as it behaves today: the phone path (checkConfigPatch), the agent path
// (resolveConfigChanges / verifyConfigPayload); no field needs a passkey step-up since 2026-11-14. The expectations below are written out by
// hand and do not read the settings table, so moving a field from one side to the other turns a line red here.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_CONFIG_ALLOWLIST,
  AgentConfig,
  CONFIG_PATCH_ALLOWLIST,
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

// owner ruling 2026-11-14: no step-up anywhere but sign-in, so every allowed patch is just allowed (the work, session and
// trust-on purposes are gone); the bug webhook keeps its flag for the relay's address check
const PLAIN = { ok: true } as const
const WORK = PLAIN
const SESSION = PLAIN
const TRUST_ON = PLAIN
const refused = (path: string) => ({ ok: false, path }) as const

describe('phone path: checkConfigPatch result for every field', () => {
  // path -> [value sent, exact result]
  const cases: Array<[string, unknown, unknown]> = [
    ['version', 1, refused('version')],
    ['rev', 1, refused('rev')],
    ['agent', {}, PLAIN],
    ['agent.name', 'Atlas', PLAIN],
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
    ['media_keep_days', 30, PLAIN],
    ['always_allow', [], PLAIN],
    ['dev', {}, PLAIN],
    ['dev.thread_fence', false, PLAIN],
    ['dev.note_lookup', false, PLAIN],
    ['dev.unlisted_key', 1, refused('dev.unlisted_key')],
    ['os_sandbox', true, PLAIN],
    ['auto_continue_at_limit', false, PLAIN],
    ['settings_lock', false, PLAIN],
    ['dedicated', {}, PLAIN],
    ['theme', 'paper', PLAIN],
    // trust mode: a boolean or null, anything else is refused
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
  it('the work fields in one patch are one plain patch', () => {
    expect(checkConfigPatch({ work: { enabled: [], retention: 'buffer' } })).toEqual(WORK)
    expect(checkConfigPatch({ work: { label: 'x', retention: 'buffer' } })).toEqual(WORK)
  })
  it('fields that once needed different step-ups now share a patch', () => {
    expect(checkConfigPatch({ permission_relay: true, work: { enabled: [] } })).toEqual(PLAIN)
    expect(checkConfigPatch({ permission_relay: true, work: { retention: 'buffer' } })).toEqual(PLAIN)
    expect(checkConfigPatch({ permission_relay: true, timezone: 'UTC' })).toEqual(PLAIN)
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
      'memory.nyx_url',
      'voice_notes',
      'work.enabled',
      'work.thread',
      'work.label',
      'work.ask_note',
      'work.retention',
      'permission_relay',
      'session_models',
      'memory_browser',
      'media_keep_days',
      'always_allow',
      'dev.thread_fence',
      'dev.note_lookup',
      'os_sandbox',
      'auto_continue_at_limit',
      'settings_lock',
      'dedicated',
      'theme',
      'trust_mode',
      'bug_webhook_url',
    ])
  })
  it('no setting needs a step-up (2026-11-14): the list that named them is gone', async () => {
    expect('CONFIG_SESSION_STEPUP_FIELDS' in (await import('../src/index.ts'))).toBe(false)
  })
})

describe('agent path: config_propose result for every field', () => {
  const ALLOWED_LIST =
    'agent.name, owner.display_name, threads.<id>.<field>, default_thread, timezone, quiet_window, notifications.master, notifications.show_thread_names, voice_notes.reply_with_voice, voice_notes.driving_until, work.thread, work.label, work.ask_note, session_models, memory_browser, media_keep_days, always_allow, dev.thread_fence, dev.note_lookup, os_sandbox, auto_continue_at_limit, settings_lock, dedicated, theme'
  // owner ruling 2026-11-14: the agent changes the rest when he asks; these stay the owner's
  const NAMED = new Set(['permission_relay', 'work.enabled', 'work.retention', 'trust_mode', 'bug_webhook_url'])
  const named = (p: string) => NAMED.has(p)
  const refusal = (p: string) =>
    named(p)
      ? `${p} can't be changed by you. The owner changes it in Settings. Allowed: ${ALLOWED_LIST}.`
      : `${p} is not a setting you may propose. Allowed: ${ALLOWED_LIST}. Devices, keys, enrollment and security settings are never on the list.`

  // the table rows the agent may propose (threads through the per-thread paths below), with a new value that is valid and different from the example config, and what is there now
  const allowed: Array<[string, unknown, unknown]> = [
    ['agent.name', 'Atlas', 'Talos'],
    ['owner.display_name', 'Alex Example', 'You'],
    ['timezone', 'Europe/Paris', 'UTC'],
    ['quiet_window', { start: '22:00', end: '07:00' }, null],
    ['notifications.master', false, true],
    ['notifications.show_thread_names', 'all', 'fixed_only'],
    ['voice_notes.reply_with_voice', 'always', 'never'],
    ['voice_notes.driving_until', '2026-11-09T18:00:00.000Z', null],
    ['session_models', ['default', 'opus'], ['default', 'opus', 'sonnet', 'haiku']],
    ['dedicated', false, true], // shown on until written off (threadSessionsAllowed)
    ['theme', { ...structuredClone(STOCK_THEMES[1]), name: 'dusk' }, 'talos'],
    ['work.label', 'Office', 'Work systems'],
    ['work.ask_note', 'Ask Sam first.', 'Ask your IT team before connecting these.'],
    ['memory_browser', false, true],
    ['media_keep_days', 30, null],
    ['always_allow', ['email'], []],
    ['dev.thread_fence', false, true],
    ['dev.note_lookup', false, true],
    ['os_sandbox', true, false],
    ['auto_continue_at_limit', false, true],
    ['settings_lock', true, false],
  ]
  it.each(allowed)('%s is allowed', (path, value, old) => {
    expect(resolveConfigChanges([{ path, value }], config)).toEqual({
      ok: true,
      changes: [{ path, old, new: value }],
    })
  })

  it('work.thread (where work alerts land) is the one work row beyond the words the agent may set, and it must be a real thread', () => {
    const ok = resolveConfigChanges([{ path: 'work.thread', value: 'general' }], config)
    expect(ok.ok).toBe(true)
    const unknown = resolveConfigChanges([{ path: 'work.thread', value: 'nowhere' }], config)
    expect(unknown.ok).toBe(false)
    // Trust mode, the unlock rule and what is connected are still the owner's
    for (const path of ['trust_mode', 'permission_relay', 'work.enabled', 'work.retention'])
      expect(resolveConfigChanges([{ path, value: 'anything' }], config)).toEqual({ ok: false, error: refusal(path) })
  })

  const notAllowed = [
    'version',
    'rev',
    'agent',
    'owner',
    'threads',
    'notifications',
    'work',
    'work.enabled',
    'work.retention',
    'voice_notes',
    'permission_relay',
    'permission_stepup',
    'sessions_view',
    'trust_mode',
    'bug_webhook_url',
    'bug_webhook_host',
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
      'owner.display_name',
      'threads',
      'default_thread',
      'timezone',
      'quiet_window',
      'notifications.master',
      'notifications.show_thread_names',
      'voice_notes.reply_with_voice',
      'voice_notes.driving_until',
      'work.thread',
      'work.label',
      'work.ask_note',
      'session_models',
      'memory_browser',
      'media_keep_days',
      'always_allow',
      'dev.thread_fence',
      'dev.note_lookup',
      'os_sandbox',
      'auto_continue_at_limit',
      'settings_lock',
      'dedicated',
      'theme',
    ])
  })
  it('default_thread and the thread paths are allowed with a valid value (the example config has two threads)', () => {
    const base = AgentConfig.parse({
      ...defaultConfig,
      threads: [
        ...defaultConfig.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'agent',
          order: 5,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
        },
      ],
    })
    expect(resolveConfigChanges([{ path: 'default_thread', value: 'trip' }], base)).toEqual({
      ok: true,
      changes: [{ path: 'default_thread', old: 'general', new: 'trip' }],
    })
    expect(resolveConfigChanges([{ path: 'threads.trip.name', value: 'Travel' }], base)).toEqual({
      ok: true,
      changes: [{ path: 'threads.trip.name', old: 'Trip', new: 'Travel' }],
    })
  })
  it('a proposal for a field changes nothing about which fields need step-up: the agent path has no step-up of its own', () => {
    const r = resolveConfigChanges([{ path: 'permission_relay', value: true }], config)
    expect(r.ok).toBe(false)
  })
})
