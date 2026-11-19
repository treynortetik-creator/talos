// The thread-sessions switch is shown on for a config that never wrote it (the owner, 2026-11-19). What the bridge WRITES makes
// that real: the first thread turned on writes `dedicated.enabled: true`, so the Mac app (which reads a missing switch as off)
// starts that thread's session, and only that one: threads left dedicated from before, shown off, go back to shared.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadSessionMode } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

function file(threads: unknown[], dedicated?: unknown) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ts-default-on-'))
  made.push(dir)
  const { dedicated: _d, ...cfg } = loadExampleConfig('default') as Record<string, unknown> & { threads: unknown[] }
  const path = join(dir, 'config.json')
  writeFileSync(
    path,
    JSON.stringify({ ...cfg, threads: [...cfg.threads, ...threads], ...(dedicated ? { dedicated } : {}) }),
    { mode: 0o600 },
  )
  const f = new ConfigFile(path, { roots: { home: dir, talosHome: dir }, log: { warn() {} } })
  f.load()
  return { f, disk: () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any> }
}
/** The whole list as the app sends it (ids, places, only what changed): `change` for the thread named. */
const list = (f: ConfigFile, id: string, change: Record<string, unknown>) =>
  f.config.threads.map((t) => ({ id: t.id, order: t.order, ...(t.id === id ? change : {}) }))
const session = (d: Record<string, any>, id: string) => d.threads.find((t: { id: string }) => t.id === id)?.session

describe('a config that never wrote the thread-sessions switch', () => {
  test('turning a thread on writes the switch on: that thread is routed to its own session', () => {
    const { f, disk } = file([thread('trip'), thread('garden')])
    expect(disk().dedicated).toBeUndefined()
    const r = f.applyPatch(f.config.rev, { threads: list(f, 'trip', { session: 'dedicated' }) })
    expect(r).toMatchObject({ ok: true })
    expect(disk().dedicated?.enabled).toBe(true)
    expect(threadSessionMode(f.config, 'trip')).toBe('dedicated')
    expect(threadSessionMode(f.config, 'garden')).toBe('shared')
  })

  test('a thread left on its own session (it never ran) reads shared, and is written so with the next change', () => {
    const { f, disk } = file([thread('trip'), thread('research', { session: 'dedicated' })])
    expect(f.config.threads.find((t) => t.id === 'research')?.session).toBe('shared')
    expect(f.applyPatch(f.config.rev, { threads: list(f, 'trip', { name: 'Trip' }) }).ok).toBe(true)
    expect(session(disk(), 'research')).toBe('shared')
    expect(disk().dedicated).toBeUndefined()
  })

  // review finding 1: the agent's card sends every thread whole (agentConfigPatch), session included
  test("an agent's change that sends every thread whole starts no leftover", () => {
    const { f, disk } = file([thread('trip'), thread('research', { session: 'dedicated' })])
    const whole = f.config.threads.map((t) => (t.id === 'trip' ? { ...t, topic: 'Flights' } : t))
    expect(f.applyPatch(f.config.rev, { threads: whole }, Date.now(), { agent: true }).ok).toBe(true)
    expect(disk().dedicated).toBeUndefined()
    expect(session(disk(), 'research')).toBe('shared')
    expect(threadSessionMode(f.config, 'research')).toBe('shared')
  })

  test("an agent's card turning a thread on writes the switch the same way", () => {
    const { f, disk } = file([thread('trip')])
    const whole = f.config.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'dedicated' as const } : t))
    expect(f.applyPatch(f.config.rev, { threads: whole }, Date.now(), { agent: true }).ok).toBe(true)
    expect(disk().dedicated?.enabled).toBe(true)
    expect(threadSessionMode(f.config, 'trip')).toBe('dedicated')
  })

  test('a tool turning a thread on through update() writes it too', () => {
    const { f, disk } = file([thread('trip')])
    f.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'dedicated' as const } : t)),
    }))
    expect(disk().dedicated?.enabled).toBe(true)
  })

  test('an edit that turns nothing on writes no switch', () => {
    const { f, disk } = file([thread('trip')])
    expect(f.applyPatch(f.config.rev, { threads: list(f, 'trip', { name: 'Trip' }) }).ok).toBe(true)
    expect(disk().dedicated).toBeUndefined()
  })

  test('general and inbox are still refused, and write nothing', () => {
    const { f, disk } = file([])
    const r = f.applyPatch(f.config.rev, { threads: list(f, 'general', { session: 'dedicated' }) })
    expect(r.ok).toBe(false)
    expect(disk().dedicated).toBeUndefined()
  })

  // review finding 2: off, then on again
  test('turning the switch off and on again starts no leftover', () => {
    const { f, disk } = file([thread('research', { session: 'dedicated' })])
    expect(f.applyPatch(f.config.rev, { dedicated: { enabled: false } }).ok).toBe(true)
    expect(disk().dedicated?.enabled).toBe(false)
    expect(f.applyPatch(f.config.rev, { dedicated: { enabled: true } }).ok).toBe(true)
    expect(disk().dedicated?.enabled).toBe(true)
    expect(session(disk(), 'research')).toBe('shared')
    expect(threadSessionMode(f.config, 'research')).toBe('shared')
  })

  test('a hand edit that sets a thread on its own session with no switch reads shared', () => {
    const { f, disk } = file([thread('trip')])
    const d = disk()
    const path = (f as unknown as { path: string }).path
    writeFileSync(
      path,
      JSON.stringify({
        ...d,
        threads: d.threads.map((t: { id: string }) => (t.id === 'trip' ? { ...t, session: 'dedicated' } : t)),
      }),
    )
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    f.reloadIfChanged()
    expect(threadSessionMode(f.config, 'trip')).toBe('shared')
    expect(session(disk(), 'trip')).toBe('shared')
  })
})

test('a switch written off stays off when a thread is turned on', () => {
  const { f, disk } = file([thread('trip')], { enabled: false })
  expect(f.applyPatch(f.config.rev, { threads: list(f, 'trip', { session: 'dedicated' }) }).ok).toBe(true)
  expect(disk().dedicated?.enabled).toBe(false)
  expect(threadSessionMode(f.config, 'trip')).toBe('shared')
})
