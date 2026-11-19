// Folder trust answered by the owner's own choice of folder (folder-trust.ts): what it writes, what it refuses, a concurrent writer,
// and the planner's use of it. Temp folders only; the config file is a stand-in for Claude Code's `.claude.json`.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCK_DELAYS_MS,
  preAcceptFolderTrust,
  TRUST_WRITE_TRIES,
  trustConfigFile,
  trustRefusal,
} from '../../src/supervisor/folder-trust.ts'
import { recordOwnerFolders } from '../../src/supervisor/owner-folders.ts'
import { PYTHON_RULES } from '../../src/supervisor/worker-hook.ts'
import { fsProbe } from '../../src/supervisor/worker-policy.ts'
import { workerPlanner } from '../../src/supervisor/workers-wiring.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

afterAll(cleanupReleases)
const saved = { ...PYTHON_RULES }
beforeEach(() => Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 }))
afterEach(() => Object.assign(PYTHON_RULES, saved))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A home with the agent folder, the Talos home, a thread folder, and a Claude Code config holding other keys. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-bridge-test-trust-')))
  dirs.push(root)
  const home = join(root, 'home')
  const agentDir = join(home, 'agent')
  const talosHome = join(home, '.talos')
  const trip = join(home, 'work', 'trip')
  for (const d of [agentDir, talosHome, trip, join(home, '.claude')]) mkdirSync(d, { recursive: true })
  const configFile = trustConfigFile(home)
  const original = {
    numStartups: 7,
    userID: 'not-a-real-id',
    projects: {
      [agentDir]: { hasTrustDialogAccepted: true, allowedTools: ['Read'], lastCost: 1.5 },
      [join(home, 'other')]: { hasTrustDialogAccepted: false, mcpServers: { a: { command: 'x' } } },
    },
    tipsHistory: { one: 3 },
  }
  writeFileSync(configFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 })
  const input = (o: Partial<Parameters<typeof preAcceptFolderTrust>[0]> = {}) => ({
    configFile,
    folder: trip,
    chosen: [trip],
    home,
    talosHome,
    agentDir,
    ...o,
  })
  type Cfg = { projects: Record<string, unknown>; [k: string]: unknown }
  const read = () => JSON.parse(readFileSync(configFile, 'utf8')) as Cfg
  return {
    root,
    home,
    agentDir,
    talosHome,
    trip,
    configFile,
    original,
    input,
    read,
    bytes: () => readFileSync(configFile, 'utf8'),
  }
}

describe('what a pre-accept writes', () => {
  it('exactly the thread folder’s own key; every other key is what it was; the mode and the file’s newline stay', () => {
    const w = world()
    chmodSync(w.configFile, 0o640)
    expect(preAcceptFolderTrust(w.input())).toEqual({ ok: true, wrote: true })
    const now = w.read()
    expect(now.projects[w.trip as keyof typeof now.projects]).toEqual({ hasTrustDialogAccepted: true })
    // the same file with that one project entry taken out is the original with it taken out
    const strip = (c: typeof now) => {
      const { [w.trip as keyof typeof c.projects]: _gone, ...rest } = c.projects
      return { ...c, projects: rest }
    }
    expect(strip(now)).toEqual(w.original)
    expect(Object.keys(now.projects).sort()).toEqual([...Object.keys(w.original.projects), w.trip].sort())
    expect(statSync(w.configFile).mode & 0o777).toBe(0o640)
    expect(w.bytes().endsWith('\n')).toBe(true)
    // no temp file left beside it
    expect(readdirSync(w.home).filter((n) => n.startsWith('.claude.json.tmp.'))).toEqual([])
  })
  it('a folder that already has an entry keeps its other keys and only gains the one; an accepted one is not rewritten', () => {
    const w = world()
    const cfg = w.read()
    ;(cfg.projects as Record<string, unknown>)[w.trip] = {
      allowedTools: ['Bash'],
      hasTrustDialogAccepted: false,
      lastCost: 2,
    }
    writeFileSync(w.configFile, JSON.stringify(cfg))
    expect(preAcceptFolderTrust(w.input())).toEqual({ ok: true, wrote: true })
    expect((w.read().projects as Record<string, unknown>)[w.trip]).toEqual({
      allowedTools: ['Bash'],
      hasTrustDialogAccepted: true,
      lastCost: 2,
    })
    const ino = statSync(w.configFile).ino
    expect(preAcceptFolderTrust(w.input())).toEqual({ ok: true, wrote: false })
    expect(statSync(w.configFile).ino).toBe(ino) // not replaced
  })
  it('a config that is a link (dotfiles) is written where it is, and stays a link', () => {
    const w = world()
    const real = join(w.root, 'dotfiles.json')
    writeFileSync(real, readFileSync(w.configFile))
    rmSync(w.configFile)
    symlinkSync(real, w.configFile)
    expect(preAcceptFolderTrust(w.input())).toEqual({ ok: true, wrote: true })
    expect(JSON.parse(readFileSync(real, 'utf8')).projects[w.trip].hasTrustDialogAccepted).toBe(true)
    expect(statSync(w.configFile).isFile()).toBe(true)
    expect(readFileSync(w.configFile, 'utf8')).toBe(readFileSync(real, 'utf8'))
  })
})

