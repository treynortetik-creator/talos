// The bridge half of settings parity: what ConfigFile does with each setting. `golden/settings-before.json` was captured
// from origin/main (43e9a58d) before the settings table grew its schema, label and reader columns. The same patches, loads
// and unknown fields run against the code now and must give the same answers: the same refusal code and words, the same
// value written, and the same fate for a field the bridge does not know (a newer peer's), on disk and in memory.
// Refresh only on purpose: WRITE_GOLDEN=1 bun test apps/bridge/test/settings-parity.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'

const GOLDEN = join(import.meta.dir, 'golden/settings-before.json')
const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../../../examples/config.default.json'), 'utf8'))

const VALID: Record<string, unknown> = {
  'agent.name': 'Atlas',
  'agent.voice': 'marin',
  'agent.voice_persona': 'calm',
  'owner.display_name': 'Alex Example',
  threads: defaults.threads,
  default_thread: 'general',
  timezone: 'Europe/Paris',
  quiet_window: { start: '22:00', end: '07:00' },
  'notifications.master': false,
  'notifications.show_thread_names': 'all',
  'voice_notes.reply_with_voice': 'always',
  'voice_notes.driving_until': '2999-01-01T00:00:00.000Z',
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
  version: 1,
  rev: 5,
  mirror: { telegram: 'on' },
  surprise: 1,
}
const GARBAGE: unknown[] = [5, 'x', true, false, null, [], {}, 'a'.repeat(5000), 'Not/AZone']
const SECTIONS = ['agent', 'owner', 'notifications', 'work', 'voice_notes']

const patchFor = (path: string, value: unknown): Record<string, unknown> => {
  const [top, sub] = path.split('.')
  return sub === undefined ? { [top as string]: value } : { [top as string]: { [sub]: value } }
}
const readAt = (cfg: unknown, path: string) => {
  const [top, sub] = path.split('.')
  const t = (cfg as Record<string, unknown>)[top as string]
  return sub === undefined ? t : (t as Record<string, unknown> | undefined)?.[sub]
}

function fresh(content: unknown = defaults) {
  const dir = mkdtempSync(join(tmpdir(), 'talos-settings-parity-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return { dir, path, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function applyOne(path: string, value: unknown) {
  const f = fresh()
  try {
    const file = new ConfigFile(join(f.dir, 'config.json'))
    file.load()
    const r = file.applyPatch(0, patchFor(path, value), Date.parse('2026-11-06T00:00:00Z'))
    const disk = JSON.parse(readFileSync(f.path, 'utf8'))
    return r.ok
      ? {
          ok: true,
          at: readAt(r.config, path) ?? '__absent__',
          disk_rev: disk.rev,
          disk_at: readAt(disk, path) ?? '__absent__',
        }
      : { ok: false, code: r.code, message: r.message, disk_rev: disk.rev }
  } finally {
    f.done()
  }
}

function loadWith(mutate: (c: Record<string, unknown>) => void) {
  const c = structuredClone(defaults)
  mutate(c)
  const f = fresh(c)
  try {
    const file = new ConfigFile(f.path)
    try {
      return { loads: true, config: file.load() }
    } catch (e) {
      return { loads: false, error: (e as Error).message }
    }
  } finally {
    f.done()
  }
}

function probe() {
  const out: Record<string, unknown> = {}
  for (const path of Object.keys(VALID)) {
    const entry: Record<string, unknown> = {}
    entry.apply = [VALID[path], ...GARBAGE].map((v) => ({ v, r: applyOne(path, v) }))
    entry.load_missing = (() => {
      const r = loadWith((c) => {
        const [top, sub] = path.split('.')
        if (sub === undefined) delete c[top as string]
        else delete (c[top as string] as Record<string, unknown>)[sub]
      })
      return r.loads ? { loads: true, at: readAt(r.config, path) ?? '__absent__' } : r
    })()
    entry.load_garbled = [...GARBAGE, VALID[path]].map((v) => {
      const r = loadWith((c) => {
        const [top, sub] = path.split('.')
        if (sub === undefined) c[top as string] = v
        else (c[top as string] as Record<string, unknown>)[sub] = v
      })
      return { v, r: r.loads ? { loads: true, at: readAt(r.config, path) ?? '__absent__' } : r }
    })
    out[path] = entry
  }
  for (const s of SECTIONS) out[`section:${s}`] = [{}, null, 5].map((v) => ({ v, r: applyOne(s, v) }))
  // a newer peer's unknown fields in the file: kept in memory? still on disk after the next write?
  const f = fresh({ ...defaults, future_thing: { a: 1 }, agent: { ...defaults.agent, future_key: 'x' } })
  try {
    const file = new ConfigFile(f.path)
    const cfg = file.load() as Record<string, unknown>
    const before = Object.keys(cfg).sort()
    const r = file.applyPatch(0, { agent: { name: 'Atlas' } })
    const disk = JSON.parse(readFileSync(f.path, 'utf8'))
    out.unknown_in_file = {
      loaded_top_keys: before,
      loaded_agent_key: 'future_key' in (cfg.agent as object),
      patch_ok: r.ok,
      disk_top_key: 'future_thing' in disk,
      disk_agent_key: 'future_key' in disk.agent,
    }
  } finally {
    f.done()
  }
  return out
}

const text = (o: unknown) =>
  JSON.stringify(
    o,
    (_k, v) =>
      v === undefined ? '__undefined__' : typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v,
    1,
  )

describe('settings parity (bridge): old code (golden) vs the code now', () => {
  if (process.env.WRITE_GOLDEN === '1') {
    test('writes the golden', () => writeFileSync(GOLDEN, `${text(probe())}\n`))
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
    const now = JSON.parse(text(probe())) as Record<string, unknown>
    test('covers the same settings', () => {
      expect(Object.keys(golden).length).toBeGreaterThan(30)
      expect(Object.keys(now)).toEqual(Object.keys(golden))
    })
    for (const key of Object.keys(golden))
      test(`${key}: patch, refusal, load of a missing or garbled value and unknown fields are unchanged`, () => {
        expect(now[key]).toEqual(golden[key])
      })
  }
})
