// What the supervisor hands the thread-session manager (P3d2, part 4): the dedicated threads from config.json, and each start's
// plan from worker-spec.ts. Temp folders; nothing is launched.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPEC_HASH_PATTERN } from '@talos-app/protocol'
import { leadSettings } from '../../src/lead/settings.ts'
import { osSandboxForStart } from '../../src/supervisor/plan-wiring.ts'
import { KIT_MARKETPLACE, MANAGED_SETTINGS, ROOTED_KIT } from '../../src/supervisor/rooted-kit.ts'
import { classifyUpdate } from '../../src/supervisor/update-check.ts'
import {
  installReleaseCommand,
  installWorkerHook,
  PYTHON_RULES,
  releaseContentSha,
  releaseHook,
  workerHookDir,
} from '../../src/supervisor/worker-hook.ts'
import { fenceDenyRules, foldsCase, mainNarrowedMode } from '../../src/supervisor/worker-policy.ts'
import { defaultPreamble } from '../../src/supervisor/worker-preamble.ts'
import { WORKER_EXTRA_DENY } from '../../src/supervisor/worker-spec.ts'
import type { WorkerThread } from '../../src/supervisor/worker-types.ts'
import {
  dedicatedMaxLive,
  dedicatedThreads,
  droppedEntriesNotice,
  droppedThreadEntries,
  MAIN_ENV_UNKNOWN,
  mainCeiling,
  mainRead,
  mainSettingsRefusal,
  workerPlanner,
} from '../../src/supervisor/workers-wiring.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

// The stand-in python3 files these tests build in temp folders are this user's own: the two trust rules (the system's folder
// first, nothing the session's user could change) are off here and back after each test; worker-hook.test.ts tests them.
const savedPythonRules = { ...PYTHON_RULES }
beforeEach(() => Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 }))
afterEach(() => Object.assign(PYTHON_RULES, savedPythonRules))

// the sealed kit releases this file made: writable again and removed (kit-release-fixture.ts)
afterAll(cleanupReleases)

/** No managed settings: the ceiling never reads the machine's own (managedDir is required in production code). */
const NO_MANAGED = join(tmpdir(), 'talos-test-no-managed-settings')

const TMP_FOLDS = foldsCase(realpathSync(tmpdir()))
const onCaseExactTmp = it.skipIf(TMP_FOLDS) // the fence refuses a case-folding temp folder (a Mac's): see worker-spec.test.ts

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-wiring-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const config = (threads: unknown[], enabled = true) => ({
  default_thread: 'general',
  dedicated: { enabled },
  threads: [{ id: 'general', kind: 'fixed' }, { id: 'inbox', kind: 'system' }, ...threads],
})

describe('a sub-thread with a folder of its own under a parent with none', () => {
  it('is judged against the agent folder, where that parent runs', () => {
    const parent = { id: 'dash', name: 'Dash', kind: 'user', session: 'dedicated' }
    const child = {
      id: 'well',
      name: 'Well',
      kind: 'user',
      session: 'dedicated',
      parent_id: 'dash',
      session_opts: { cwd: '/home/alex/Desktop/reports' },
    }
    const t = dedicatedThreads(config([parent, child]), '/home/alex/agent')?.find((x) => x.id === 'well')
    expect(t).toMatchObject({ cwd: '/home/alex/Desktop/reports', parentCwd: '/home/alex/agent' })
    expect(t?.sub).toMatchObject({ ownCwd: true, refusal: null })
    // one already refused (its parent's folder setting can't be read) gets no agent folder handed on (as on the Mac)
    const junk = dedicatedThreads(config([{ ...parent, session_opts: { cwd: 7 } }, child]), '/home/alex/agent')
    expect(junk?.find((x) => x.id === 'well')).toMatchObject({ parentCwd: null })
    expect(junk?.find((x) => x.id === 'well')?.sub?.refusal).toContain("can't be read")
    // one with no folder still shares the parent's (the agent folder), with nothing to be judged against
    const bare = dedicatedThreads(config([parent, { ...child, session_opts: {} }]), '/home/alex/agent')
    expect(bare?.find((x) => x.id === 'well')).toMatchObject({ cwd: '/home/alex/agent', parentCwd: null })
  })
})

describe('the dedicated threads', () => {
  it('only with the switch on, only threads that ask, never general/inbox/archived', () => {
    const trip = {
      id: 'trip',
      name: 'Trip',
      kind: 'user',
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/trip', model: 'sonnet' },
    }
    expect(dedicatedThreads(config([trip]), '/home/alex/agent')).toEqual([
      {
        id: 'trip',
        cwd: '/home/alex/trip',
        model: 'sonnet',
        effort: null,
        parentCwd: null,
        name: 'Trip',
        idleParkMin: 30,
      },
    ])
    // the thread's own idle time, from its session options (P3d3, part 5)
    const quick = { ...trip, session_opts: { ...trip.session_opts, idle_park_min: 5 } }
    expect(dedicatedThreads(config([quick]), '/a')?.[0]?.idleParkMin).toBe(5)
    expect(dedicatedThreads(config([trip], false), '/a')).toEqual([])
    expect(dedicatedThreads(config([{ ...trip, archived: true }]), '/a')).toEqual([])
    // a sub-thread is listed with the Mac's rules: here its parent is not there, so its start is refused (P3d5)
    expect(dedicatedThreads(config([{ ...trip, parent_id: 'work' }]), '/a')?.[0]?.sub?.refusal).toContain(
      'the parent thread is not there any more',
    )
    expect(dedicatedThreads(config([{ id: 'x', kind: 'user', session: 'shared' }]), '/a')).toEqual([])
    // session options that are there but cannot be read: the empty MCP list, and marked so their defaults restart nothing
    expect(dedicatedThreads(config([{ ...trip, session_opts: 'x' }]), '/a')?.[0]).toMatchObject({
      cwd: '/a',
      mcpAllow: [],
      optsUnread: ['session_opts'],
    })
    expect(dedicatedThreads(config([trip]), '/a')?.[0]?.optsUnread).toBeUndefined()
    // one field that cannot be read (a hand-edited typo): named on its own; the rest are read as written
    const typo = { ...trip, session_opts: { cwd: '~/trip', model: 'sonnet', effort: 7 } }
    expect(dedicatedThreads(config([typo]), '/a')?.[0]).toMatchObject({
      cwd: '/a',
      model: 'sonnet',
      optsUnread: ['cwd', 'effort'],
    })
    // no folder of its own: the agent folder
    expect(
      dedicatedThreads(config([{ id: 'q', kind: 'user', session: 'dedicated' }]), '/home/alex/agent')?.[0]?.cwd,
    ).toBe('/home/alex/agent')
  })
  it('a sub-thread: its own folder, its parent’s model, its MCP list cut to the parent’s, and the parent’s folder to be inside', () => {
    const work = {
      id: 'work',
      kind: 'user',
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/work', model: 'opus', mcp_allow: ['github', 'notion'], idle_park_min: 90 },
    }
    const bug = {
      id: 'bug',
      kind: 'user',
      session: 'dedicated',
      parent_id: 'work',
      session_opts: { cwd: '/home/alex/work/bug', mcp_allow: ['notion', 'slack'] },
    }
    const list = dedicatedThreads(config([work, bug]), '/home/alex/agent') ?? []
    expect(list.find((t) => t.id === 'bug')).toEqual({
      id: 'bug',
      cwd: '/home/alex/work/bug',
      model: 'opus',
      effort: null,
      parentCwd: '/home/alex/work',
      name: null,
      idleParkMin: 30, // never inherited
      mcpAllow: ['notion'],
      sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: {} },
    })
    expect(list.find((t) => t.id === 'work')?.sub).toBeUndefined()
    // no folder of its own: it runs in its parent's (subthreads_shared_folder), and is judged against nothing
    const shared = { ...bug, session_opts: { mcp_allow: ['notion'] } }
    const s = dedicatedThreads(config([work, shared]), '/home/alex/agent')?.find((t) => t.id === 'bug')
    expect(s).toMatchObject({
      cwd: '/home/alex/work',
      parentCwd: null,
      sub: { parentId: 'work', ownCwd: false, shares: true, refusal: null },
    })
    // the parent's own folder, named outright, is the same thing; a parent with none gives the agent folder
    const same = dedicatedThreads(config([work, { ...bug, session_opts: { cwd: '/home/alex/work/' } }]), '/a')
    expect(same?.find((t) => t.id === 'bug')).toMatchObject({ cwd: '/home/alex/work', sub: { shares: true } })
    const bare = { id: 'bare', kind: 'user', session: 'dedicated' }
    const agent = dedicatedThreads(config([bare, { ...shared, parent_id: 'bare' }]), '/home/alex/agent')
    expect(agent?.find((t) => t.id === 'bug')).toMatchObject({ cwd: '/home/alex/agent', parentCwd: null })
    // a parent_id that cannot be read fails closed: a sub-thread with the empty list, refused
    const broken = { ...bug, parent_id: 7 }
    const b = dedicatedThreads(config([work, broken]), '/home/alex/agent')?.find((t) => t.id === 'bug')
    expect(b?.mcpAllow).toEqual([])
    expect(b?.sub?.refusal).toContain("parent can't be read")
  })
  it('an entry that is not a thread is left out and the rest is read, never the whole config (the safer rule)', () => {
    const trip = { id: 'trip', kind: 'user', session: 'dedicated', session_opts: { cwd: '/home/alex/trip' } }
    const raw = {
      ...config([trip]),
      threads: [...config([trip]).threads, 'oops', null, { id: 7, kind: 'user' }, ['x']],
    }
    expect(dedicatedThreads(raw, '/a')?.map((t) => t.id)).toEqual(['trip'])
    expect(droppedThreadEntries(raw)).toEqual([4, 5, 6, 7])
    expect(droppedThreadEntries(config([trip]))).toEqual([])
  })
  it('the owner is told once per set of dropped entries, in the default thread, and again only when the set changes', () => {
    const one = { default_thread: 'general', threads: [{ id: 'general', kind: 'fixed' }, 'oops'] }
    const first = droppedEntriesNotice(one, '')
    expect(first).toEqual({
      said: '2',
      thread: 'general',
      text: "config.threads entry #2 isn't a thread object and was ignored; if it had its own session, that session stops.",
    })
    expect(droppedEntriesNotice(one, '2')).toBeNull() // the same set: nothing more
    const two = { ...one, threads: [...one.threads, 5] }
    expect(droppedEntriesNotice(two, '2')?.text).toBe(
      "config.threads entries #2, #3 aren't thread objects and were ignored; if they had their own sessions, those sessions stop.",
    )
    expect(droppedEntriesNotice(config([]), '2')).toBeNull() // none dropped
  })
  it('the live cap is dedicated.max_live (the default without one); a config.json that cannot be read is null', () => {
    expect(dedicatedMaxLive(config([]))).toBe(3)
    expect(dedicatedMaxLive({ ...config([]), dedicated: { enabled: true, max_live: 1 } })).toBe(1)
    expect(dedicatedMaxLive({ ...config([]), dedicated: { enabled: true, max_live: 99 } })).toBe(3)
    expect(dedicatedMaxLive(null)).toBeNull()
    expect(dedicatedMaxLive('x')).toBeNull()
  })
  it('a config.json that cannot be read is null (the last good list is kept), never "no threads"', () => {
    expect(dedicatedThreads(null, '/a')).toBeNull()
    expect(dedicatedThreads({ threads: 'x' }, '/a')).toBeNull()
  })
})