describe('what it refuses, with the config left as it was', () => {
  const refused = (w: ReturnType<typeof world>, o: Parameters<typeof w.input>[0], why: RegExp) => {
    const before = w.bytes()
    const r = preAcceptFolderTrust(w.input(o))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toMatch(why)
    expect(w.bytes()).toBe(before)
    expect(readdirSync(w.home).filter((n) => n.startsWith('.claude.json.tmp.'))).toEqual([])
  }
  it('a parent of the chosen folder, the home folder, a folder above it, and /', () => {
    const w = world()
    refused(w, { folder: join(w.home, 'work') }, /not one the owner chose/) // the parent: not the chosen folder
  })
  it('$HOME, a folder holding $HOME, and / are refused even when the owner “chose” them', () => {
    const w = world()
    for (const f of [w.home, w.root, '/']) refused(w, { folder: f, chosen: [f] }, /inside the home folder/)
  })
  it('a folder that holds the agent folder or the Talos data, or sits in them or in ~/.claude', () => {
    const w = world()
    refused(w, { folder: w.agentDir, chosen: [w.agentDir] }, /agent folder/)
    refused(w, { folder: w.talosHome, chosen: [w.talosHome] }, /Talos data/)
    const inside = join(w.talosHome, 'workers')
    mkdirSync(inside, { recursive: true })
    refused(w, { folder: inside, chosen: [inside] }, /Talos data/)
    refused(w, { folder: join(w.home, '.claude'), chosen: [join(w.home, '.claude')] }, /~\/\.claude/)
  })
  it('a symlink to a parent: the folder named is a link, or the configured folder is a link into its own parent', () => {
    const w = world()
    // the session would launch in the real folder; the link as the folder is not its own real path
    const toHome = join(w.home, 'work', 'toHome')
    symlinkSync(w.home, toHome)
    refused(w, { folder: toHome, chosen: [toHome] }, /real path|inside the home/)
    // a configured "trip/up" that leads to its own parent "work": the real path is work, written under work
    const up = join(w.home, 'work', 'up')
    symlinkSync(join(w.home, 'work'), up)
    refused(w, { folder: join(w.home, 'work'), chosen: [up] }, /link into its own parent/)
    // a link to $HOME as the configured folder: refused as the home folder
    refused(w, { folder: w.home, chosen: [toHome] }, /inside the home folder/)
  })
  it('a folder the owner did not choose for a thread (a path outside the chosen set, a lookalike, a relative path)', () => {
    const w = world()
    const elsewhere = join(w.home, 'elsewhere')
    mkdirSync(elsewhere)
    refused(w, { folder: elsewhere }, /not one the owner chose/)
    refused(w, { folder: w.trip, chosen: [] }, /not one the owner chose/)
    refused(w, { folder: w.trip, chosen: ['trip', `${w.trip}/..`] }, /not one the owner chose/)
    refused(w, { folder: `${w.trip}/` + '.' }, /plain absolute path/)
    refused(w, { folder: 'work/trip' }, /plain absolute path/)
    refused(w, { folder: join(w.home, 'gone'), chosen: [join(w.home, 'gone')] }, /does not exist/)
  })
  it('a chosen link to the folder is fine when it is not into its own parent (its real path is what is trusted)', () => {
    const w = world()
    const alias = join(w.home, 'alias')
    symlinkSync(w.trip, alias)
    expect(trustRefusal(w.input({ chosen: [alias] }))).toBeNull()
    expect(preAcceptFolderTrust(w.input({ chosen: [alias] }))).toEqual({ ok: true, wrote: true })
    expect(Object.keys(w.read().projects)).toContain(w.trip)
    expect(Object.keys(w.read().projects)).not.toContain(alias)
  })
  it('a config that is missing, not JSON, or the wrong shape is left alone and said', () => {
    const w = world()
    const good = w.bytes()
    for (const [bad, why] of [
      ['{ not json', /not valid JSON/],
      ['[1,2]', /not a JSON object/],
      [JSON.stringify({ projects: [] }), /projects is not an object/],
      [JSON.stringify({ projects: { [w.trip]: 5 } }), /entry .* is not an object/],
    ] as const) {
      writeFileSync(w.configFile, bad)
      refused(w, {}, why)
    }
    rmSync(w.configFile)
    const r = preAcceptFolderTrust(w.input())
    expect(r).toMatchObject({ ok: false })
    expect(existsSync(w.configFile)).toBe(false) // never created from nothing
    writeFileSync(w.configFile, good)
  })
})

