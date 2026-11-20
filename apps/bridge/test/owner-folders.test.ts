// Folder trust is pre-accepted only for a folder the OWNER chose (supervisor/owner-folders.ts): a signed config.patch from the app
// makes the record; `talos-app lead init`, a hand edit and a patch that only echoes a folder back never do.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'
import { configFrames } from '../src/inbound-config.ts'
import { cmdLead } from '../src/lead/cli.ts'
import { ownerChose, ownerFoldersPath, readOwnerFolders, recordOwnerFolders } from '../src/supervisor/owner-folders.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), p)))
  made.push(d)
  return d
}
const t = (id: string, cwd?: string) => ({ id, ...(cwd !== undefined ? { session_opts: { cwd } } : {}) })

describe('the record (unit)', () => {
  test('a folder a patch SET is the owner’s; its real path is kept; the file is 0600 JSON', () => {
    const home = tmp('talos-bridge-test-of-home-')
    const trip = join(home, 'trip')
    mkdirSync(trip)
    recordOwnerFolders(home, [t('trip')], [t('trip', trip)], [{ id: 'trip', session_opts: { cwd: trip } }])
    expect(readOwnerFolders(home)).toEqual({ trip: { cwd: trip, real: trip } })
    expect(ownerChose(home, ['trip'], trip, trip)).toBe(true)
    expect(JSON.parse(readFileSync(ownerFoldersPath(home), 'utf8')).v).toBe(1)
  })
  test('an echo of a folder the patch did not change makes no record (an agent’s folder is not laundered by Settings)', () => {
    const home = tmp('talos-bridge-test-of-home-')
    const trip = join(home, 'trip')
    mkdirSync(trip)
    // `lead init` set it; the owner’s later patch names it again unchanged
    recordOwnerFolders(home, [t('trip', trip)], [t('trip', trip)], [{ id: 'trip', session_opts: { cwd: trip } }])
    expect(readOwnerFolders(home)).toEqual({})
    expect(ownerChose(home, ['trip'], trip, trip)).toBe(false)
  })
  test('a later change of folder leaves the old record with nothing to match; an old one is kept while it still matches', () => {
    const home = tmp('talos-bridge-test-of-home-')
    const a = join(home, 'a')
    const b = join(home, 'b')
    mkdirSync(a)
    mkdirSync(b)
    recordOwnerFolders(home, [], [t('trip', a)], [{ id: 'trip', session_opts: { cwd: a } }])
    // an unrelated patch: kept
    recordOwnerFolders(home, [t('trip', a)], [t('trip', a)], [])
    expect(ownerChose(home, ['trip'], a, a)).toBe(true)
    // `lead init` (no signed patch, so no call here) moves it to b: the record says a, so b is not the owner's
    expect(ownerChose(home, ['trip'], b, b)).toBe(false)
    // and the next signed patch, which does not name the folder, drops the stale record
    recordOwnerFolders(home, [t('trip', b)], [t('trip', b)], [])
    expect(readOwnerFolders(home)).toEqual({})
  })
  test('the folder must still resolve to what it did: a link swapped in afterwards is not the owner’s choice', () => {
    const home = tmp('talos-bridge-test-of-home-')
    const a = join(home, 'a')
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(a)
    mkdirSync(elsewhere)
    recordOwnerFolders(home, [], [t('trip', a)], [{ id: 'trip', session_opts: { cwd: a } }])
    rmSync(a, { recursive: true })
    symlinkSync(elsewhere, a)
    expect(ownerChose(home, ['trip'], a, elsewhere)).toBe(false)
  })
  test('a sub-thread sharing its parent’s folder is judged by the parent’s record; a missing, broken or linked file is no record', () => {
    const home = tmp('talos-bridge-test-of-home-')
    const a = join(home, 'a')
    mkdirSync(a)
    recordOwnerFolders(home, [], [t('proj', a)], [{ id: 'proj', session_opts: { cwd: a } }])
    expect(ownerChose(home, ['sub', 'proj'], a, a)).toBe(true)
    expect(ownerChose(home, ['sub'], a, a)).toBe(false)
    writeFileSync(ownerFoldersPath(home), '{ nope')
    expect(readOwnerFolders(home)).toEqual({})
    rmSync(ownerFoldersPath(home))
    writeFileSync(join(home, 'elsewhere.json'), JSON.stringify({ v: 1, threads: { proj: { cwd: a, real: a } } }))
    symlinkSync(join(home, 'elsewhere.json'), ownerFoldersPath(home))
    expect(readOwnerFolders(home)).toEqual({})
  })
})

