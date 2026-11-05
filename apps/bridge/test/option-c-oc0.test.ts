// Option C, WP-OC0 (docs/OPTION-C.md 9.2): the per-thread switch over config.patch. Off by default, no step-up, front
// doors refused, and the thread folder checked on the Mac (exists, a folder, under home, not ~/.claude or the data
// folder, through symlinks too).
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadSessionMode } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'

function rig() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'oc0-home-')))
  const talosHome = join(home, '.talos-app')
  mkdirSync(talosHome)
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  mkdirSync(join(home, 'Projects', 'trip'), { recursive: true })
  const p = join(talosHome, 'config.json')
  writeFileSync(p, JSON.stringify(loadExampleConfig('default')))
  const f = new ConfigFile(p, { roots: { home, talosHome } })
  const trip = {
    id: 'trip',
    name: 'Trip',
    kind: 'fixed',
    order: 5,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: '2026-10-28T00:00:00.000Z',
  }
  const withTrip = (extra: Record<string, unknown>) => ({ threads: [...f.config.threads, { ...trip, ...extra }] })
  return { home, talosHome, f, withTrip }
}

describe('OC0: the Own session switch', () => {
  test('off by default: a fresh config has no dedicated section and every thread is shared', () => {
    const { f } = rig()
    expect(f.config.dedicated).toBeUndefined()
    for (const t of f.config.threads) expect(threadSessionMode(f.config, t.id)).toBe('shared')
  })

  test('the switch and the master switch apply with no step-up', () => {
    const { f, withTrip, home } = rig()
    const r = f.applyPatch(0, {
      ...withTrip({ session: 'dedicated', session_opts: { cwd: join(home, 'Projects', 'trip') } }),
      dedicated: { enabled: true },
    })
    expect(r).toMatchObject({ ok: true })
    expect(threadSessionMode(f.config, 'trip')).toBe('dedicated')
  })

  test('general, inbox and the default thread are refused, nothing written', () => {
    const { f } = rig()
    for (const id of ['general', 'inbox']) {
      const threads = f.config.threads.map((t) => (t.id === id ? { ...t, session: 'dedicated' } : t))
      const r = f.applyPatch(f.config.rev, { threads })
      expect(r).toMatchObject({ ok: false, code: 'thread_session_refused' })
      expect(f.config.rev).toBe(0)
    }
  })

  test.each([
    ['a missing folder', (h: string) => join(h, 'nope')],
    ['a file, not a folder', (h: string) => join(h, 'Projects', 'file.txt')],
    ['~/.claude', (h: string) => join(h, '.claude', 'projects')],
    ['the data folder', (_h: string, t: string) => t],
    ['a symlink into ~/.claude', (h: string) => join(h, 'Projects', 'sneaky')],
    ['a dot-dot escape', (h: string) => `${h}/Projects/../../etc`],
  ])('a thread folder that is %s is refused', (_label, pick) => {
    const { f, withTrip, home, talosHome } = rig()
    writeFileSync(join(home, 'Projects', 'file.txt'), 'x')
    symlinkSync(join(home, '.claude'), join(home, 'Projects', 'sneaky'))
    const r = f.applyPatch(0, withTrip({ session: 'dedicated', session_opts: { cwd: pick(home, talosHome) } }))
    expect(r).toMatchObject({ ok: false })
    expect(f.config.rev).toBe(0)
  })

  test('an unchanged folder that has since vanished does not block other edits', () => {
    const { f, withTrip, home } = rig()
    const cwd = join(home, 'Projects', 'trip')
    expect(f.applyPatch(0, withTrip({ session: 'dedicated', session_opts: { cwd } })).ok).toBe(true)
    // the folder goes away; renaming the thread still works
    const threads = f.config.threads.map((t) => (t.id === 'trip' ? { ...t, name: 'Trip 2' } : t))
    rmSync(cwd, { recursive: true })
    expect(f.applyPatch(f.config.rev, { threads }).ok).toBe(true)
  })

  test('junk in a patch is refused, not silently read as off (the schema is tolerant only when reading)', () => {
    const { f, withTrip } = rig()
    expect(f.applyPatch(0, { dedicated: { max_live: 50 } })).toMatchObject({
      ok: false,
      code: 'thread_session_refused',
    })
    expect(f.applyPatch(0, withTrip({ session: 'hybrid' }))).toMatchObject({
      ok: false,
      code: 'thread_session_refused',
    })
    expect(f.applyPatch(0, withTrip({ session_opts: { model: '--channels' } }))).toMatchObject({
      ok: false,
      code: 'thread_session_refused',
    })
    expect(f.config.rev).toBe(0)
  })

  test('a hand-edited unknown session mode still loads and reads as shared', () => {
    const { f, talosHome } = rig()
    const p = join(talosHome, 'config.json')
    const c = JSON.parse(readFileSync(p, 'utf8'))
    c.threads[0].session = 'hybrid'
    writeFileSync(p, JSON.stringify(c))
    expect(new ConfigFile(p).config.threads[0]?.session).toBeUndefined()
    expect(f.config.rev).toBe(0)
  })
})