describe('a concurrent writer', () => {
  it('a change between the read and the rename is kept: the write starts over on what is there now', () => {
    const w = world()
    let hits = 0
    const r = preAcceptFolderTrust(w.input(), () => {
      if (hits++ > 0) return
      // Claude Code rewrites its own file: a new top-level key and a changed project entry land after our read
      const cfg = w.read() as Record<string, unknown>
      cfg.numStartups = 8
      cfg.addedByClaude = { x: 1 }
      writeFileSync(w.configFile, `${JSON.stringify(cfg, null, 2)}\n`)
    })
    expect(r).toEqual({ ok: true, wrote: true })
    expect(hits).toBe(2)
    const now = w.read() as Record<string, unknown> & { projects: Record<string, { hasTrustDialogAccepted?: boolean }> }
    expect(now.numStartups).toBe(8)
    expect(now.addedByClaude).toEqual({ x: 1 })
    expect(now.projects[w.trip]?.hasTrustDialogAccepted).toBe(true)
    expect(readdirSync(w.home).filter((n) => n.startsWith('.claude.json.tmp.'))).toEqual([])
  })
  it('a writer that never lets up: not recorded, said, the writer’s file intact and no temp file left', () => {
    const w = world()
    let n = 0
    const r = preAcceptFolderTrust(w.input(), () => {
      const cfg = w.read() as Record<string, unknown>
      cfg.numStartups = 100 + n++
      writeFileSync(w.configFile, JSON.stringify(cfg))
    })
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('kept changing') })
    expect(n).toBe(TRUST_WRITE_TRIES)
    expect((w.read() as Record<string, unknown>).numStartups).toBe(100 + n - 1)
    expect(readdirSync(w.home).filter((x) => x.startsWith('.claude.json.tmp.'))).toEqual([])
  })
  it('two pre-accepts for two folders, back to back, both keys are there', () => {
    const w = world()
    const two = join(w.home, 'work', 'two')
    mkdirSync(two)
    expect(preAcceptFolderTrust(w.input())).toMatchObject({ ok: true })
    expect(preAcceptFolderTrust(w.input({ folder: two, chosen: [two] }))).toMatchObject({ ok: true })
    const keys = Object.keys(w.read().projects)
    expect(keys).toContain(w.trip)
    expect(keys).toContain(two)
  })
})