describe('the developer thread fence (owner ruling 2026-11-15)', () => {
  function planWith(threadFence?: () => boolean, asLead = false, setup?: (userHome: string) => void) {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    const trip = join(userHome, 'trip')
    for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
    setup?.(userHome)
    // a lead's own fence in its folder, as `talos-app lead init` writes it (lead/settings.ts): the Talos home, the vault and the
    // credential folders among its roots
    const lead = leadSettings({
      agentDir,
      talosHome,
      home: userHome,
      claudeDir: join(userHome, '.claude'),
      folder: trip,
      profile: 'light',
    })
    if (asLead) {
      mkdirSync(join(trip, '.claude'), { recursive: true })
      writeFileSync(join(trip, '.claude', 'settings.json'), JSON.stringify(lead))
    }
    const leadDeny = [
      `Read(/${talosHome}/**)`,
      `Read(/${join(userHome, 'private-agent-vault')}/**)`,
      `Read(/${join(userHome, '.ssh')}/**)`,
    ]
    for (const r of leadDeny) expect(lead.permissions.deny).toContain(r)
    const events: string[] = []
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome,
      userHome,
      agentDir,
      claudeDir: join(userHome, '.claude'),
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--permission-mode=default'],
      managedDir: NO_MANAGED,
      audit: (e) => events.push(e),
      ...(threadFence ? { threadFence } : {}),
    })
    const p = planner({
      thread: { id: 'trip', cwd: trip, model: 'inherit', effort: null, parentCwd: null },
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      nonce: 'ab'.repeat(16),
      baseEnv: { PATH: '/usr/bin', HOME: userHome, TALOS_APP_BRIDGE: '1' },
    })
    if ('refused' in p) throw new Error(p.refused.detail)
    const perms = (
      JSON.parse(readFileSync(join(talosHome, 'workers', 'trip', 'settings.json'), 'utf8')) as {
        permissions: { deny: string[]; ask?: string[] }
      }
    ).permissions
    const deny = perms.deny
    const ask = perms.ask ?? []
    return { deny, ask, talosHome, userHome, leadDeny, events, specHash: p.specHash }
  }
  onCaseExactTmp('a hook script in a skills folder stays denied with the fence on or off', () => {
    const setup = (userHome: string) => {
      const c = join(userHome, '.claude')
      mkdirSync(join(c, 'skills', 'h'), { recursive: true })
      writeFileSync(
        join(c, 'settings.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `sh ${c}/skills/h/run.sh` }] }] } }),
      )
    }
    for (const f of [undefined, () => false]) {
      const w = planWith(f, false, setup)
      const rule = `Edit(/${join(w.userHome, '.claude', 'skills', 'h', 'run.sh')})`
      expect(w.deny).toContain(rule)
      expect(w.ask).not.toContain(rule)
    }
  })
  onCaseExactTmp('on: the config folder’s agents and skills are denied, not asked', () => {
    const w = planWith()
    const c = `/${join(w.userHome, '.claude')}`
    expect(w.deny).toContain(`Edit(${c}/agents/**)`)
    expect(w.deny).toContain(`Edit(${c}/skills/**)`)
    expect(w.ask.some((r) => r.includes('/.claude/agents/'))).toBe(false)
    expect(w.ask.some((r) => r.includes('/.claude/skills/'))).toBe(false)
  })
  onCaseExactTmp(
    'off: agents, skills and the like ask by card; settings, hooks, plugins and .claude.json stay denied',
    () => {
      const w = planWith(() => false)
      const c = `/${join(w.userHome, '.claude')}`
      for (const r of [
        `Edit(${c}/agents/**)`,
        `Edit(${c}/skills/**)`,
        `Edit(${c}/commands/**)`,
        `Edit(${c}/CLAUDE.md)`,
      ]) {
        expect(w.ask).toContain(r)
        expect(w.deny).not.toContain(r)
      }
      for (const r of [
        `Edit(${c}/settings.json)`,
        `Edit(${c}/settings.local.json)`,
        `Edit(${c}/hooks/**)`,
        `Edit(${c}/plugins/**)`,
        `Edit(/${join(w.userHome, '.claude.json')})`,
      ]) {
        expect(w.deny).toContain(r)
        expect(w.ask).not.toContain(r)
      }
      for (const r of WORKER_EXTRA_DENY) expect(w.deny).toContain(r)
    },
  )
  onCaseExactTmp('on (the default, and when config says true): the Talos-home deny is in the session settings', () => {
    for (const f of [undefined, () => true]) {
      const w = planWith(f)
      for (const r of fenceDenyRules(w.talosHome)) expect(w.deny).toContain(r)
      expect(w.events).not.toContain('worker_thread_fence_off')
    }
  })
  onCaseExactTmp(
    "off: Main's access (no Talos-home fence, read or write); the rest stays; a lead keeps its own fence (Talos home, vault, ~/.ssh)",
    () => {
      const on = planWith()
      const w = planWith(() => false)
      for (const r of fenceDenyRules(on.talosHome)) expect(on.deny).toContain(r)
      for (const r of fenceDenyRules(w.talosHome)) expect(w.deny).not.toContain(r)
      // everything else that fences a session is still written: the extra denies and the edit-only rules on settings and hooks
      for (const r of WORKER_EXTRA_DENY) expect(w.deny).toContain(r)
      expect(w.deny.some((r) => r.startsWith('Edit(') && r.includes('.claude'))).toBe(true)
      expect(w.events).toContain('worker_thread_fence_off')
      // a different launch: the spec hash moves, so the next start is a new one
      expect(w.specHash).not.toBe(on.specHash)
      // a lead's own fence rides along from its folder whatever this switch says (its settings as `lead init` writes them)
      const lead = planWith(() => false, true)
      for (const r of lead.leadDeny) expect(lead.deny).toContain(r)
    },
  )
})

