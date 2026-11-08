// Field-by-field parity for every setting in config.json. `golden/settings-before.json` was captured from the code on
// origin/main (43e9a58d), before the settings table grew its schema, label and reader columns. This test runs the same
// questions against the code as it is now and demands the same answers, word for word: the default, whether the phone
// and the agent may write the field, the step-up it needs, the values each path accepts or refuses (wrong types and
// unknown fields included), and what loading the file does with a missing, garbled or unknown field.
// Refresh the file only on purpose: WRITE_GOLDEN=1 vitest run packages/protocol/test/settings-parity.test.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_CONFIG_ALLOWLIST,
  AGENT_CONFIG_REFUSED,
  AgentConfig,
  type AgentConfigPath,
  agentConfigPatch,
  checkConfigPatch,
  describeChange,
  readConfigPath,
  resolveConfigChanges,
  validateAgentConfig,
  verifyConfigPayload,
} from '../src/index.ts'

const GOLDEN = join(import.meta.dirname, 'golden/settings-before.json')

/** One valid value per setting, and the unknown names a newer or hostile peer might send. Written by hand. */
const VALID: Record<string, unknown> = {
  version: 1,
  rev: 1,
  'agent.name': 'Atlas',
  'agent.voice': 'marin',
  'agent.voice_persona': 'calm',
  'owner.display_name': 'Alex Example',
  threads: defaultConfig.threads,
  default_thread: 'general',
  timezone: 'Europe/Paris',
  quiet_window: { start: '22:00', end: '07:00' },
  'notifications.master': false,
  'notifications.show_thread_names': 'all',
  'voice_notes.reply_with_voice': 'always',
  'voice_notes.driving_until': '2026-11-06T10:00:00.000Z',
  'work.enabled': ['gmail'],
  'work.thread': 'general',
  'work.label': 'Work',
  'work.ask_note': 'Ask first.',
  'work.retention': 'buffer',
  permission_relay: true,
  session_models: ['default', 'opus'],
  memory_browser: false,
  dedicated: { enabled: true },
  theme: 'paper',
  trust_mode: true,
}
const UNKNOWN = ['mirror', 'surprise', 'agent.future_key', 'work.surprise', 'notifications.future', 'constructor.x']
const GARBAGE: unknown[] = [
  5,
  'x',
  true,
  false,
  null,
  [],
  {},
  'a'.repeat(5000),
  'Not/AZone',
  { start: '25:00', end: '07:00' },
]
const SECTIONS = ['agent', 'owner', 'notifications', 'work', 'voice_notes']

const patchFor = (path: string, value: unknown): Record<string, unknown> => {
  const [top, sub] = path.split('.')
  return sub === undefined ? { [top as string]: value } : { [top as string]: { [sub]: value } }
}
const base = () => structuredClone(defaultConfig) as Record<string, unknown>
const setAt = (cfg: Record<string, unknown>, path: string, value: unknown) => {
  const [top, sub] = path.split('.')
  if (sub === undefined) cfg[top as string] = value
  else (cfg[top as string] as Record<string, unknown>)[sub] = value
  return cfg
}
const delAt = (cfg: Record<string, unknown>, path: string) => {
  const [top, sub] = path.split('.')
  if (sub === undefined) delete cfg[top as string]
  else delete (cfg[top as string] as Record<string, unknown>)[sub]
  return cfg
}
const readAt = (cfg: unknown, path: string) => {
  const [top, sub] = path.split('.')
  const t = (cfg as Record<string, unknown>)[top as string]
  return sub === undefined ? t : (t as Record<string, unknown> | undefined)?.[sub]
}

/** What loading does with this file: the parsed value at `path`, or the first complaint. */
function load(cfg: Record<string, unknown>, path: string) {
  const r = AgentConfig.safeParse(cfg)
  if (!r.success) return { loads: false, at: r.error.issues[0]?.path.join('.') ?? '' }
  const issues = validateAgentConfig(r.data)
  if (issues.length) return { loads: false, structure: issues[0] }
  return { loads: true, value: readAt(r.data, path) ?? '__absent__' }
}

const current = AgentConfig.parse(defaultConfig)
const allPaths = [...Object.keys(VALID), ...UNKNOWN]
const values = (path: string): unknown[] => (path in VALID ? [VALID[path], ...GARBAGE] : [1, 'x', null])