describe('Claude Code’s own lock (<config file>.lock, proper-lockfile: a folder made by mkdir)', () => {
  const lockOf = (w: ReturnType<typeof world>) => `${w.configFile}.lock`
  it('the write is made while that lock is held, and it is gone after (success, refusal and failure alike)', () => {
    const w = world()
    let seen = false
    expect(
      preAcceptFolderTrust(w.input(), () => {
        seen = existsSync(lockOf(w)) && statSync(lockOf(w)).isDirectory()
      }),
    ).toEqual({ ok: true, wrote: true })
    expect(seen).toBe(true)
    expect(existsSync(lockOf(w))).toBe(false)
    writeFileSync(w.configFile, '{ broken')
    expect(preAcceptFolderTrust(w.input({ folder: join(w.home, 'work') }))).toMatchObject({ ok: false }) // refused before the lock
    expect(preAcceptFolderTrust(w.input())).toMatchObject({ ok: false }) // a config that cannot be read: refused under it
    expect(existsSync(lockOf(w))).toBe(false)
  })
  it('a lock Claude Code holds is waited for, never taken: the write goes on once it lets go', () => {
    const w = world()
    mkdirSync(lockOf(w))
    const waits: number[] = []
    const r = preAcceptFolderTrust(w.input(), undefined, (ms) => {
      waits.push(ms)
      if (waits.length === 3) rmdirSync(lockOf(w)) // Claude Code finishes its save
    })
    expect(r).toEqual({ ok: true, wrote: true })
    expect(waits).toHaveLength(3)
    expect(Object.keys(w.read().projects)).toContain(w.trip)
  })
  it('a lock that never lets go: not written, said, the config as it was, and the lock left exactly as it was (never stolen)', () => {
    const w = world()
    mkdirSync(lockOf(w))
    const old = new Date(Date.now() - 3_600_000) // even one that looks stale (Claude Code’s own rule is 10 s) is not ours to remove
    utimesSync(lockOf(w), old, old)
    const before = w.bytes()
    const waits: number[] = []
    const r = preAcceptFolderTrust(w.input(), undefined, (ms) => waits.push(ms))
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('its lock is held') })
    expect(waits).toHaveLength(LOCK_DELAYS_MS.length)
    expect(w.bytes()).toBe(before)
    expect(existsSync(lockOf(w))).toBe(true)
    expect(statSync(lockOf(w)).mtimeMs).toBe(old.getTime())
  })
  it('a lock that cannot be made at all (the folder is read only) is a refusal, never a write without it', () => {
    const w = world()
    chmodSync(w.home, 0o500)
    try {
      const before = w.bytes()
      if (process.getuid?.() === 0) return // root ignores the mode
      expect(preAcceptFolderTrust(w.input())).toMatchObject({ ok: false, why: expect.stringContaining('lock') })
      expect(w.bytes()).toBe(before)
    } finally {
      chmodSync(w.home, 0o700)
    }
  })
})

// The fence refuses a case-folding temp folder (every Mac's). The planner is run for real on any temp folder by giving foldsCase a
// look that tells the two spellings of a path apart; the case-folding refusals themselves are tested in worker-spec.test.ts.
const realProbe = fsProbe.stat
beforeEach(() => {
  fsProbe.stat = (p) => {
    const st = realProbe(p)
    return st ? { dev: st.dev, ino: [...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1_000_003, 7) } : null
  }
})
afterEach(() => {
  fsProbe.stat = realProbe
})