describe('a start’s plan', () => {
  function world() {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    const trip = join(userHome, 'trip')
    for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome,
      userHome,
      agentDir,
      claudeDir: join(userHome, '.claude'),
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--permission-mode=default'],
      managedDir: NO_MANAGED,
    })
    const plan = (cwd: string, model = 'inherit') =>
      planner({
        thread: { id: 'trip', cwd, model, effort: null, parentCwd: null },
        sessionId: '11111111-2222-3333-4444-555555555555',
        resume: false,
        nonce: 'ab'.repeat(16),
        baseEnv: { PATH: '/usr/bin', HOME: userHome, TALOS_APP_BRIDGE: '1' },
      })
    const planSub = (thread: WorkerThread) =>
      planner({
        thread,
        sessionId: '11111111-2222-3333-4444-555555555555',
        resume: false,
        nonce: 'ab'.repeat(16),
        baseEnv: { PATH: '/usr/bin', HOME: userHome, TALOS_APP_BRIDGE: '1' },
      })
    return { root, userHome, agentDir, talosHome, trip, plan, planSub, planner }
  }
  onCaseExactTmp(
    'its spec hash (restart-on-update): the same launch twice is the same; a setting changed is not; a new nonce or session id is the same',
    () => {
      const w = world()
      const hashOf = (
        o: {
          sessionId?: string
          nonce?: string
          resume?: boolean
          model?: string
          path?: string
          extra?: Record<string, string>
        } = {},
      ) => {
        const p = w.planner({
          thread: { id: 'trip', cwd: w.trip, model: o.model ?? 'inherit', effort: null, parentCwd: null },
          sessionId: o.sessionId ?? '11111111-2222-3333-4444-555555555555',
          resume: o.resume ?? false,
          nonce: o.nonce ?? 'ab'.repeat(16),
          baseEnv: { PATH: o.path ?? '/usr/bin', HOME: w.userHome, TALOS_APP_BRIDGE: '1', ...o.extra },
        })
        if ('refused' in p) throw new Error(p.refused.detail)
        expect(p.specHash).toMatch(SPEC_HASH_PATTERN)
        return p.specHash
      }
      const base = hashOf()
      expect(hashOf()).toBe(base) // built twice
      // what differs on every launch never moves it
      expect(hashOf({ nonce: 'cd'.repeat(16) })).toBe(base)
      expect(hashOf({ sessionId: '99999999-8888-7777-6666-555555555555' })).toBe(base)
      expect(hashOf({ resume: true })).toBe(base) // --resume <id> in place of --session-id <id>
      // the login environment is not the launch's: a changed PATH the start does not set is not a new spec, nor a login
      // environment that gains a variable the start strips (the strip RULE is hashed, never what happened to be there)
      expect(hashOf({ path: '/usr/local/bin:/usr/bin' })).toBe(base)
      expect(hashOf({ extra: { CLAUDE_CODE_ENTRYPOINT: 'cli', TELEGRAM_X: '1', LD_PRELOAD: '/x.so' } })).toBe(base)
      // a setting the session launches with is
      expect(hashOf({ model: 'sonnet' })).not.toBe(base)
      // and so is a file the start writes: the preamble
      mkdirSync(join(w.agentDir, 'threads', 'trip'), { recursive: true })
      writeFileSync(join(w.agentDir, 'threads', 'trip', 'WORKER.md'), 'a different preamble\n')
      expect(hashOf()).not.toBe(base)
    },
  )
  onCaseExactTmp(
    'its spec hash with instruction files, other threads, a launch-config env and the agent folder’s MCP entry (Fable R1-1..R1-4)',
    () => {
      const root = tmp()
      const userHome = join(root, 'home')
      const agentDir = join(userHome, 'agent')
      const talosHome = join(userHome, '.talos')
      const trip = join(userHome, 'trip')
      for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { command: 'talos' } } }))
      writeFileSync(join(trip, 'CLAUDE.md'), 'the thread folder’s own instructions\n') // its markers carry a random token
      const world = {
        others: [join(userHome, 'a'), join(userHome, 'b')],
        launchEnv: { FOO: '1' } as Record<string, string>,
      }
      const planner = workerPlanner({
        threadFolders: () => world.others,
        launchEnv: () => world.launchEnv,
        kitVendor: sealedRelease(),
        talosHome,
        userHome,
        agentDir,
        claudeDir: join(userHome, '.claude'),
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => ['--permission-mode=default'],
        managedDir: NO_MANAGED,
      })
      const hashOf = (cwd = trip) => {
        const p = planner({
          thread: { id: 'trip', cwd, model: 'inherit', effort: null, parentCwd: null },
          sessionId: '11111111-2222-3333-4444-555555555555',
          resume: false,
          nonce: 'ab'.repeat(16),
          baseEnv: { PATH: '/usr/bin', HOME: userHome },
        })
        if ('refused' in p) throw new Error(p.refused.detail)
        return p.specHash
      }
      const base = hashOf()
      // R1-1: the instruction files' random token never moves it
      expect(readFileSync(join(talosHome, 'workers', 'trip', 'system-prompt.md'), 'utf8')).toContain(
        '<<<instruction-file ',
      )
      expect(hashOf()).toBe(base)
      // R1-2: the other threads in another order are the same launch; one more thread is a new fence
      world.others = [join(userHome, 'b'), join(userHome, 'a')]
      expect(hashOf()).toBe(base)
      world.others = [join(userHome, 'b'), join(userHome, 'a'), join(userHome, 'c')]
      expect(hashOf()).not.toBe(base)
      world.others = [join(userHome, 'a'), join(userHome, 'b')]
      expect(hashOf()).toBe(base)
      // R1-3: the launch config's env, folded into the login environment, is part of the spec
      world.launchEnv = { FOO: '2' }
      expect(hashOf()).not.toBe(base)
      world.launchEnv = { FOO: '1' }
      expect(hashOf()).toBe(base)
      // R1-3: a session in the agent folder (no file written for its MCP): the talos-app entry it loads is in its spec
      const inAgent = hashOf(agentDir)
      expect(hashOf(agentDir)).toBe(inAgent)
      writeFileSync(
        join(agentDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'talos-app': { command: 'talos-2' } } }),
      )
      expect(hashOf(agentDir)).not.toBe(inAgent)
    },
  )
  onCaseExactTmp(
    'its instructions digest (the update check): an edit to the instructions alone is told apart from any other change',
    () => {
      const root = tmp()
      const userHome = join(root, 'home')
      const agentDir = join(userHome, 'agent')
      const talosHome = join(userHome, '.talos')
      const trip = join(userHome, 'trip')
      for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(trip, 'CLAUDE.md'), 'the thread folder’s own instructions\n')
      const planner = workerPlanner({
        threadFolders: () => [],
        kitVendor: sealedRelease(),
        talosHome,
        userHome,
        agentDir,
        claudeDir: join(userHome, '.claude'),
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => ['--permission-mode=default'],
        managedDir: NO_MANAGED,
      })
      const plan = (o: { dry?: boolean; cwd?: string; model?: string } = {}) => {
        const p = planner({
          thread: { id: 'trip', cwd: o.cwd ?? trip, model: o.model ?? 'inherit', effort: null, parentCwd: null },
          sessionId: '11111111-2222-3333-4444-555555555555',
          resume: true,
          nonce: 'ab'.repeat(16),
          baseEnv: { PATH: '/usr/bin', HOME: userHome },
          ...(o.dry ? { dry: true } : {}),
        })
        if ('refused' in p) throw new Error(p.refused.detail)
        return p
      }
      const started = plan()
      expect(started.instructionsHash).toMatch(SPEC_HASH_PATTERN)
      expect(started.specWith).toBeUndefined() // a real start's plan never carries it
      // the digest is the spec's own entry for the instructions file, with its random token replaced
      const text = readFileSync(join(talosHome, 'workers', 'trip', 'system-prompt.md'), 'utf8')
      expect(text).toContain('the thread folder’s own instructions')
      const launched = {
        cwd: trip,
        model: 'inherit',
        spec_hash: started.specHash,
        instructions_hash: started.instructionsHash,
      }
      const unchanged = plan({ dry: true })
      expect(classifyUpdate(unchanged, launched, false, false)).toBe('unchanged')
      expect(unchanged.specWith?.(started.instructionsHash as string)).toBe(started.specHash)
      // the instructions alone edited: a new spec, and with the recorded digest put back it is the spec recorded
      writeFileSync(join(trip, 'CLAUDE.md'), 'edited instructions\n')
      const edited = plan({ dry: true })
      expect(edited.specHash).not.toBe(started.specHash)
      expect(edited.instructionsHash).not.toBe(started.instructionsHash)
      expect(edited.specWith?.(started.instructionsHash as string)).toBe(started.specHash)
      expect(classifyUpdate(edited, launched, false, false)).toBe('instructions changed')
      expect(classifyUpdate(edited, launched, true, false)).toBe('busy (would wait)')
      // the record says the agent folder: never "instructions changed" (that folder's files are not hashed)
      expect(classifyUpdate(edited, launched, false, true)).toBe('spec changed')
      // the instructions and something else: "spec changed", the wider one
      const both = plan({ dry: true, model: 'sonnet' })
      expect(both.specWith?.(started.instructionsHash as string)).not.toBe(started.specHash)
      expect(classifyUpdate(both, launched, false, false)).toBe('spec changed')
      // a value that is not a digest gives nothing
      expect(edited.specWith?.('sha256:XYZ')).toBeUndefined()
      // in the agent folder: no instructions file written, so no digest
      expect(plan({ cwd: agentDir }).instructionsHash).toBeUndefined()
    },
  )
  onCaseExactTmp(
    'builds a checked launch in the thread folder, writes its settings 0600, and never carries Main markers',
    () => {
      const w = world()
      const p = w.plan(w.trip)
      if ('refused' in p) throw new Error(p.refused.detail)
      expect(p.launch.session).toBe('t-trip')
      expect(p.launch.cwd).toBe(w.trip)
      expect(p.launch.argv[0]).toBe('/usr/bin/claude')
      expect(p.launch.env.TALOS_APP_WORKER_NONCE).toBe('ab'.repeat(16))
      expect(p.launch.env.TALOS_APP_BRIDGE).toBeUndefined()
      const settings = join(w.talosHome, 'workers', 'trip', 'settings.json')
      expect(readFileSync(settings, 'utf8')).toBe(p.settingsJSON)
      expect(statSync(settings).mode & 0o777).toBe(0o600)
    },
  )
  onCaseExactTmp('every launch carries the thread’s preamble: its WORKER.md, else the default (the Mac’s)', () => {
    const w = world()
    const p = w.plan(w.trip)
    if ('refused' in p) throw new Error(p.refused.detail)
    // a thread folder: the preamble is in the worker's own file (with the folder's instruction files after it)
    const file = join(w.talosHome, 'workers', 'trip', 'system-prompt.md')
    expect(p.launch.argv).toContain(`--append-system-prompt-file=${file}`)
    expect(readFileSync(file, 'utf8')).toStartWith(defaultPreamble('trip'))
    mkdirSync(join(w.agentDir, 'threads', 'trip'), { recursive: true })
    writeFileSync(join(w.agentDir, 'threads', 'trip', 'WORKER.md'), 'Plan the trip.\n')
    const q = w.plan(w.trip)
    if ('refused' in q) throw new Error(q.refused.detail)
    expect(readFileSync(file, 'utf8')).toStartWith('Plan the trip.\n')
  })
  const subOf = (cwd: string, parentCwd: string): WorkerThread => ({
    id: 'trip',
    cwd,
    model: 'inherit',
    effort: null,
    parentCwd,
    sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: {} },
  })
  onCaseExactTmp('a sub-thread’s folder is made strictly inside its parent’s, and launched there resolved', () => {
    const w = world()
    const made = join(w.trip, 'bug', 'deep')
    const p = w.planSub(subOf(made, w.trip))
    if ('refused' in p) throw new Error(p.refused.detail)
    expect(p.launch.cwd).toBe(made)
    expect(existsSync(made)).toBe(true)
  })
  onCaseExactTmp(
    'a sub-thread at its parent’s own folder, outside it, through a link out, or under a fenced parent: refused, nothing made',
    () => {
      const w = world()
      expect(w.planSub(subOf(w.trip, w.trip))).toMatchObject({ refused: { code: 'start_failed' } })
      expect(w.planSub(subOf(`${w.trip}/`, w.trip))).toMatchObject({ refused: { code: 'start_failed' } })
      const outside = join(w.root, 'outside')
      mkdirSync(outside)
      expect(w.planSub(subOf(join(outside, 'x'), w.trip))).toMatchObject({ refused: { code: 'start_failed' } })
      symlinkSync(outside, join(w.trip, 'escape'))
      expect(w.planSub(subOf(join(w.trip, 'escape', 'made'), w.trip))).toMatchObject({
        refused: { code: 'start_failed' },
      })
      expect(existsSync(join(outside, 'x')) || existsSync(join(outside, 'made'))).toBe(false)
      // the parent's folder is the home itself: nothing is made in it
      const r = w.planSub(subOf(join(w.userHome, 'new'), w.userHome))
      expect(r).toMatchObject({ refused: { code: 'start_failed' } })
      expect('refused' in r && r.refused.detail).toContain("the parent's folder")
      expect(existsSync(join(w.userHome, 'new'))).toBe(false)
    },
  )
  onCaseExactTmp(
    'a sub-thread in its own existing folder outside its parent’s: launched there, nothing made, and the parent’s deny and ask rules carried in',
    () => {
      const w = world()
      // the parent's folder holds its fence (a lead's privacy rules); the own folder has its own
      mkdirSync(join(w.trip, '.claude'), { recursive: true })
      writeFileSync(
        join(w.trip, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: ['Read(./private/**)', 'WebFetch'], ask: ['Bash(git push:*)'] } }),
      )
      const own = join(w.userHome, 'own')
      mkdirSync(join(own, '.claude'), { recursive: true })
      writeFileSync(join(own, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }))
      const p = w.planSub(subOf(own, w.trip))
      if ('refused' in p) throw new Error(p.refused.detail)
      expect(p.launch.cwd).toBe(own)
      const perms = JSON.parse(p.settingsJSON).permissions
      expect(perms.deny).toContain(`Read(/${w.trip}/private/**)`) // the parent's, anchored at the parent's folder
      expect(perms.deny).toContain('WebFetch')
      expect(perms.deny).toContain('Bash(rm:*)') // and its own
      expect(perms.ask).toContain('Bash(git push:*)')
      // a parent rule that cannot be read refuses the start, as the folder's own does
      writeFileSync(join(w.trip, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: 'WebFetch' } }))
      expect(w.planSub(subOf(own, w.trip))).toMatchObject({
        refused: { detail: expect.stringContaining('the parent thread folder') },
      })
      // an inside sub-thread is unchanged: nothing from the parent's settings is added by this rule
      mkdirSync(join(w.trip, 'bug'))
      rmSync(join(w.trip, '.claude', 'settings.json'))
      const inside = w.planSub(subOf(join(w.trip, 'bug'), w.trip))
      if ('refused' in inside) throw new Error(inside.refused.detail)
    },
  )
  onCaseExactTmp(
    'under a parent with no folder (the agent folder): an existing folder outside is kept with the agent folder’s rules; one inside is made',
    () => {
      const w = world()
      mkdirSync(join(w.agentDir, '.claude'), { recursive: true })
      writeFileSync(
        join(w.agentDir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: ['Read(./private/**)'] } }),
      )
      const own = join(w.userHome, 'reports')
      mkdirSync(own)
      const p = w.planSub(subOf(own, w.agentDir))
      if ('refused' in p) throw new Error(p.refused.detail)
      expect(p.launch.cwd).toBe(own)
      expect(JSON.parse(p.settingsJSON).permissions.deny).toContain(`Read(/${w.agentDir}/private/**)`)
      const inside = join(w.agentDir, 'threads', 'well')
      const q = w.planSub(subOf(inside, w.agentDir))
      if ('refused' in q) throw new Error(q.refused.detail)
      expect(q.launch.cwd).toBe(inside)
      expect(existsSync(inside)).toBe(true)
      // a folder outside that does not exist is never made
      expect(w.planSub(subOf(join(w.userHome, 'nowhere'), w.agentDir))).toMatchObject({
        refused: { code: 'start_failed' },
      })
      expect(existsSync(join(w.userHome, 'nowhere'))).toBe(false)
    },
  )
  onCaseExactTmp(
    'a sub-thread that shares its parent’s folder: launched there like any thread, nothing made, the folder’s own rules carried',
    () => {
      const w = world()
      mkdirSync(join(w.trip, '.claude'), { recursive: true })
      writeFileSync(
        join(w.trip, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: ['Read(./private/**)'] } }),
      )
      const shared: WorkerThread = {
        id: 'trip',
        cwd: w.trip,
        model: 'inherit',
        effort: null,
        parentCwd: null,
        sub: { parentId: 'work', ownCwd: false, shares: true, refusal: null, unreadable: {} },
      }
      const before = readdirSync(w.trip)
      const p = w.planSub(shared)
      if ('refused' in p) throw new Error(p.refused.detail)
      expect(p.launch.cwd).toBe(w.trip)
      expect(JSON.parse(p.settingsJSON).permissions.deny).toContain(`Read(/${w.trip}/private/**)`)
      expect(readdirSync(w.trip)).toEqual(before) // nothing made
      // the same thread without the flag is still the old refusal: a folder of its own is needed
      const old = { ...shared, sub: { parentId: 'work', ownCwd: false, refusal: null, unreadable: {} } }
      expect(w.planSub({ ...old, parentCwd: w.trip })).toMatchObject({ refused: { code: 'start_failed' } })
      // and a refusal from the rules still stands for one that shares
      const refused = { ...shared, sub: { ...shared.sub, refusal: 'no parent' } }
      expect(w.planSub(refused as WorkerThread)).toMatchObject({ refused: { detail: 'no parent' } })
    },
  )
  onCaseExactTmp('a sub-thread the rules refuse is refused by the planner too, with their reason', () => {
    const w = world()
    const t = {
      ...subOf(join(w.trip, 'bug'), w.trip),
      sub: { parentId: 'work', ownCwd: true, refusal: 'no parent', unreadable: {} },
    }
    expect(w.planSub(t)).toMatchObject({ refused: { code: 'start_failed', detail: 'no parent' } })
    expect(existsSync(join(w.trip, 'bug'))).toBe(false)
  })
  onCaseExactTmp(
    'no MCP list, a folder of its own: --mcp-config with the agent folder’s talos-app server only (the Mac’s)',
    () => {
      const w = world()
      writeFileSync(
        join(w.agentDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'talos-app': { command: 'bun', args: ['x'], env: { TALOS_APP_BRIDGE: '1', KEEP: 'y' } },
            other: {},
          },
        }),
      )
      const p = w.plan(w.trip)
      if ('refused' in p) throw new Error(p.refused.detail)
      const file = join(w.talosHome, 'workers', 'trip', 'mcp.json')
      expect(p.launch.argv).toContain(`--mcp-config=${file}`)
      expect(p.launch.argv).not.toContain('--strict-mcp-config')
      expect(statSync(file).mode & 0o777).toBe(0o600)
      // sorted keys, nothing but talos-app, and its env without what a worker must never have
      const cfg = JSON.parse(readFileSync(file, 'utf8'))
      expect(Object.keys(cfg.mcpServers)).toEqual(['talos-app'])
      expect(cfg.mcpServers['talos-app'].command).toBe('bun')
      expect(cfg.mcpServers['talos-app'].env?.TALOS_APP_BRIDGE).toBeUndefined()
      expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))))
    },
  )
  onCaseExactTmp(
    'the no-list cleanup never deletes that file: a second start keeps and uses it, a list start’s file goes',
    () => {
      const w = world()
      const file = join(w.talosHome, 'workers', 'trip', 'mcp.json')
      const listFile = join(w.talosHome, 'workers', 'trip', 'mcp', 'mcp.json')
      mkdirSync(join(w.talosHome, 'workers', 'trip', 'mcp'), { recursive: true })
      writeFileSync(listFile, '{"mcpServers":{"x":{"env":{"TOKEN":"fake-secret"}}}}')
      for (let i = 0; i < 2; i++) {
        const p = w.plan(w.trip)
        if ('refused' in p) throw new Error(p.refused.detail)
        expect(existsSync(file)).toBe(true)
        expect(p.launch.argv).toContain(`--mcp-config=${file}`)
        expect(existsSync(listFile)).toBe(false)
      }
    },
  )
  onCaseExactTmp('in the agent folder: no --mcp-config (its own .mcp.json is read there)', () => {
    const w = world()
    const p = w.plan(w.agentDir)
    if ('refused' in p) throw new Error(p.refused.detail)
    expect(p.launch.argv.some((a) => a.startsWith('--mcp-config'))).toBe(false)
  })
  onCaseExactTmp('a folder outside the home, or one that is not there, is refused before anything is built', () => {
    const w = world()
    const out = join(w.root, 'elsewhere')
    mkdirSync(out)
    expect(w.plan(out)).toMatchObject({ refused: { code: 'start_failed' } })
    expect(w.plan(join(w.userHome, 'nope'))).toMatchObject({ refused: { code: 'start_failed' } })
  })
  onCaseExactTmp(
    'a start with no MCP list removes an mcp.json an earlier launch wrote (it holds server credentials)',
    () => {
      const w = world()
      const stale = join(w.talosHome, 'workers', 'trip', 'mcp', 'mcp.json')
      mkdirSync(join(w.talosHome, 'workers', 'trip', 'mcp'), { recursive: true })
      writeFileSync(stale, '{"mcpServers":{"x":{"env":{"TOKEN":"fake-secret"}}}}')
      const p = w.plan(w.trip)
      expect('refused' in p).toBe(false)
      expect(existsSync(stale)).toBe(false)
    },
  )
  onCaseExactTmp('a value the spec refuses is a failed start with its reason, never a launch', () => {
    const w = world()
    const p = w.plan(w.trip, 'not a model!')
    expect(p).toMatchObject({ refused: { code: 'start_failed' } })
    expect('refused' in p && p.refused.detail).toContain('bad_model')
  })
})

