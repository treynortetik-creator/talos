// "Always allow" on every action kind (owner, 2026-11-21): the grantable kinds, the config trust keys, and which cards offer it.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_RULES,
  AGENT_SETTING_PATHS,
  AgentConfig,
  ALWAYS_ALLOW_2_FEATURE,
  ALWAYS_ALLOW_FEATURE,
  ALWAYS_KINDS,
  AlwaysAllowList,
  alwaysAllowed,
  alwaysKindOffered,
  CLI_FIELD_KEY,
  CONFIG_NEVER_PASS,
  CONFIG_TRUST_KEYS,
  cardOffersAlways,
  configChangesOfferAlways,
  isAlwaysKind,
  isConfigNeverPass,
  isConfigTrustPath,
  SEND_KINDS,
  THREAD_FIELD_RULES,
  THREAD_FIELDS,
} from '../src/index.ts'

const card = (over: Record<string, unknown> = {}) => ({ kind: 'generic', risk: 'low', fields: [], ...over })
const cfg = (...changes: Array<[string, unknown, unknown]>) =>
  card({
    kind: 'config',
    payload: { v: 1, base_rev: 1, reason: 'why', changes: changes.map(([path, o, n]) => ({ path, old: o, new: n })) },
  })

describe('the grantable kinds', () => {
  it('are the send kinds, generic, schedule, undo and config, and never a question or a permission card', () => {
    expect([...ALWAYS_KINDS]).toEqual([...SEND_KINDS, 'generic', 'schedule', 'undo', 'config'])
    for (const k of ['decision', 'dialog', 'permission', 'app_action', 'nonsense']) expect(isAlwaysKind(k)).toBe(false)
  })
  it('a list takes one entry of each, and refuses a kind outside', () => {
    const all = ALWAYS_KINDS.map((kind) => ({ kind, destination: null }))
    expect(AlwaysAllowList.safeParse(all).success).toBe(true)
    expect(AlwaysAllowList.safeParse([{ kind: 'decision', destination: null }]).success).toBe(false)
    expect(AlwaysAllowList.safeParse([{ kind: 'permission', destination: null }]).success).toBe(false)
  })
  it('alwaysAllowed reads the new kinds', () => {
    expect(alwaysAllowed([{ kind: 'schedule', destination: null }] as never, 'schedule')).toBe(true)
    expect(alwaysAllowed([{ kind: 'schedule', destination: null }] as never, 'undo')).toBe(false)
  })
})

describe('CONFIG_TRUST_KEYS', () => {
  it('names exactly the settings that widen what Talos does without asking', () => {
    expect([...CONFIG_TRUST_KEYS]).toEqual(['always_allow', 'settings_lock', 'dev.thread_fence', 'threads'])
  })
  it.each([
    ['always_allow', true],
    ['settings_lock', true],
    ['dev.thread_fence', true],
    ['threads', true],
    ['threads.trip', true],
    ['threads.trip.session', true],
    ['threads.trip.session_opts.cwd', true],
    ['threads.trip.mcp_allow', true],
    ['agent.name', false],
    ['dev.note_lookup', false],
    ['threadsafe', false],
  ])('%s is a trust path: %s', (path, yes) => expect(isConfigTrustPath(path)).toBe(yes))
})

describe('which cards offer Always allow', () => {
  it.each([...SEND_KINDS, 'generic', 'undo'])('a %s card does', (kind) =>
    expect(cardOffersAlways(card({ kind }))).toBe(true),
  )
  it.each(['decision', 'dialog', 'permission', 'app_action'])('a %s card does not', (kind) =>
    expect(cardOffersAlways(card({ kind }))).toBe(false),
  )
  it('a card of talos-app commands does not (a notification cannot approve it either)', () => {
    expect(cardOffersAlways(card({ fields: [{ key: CLI_FIELD_KEY }] }))).toBe(false)
  })
  it.each(['permission_mode', 'update_resend', 'screen_allow', 'peer_address'])('a %s card does not', (k) =>
    expect(cardOffersAlways(card({ kind: 'config', payload: { [k]: { x: 1 } } }))).toBe(false),
  )
  it('a rule-ask card does only with a send kind', () => {
    expect(cardOffersAlways(card({ kind: 'deploy', payload: { action_rule: { rule: 'r', kind: 'deploy' } } }))).toBe(
      true,
    )
    expect(cardOffersAlways(card({ payload: { action_rule: { rule: 'r', kind: null } } }))).toBe(false)
  })
  it('an ordinary settings card does', () => {
    expect(cardOffersAlways(cfg(['agent.name', 'Talos', 'Hal']))).toBe(true)
    expect(cardOffersAlways(cfg(['dev.note_lookup', true, false]))).toBe(true) // off only
  })
  it.each([
    'always_allow',
    'settings_lock',
    'dev.thread_fence',
    'threads.trip.model',
    'threads.trip.session',
    'default_thread',
  ])('a settings card for %s does not', (path) => expect(cardOffersAlways(cfg([path, 'a', 'b']))).toBe(false))
  it('a settings card that is high, unreadable or mixed does not', () => {
    expect(cardOffersAlways({ ...cfg(['agent.name', 'Talos', 'Hal']), risk: 'high' })).toBe(false)
    expect(cardOffersAlways(card({ kind: 'config', payload: { v: 1, changes: 3 } }))).toBe(false)
    expect(cardOffersAlways(card({ kind: 'config' }))).toBe(false)
    expect(cardOffersAlways(cfg(['agent.name', 'a', 'b'], ['settings_lock', false, true]))).toBe(false)
    expect(configChangesOfferAlways([])).toBe(false)
  })
})