describe('the planner uses it for a real start of the owner’s own folder only, never for the agent folder', () => {
  function planned() {
    const w = world()
    const audit: Array<[string, Record<string, string> | undefined]> = []
    writeFileSync(join(w.agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome: w.talosHome,
      userHome: w.home,
      agentDir: w.agentDir,
      claudeDir: join(w.home, '.claude'),
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--permission-mode=default'],
      managedDir: join(tmpdir(), 'talos-test-no-managed-settings'),
      audit: (e, f) => audit.push([e, f]),
    })
    const plan = (cwd: string, o: { dry?: boolean; id?: string } = {}) =>
      planner({
        thread: { id: o.id ?? 'trip', cwd, model: 'inherit', effort: null, parentCwd: null },
        sessionId: '11111111-2222-3333-4444-555555555555',
        resume: false,
        nonce: 'ab'.repeat(16),
        baseEnv: { PATH: '/usr/bin', HOME: w.home, TALOS_APP_BRIDGE: '1' },
        ...(o.dry ? { dry: true } : {}),
      })
    /** What a signed config.patch leaves: the owner chose this folder for the thread. */
    const ownerChooses = (cwd: string, id = 'trip') =>
      recordOwnerFolders(w.talosHome, [{ id }], [{ id, session_opts: { cwd } }], [{ id, session_opts: { cwd } }])
    return { ...w, audit, plan, ownerChooses }
  }
  const trusted = (w: ReturnType<typeof world>) => Object.keys(w.read().projects)
  const said = (w: ReturnType<typeof planned>, e: string) => w.audit.filter(([n]) => n === e)
  it('a dry plan writes nothing; the real start of an owner-chosen folder records it, once, and audits it', () => {
    const w = planned()
    w.ownerChooses(w.trip)
    const before = w.bytes()
    expect('refused' in w.plan(w.trip, { dry: true })).toBe(false)
    expect(w.bytes()).toBe(before)
    expect('refused' in w.plan(w.trip)).toBe(false)
    expect(trusted(w)).toContain(w.trip)
    expect(said(w, 'worker_folder_trust_accepted')).toEqual([['worker_folder_trust_accepted', { thread: 'trip' }]])
    w.plan(w.trip)
    expect(said(w, 'worker_folder_trust_accepted')).toHaveLength(1) // already accepted: nothing said again
  })
  it('a folder nobody recorded as the owner’s (lead init, a hand edit) is not pre-accepted: the card shows it', () => {
    const w = planned()
    const before = w.bytes()
    expect('refused' in w.plan(w.trip)).toBe(false) // the start goes on
    expect(w.bytes()).toBe(before)
    expect(said(w, 'worker_folder_trust_refused')[0]?.[1]).toMatchObject({ thread: 'trip' })
    expect(said(w, 'worker_folder_trust_accepted')).toEqual([])
  })
  it('the owner chose one folder and the config now names another (lead init, a hand edit): the other is not pre-accepted', () => {
    const w = planned()
    const other = join(w.home, 'work', 'other')
    mkdirSync(other)
    w.ownerChooses(w.trip)
    w.plan(other)
    expect(trusted(w)).not.toContain(other)
    expect(said(w, 'worker_folder_trust_refused')).toHaveLength(1)
  })
  it('the agent folder is never written by it (Main’s trust is first-start’s)', () => {
    const w = planned()
    w.ownerChooses(w.agentDir)
    const cfg = w.read()
    delete (cfg.projects as Record<string, unknown>)[w.agentDir]
    writeFileSync(w.configFile, JSON.stringify(cfg))
    const before = w.bytes()
    expect('refused' in w.plan(w.agentDir)).toBe(false)
    expect(w.bytes()).toBe(before)
  })
  it('a refusal never stops the start: a config that cannot be written is audited and the plan still goes', () => {
    const w = planned()
    w.ownerChooses(w.trip)
    writeFileSync(w.configFile, '{ broken')
    expect('refused' in w.plan(w.trip)).toBe(false)
    expect(said(w, 'worker_folder_trust_refused')[0]?.[1]).toMatchObject({ thread: 'trip' })
    expect(w.bytes()).toBe('{ broken')
  })
})