describe('a start whose permission hook cannot run (refused and told, never a silent fallback to the terminal)', () => {
  function world(
    o: {
      permissionHook?: string
      kitVendor?: string
      path?: string
      root?: string
      threadFolders?: () => string[] | null
      mainArgs?: string[]
      /** The thread's folder, under the test's home (default: the agent folder). */
      cwd?: string
    } = {},
  ) {
    const root = o.root ?? tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    for (const d of [agentDir, talosHome, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
    if (o.cwd) mkdirSync(join(userHome, o.cwd), { recursive: true })
    writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
    const audit: Array<[string, Record<string, string> | undefined]> = []
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: o.kitVendor ?? sealedRelease(),
      talosHome,
      userHome,
      agentDir,
      claudeDir: join(userHome, '.claude'),
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => o.mainArgs ?? ['--permission-mode=default'],
      managedDir: NO_MANAGED,
      ...(o.permissionHook ? { permissionHook: o.permissionHook.replace('<agent>', agentDir) } : {}),
      ...(o.threadFolders ? { threadFolders: o.threadFolders } : {}),
      audit: (e, f) => audit.push([e, f]),
    })
    const plan = planner({
      thread: {
        id: 'trip',
        cwd: o.cwd ? join(userHome, o.cwd) : agentDir,
        model: 'inherit',
        effort: null,
        parentCwd: null,
      },
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      nonce: 'ab'.repeat(16),
      baseEnv: { PATH: o.path ?? '/usr/bin', HOME: userHome },
    })
    return { plan, audit, agentDir, talosHome, root, userHome }
  }
  const releaseSource = () => {
    const r = releaseHook(sealedRelease())
    if (!('source' in r)) throw new Error(r.problem)
    return r.source
  }
  onCaseExactTmp(
    'a dry plan (the update check) gives the launch’s own spec hash, and writes, removes and audits nothing',
    () => {
      const root = tmp()
      const userHome = join(root, 'home')
      const agentDir = join(userHome, 'agent')
      const talosHome = join(userHome, '.talos')
      const trip = join(userHome, 'trip')
      const hooks = join(root, 'hooks')
      for (const d of [agentDir, talosHome, trip, hooks, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { command: 'talos' } } }))
      writeFileSync(join(trip, 'CLAUDE.md'), 'the thread folder’s instructions\n')
      // the folder's own settings, which a session outside the agent folder does not load: a real start audits that
      mkdirSync(join(trip, '.claude'))
      writeFileSync(join(trip, '.claude', 'settings.json'), JSON.stringify({ env: { NOT_ALLOWED_HERE: '1' } }))
      const hook = join(hooks, 'permission-relay.py')
      writeFileSync(hook, readFileSync(releaseSource()))
      const audit: string[] = []
      const planner = workerPlanner({
        threadFolders: () => [],
        kitVendor: sealedRelease(),
        permissionHook: hook,
        talosHome,
        userHome,
        agentDir,
        claudeDir: join(userHome, '.claude'),
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => ['--permission-mode=default'],
        managedDir: NO_MANAGED,
        audit: (e) => audit.push(e),
      })
      const plan = (dry: boolean) => {
        const p = planner({
          thread: { id: 'trip', cwd: trip, model: 'inherit', effort: null, parentCwd: null },
          sessionId: '11111111-2222-3333-4444-555555555555',
          resume: false,
          nonce: 'ab'.repeat(16),
          baseEnv: { PATH: '/usr/bin', HOME: userHome },
          dry,
        })
        if ('refused' in p) throw new Error(p.refused.detail)
        return p
      }
      const tree = () =>
        execFileSync('find', [root, '-printf', '%p %s %T@\\n'], { encoding: 'utf8' }).split('\n').sort().join('\n')
      // first a dry plan in a home no start has touched: nothing at all appears or changes
      const before = tree()
      const dry = plan(true)
      expect(tree()).toBe(before)
      expect(audit).toEqual([])
      expect(existsSync(join(talosHome, 'workers'))).toBe(false)
      // the real start's hash is the dry one, and a later dry plan still agrees
      const real = plan(false)
      expect(audit).toContain('worker_project_settings_ignored') // the real start does audit
      expect(real.specHash).toMatch(SPEC_HASH_PATTERN)
      expect(dry.specHash).toBe(real.specHash)
      expect(dry.launch).toEqual(real.launch)
      const after = tree()
      expect(plan(true).specHash).toBe(real.specHash)
      expect(tree()).toBe(after)
      // a release that changes the permission hook's bytes is a new spec (the hook's path in the settings is the same)
      writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n# a new release\n`)
      expect(plan(true).specHash).not.toBe(real.specHash)
    },
  )
  onCaseExactTmp(
    'a dry plan refuses as a real start would, and still makes and audits nothing (Fable R1 on the dry plan)',
    () => {
      const root = tmp()
      const userHome = join(root, 'home')
      const agentDir = join(userHome, 'agent')
      const talosHome = join(userHome, '.talos')
      const work = join(userHome, 'work')
      for (const d of [agentDir, talosHome, work, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
      writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { command: 'talos' } } }))
      const audit: string[] = []
      const world = { mainArgs: ['--permission-mode=default'] }
      const planner = workerPlanner({
        threadFolders: () => [],
        kitVendor: sealedRelease(),
        talosHome,
        userHome,
        agentDir,
        claudeDir: join(userHome, '.claude'),
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => world.mainArgs,
        managedDir: NO_MANAGED,
        audit: (e) => audit.push(e),
      })
      const base = { sessionId: '11111111-2222-3333-4444-555555555555', resume: false, nonce: 'ab'.repeat(16) }
      const env = { PATH: '/usr/bin', HOME: userHome }
      const tree = () =>
        execFileSync('find', [root, '-printf', '%p %s %T@\\n'], { encoding: 'utf8' }).split('\n').sort().join('\n')
      // R1-1: a sub-thread whose folder is gone: refused, and the folder is NOT made again
      const sub: WorkerThread = {
        id: 'bug',
        cwd: join(work, 'subs', 'bug'),
        model: 'inherit',
        effort: null,
        parentCwd: work,
        sub: { parentId: 'work', ownCwd: true, refusal: null, unreadable: {} },
      }
      const before = tree()
      const subDry = planner({ ...base, thread: sub, baseEnv: env, dry: true })
      expect('refused' in subDry).toBe(true)
      expect(existsSync(join(work, 'subs'))).toBe(false)
      expect(tree()).toBe(before)
      // R1-2: Main's own --settings cannot be read (a real start is refused and audits it): a dry plan audits nothing
      world.mainArgs = ['--permission-mode=default', '--settings', join(root, 'missing.json')]
      const thread = { id: 'trip', cwd: work, model: 'inherit', effort: null, parentCwd: null } as WorkerThread
      planner({ ...base, thread, baseEnv: env, dry: true })
      expect(audit).toEqual([])
      planner({ ...base, thread, baseEnv: env })
      expect(audit).toContain('worker_start_refused') // the real start does (mainSettingsRefusal)
      // R1-3: a hook folder other accounts can write: the real start refuses, and so does the dry plan (never a launch it refuses)
      world.mainArgs = ['--permission-mode=default']
      mkdirSync(join(talosHome, 'workers'), { recursive: true })
      chmodSync(join(talosHome, 'workers'), 0o777)
      const real = planner({ ...base, thread, baseEnv: env })
      const dry = planner({ ...base, thread, baseEnv: env, dry: true })
      expect('refused' in real && real.refused.hookMissing).toContain('can be written by other accounts')
      expect(dry).toEqual(real)
    },
  )
  it('a hook script that is not there: refused with its path, audited, and no settings written', () => {
    // Delphi's layout: an older agent folder with no hooks/ (its hook lives in scripts/claude-code/hooks/)
    const w = world({ permissionHook: '<agent>/hooks/permission-relay.py' })
    const why = `the permission hook ${join(w.agentDir, 'hooks', 'permission-relay.py')} is missing or cannot be read`
    expect(w.plan).toEqual({ refused: { code: 'start_failed', detail: why, hookMissing: why } })
    expect(w.audit).toContainEqual(['worker_hook_missing', { thread: 'trip', why }])
    expect(existsSync(join(w.talosHome, 'workers', 'trip', 'settings.json'))).toBe(false)
  })
  it('python3 not on the session’s PATH (outside its folders): refused the same way', () => {
    const w = world({ path: '/nonexistent' })
    expect('refused' in w.plan && w.plan.refused.hookMissing).toBe(
      "python3 is not on the thread session's PATH (outside its own folders), so its permission hook cannot run",
    )
  })
  onCaseExactTmp(
    'a python3 inside ANOTHER configured thread’s folder is passed over, and the list is read again at each start',
    () => {
      // a thread with acceptEdits could write an interpreter into its own folder and put that first on the PATH every session gets
      const root = tmp()
      const other = join(root, 'other-thread')
      mkdirSync(join(other, 'bin'), { recursive: true })
      cpSync(realpathSync('/usr/bin/python3'), join(other, 'bin', 'python3'))
      const path = `${join(other, 'bin')}:/usr/bin`
      const hookOf = (p: ReturnType<typeof world>['plan']) => {
        if (!('launch' in p)) throw new Error(JSON.stringify(p))
        return JSON.parse(p.settingsJSON).hooks.PermissionRequest[0].hooks[0].command as string
      }
      // control: with no other thread configured, that interpreter would be taken
      expect(hookOf(world({ root: join(root, 'a'), path, threadFolders: () => [] }).plan)).toContain(
        `'${join(other, 'bin', 'python3')}'`,
      )
      let reads = 0
      const fenced = world({ root: join(root, 'b'), path, threadFolders: () => (reads++, [other]) })
      expect(reads).toBe(1)
      const cmd = hookOf(fenced.plan)
      expect(cmd).not.toContain(other)
      expect(cmd).toMatch(/ '\/usr\/bin\/python3[.0-9]*'$/)
      // only the other thread's interpreter on the PATH: refused, never run
      expect(
        world({ root: join(root, 'c'), path: join(other, 'bin'), threadFolders: () => [other] }).plan,
      ).toMatchObject({
        refused: { code: 'start_failed' },
      })
    },
  )
  it('config.json never read yet: refused, never fenced by fewer folders than are configured', () => {
    const w = world({ threadFolders: () => null })
    expect(w.plan).toMatchObject({ refused: { code: 'start_failed' } })
    expect('refused' in w.plan && w.plan.refused.detail).toContain("can't be read from config.json yet")
  })
  onCaseExactTmp(
    'the agent folder (its files load as Main’s do): a skill with hooks of its own refuses, audited, nothing written',
    () => {
      const root = tmp()
      const agentDir = join(root, 'home', 'agent')
      mkdirSync(join(agentDir, '.claude', 'skills', 's'), { recursive: true })
      writeFileSync(join(agentDir, '.claude', 'skills', 's', 'SKILL.md'), '---\nname: s\nhooks:\n  Stop: []\n---\n')
      const w = world({ root })
      expect('refused' in w.plan && w.plan.refused.detail).toContain('the agent folder: ')
      expect('refused' in w.plan && w.plan.refused.detail).toContain('has hooks in its frontmatter')
      expect('refused' in w.plan && w.plan.refused.detail).toContain("remove it or move this thread's folder")
      expect(w.audit.some(([e]) => e === 'worker_project_settings_refused')).toBe(true)
      expect(existsSync(join(w.talosHome, 'workers', 'trip', 'settings.json'))).toBe(false)
    },
  )
  onCaseExactTmp(
    'the agent folder: no --setting-sources of its own (Main’s, when Main names one), the preamble as one argument',
    () => {
      const w = world()
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      expect(w.plan.launch.argv.some((a) => a.startsWith('--setting-sources'))).toBe(false)
      expect(w.plan.launch.argv.some((a) => a.startsWith('--append-system-prompt='))).toBe(true)
      const v = world({ mainArgs: ['--permission-mode=default', '--setting-sources', 'project,user'] })
      if (!('launch' in v.plan)) throw new Error(JSON.stringify(v.plan))
      expect(v.plan.launch.argv).toContain('--setting-sources=project,user')
    },
  )
  onCaseExactTmp(
    'a thread folder: only user settings, and what its folder carries is told, never a refusal (it loads none of it)',
    () => {
      const root = tmp()
      const folder = join(root, 'home', 'proj')
      mkdirSync(join(folder, '.claude', 'skills', 's'), { recursive: true })
      writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ env: { LD_PRELOAD: '/x.so' } }))
      writeFileSync(join(folder, '.claude', 'skills', 's', 'SKILL.md'), '---\nhooks: {}\n---\n')
      const w = world({ root, cwd: 'proj' })
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      expect(w.plan.launch.argv).toContain('--setting-sources=user')
      expect(w.plan.settingsIgnored).toContain('has hooks in its frontmatter')
      expect(w.audit.some(([e]) => e === 'worker_project_settings_ignored')).toBe(true)
    },
  )
  onCaseExactTmp(
    'a thread folder’s own deny and ask rules still hold (copied in, made absolute): it does not load its settings',
    () => {
      const root = tmp()
      const folder = join(root, 'home', 'proj')
      mkdirSync(join(folder, '.claude'), { recursive: true })
      writeFileSync(
        join(folder, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: ['Read(./secrets/**)', 'Bash(rm:*)'], ask: ['Bash(git push:*)'] } }),
      )
      const w = world({ root, cwd: 'proj' })
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      const perms = JSON.parse(w.plan.settingsJSON).permissions
      expect(perms.deny).toContain(`Read(/${folder}/secrets/**)`)
      expect(perms.deny).toContain('Bash(rm:*)')
      expect(perms.ask).toContain('Bash(git push:*)')
    },
  )
  onCaseExactTmp(
    'a repo root the folder loads settings from that no rule can name refuses the start (Fable R1-4)',
    () => {
      const root = tmp()
      const folder = join(root, 'home', 'proj')
      // a worktree whose main checkout sits in a folder with a paren in its name
      const main = join(root, 'home', 'checkout (old)')
      mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true })
      writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'w')}\n`)
      const w = world({ root, cwd: 'proj' })
      expect(w.plan).toMatchObject({
        refused: { detail: expect.stringContaining("a character a permission rule can't name") },
      })
    },
  )
  onCaseExactTmp(
    'a settings file whose deny/ask rules cannot all be read refuses the start: a link, too big, a non-list, a non-string (Fable R2-1)',
    () => {
      const cases: Array<[string, (dir: string) => void]> = [
        [
          'a link',
          (dir) => {
            writeFileSync(join(dir, 'real.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }))
            symlinkSync(join(dir, 'real.json'), join(dir, '.claude', 'settings.json'))
          },
        ],
        [
          'over 256 KB',
          (dir) =>
            writeFileSync(
              join(dir, '.claude', 'settings.json'),
              JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, pad: 'x'.repeat(300 * 1024) }),
            ),
        ],
        [
          'deny as a string',
          (dir) =>
            writeFileSync(
              join(dir, '.claude', 'settings.json'),
              JSON.stringify({ permissions: { deny: 'Bash(rm:*)' } }),
            ),
        ],
        [
          'a non-string entry',
          (dir) =>
            writeFileSync(
              join(dir, '.claude', 'settings.json'),
              JSON.stringify({ permissions: { ask: ['Bash(git push:*)', { rule: 'x' }] } }),
            ),
        ],
        ['not JSON', (dir) => writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ "permissions": ')],
        ['not a settings object', (dir) => writeFileSync(join(dir, '.claude', 'settings.json'), '["Bash(rm:*)"]')],
        [
          'permissions not an object',
          (dir) =>
            writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: ['Bash(rm:*)'] })),
        ],
      ]
      // each refusal names what was wrong, so removing any one of them turns its case red
      const detail: Record<string, string> = {
        'a link': 'is a link',
        'over 256 KB': 'at most 256 KB',
        'deny as a string': '"permissions.deny" is not a list',
        'a non-string entry': 'holds something that is not a rule',
        'not JSON': 'cannot be read as JSON',
        'not a settings object': 'is not a settings object',
        'permissions not an object': '"permissions" is not an object',
      }
      for (const [what, make] of cases) {
        const root = tmp()
        const folder = join(root, 'home', 'proj')
        mkdirSync(join(folder, '.claude'), { recursive: true })
        make(folder)
        const w = world({ root, cwd: 'proj' })
        expect(w.plan, what).toMatchObject({ refused: { detail: expect.stringContaining(detail[what] as string) } })
      }
      // an empty or blank settings file is no settings (as Claude Code, the Mac and the hook read it): the start goes on
      for (const empty of ['', '  \n']) {
        const root = tmp()
        const folder = join(root, 'home', 'proj')
        mkdirSync(join(folder, '.claude'), { recursive: true })
        writeFileSync(join(folder, '.claude', 'settings.local.json'), empty)
        expect(world({ root, cwd: 'proj' }).plan, JSON.stringify(empty)).toHaveProperty('launch')
      }
      // a settings file that cannot even be looked at (its folder unsearchable): refused, never taken as not there
      if ((process.getuid?.() ?? 0) !== 0) {
        const root = tmp()
        const folder = join(root, 'home', 'proj')
        mkdirSync(join(folder, '.claude'), { recursive: true })
        writeFileSync(
          join(folder, '.claude', 'settings.json'),
          JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }),
        )
        chmodSync(join(folder, '.claude'), 0o600)
        try {
          expect(world({ root, cwd: 'proj' }).plan).toMatchObject({
            refused: { detail: expect.stringContaining('cannot be looked at (EACCES)') },
          })
        } finally {
          chmodSync(join(folder, '.claude'), 0o700)
        }
      }
    },
  )
  onCaseExactTmp(
    'a carried deny or ask rule this check cannot read refuses the start, never dropped (Codex on R1-3: fail closed)',
    () => {
      for (const [key, bad] of [
        ['deny', 'mcp__*'],
        ['deny', '*'],
        ['deny', 'Bash('],
        ['ask', 'mcp__*'],
      ] as const) {
        const root = tmp()
        const folder = join(root, 'home', 'proj')
        mkdirSync(join(folder, '.claude'), { recursive: true })
        writeFileSync(
          join(folder, '.claude', 'settings.json'),
          JSON.stringify({ permissions: { [key]: ['Bash(rm:*)', bad] } }),
        )
        const w = world({ root, cwd: 'proj' })
        expect(w.plan, `${key} ${bad}`).toMatchObject({
          refused: { detail: expect.stringContaining('permission rule') },
        })
        expect(
          w.audit.some(([e]) => e === 'worker_folder_rule_refused'),
          `${key} ${bad}`,
        ).toBe(true)
      }
    },
  )
  onCaseExactTmp(
    'a thread folder: the preamble and its instruction files, parent first, from the worker’s own file',
    () => {
      const root = tmp()
      const repo = join(root, 'home', 'repo')
      const folder = join(repo, 'sub')
      mkdirSync(join(repo, '.git'), { recursive: true })
      mkdirSync(folder)
      writeFileSync(join(repo, 'AGENTS.md'), 'ROOT-CODEWORD\n')
      writeFileSync(join(folder, 'CLAUDE.md'), 'SUB-CODEWORD\n')
      const w = world({ root, cwd: 'repo/sub' })
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      const file = join(w.talosHome, 'workers', 'trip', 'system-prompt.md')
      expect(w.plan.launch.argv).toContain(`--append-system-prompt-file=${file}`)
      expect(w.plan.launch.argv.some((a) => a.startsWith('--append-system-prompt='))).toBe(false)
      const text = readFileSync(file, 'utf8')
      expect(text).toContain(defaultPreamble('trip'))
      expect(text.indexOf('ROOT-CODEWORD')).toBeGreaterThan(text.indexOf(defaultPreamble('trip')))
      expect(text.indexOf('ROOT-CODEWORD')).toBeLessThan(text.indexOf('SUB-CODEWORD'))
    },
  )
  onCaseExactTmp(
    'every worker: no file-tool edit of a script the agent folder’s settings run, nor of its hooks/ and kit/hooks/',
    () => {
      const root = tmp()
      const agentDir = join(root, 'home', 'agent')
      mkdirSync(join(agentDir, '.claude'), { recursive: true })
      writeFileSync(
        join(agentDir, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/scripts/guard.py"' }] }],
          },
          statusLine: { type: 'command', command: `sh ${join(agentDir, 'bin', 'status.sh')}` },
        }),
      )
      const w = world({ root, cwd: 'proj' })
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      const deny: string[] = JSON.parse(w.plan.settingsJSON).permissions.deny
      for (const rel of ['scripts/guard.py', 'bin/status.sh', 'hooks/**', 'kit/hooks/**'])
        for (const tool of ['Edit']) expect(deny).toContain(`${tool}(/${agentDir}/${rel})`)
    },
  )
  onCaseExactTmp(
    'Main leaves out user settings (--setting-sources): a thread folder is refused, never a source Main does not load',
    () => {
      const w = world({ cwd: 'proj2', mainArgs: ['--permission-mode=default', '--setting-sources', 'project'] })
      expect('refused' in w.plan && w.plan.refused.detail).toContain(
        "Main's --setting-sources leaves out user settings",
      )
    },
  )
  onCaseExactTmp(
    'a start records the folder for the bridge’s check at each request, and denies edits of all it reads',
    () => {
      const w = world()
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      expect(JSON.parse(readFileSync(join(w.talosHome, 'workers', 'trip', 'project-check.json'), 'utf8'))).toEqual({
        v: 1,
        folders: [{ folder: w.agentDir, agent_folder: true }],
        sources: null,
      })
      const deny: string[] = JSON.parse(w.plan.settingsJSON).permissions.deny
      const home = join(w.root, 'home')
      for (const r of [
        `Edit(/${w.agentDir}/.claude/**)`,
        `Edit(/${w.agentDir}/.mcp.json)`,
        `Edit(/${w.agentDir}/.env*)`,
        `Edit(/${home}/.claude/settings.json)`,
        `Edit(/${home}/.claude/skills/**)`,
        `Edit(/${home}/.claude.json)`,
      ])
        expect(deny).toContain(r)
    },
  )
  onCaseExactTmp(
    'a start records real paths only: a thread folder named through a link is recorded as where it leads',
    () => {
      // the bridge compares what a start recorded as strings at each request (hub/server.ts recheckSettings), so a start must
      // never record a path a link stands in: the folder is resolved before anything is checked or launched
      const root = tmp()
      mkdirSync(join(root, 'home', 'proj-real'), { recursive: true })
      symlinkSync(join(root, 'home', 'proj-real'), join(root, 'home', 'proj-link'))
      const w = world({ root, cwd: 'proj-link' })
      if (!('launch' in w.plan)) throw new Error(JSON.stringify(w.plan))
      const rec = JSON.parse(readFileSync(join(w.talosHome, 'workers', 'trip', 'project-check.json'), 'utf8'))
      expect(rec.folders.map((f: { folder: string }) => f.folder)).toEqual([
        realpathSync(join(root, 'home', 'proj-real')),
      ])
      for (const f of rec.folders as Array<{ folder: string }>) expect(realpathSync(f.folder)).toBe(f.folder)
    },
  )
  it('no sealed kit release: refused, with the one command that installs one', () => {
    const vendor = join(tmp(), 'kit')
    const w = world({ kitVendor: vendor })
    expect('refused' in w.plan && w.plan.refused.hookMissing).toBe(
      `this install has no sealed kit release (${join(vendor, 'current')}); install a sealed release with: ${installReleaseCommand(vendor)}`,
    )
    expect(existsSync(join(w.talosHome, 'workers', '_hook'))).toBe(false)
  })
  describe('on a Talos distro (root keeps the kit): root’s file runs where it is, never a copy (Fable R2-3)', () => {
    const saved = { ...ROOTED_KIT }
    afterEach(() => Object.assign(ROOTED_KIT, saved))
    /** A Talos distro whose "root" is this test's own uid: the marker, /etc/talos/kit-release, root's kit in the box. */
    function rootedDistro() {
      const box = tmp()
      mkdirSync(join(box, 'talos-wsl'))
      chmodSync(join(box, 'talos-wsl'), 0o755)
      writeFileSync(join(box, 'talos-wsl', 'marker'), 'talos\n')
      chmodSync(join(box, 'talos-wsl', 'marker'), 0o644)
      mkdirSync(join(box, 'etc-talos'))
      chmodSync(join(box, 'etc-talos'), 0o755)
      const vendor = sealedRelease({ fresh: true }) // removed by cleanupReleases, never with the box
      mkdirSync(join(vendor, '.claude-plugin'), { mode: 0o755 })
      writeFileSync(join(vendor, '.claude-plugin', 'marketplace.json'), KIT_MARKETPLACE)
      chmodSync(join(vendor, '.claude-plugin', 'marketplace.json'), 0o444)
      const plugin = join(vendor, 'current', 'talos-kit')
      const record = { v: 1, version: '9.9.9-test', content_sha256: releaseContentSha(plugin) }
      writeFileSync(join(box, 'etc-talos', 'kit-release'), JSON.stringify(record))
      chmodSync(join(box, 'etc-talos', 'kit-release'), 0o644)
      mkdirSync(join(box, 'claude-code'))
      chmodSync(join(box, 'claude-code'), 0o755)
      writeFileSync(join(box, 'claude-code', 'managed-settings.json'), MANAGED_SETTINGS)
      chmodSync(join(box, 'claude-code', 'managed-settings.json'), 0o644)
      Object.assign(ROOTED_KIT, {
        managed: join(box, 'claude-code', 'managed-settings.json'),
        marker: join(box, 'talos-wsl', 'marker'),
        etc: join(box, 'etc-talos'),
        vendor,
        root: process.getuid?.() ?? 0,
      })
      return { vendor }
    }
    onCaseExactTmp('the settings run root’s own file, by its real path, and no copy is made in the Talos home', () => {
      const { vendor } = rootedDistro()
      const w = world({ kitVendor: sealedRelease() }) // the home kit is named, and never used
      expect('refused' in w.plan ? w.plan.refused : null).toBeNull()
      const settings = JSON.parse('settingsJSON' in w.plan ? w.plan.settingsJSON : '{}')
      const roots = join(realpathSync(vendor), 'releases', '9.9.9-test', 'talos-kit', 'hooks', 'permission-relay.py')
      expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain(`f='${roots}';`)
      expect(existsSync(join(workerHookDir(w.talosHome), 'permission-relay.py'))).toBe(false)
    })
    onCaseExactTmp('a guards file, whatever it holds: the start is refused, naming the file (Fable R3-1, R4-1)', () => {
      rootedDistro()
      // a hook, or only a mode (which also sets Main's ceiling, so the ceiling cannot hold it): present at all, refused
      for (const body of [
        { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/true' }] }] } },
        { permissions: { defaultMode: 'bypassPermissions' } },
      ]) {
        const root = tmp()
        const guards = join(root, 'home', '.talos', 'guards')
        mkdirSync(guards, { recursive: true })
        writeFileSync(join(guards, 'settings.json'), JSON.stringify(body))
        const w = world({ root })
        const why = 'refused' in w.plan ? w.plan.refused.detail : `started: ${JSON.stringify(w.plan).slice(0, 80)}`
        expect(why).toContain(`the guards file ${join(guards, 'settings.json')} is there`)
      }
    })
    onCaseExactTmp('a hook that is not root’s own file (a copy in the Talos home): the start is refused', () => {
      rootedDistro()
      // the test seam names a hook outside root's kit: it is copied into the Talos home as before, and that copy never runs
      const w = world({ permissionHook: releaseSource() })
      const why = 'refused' in w.plan ? w.plan.refused.detail : `started: ${JSON.stringify(w.plan).slice(0, 80)}`
      expect(why).toContain("it must be root's own, under")
    })
  })
  it('the release’s hook copies into the fenced Talos home on any temp folder (a Mac’s too)', () => {
    const talosHome = join(tmp(), '.talos')
    mkdirSync(talosHome)
    const got = installWorkerHook(talosHome, releaseSource(), { PATH: '/usr/bin:/bin' })
    expect('problem' in got ? got.problem : null).toBeNull()
    expect(readFileSync(join(workerHookDir(talosHome), 'permission-relay.py'), 'utf8')).toBe(
      readFileSync(releaseSource(), 'utf8'),
    )
  })
  // a launch needs a case-exact temp folder: the fence refuses a case-folding one (a Mac's), as every launch test above
  onCaseExactTmp(
    'the default is the sealed release’s hook, copied into the fenced Talos home, and the session’s settings run that copy',
    () => {
      const w = world()
      // the refusal itself, when there is one, so a failure says why
      expect('refused' in w.plan ? w.plan.refused : null).toBeNull()
      const settings = JSON.parse('settingsJSON' in w.plan ? w.plan.settingsJSON : '{}')
      const copy = join(workerHookDir(w.talosHome), 'permission-relay.py')
      expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain(`f='${copy}';`)
      expect(readFileSync(copy, 'utf8')).toBe(readFileSync(releaseSource(), 'utf8'))
    },
  )
})