describe('who writes it', () => {
  const thread = (extra: Record<string, unknown>) => ({
    id: 'trip',
    name: 'Trip',
    kind: 'fixed',
    order: 5,
    notify: 'all',
    archived: false,
    created_at: '2026-10-28T00:00:00.000Z',
    session: 'dedicated',
    ...extra,
  })
  /** The real handler of a signed config.patch (inbound-config.ts) on a real ConfigFile, the rest stubbed. */
  function rig() {
    const userHome = tmp('talos-bridge-test-of-user-')
    const talosHome = join(userHome, '.talos')
    for (const d of [
      talosHome,
      join(userHome, '.claude'),
      join(userHome, 'work', 'chosen'),
      join(userHome, 'work', 'lead'),
      join(userHome, 'work', 'edited'),
    ])
      mkdirSync(d, { recursive: true })
    const cfgPath = join(talosHome, 'config.json')
    const base = loadExampleConfig('default')
    writeFileSync(
      cfgPath,
      JSON.stringify({ ...base, dedicated: { enabled: true }, threads: [...base.threads, thread({})] }),
      { mode: 0o600 },
    )
    const config = new ConfigFile(cfgPath, { roots: { home: userHome, talosHome }, log: { warn() {} } })
    config.load()
    const noop = () => {}
    const log = { debug: noop, info: noop, warn: noop, error: noop, security: noop }
    const rejected: string[] = []
    const ctx = {
      config,
      log,
      clock: { now: () => Date.now() },
      paths: { home: talosHome, inbox: join(userHome, '.inbox') },
      permission: { reconcile: noop },
      emit: async () => {},
      defaultThread: 'general',
    }
    const self = {
      ctx,
      fire: noop,
      done: noop,
      reject: (_: unknown, code: string, msg: string) => void rejected.push(`${code}: ${msg}`),
    }
    const patch = async (cwd: string) => {
      const threads = config.config.threads.map((x) =>
        x.id === 'trip' ? { ...x, session_opts: { ...(x.session_opts ?? {}), cwd } } : x,
      )
      await configFrames.onConfigPatch.call(
        self as never,
        { raw: { patch: { threads } } } as never,
        { base_rev: config.config.rev } as never,
      )
    }
    return { userHome, talosHome, cfgPath, config, patch, rejected }
  }

  test('an owner-signed config.patch that sets the folder is recorded; lead init by an agent is not; a hand edit is not', async () => {
    const r = rig()
    const chosen = join(r.userHome, 'work', 'chosen')
    const leadFolder = join(r.userHome, 'work', 'lead')
    const edited = join(r.userHome, 'work', 'edited')
    // 1. the app's signed patch goes through the real handler
    await r.patch(chosen)
    expect(r.rejected).toEqual([])
    expect(ownerChose(r.talosHome, ['trip'], chosen, chosen)).toBe(true)
    // 2. `talos-app lead init trip --folder <other>`: written through the config file with no signature
    const agentDir = tmp('talos-bridge-test-of-agent-')
    writeFileSync(join(agentDir, '.talos-version'), '1')
    const lines: string[] = []
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`), isTerminal: true }
    const code = cmdLead(
      { home: r.talosHome } as never,
      ['init', 'trip', '--folder', leadFolder, '--agent-dir', agentDir],
      io,
      {
        home: r.userHome,
        claudeDir: join(r.userHome, '.claude'),
        pathDirs: [],
      },
    )
    const cwd = () =>
      JSON.parse(readFileSync(r.cfgPath, 'utf8')).threads.find((x: { id: string }) => x.id === 'trip')?.session_opts
        ?.cwd
    expect(cwd(), `${code} ${lines.join('|')}`).toBe(leadFolder)
    expect(ownerChose(r.talosHome, ['trip'], leadFolder, leadFolder)).toBe(false) // no pre-accept: the card shows the folder
    expect(ownerChose(r.talosHome, ['trip'], chosen, chosen)).toBe(true) // the old record names the old folder only
    // 3. a hand edit of config.json
    const raw = JSON.parse(readFileSync(r.cfgPath, 'utf8'))
    for (const x of raw.threads) if (x.id === 'trip') x.session_opts = { ...x.session_opts, cwd: edited }
    writeFileSync(r.cfgPath, JSON.stringify(raw))
    expect(ownerChose(r.talosHome, ['trip'], edited, edited)).toBe(false)
  })

  test('the owner’s signed patch that echoes an agent’s folder back does not make it the owner’s', async () => {
    const r = rig()
    const leadFolder = join(r.userHome, 'work', 'lead')
    r.config.update((c) => ({
      ...c,
      threads: c.threads.map((x) => (x.id === 'trip' ? ({ ...x, session_opts: { cwd: leadFolder } } as typeof x) : x)),
    }))
    await r.patch(leadFolder) // Settings sends back what it last saw
    expect(r.rejected).toEqual([])
    expect(ownerChose(r.talosHome, ['trip'], leadFolder, leadFolder)).toBe(false)
  })
})
