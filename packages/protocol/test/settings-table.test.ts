import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import fiveThreadsConfig from '../../../examples/config.five-threads.json' with { type: 'json' }
import {
  AgentConfig,
  defineSettingsTable,
  SETTINGS_TABLE,
  type SettingPath,
  type SettingRow,
  type SettingsTableShape,
  settingsTableProblems,
} from '../src/index.ts'

const paths = Object.keys(SETTINGS_TABLE) as SettingPath[]

describe('the settings table', () => {
  it('trust_mode: the owner may write it from the app (the passkey rule is on turning it on), the agent never', () => {
    expect(SETTINGS_TABLE.trust_mode.phone).toBe('leaf')
    expect(SETTINGS_TABLE.trust_mode.agent).toBe(false)
    expect(SETTINGS_TABLE.trust_mode.stepupOnTrue).toBe('config:session')
  })

  it('a setting with no row does not typecheck', () => {
    const { trust_mode: _gone, ...withoutTrustMode } = SETTINGS_TABLE
    // @ts-expect-error trust_mode has no row, so this is not a settings table
    defineSettingsTable(withoutTrustMode)
    const whole: SettingsTableShape = SETTINGS_TABLE
    expect(Object.keys(whole)).toEqual(paths)
  })

  it('a default in the table is what the config schema gives a file that leaves the field out', () => {
    const minimal = {
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
    const parsed = AgentConfig.parse(minimal) as Record<string, unknown>
    for (const path of paths) {
      const row = SETTINGS_TABLE[path]
      if (path === 'threads' || path === 'default_thread' || path === 'timezone') {
        expect(row.default, path).toBeUndefined() // no schema default: init writes them
        continue
      }
      const [top, sub] = path.split('.')
      const got = sub === undefined ? parsed[top as string] : (parsed[top as string] as Record<string, unknown>)[sub]
      expect(got, path).toEqual(row.default)
    }
  })

  it('every setting the example config files set has a row', () => {
    for (const [top, v] of [...Object.entries(defaultConfig), ...Object.entries(fiveThreadsConfig)]) {
      if (top === 'version' || top === 'rev') continue
      // a top-level scalar or array is one setting of its own and needs its own row
      if (v === null || typeof v !== 'object' || Array.isArray(v)) expect(paths, top).toContain(top)
      const known = (p: string) => paths.some((x) => x === p || x.startsWith(`${p}.`))
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && top !== 'dedicated')
        for (const sub of Object.keys(v)) expect(known(`${top}.${sub}`) || known(top), `${top}.${sub}`).toBe(true)
    }
  })
})

type Rows = Record<string, Record<string, unknown>>
const copy = (): Rows => structuredClone(SETTINGS_TABLE) as unknown as Rows
const problems = (t: Rows) => settingsTableProblems(t as never)

describe('rules the table keeps so no row is silently ignored', () => {
  it("today's table breaks none of them", () => {
    expect(problems(copy())).toEqual([])
  })

  it('(a) a row beside a section row must be a section row too', () => {
    const t = copy()
    t['owner.extra'] = { phone: false, agent: false, default: 'x' } // owner is open to the phone as a whole section
    expect(problems(t).join('\n')).toMatch(/owner\.extra/)
    const u = copy()
    ;(u['agent.voice'] as Record<string, unknown>).phone = 'leaf'
    expect(problems(u).join('\n')).toMatch(/agent\.voice/)
  })

  it('(b) config:session only on a top-level row', () => {
    const t = copy()
    ;(t['work.label'] as Record<string, unknown>).stepup = 'config:session'
    expect(problems(t).join('\n')).toMatch(/work\.label/)
  })

  it('(c) config:work only on a dotted leaf row', () => {
    const top = copy()
    ;(top.timezone as Record<string, unknown>).stepup = 'config:work'
    expect(problems(top).join('\n')).toMatch(/timezone/)
    const whole = copy()
    ;(whole['agent.name'] as Record<string, unknown>).stepup = 'config:work' // a whole-section row
    expect(problems(whole).join('\n')).toMatch(/agent\.name/)
  })

  it('(d) phoneOffOnly only on a top-level row', () => {
    const t = copy()
    ;(t['work.label'] as Record<string, unknown>).phoneOffOnly = 'no'
    expect(problems(t).join('\n')).toMatch(/work\.label/)
  })

  it('the same four are type errors on a typed row', () => {
    const ok = { phone: 'leaf', agent: false, default: undefined } as const
    // @ts-expect-error config:session on a dotted path would be dropped
    const a: SettingRow<'work.label'> = { ...ok, stepup: 'config:session' }
    // @ts-expect-error config:work on a top-level row would be ignored
    const b: SettingRow<'timezone'> = { ...ok, stepup: 'config:work' }
    // @ts-expect-error phoneOffOnly on a dotted path would be skipped
    const c: SettingRow<'work.label'> = { ...ok, phoneOffOnly: 'no' }
    expect([a, b, c]).toHaveLength(3)
  })

  it('a row for a removed setting does not typecheck', () => {
    // @ts-expect-error 'gone' is not a setting, so this is not exactly one row per setting
    defineSettingsTable({ ...SETTINGS_TABLE, gone: { phone: false, agent: false, default: undefined } })
    expect(Object.keys(SETTINGS_TABLE)).toEqual(paths)
  })
})