describe('Main’s mode for the ceiling, with Main’s own --settings (never wider than Main runs)', () => {
  function home() {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    const claudeDir = join(userHome, '.claude')
    for (const d of [agentDir, join(talosHome, 'guards'), claudeDir]) mkdirSync(d, { recursive: true })
    const put = (p: string, mode: unknown) => writeFileSync(p, JSON.stringify({ permissions: { defaultMode: mode } }))
    const audits: Array<[string, Record<string, string> | undefined]> = []
    const ceiling = (args: string[]) =>
      mainCeiling({
        talosHome,
        userHome,
        agentDir,
        claudeDir,
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => args,
        managedDir: NO_MANAGED,
        threadFolders: () => [],
        audit: (e, f) => audits.push([e, f]),
      }).defaultMode
    return { root, agentDir, talosHome, claudeDir, put, ceiling, audits }
  }
  it('the guards’ file is not read when Main has its own --settings (it is not Main’s then)', () => {
    const h = home()
    h.put(join(h.talosHome, 'guards', 'settings.json'), 'bypassPermissions')
    h.put(join(h.claudeDir, 'settings.json'), 'default')
    writeFileSync(join(h.root, 'own.json'), '{}')
    expect(h.ceiling(['--settings', join(h.root, 'own.json')])).toBe('default')
    expect(h.ceiling([])).toBe('bypassPermissions') // with none, the guards' file is Main's --settings
  })
  it('a mode in Main’s own --settings is Main’s mode: narrower than the user’s, the ceiling is narrower', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), 'acceptEdits')
    h.put(join(h.root, 'own.json'), 'plan')
    expect(h.ceiling([`--settings=${join(h.root, 'own.json')}`])).toBe('plan')
    // relative to Main's folder, the agent folder; and given inline
    h.put(join(h.agentDir, 'rel.json'), 'plan')
    expect(h.ceiling(['--settings', 'rel.json'])).toBe('plan')
    expect(h.ceiling(['--settings', '{"permissions":{"defaultMode":"plan"}}'])).toBe('plan')
    // the last --settings is the one Main runs with
    expect(h.ceiling(['--settings', join(h.root, 'nope.json'), '--settings', join(h.root, 'own.json')])).toBe('plan')
  })
  it('one with no mode falls through to the project’s and the user’s, as Claude Code does', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), 'acceptEdits')
    writeFileSync(join(h.root, 'own.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }))
    expect(h.ceiling(['--settings', join(h.root, 'own.json')])).toBe('acceptEdits')
    expect(h.audits).toEqual([])
  })
  it('one that cannot be read is never guessed at: the narrowest mode (plan, below default), said in the audit log', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), 'acceptEdits')
    writeFileSync(join(h.root, 'bad.json'), '{not json')
    writeFileSync(join(h.root, 'list.json'), '[]')
    h.put(join(h.root, 'num.json'), 7)
    for (const f of ['missing.json', 'bad.json', 'list.json', 'num.json'])
      expect([f, h.ceiling(['--settings', join(h.root, f)])]).toEqual([f, 'plan'])
    expect(h.ceiling(['--settings', '{oops}'])).toBe('plan') // inline as Claude Code takes it: { ... }
    expect(h.audits.length).toBe(5)
    expect(h.audits[0]).toEqual([
      'worker_ceiling_narrowed',
      { why: 'main_settings_unreadable', settings: join(h.root, 'missing.json') },
    ])
    // never the inline text itself in the log
    expect(h.audits[4]?.[1]?.settings).toBe('the settings given inline')
  })
  it('a mode Claude Code does not know, from any file, ranks as the narrowest for Main, never the widest', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), 'yolo')
    expect(h.ceiling([])).toBe('plan')
    expect(h.audits).toEqual([['worker_ceiling_narrowed', { why: 'unknown_mode', mode: 'yolo' }]])
    // a misspelled mode in the project over a user’s plan: Main runs in plan (Claude Code skips the bad one), never wider
    h.put(join(h.claudeDir, 'settings.json'), 'plan')
    mkdirSync(join(h.agentDir, '.claude'), { recursive: true })
    h.put(join(h.agentDir, '.claude', 'settings.local.json'), 'Plan')
    expect(h.ceiling([])).toBe('plan')
  })
  it('the deny rules in Main’s own --settings are in the ceiling, made absolute where they were defined', () => {
    const h = home()
    mkdirSync(join(h.root, 'cfg'))
    writeFileSync(
      join(h.root, 'cfg', 'own.json'),
      JSON.stringify({ permissions: { deny: ['Read(./secrets/**)', 'Read(/notes/**)', 'Bash(curl:*)', 7] } }),
    )
    const deny = (args: string[]) =>
      mainCeiling({
        talosHome: h.talosHome,
        userHome: join(h.root, 'home'),
        agentDir: h.agentDir,
        claudeDir: h.claudeDir,
        resolveClaude: () => '/usr/bin/claude',
        mainArgs: () => args,
        managedDir: NO_MANAGED,
        threadFolders: () => [],
      }).denyRules
    const d = deny(['--settings', join(h.root, 'cfg', 'own.json')])
    expect(d).toContain(`Read(/${h.agentDir}/secrets/**)`) // relative: Main's folder
    expect(d).toContain(`Read(/${join(h.root, 'cfg')}/notes/**)`) // /-rooted: the file's own folder
    expect(d).toContain('Bash(curl:*)')
    // inline: rooted at the agent folder
    expect(deny(['--settings', '{"permissions":{"deny":["Read(/x/**)"]}}'])).toContain(`Read(/${h.agentDir}/x/**)`)
    // a deny that is not a list: the settings cannot be read (never "no rules")
    writeFileSync(join(h.root, 'cfg', 'bad.json'), JSON.stringify({ permissions: { deny: 'Read(**)' } }))
    expect(h.ceiling(['--settings', join(h.root, 'cfg', 'bad.json')])).toBe('plan')
  })
  it('a --settings reached through a link roots its /-rules at the folder the file really is in (as Claude Code does)', () => {
    const h = home()
    mkdirSync(join(h.root, 'dotfiles'))
    writeFileSync(
      join(h.root, 'dotfiles', 'main.json'),
      JSON.stringify({ permissions: { deny: ['Read(/secrets/**)'] } }),
    )
    symlinkSync(join(h.root, 'dotfiles', 'main.json'), join(h.agentDir, 'main.json'))
    const c = mainCeiling({
      talosHome: h.talosHome,
      userHome: join(h.root, 'home'),
      agentDir: h.agentDir,
      claudeDir: h.claudeDir,
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--settings', 'main.json'],
      managedDir: NO_MANAGED,
      threadFolders: () => [],
    })
    expect(c.denyRules).toContain(`Read(/${join(h.root, 'dotfiles')}/secrets/**)`)
    expect(c.denyRules).not.toContain(`Read(/${h.agentDir}/secrets/**)`)
  })
  it('a start reads Main’s arguments and its own --settings once: the refusal and the ceiling see the same read', () => {
    const h = home()
    const own = join(h.root, 'own.json')
    writeFileSync(own, JSON.stringify({ permissions: { deny: ['Read(//etc/secret)'] } }))
    let reads = 0
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome: h.talosHome,
      userHome: join(h.root, 'home'),
      agentDir: h.agentDir,
      claudeDir: h.claudeDir,
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => {
        reads++
        return ['--settings', own]
      },
      managedDir: NO_MANAGED,
    })
    planner({
      thread: { id: 'trip', cwd: h.agentDir, model: 'inherit', effort: null, parentCwd: null },
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      nonce: 'ab'.repeat(16),
      baseEnv: { PATH: '/usr/bin', HOME: join(h.root, 'home') },
    })
    expect(reads).toBe(1)
  })
  it('inline settings: their /-rules also rooted where Claude Code writes them (<tmp>/claude-<uid>); a whole-tool deny stays whole', () => {
    const h = home()
    const c = mainCeiling({
      talosHome: h.talosHome,
      userHome: join(h.root, 'home'),
      agentDir: h.agentDir,
      claudeDir: h.claudeDir,
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--settings', '{"permissions":{"deny":["Read(/x/**)","Edit(*)"]}}'],
      managedDir: NO_MANAGED,
      threadFolders: () => [],
    })
    const uid = process.getuid?.()
    if (uid !== undefined) expect(c.denyRules).toContain(`Read(/${join(tmpdir(), `claude-${uid}`)}/x/**)`)
    expect(c.denyRules).toContain('Edit(*)')
  })
  it('a --settings that is not a regular file (a FIFO) is never read: no hang, unreadable', () => {
    const h = home()
    const fifo = join(h.root, 'pipe')
    execFileSync('mkfifo', [fifo])
    const t0 = Date.now()
    expect(h.ceiling(['--settings', fifo])).toBe('plan')
    expect(h.ceiling(['--settings', h.root])).toBe('plan') // a folder
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('a start while Main’s own --settings cannot be read (refused, never guessed)', () => {
  function world() {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    const trip = join(userHome, 'trip')
    for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
    const own = join(root, 'own.json')
    const audits: Array<[string, Record<string, string> | undefined]> = []
    const planner = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome,
      userHome,
      agentDir,
      claudeDir: join(userHome, '.claude'),
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--settings', own],
      managedDir: NO_MANAGED,
      audit: (e, f) => audits.push([e, f]),
    })
    const plan = () =>
      planner({
        thread: { id: 'trip', cwd: trip, model: 'inherit', effort: null, parentCwd: null },
        sessionId: '11111111-2222-3333-4444-555555555555',
        resume: false,
        nonce: 'ab'.repeat(16),
        baseEnv: { PATH: '/usr/bin', HOME: userHome },
      })
    return { talosHome, own, plan, audits }
  }
  onCaseExactTmp(
    'refused with the file named, nothing written; once the file is readable the next start just works',
    () => {
      const w = world()
      const p = w.plan()
      expect(p).toMatchObject({ refused: { code: 'start_failed', mainSettingsUnreadable: w.own } })
      expect(existsSync(join(w.talosHome, 'workers', 'trip', 'settings.json'))).toBe(false)
      expect(w.audits).toContainEqual([
        'worker_start_refused',
        { thread: 'trip', why: 'main_settings_unreadable', settings: w.own },
      ])
      writeFileSync(w.own, JSON.stringify({ permissions: { defaultMode: 'plan', deny: ['Bash(curl:*)'] } }))
      const q = w.plan()
      if ('refused' in q) throw new Error(q.refused.detail)
      expect(JSON.parse(q.settingsJSON).permissions.defaultMode).toBe('plan')
      expect(JSON.parse(q.settingsJSON).permissions.deny).toContain('Bash(curl:*)')
    },
  )
})

