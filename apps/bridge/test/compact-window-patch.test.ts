// The owner's `config.patch` for a thread's compact_window (session_opts): the strict check on write, in the bridge's own store.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const trip = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
}
function file() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'compact-window-'))
  made.push(dir)
  const cfg = loadExampleConfig('default')
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ ...cfg, threads: [...cfg.threads, trip], dedicated: { enabled: true } }),
    { mode: 0o600 },
  )
  const f = new ConfigFile(join(dir, 'config.json'), { roots: { home: dir, talosHome: dir }, log: { warn() {} } })
  f.load()
  return f
}
const threadsWith = (f: ConfigFile, session_opts: unknown) =>
  f.config.threads.map((t) => (t.id === 'trip' ? { ...t, session_opts } : t))
const tripOpts = (f: ConfigFile) => f.config.threads.find((t) => t.id === 'trip')?.session_opts

describe('config.patch with session_opts.compact_window', () => {
  test('100000 to 1000000 is written as it is; null and absent are unset', () => {
    const f = file()
    for (const compact_window of [100000, 400000, 1000000]) {
      const r = f.applyPatch(f.config.rev, { threads: threadsWith(f, { compact_window }) })
      expect(r.ok, String(compact_window)).toBe(true)
      expect(tripOpts(f)?.compact_window).toBe(compact_window)
    }
    expect(f.applyPatch(f.config.rev, { threads: threadsWith(f, { compact_window: null }) }).ok).toBe(true)
    expect(tripOpts(f)?.compact_window).toBeUndefined()
    expect(f.applyPatch(f.config.rev, { threads: threadsWith(f, {}) }).ok).toBe(true)
  })
  test('too small, too big, fractional and text are refused in words and nothing is written', () => {
    const f = file()
    const rev = f.config.rev
    for (const compact_window of [0, 99999, 1000001, 400000.5, '400000', '400k', 'auto']) {
      const r = f.applyPatch(rev, { threads: threadsWith(f, { compact_window }) })
      expect(r.ok, String(compact_window)).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('thread_session_refused')
        expect(r.message).toMatch(/those session settings are not valid/)
      }
    }
    expect(f.config.rev).toBe(rev)
    expect(tripOpts(f)?.compact_window).toBeUndefined()
  })
})