describe('rows that can be made high by their value (alsoHigh)', () => {
  const config = AgentConfig.parse(defaultConfig)
  // every row with an alsoHigh, on both sides: the app (no config) refuses any change to it; the bridge judges the value
  const rows = [
    ...AGENT_SETTING_PATHS.filter((p) => AGENT_RULES[p].alsoHigh).map((p) => ({
      path: p,
      also: AGENT_RULES[p].alsoHigh,
    })),
    ...THREAD_FIELDS.filter((f) => THREAD_FIELD_RULES[f].alsoHigh).map((f) => ({
      path: `threads.trip.${f}`,
      also: THREAD_FIELD_RULES[f].alsoHigh,
    })),
  ]
  it('there are such rows', () => expect(rows.length).toBeGreaterThan(0))
  it.each(rows.map((r) => [r.path, r] as const))('%s: the app refuses any change', (path) => {
    for (const v of [null, 'off', { start: '22:00', end: '07:00' }, 'all'])
      expect(cardOffersAlways(cfg([path, 'x', v]))).toBe(false)
    expect(configChangesOfferAlways([{ path, old: null, new: null }])).toBe(false)
  })
  it('quiet_window: the bridge refuses a set, and a set is not a turn off', () => {
    const set = [{ path: 'quiet_window', old: null, new: { start: '22:00', end: '07:00' } }]
    expect(configChangesOfferAlways(set, config)).toBe(false)
    expect(cardOffersAlways(cfg(['quiet_window', null, set[0]?.new]), config)).toBe(false)
    // turning it off is low on the table; the app still refuses (it cannot tell), the bridge passes it
    expect(configChangesOfferAlways([{ path: 'quiet_window', old: set[0]?.new, new: null }], config)).toBe(true)
  })
})

describe('CONFIG_NEVER_PASS', () => {
  it('names the three ordinary settings that must keep a card', () => {
    expect(CONFIG_NEVER_PASS.map((r) => r.path)).toEqual(['memory_browser', 'dev.note_lookup', 'media_keep_days'])
  })
  it.each([
    ['memory_browser', false, true, true],
    ['memory_browser', true, false, false],
    ['dev.note_lookup', false, true, true],
    ['dev.note_lookup', true, false, false],
    ['media_keep_days', null, 30, true],
    ['media_keep_days', 60, 30, true],
    ['media_keep_days', 30, 60, false],
    ['media_keep_days', 30, null, false],
  ])('%s %s -> %s never passes: %s', (path, o, n, never) => {
    expect(isConfigNeverPass({ path, old: o, new: n })).toBe(never)
    expect(cardOffersAlways(cfg([path, o, n]))).toBe(!never)
  })
})

describe('a schedule card', () => {
  const sched = (risk: string, own?: string) => card({ kind: 'schedule', risk, payload: own ? { own_risk: own } : {} })
  it('offers Always allow only when it is low risk by its own measure, whatever trust mode made of the card risk', () => {
    expect(cardOffersAlways(sched('low', 'low'))).toBe(true)
    expect(cardOffersAlways(sched('high', 'low'))).toBe(false)
    // trust mode mints every schedule card low; the change's own risk is what counts
    expect(cardOffersAlways(sched('low', 'high'))).toBe(false)
    // an older card without it reads as high
    expect(cardOffersAlways(sched('low'))).toBe(false)
  })
})

describe('always-allow/2 (version skew)', () => {
  it('the send kinds need /1 alone; the newer kinds need /2 too', () => {
    const v1 = [ALWAYS_ALLOW_FEATURE]
    const v2 = [ALWAYS_ALLOW_FEATURE, ALWAYS_ALLOW_2_FEATURE]
    for (const k of SEND_KINDS) {
      expect(alwaysKindOffered(v1, k)).toBe(true)
      expect(alwaysKindOffered([], k)).toBe(false)
    }
    for (const k of ['generic', 'schedule', 'undo', 'config']) {
      expect(alwaysKindOffered(v1, k)).toBe(false)
      expect(alwaysKindOffered(v2, k)).toBe(true)
    }
    expect(alwaysKindOffered(undefined, 'email')).toBe(false)
  })
})