describe('the ceiling under managed settings and --setting-sources (what Main really runs under)', () => {
  function home() {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    const claudeDir = join(userHome, '.claude')
    const managedDir = join(root, 'managed')
    for (const d of [agentDir, join(agentDir, '.claude'), talosHome, claudeDir, join(managedDir, 'managed-settings.d')])
      mkdirSync(d, { recursive: true })
    const put = (p: string, permissions: unknown) => writeFileSync(p, JSON.stringify({ permissions }))
    const inputs = (args: string[]) => ({
      talosHome,
      userHome,
      agentDir,
      claudeDir,
      managedDir,
      threadFolders: () => [],
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => args,
    })
    const ceiling = (args: string[] = [], env: Record<string, string> = {}) =>
      mainCeiling(inputs(args), mainRead(inputs(args), env))
    return { root, agentDir, claudeDir, managedDir, put, ceiling }
  }
  it('a managed mode outranks the user’s: a managed plan makes the ceiling plan, not the user’s acceptEdits', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'acceptEdits' })
    h.put(join(h.managedDir, 'managed-settings.json'), { defaultMode: 'plan' })
    expect(h.ceiling().defaultMode).toBe('plan')
    // several managed documents: the narrowest of the modes they name
    h.put(join(h.managedDir, 'managed-settings.json'), { defaultMode: 'acceptEdits' })
    h.put(join(h.managedDir, 'managed-settings.d', '10-org.json'), { defaultMode: 'default' })
    expect(h.ceiling().defaultMode).toBe('default')
  })
  it('managed deny rules are in the ceiling, from the file and the drop-in folder', () => {
    const h = home()
    h.put(join(h.managedDir, 'managed-settings.json'), { deny: ['Bash(curl:*)', 'Edit(*)'] })
    h.put(join(h.managedDir, 'managed-settings.d', '20-x.json'), { deny: ['Read(//etc/secret)'] })
    writeFileSync(join(h.managedDir, 'managed-settings.d', 'notes.txt'), 'not settings')
    const deny = h.ceiling().denyRules
    expect(deny).toEqual(expect.arrayContaining(['Bash(curl:*)', 'Edit(*)', 'Read(//etc/secret)']))
  })
  it('--setting-sources that leaves the user out: the user’s mode is not Main’s, so not the ceiling’s', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'acceptEdits' })
    expect(h.ceiling().defaultMode).toBe('acceptEdits')
    expect(h.ceiling(['--setting-sources', 'project,local']).defaultMode).toBeNull()
    expect(h.ceiling(['--setting-sources=project']).defaultMode).toBeNull()
    // a project mode still counts when the project is loaded, and not when it is left out
    h.put(join(h.agentDir, '.claude', 'settings.json'), { defaultMode: 'plan' })
    expect(h.ceiling(['--setting-sources', 'project']).defaultMode).toBe('plan')
    expect(h.ceiling(['--setting-sources', 'user']).defaultMode).toBe('acceptEdits')
  })
  it('a managed mode Claude Code cannot read stands as default, never set aside for a wider one (its substitute)', () => {
    const h = home()
    h.put(join(h.managedDir, 'managed-settings.json'), { defaultMode: 'bypassPermissions' })
    h.put(join(h.managedDir, 'managed-settings.d', '10.json'), { defaultMode: 'bogus' })
    expect(h.ceiling().defaultMode).toBe('default')
    h.put(join(h.managedDir, 'managed-settings.d', '10.json'), { defaultMode: 5 })
    expect(h.ceiling().defaultMode).toBe('default')
    // a deny list it cannot read withholds the mode next to it
    h.put(join(h.managedDir, 'managed-settings.d', '10.json'), {})
    h.put(join(h.managedDir, 'managed-settings.json'), { defaultMode: 'bypassPermissions', deny: 'Bash' })
    expect(h.ceiling().defaultMode).toBe('default')
  })
  it('a higher managed source this cannot see may set the file aside: never wider than the ordinary chain', () => {
    const h = home()
    h.put(join(h.managedDir, 'managed-settings.json'), { defaultMode: 'acceptEdits' })
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'default' })
    expect(h.ceiling().defaultMode).toBe('default')
  })
  it('bypass ruled out by managed settings or --restricted: the bypass flags are not Main’s mode', () => {
    const h = home()
    h.put(join(h.managedDir, 'managed-settings.json'), { disableBypassPermissionsMode: 'disable' })
    const args = ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--name', 'x']
    expect(h.ceiling(args).permissionArgs).toEqual(['--name', 'x'])
    rmSync(join(h.managedDir, 'managed-settings.json'))
    expect(h.ceiling(['--restricted', '--dangerously-skip-permissions']).permissionArgs).toEqual(['--restricted'])
    // restricted reads no user, project or local settings
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'acceptEdits' })
    expect(h.ceiling(['--restricted']).defaultMode).toBeNull()
  })
  it('arguments are read as Claude Code reads them: nothing after --, and no flag’s value taken for a flag', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'plan' })
    // after --: the prompt, not settings
    expect(h.ceiling(['--', '--settings', '{"permissions":{"defaultMode":"bypassPermissions"}}']).defaultMode).toBe(
      'plan',
    )
    expect(h.ceiling(['--', '--setting-sources', 'project']).defaultMode).toBe('plan')
    // the value of another flag
    expect(h.ceiling(['--append-system-prompt', '--setting-sources=project']).defaultMode).toBe('plan')
  })
  it('a dotfile in managed-settings.d is not read (Claude Code skips it)', () => {
    const h = home()
    h.put(join(h.managedDir, 'managed-settings.d', '.hidden.json'), { defaultMode: 'plan', deny: ['Bash(x:*)'] })
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'acceptEdits' })
    const c = h.ceiling()
    expect(c.defaultMode).toBe('acceptEdits')
    expect(c.denyRules).not.toContain('Bash(x:*)')
  })
  it('bypass ruled out clamps a bypass mode from settings too, and is read as Claude Code reads the switch', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'bypassPermissions' })
    h.put(join(h.managedDir, 'managed-settings.json'), { disableBypassPermissionsMode: 'disable' })
    expect(h.ceiling().defaultMode).toBe('default')
    // any value but false, and a permissions value it cannot read, are the restrictive value
    h.put(join(h.managedDir, 'managed-settings.json'), { disableBypassPermissionsMode: true })
    expect(h.ceiling(['--dangerously-skip-permissions']).permissionArgs).toEqual([])
    writeFileSync(join(h.managedDir, 'managed-settings.json'), JSON.stringify({ permissions: 'oops' }))
    expect(h.ceiling(['--dangerously-skip-permissions']).permissionArgs).toEqual([])
    // and from a source Main loads, not only managed files
    rmSync(join(h.managedDir, 'managed-settings.json'))
    writeFileSync(
      join(h.claudeDir, 'settings.json'),
      JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable', defaultMode: 'acceptEdits' } }),
    )
    expect(h.ceiling(['--dangerously-skip-permissions']).permissionArgs).toEqual([])
    expect(h.ceiling(['--dangerously-skip-permissions']).defaultMode).toBe('acceptEdits')
  })
  it('with two --permission-mode flags the last counts: if it is bypass and bypass is ruled out, Main falls past both', () => {
    const h = home()
    h.put(join(h.managedDir, 'managed-settings.json'), { disableBypassPermissionsMode: 'disable' })
    const args = ['--permission-mode', 'acceptEdits', '--permission-mode', 'bypassPermissions']
    expect(h.ceiling(args).permissionArgs).toEqual([])
  })
  it('a flag whose value is optional takes the next word only when it is not a flag (--resume --settings x)', () => {
    const h = home()
    const own = join(h.agentDir, 'own.json')
    writeFileSync(own, JSON.stringify({ permissions: { defaultMode: 'plan', deny: ['Bash(curl:*)'] } }))
    const c = h.ceiling(['--resume', '--settings', own])
    expect(c.defaultMode).toBe('plan')
    expect(c.denyRules).toContain('Bash(curl:*)')
    // a value that is not a flag is --resume's own
    expect(h.ceiling(['--resume', 'abc', '--settings', own]).defaultMode).toBe('plan')
  })
  it('--restricted is read as Claude Code reads it: not as another flag’s value, not after --', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'plan' })
    expect(h.ceiling(['--append-system-prompt', '--restricted']).defaultMode).toBe('plan')
    expect(h.ceiling(['--', '--restricted']).defaultMode).toBe('plan')
    expect(h.ceiling(['--restricted']).defaultMode).toBeNull()
  })
  it('an unknown mode from the ordinary chain keeps its plan fallback and audit line, managed settings or not', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'yolo' })
    h.put(join(h.managedDir, 'managed-settings.json'), { defaultMode: 'acceptEdits' })
    expect(h.ceiling().defaultMode).toBe('plan')
  })
  it('CLAUDE_CODE_RESTRICTED in Main’s environment (the owner’s env) is restricted mode: no user settings, no bypass', () => {
    const h = home()
    h.put(join(h.claudeDir, 'settings.json'), { defaultMode: 'acceptEdits' })
    expect(h.ceiling([], { CLAUDE_CODE_RESTRICTED: '1' }).defaultMode).toBeNull()
    expect(h.ceiling(['--dangerously-skip-permissions'], { CLAUDE_CODE_RESTRICTED: 'true' }).permissionArgs).toEqual([])
    expect(h.ceiling([], { CLAUDE_CODE_RESTRICTED: '0' }).defaultMode).toBe('acceptEdits')
    expect(h.ceiling([]).defaultMode).toBe('acceptEdits')
  })
  it('inline /-rules are rooted at Main’s own temp folders too (its TMPDIR, its CLAUDE_CODE_TMPDIR), with claude-<uid>', () => {
    const h = home()
    const env = { TMPDIR: join(h.root, 'main-tmp'), CLAUDE_CODE_TMPDIR: join(h.root, 'cc-tmp') }
    const deny = h.ceiling(['--settings', '{"permissions":{"deny":["Read(/x/**)"]}}'], env).denyRules
    const uid = process.getuid?.()
    for (const t of [env.TMPDIR, env.CLAUDE_CODE_TMPDIR]) {
      expect(deny).toContain(`Read(/${t}/x/**)`)
      if (uid !== undefined) expect(deny).toContain(`Read(/${join(t, `claude-${uid}`)}/x/**)`)
    }
  })
  it('Main’s temp folder as Bun picks it: TMPDIR, else TMP, else TEMP', () => {
    const h = home()
    const deny = h.ceiling(['--settings', '{"permissions":{"deny":["Read(/x/**)"]}}'], {
      TMP: join(h.root, 'tmp2'),
    }).denyRules
    expect(deny).toContain(`Read(/${join(h.root, 'tmp2')}/x/**)`)
  })
})