function probe() {
  const out: Record<string, unknown> = {}
  // default: what a file that leaves the field out parses to (sections are given as empty objects, as an older file has them)
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
  const minimalParsed = AgentConfig.parse(minimal)
  for (const path of Object.keys(VALID)) {
    const entry: Record<string, unknown> = {}
    entry.default = readAt(minimalParsed, path) ?? '__absent__'
    entry.phone = values(path).map((v) => ({ v, r: checkConfigPatch(patchFor(path, v)) }))
    entry.load_missing = load(delAt(base(), path), path)
    entry.load_values = values(path).map((v) => ({ v, r: load(setAt(base(), path, v), path) }))
    if (path in VALID) {
      entry.agent = values(path).map((v) => ({
        v,
        propose: resolveConfigChanges([{ path, value: v }], current),
        card: verifyConfigPayload(
          { v: 1, base_rev: 0, reason: 'r', changes: [{ path, old: readConfigSafe(path), new: v }] },
          current,
        ),
      }))
    }
    out[path] = entry
  }
  for (const path of UNKNOWN) {
    out[path] = {
      phone: [1, 'x', null].map((v) => ({ v, r: checkConfigPatch(patchFor(path, v)) })),
      agent: [resolveConfigChanges([{ path, value: 'x' }], current)],
    }
  }
  // sections themselves: a whole-section patch, and null (which would delete the section)
  for (const s of SECTIONS)
    out[`section:${s}`] = [{}, null, 5, { surprise: 1 }].map((v) => ({ v, r: checkConfigPatch({ [s]: v }) }))
  // lists the app and the agent read
  out.lists = {
    agent_allowlist: [...AGENT_CONFIG_ALLOWLIST],
    agent_refused: [...AGENT_CONFIG_REFUSED],
    card_lines: AGENT_CONFIG_ALLOWLIST.map((p) =>
      describeChange({ path: p, old: readConfigPath(current, p), new: validFor(p) }),
    ),
    read_default: AGENT_CONFIG_ALLOWLIST.map((p) => readConfigPath(current, p)),
    patch_for_all: agentConfigPatch(AGENT_CONFIG_ALLOWLIST.map((p) => ({ path: p, new: validFor(p) }))),
  }
  // unknown fields from a newer peer: top level, and one inside every section
  const future = base()
  future.future_thing = { a: 1 }
  for (const s of SECTIONS) (future[s] as Record<string, unknown>).future_key = 'kept?'
  const parsed = AgentConfig.parse(future) as Record<string, unknown>
  out.unknown_from_newer_peer = {
    top_level_kept: 'future_thing' in parsed,
    kept_in_section: Object.fromEntries(SECTIONS.map((s) => [s, 'future_key' in (parsed[s] as object)])),
    top_keys: Object.keys(parsed).sort(),
  }
  return out
}
function readConfigSafe(path: string) {
  return AGENT_CONFIG_ALLOWLIST.includes(path as AgentConfigPath)
    ? readConfigPath(current, path as AgentConfigPath)
    : null
}
function validFor(p: AgentConfigPath) {
  return p === 'quiet_window' ? { start: '22:00', end: '07:00' } : p === 'agent.name' ? 'Atlas' : VALID[p]
}

const text = (o: unknown) =>
  JSON.stringify(
    o,
    (_k, v) =>
      v === undefined ? '__undefined__' : typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v,
    1,
  )

describe('settings parity: old code (golden) vs the code now', () => {
  if (process.env.WRITE_GOLDEN === '1') {
    it('writes the golden', () => writeFileSync(GOLDEN, `${text(probe())}\n`))
    return
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
  const now = JSON.parse(text(probe())) as Record<string, unknown>

  it('covers every setting the config file has', () => {
    expect(Object.keys(golden).length).toBeGreaterThan(30)
    expect(Object.keys(now)).toEqual(Object.keys(golden))
  })
  for (const key of allPaths) {
    it(`${key}: default, phone, agent, step-up, load and value rules are unchanged`, () => {
      expect(now[key]).toEqual(golden[key])
    })
  }
  for (const key of ['lists', 'unknown_from_newer_peer', ...SECTIONS.map((s) => `section:${s}`)]) {
    it(`${key}: unchanged`, () => expect(now[key]).toEqual(golden[key]))
  }
})