describe('a thread session never starts under a restricted Main (it could not be held to it)', () => {
  const inputs = (args: string[], mainEnv?: Record<string, string>) => ({
    kitVendor: sealedRelease(),
    talosHome: '/home/alex/.talos',
    userHome: '/home/alex',
    agentDir: '/home/alex/agent',
    claudeDir: '/home/alex/.claude',
    managedDir: NO_MANAGED,
    threadFolders: () => [],
    resolveClaude: () => '/usr/bin/claude',
    mainArgs: () => args,
    ...(mainEnv ? { mainEnv: () => mainEnv } : {}),
  })
  it('restricted by its flag or by the environment it runs under: refused, and said', () => {
    expect(mainSettingsRefusal(inputs(['--restricted']), 'trip')).toMatchObject({
      code: 'start_failed',
      mainRestricted: expect.stringContaining('restricted mode'),
    })
    const i = inputs([])
    expect(mainSettingsRefusal(i, 'trip', mainRead(i, { CLAUDE_CODE_RESTRICTED: 'on' }))).toMatchObject({
      mainRestricted: expect.stringContaining('restricted mode'),
    })
    expect(mainSettingsRefusal(i, 'trip', mainRead(i, {}))).toBeNull()
  })
  it('the planner reads the environment Main was started with, ahead of its own read of it', () => {
    const plan = workerPlanner(inputs([], { CLAUDE_CODE_RESTRICTED: '1' }))({
      thread: { id: 'trip', cwd: '/home/alex/agent', model: 'inherit', effort: null, parentCwd: null },
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      nonce: 'ab'.repeat(16),
      baseEnv: { PATH: '/usr/bin' }, // the planner's own read says nothing: Main's says restricted
    })
    expect(plan).toMatchObject({
      refused: { code: 'start_failed', mainRestricted: expect.stringContaining('restricted mode') },
    })
  })
  it('every mode that narrows Main without reaching its workers refuses the start, naming it', () => {
    const i = inputs([])
    const cases: Array<[string[], Record<string, string>, string]> = [
      [[], { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: 'yes' }, 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG'],
      [['--safe-mode'], {}, 'safe mode'],
      [[], { CLAUDE_CODE_SAFE_MODE: '1' }, 'safe mode'],
      [['--bare'], {}, 'bare mode'],
      [[], { CLAUDE_CODE_SIMPLE: 'true' }, 'bare mode'],
    ]
    for (const [args, env, said] of cases) {
      const j = inputs(args)
      expect([args, env, mainSettingsRefusal(j, 'trip', mainRead(j, env))?.mainRestricted]).toEqual([
        args,
        env,
        expect.stringContaining(said),
      ])
    }
    expect(mainSettingsRefusal(i, 'trip', mainRead(i, { CLAUDE_CODE_SAFE_MODE: '0' }))).toBeNull()
  })
  it('an adopted Main whose environment cannot be known: nothing is guessed, no thread session starts', () => {
    const i = inputs([])
    expect(mainSettingsRefusal(i, 'trip', mainRead(i, MAIN_ENV_UNKNOWN))).toMatchObject({
      code: 'start_failed',
      mainRestricted: expect.stringContaining("can't read"),
    })
  })
})

describe('the ceiling’s .claude.json is Main’s own, from the environment Main runs under', () => {
  it('a CLAUDE_CONFIG_DIR only the planner’s environment has (set since Main started) never widens the ceiling', () => {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const mainDir = join(userHome, '.claude')
    const later = join(root, 'later')
    for (const d of [agentDir, mainDir, later]) mkdirSync(d, { recursive: true })
    writeFileSync(join(userHome, '.claude.json'), JSON.stringify({ mcpServers: { mains: { command: 'm' } } }))
    writeFileSync(join(later, '.claude.json'), JSON.stringify({ mcpServers: { later: { command: 'l' } } }))
    const i = {
      talosHome: join(userHome, '.talos'),
      userHome,
      agentDir,
      claudeDir: later, // the planner's: CLAUDE_CONFIG_DIR=later in today's settings
      configHome: later,
      claudeDirOf: (env: Record<string, string>) => env.CLAUDE_CONFIG_DIR || mainDir,
      managedDir: NO_MANAGED,
      threadFolders: () => [],
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => [],
    }
    const servers = mainCeiling(i, mainRead(i, {})).mcpServers // Main runs without it
    expect(servers).toContain('mains')
    expect(servers).not.toContain('later')
  })
  it('a CLAUDE_CONFIG_DIR that is not an absolute path refuses the start (each session would read its own folder’s)', () => {
    const i = {
      talosHome: '/home/alex/.talos',
      userHome: '/home/alex',
      agentDir: '/home/alex/agent',
      claudeDir: '/home/alex/.claude',
      managedDir: NO_MANAGED,
      threadFolders: () => [],
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => [],
    }
    for (const dir of ['cfg', '~/.claude', './x'])
      expect([dir, mainSettingsRefusal(i, 'trip', mainRead(i, { CLAUDE_CONFIG_DIR: dir }))?.mainRestricted]).toEqual([
        dir,
        expect.stringContaining('not an absolute path'),
      ])
    expect(mainSettingsRefusal(i, 'trip', mainRead(i, { CLAUDE_CONFIG_DIR: '/home/alex/cfg' }))).toBeNull()
  })
  it('the worker’s own environment is checked too, and a Main running with one is a mode its sessions are parked for', () => {
    const plan = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome: '/home/alex/.talos',
      userHome: '/home/alex',
      agentDir: '/home/alex/agent',
      claudeDir: '/home/alex/.claude',
      managedDir: NO_MANAGED,
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => [],
      mainEnv: () => ({}), // Main started with none
    })({
      thread: { id: 'trip', cwd: '/home/alex/agent', model: 'inherit', effort: null, parentCwd: null },
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      nonce: 'ab'.repeat(16),
      baseEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: 'cfg' }, // set since: the worker would run with it
    })
    expect(plan).toMatchObject({
      refused: { code: 'start_failed', mainRestricted: expect.stringContaining('absolute') },
    })
    expect(mainNarrowedMode([], { CLAUDE_CONFIG_DIR: '~/x' })).toContain('not an absolute path')
    expect(mainNarrowedMode([], { CLAUDE_CONFIG_DIR: '/x' })).toBeNull()
  })
})

describe('the extra lock’s check runs again right before the session starts', () => {
  function plan(osSandbox: boolean | 'kept_on') {
    const root = tmp()
    const userHome = join(root, 'home')
    const agentDir = join(userHome, 'agent')
    const talosHome = join(userHome, '.talos')
    const trip = join(userHome, 'trip')
    for (const d of [agentDir, talosHome, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
    writeFileSync(join(talosHome, 'devices.json'), '{}', { mode: 0o600 })
    const p = workerPlanner({
      threadFolders: () => [],
      kitVendor: sealedRelease(),
      talosHome,
      userHome,
      agentDir,
      claudeDir: join(userHome, '.claude'),
      resolveClaude: () => '/usr/bin/claude',
      mainArgs: () => ['--permission-mode=default'],
      managedDir: NO_MANAGED,
      osSandbox: () => osSandbox,
    })({
      thread: { id: 'trip', cwd: trip, model: 'inherit', effort: null, parentCwd: null },
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      nonce: 'ab'.repeat(16),
      baseEnv: { PATH: '/usr/bin', HOME: userHome, TALOS_APP_BRIDGE: '1' },
    })
    if ('refused' in p) throw new Error(p.refused.detail)
    return { launch: p.launch, talosHome, root, lockNote: p.lockNote }
  }
  onCaseExactTmp('a link made after the plan and before the start is refused; clear before it', () => {
    const { launch, talosHome, root } = plan(true)
    expect(launch.beforeStart).toBeDefined()
    expect(launch.beforeStart?.()).toBeNull()
    linkSync(join(talosHome, 'devices.json'), join(root, 'extra'))
    expect(launch.beforeStart?.()).toContain('has another name')
  })
  onCaseExactTmp(
    'config.json unreadable with the lock on before: it stays on for the launch and the plan carries the owner’s line',
    () => {
      const p = plan('kept_on')
      expect(p.launch.beforeStart).toBeDefined()
      expect(p.lockNote).toBe("Talos couldn't read its settings, so the extra lock stays on")
      expect(plan(true).lockNote).toBeUndefined()
    },
  )
  onCaseExactTmp(
    'config.json unreadable and the lock never on: the launch has no lock and the plan carries no line',
    () => {
      const w = mkdtempSync(join(realpathSync(tmpdir()), 'talos-osbx-lockoff-'))
      const said: string[] = []
      try {
        writeFileSync(join(w, 'config.json'), '{ nope')
        expect(osSandboxForStart(w, (e, f) => said.push(`${e} ${f?.lock}`))).toBe(false)
        expect(said).toEqual(['os_sandbox_config_unreadable kept off'])
        const p = plan(false)
        expect(p.launch.beforeStart).toBeUndefined()
        expect(p.lockNote).toBeUndefined()
        // and with a good reading of "on" before it: kept on, audited as such
        writeFileSync(join(w, 'config.json'), '{"os_sandbox": true}')
        expect(osSandboxForStart(w, () => {})).toBe(true)
        writeFileSync(join(w, 'config.json'), '')
        said.length = 0
        expect(osSandboxForStart(w, (e, f) => said.push(`${e} ${f?.lock}`))).toBe('kept_on')
        expect(said).toEqual(['os_sandbox_config_unreadable kept on'])
      } finally {
        rmSync(w, { recursive: true, force: true })
      }
    },
  )
  onCaseExactTmp('with the switch off the launch carries no re-check', () => {
    expect(plan(false).launch.beforeStart).toBeUndefined()
  })
})
