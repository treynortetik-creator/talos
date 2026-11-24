// A thread's own live state file: what the generated settings register for it (SessionStart and PreCompact, the one edit it may
// make without a prompt), the seed the start makes, and the hook command run for real. Temp folders; nothing is launched.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
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
import { join, posix } from 'node:path'
import { seedThreadState, threadStatePath, threadStateTemplate } from '../../src/supervisor/thread-state-seed.ts'
import { PYTHON_RULES, STATE_HOOK, workerHookDir } from '../../src/supervisor/worker-hook.ts'
import { foldsCase, stateFileAllowRules, stateFileDenyRules } from '../../src/supervisor/worker-policy.ts'
import { STATE_HOOK_CLEAN_LINE, threadStateHookCommand } from '../../src/supervisor/worker-spec.ts'
import { workerPlanner } from '../../src/supervisor/workers-wiring.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

const savedPythonRules = { ...PYTHON_RULES }
beforeEach(() => Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 }))
afterEach(() => Object.assign(PYTHON_RULES, savedPythonRules))
afterAll(cleanupReleases)

const NO_MANAGED = join(tmpdir(), 'talos-test-no-managed-settings')
const onCaseExactTmp = it.skipIf(foldsCase(realpathSync(tmpdir())))

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-tstate-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Hook = { matcher?: string; hooks: Array<{ type: string; timeout: number; command: string }> }
type Settings = { hooks: Record<string, Hook[]>; permissions: { allow?: string[]; deny: string[] } }

/** One start of thread `trip` (in the agent folder, or in a folder of its own), and what it wrote. */
function start(
  o: { own?: boolean; dry?: boolean; state?: boolean; setup?: (agentDir: string) => void; name?: string } = {},
) {
  const root = tmp()
  const userHome = join(root, 'home')
  const agentDir = join(userHome, 'agent')
  const talosHome = join(userHome, '.talos')
  const own = join(userHome, 'trip')
  for (const d of [agentDir, talosHome, own, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(agentDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': {} } }))
  o.setup?.(agentDir)
  const events: Array<[string, Record<string, unknown>]> = []
  const planner = workerPlanner({
    threadFolders: () => [],
    kitVendor: sealedRelease(o.state === false ? { fresh: true, state: false } : {}),
    talosHome,
    userHome,
    agentDir,
    claudeDir: join(userHome, '.claude'),
    resolveClaude: () => '/usr/bin/claude',
    mainArgs: () => ['--permission-mode=default'],
    managedDir: NO_MANAGED,
    audit: (e, d) => events.push([e, d ?? {}]),
  })
  const p = planner({
    thread: {
      id: 'trip',
      cwd: o.own ? own : agentDir,
      model: 'inherit',
      effort: null,
      parentCwd: null,
      name: o.name ?? 'Trip',
    },
    sessionId: '11111111-2222-3333-4444-555555555555',
    resume: false,
    nonce: 'ab'.repeat(16),
    baseEnv: { PATH: '/usr/bin', HOME: userHome, TALOS_APP_BRIDGE: '1' },
    ...(o.dry ? { dry: true } : {}),
  })
  if ('refused' in p) throw new Error(p.refused.detail)
  const settingsPath = join(talosHome, 'workers', 'trip', 'settings.json')
  const settings = o.dry ? null : (JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings)
  return { p, settings, agentDir, talosHome, events }
}

// Edit( ) alone covers Write too (path-rules-read-edit.test.ts)
const stateRules = (agentDir: string) => [`Edit(/${agentDir}/threads/trip.state.md)`]

describe('what the generated settings register', () => {
  for (const own of [false, true]) {
    onCaseExactTmp(
      `${own ? 'a thread in a folder of its own' : 'a thread in the agent folder'}: SessionStart and PreCompact`,
      () => {
        const w = start({ own })
        const s = w.settings as Settings
        const script = join(workerHookDir(w.talosHome), STATE_HOOK)
        const [ss] = s.hooks.SessionStart as Hook[]
        const [pc] = s.hooks.PreCompact as Hook[]
        expect(s.hooks.SessionStart).toHaveLength(1)
        expect(s.hooks.PreCompact).toHaveLength(1)
        expect(ss?.matcher).toBe('startup|resume|clear|compact|fork')
        expect(ss?.hooks[0]?.timeout).toBe(5)
        expect(pc?.matcher).toBeUndefined()
        const inject = ss?.hooks[0]?.command as string
        const save = pc?.hooks[0]?.command as string
        for (const [cmd, mode] of [
          [inject, 'inject'],
          [save, 'save'],
        ] as const) {
          // the verified copy, never the checkout or the agent folder; the agent folder as an argument and in the fixed env
          expect(cmd).toContain(`f='${script}'`)
          expect(cmd).toContain(`${mode} '${w.agentDir}' '/nonexistent'`)
          // no bytecode is written or read beside the staged script
          expect(cmd).toContain('-B -X "pycache_prefix=$4"')
          expect(cmd).toContain(`CLAUDE_PROJECT_DIR='${w.agentDir}'`)
          expect(cmd).toContain('TALOS_SESSION_ROLE=worker')
          expect(cmd).toContain("TALOS_APP_WORKER_THREAD='trip'")
          expect(cmd).toContain('/usr/bin/env -i')
        }
        expect(inject.endsWith(`inject '${w.agentDir}' '/nonexistent'`)).toBe(true)
        expect(save.endsWith(`save '${w.agentDir}' '/nonexistent'`)).toBe(true)
        // the permission hook is still there, once, beside them
        expect(s.hooks.PermissionRequest).toHaveLength(1)
      },
    )
  }
  onCaseExactTmp('the worker’s environment says the hook is registered (TALOS_APP_THREAD_STATE=1) only then', () => {
    for (const own of [false, true]) {
      const w = start({ own })
      expect((w.p as { launch: { env: Record<string, string> } }).launch.env.TALOS_APP_THREAD_STATE).toBe('1')
    }
    const none = start({ state: false })
    expect((none.p as { launch: { env: Record<string, string> } }).launch.env.TALOS_APP_THREAD_STATE).toBeUndefined()
  })
  onCaseExactTmp(
    'the allow rules are exactly the state file’s Edit( ); its children are denied as `<file>/*`, never `<file>/**`',
    () => {
      for (const own of [false, true]) {
        const w = start({ own })
        const perms = (w.settings as Settings).permissions
        expect(perms.allow).toEqual(stateRules(w.agentDir))
        for (const r of stateRules(w.agentDir)) expect(perms.deny).toContain(r.replace(/\)$/, '/*)'))
        // a `/**` deny names the file itself too (Claude Code strips only a trailing `/**`): it made Edit refuse the file
        expect(perms.deny.filter((r) => r.includes('state.md') && r.endsWith('/**)'))).toEqual([])
      }
    },
  )
  onCaseExactTmp('no deny rule of the generated settings covers the state file', () => {
    const w = start()
    const file = `${w.agentDir}/threads/trip.state.md`
    for (const rule of (w.settings as Settings).permissions.deny)
      for (const tool of ['Edit', 'Write'])
        if (rule.startsWith(`${ruleTool(tool)}(`)) expect(names(rulePath(rule), file), rule).toBe(false)
  })
  onCaseExactTmp('with the hook not staged (an older kit) there are no hook entries and no allow rules', () => {
    const w = start({ state: false })
    const s = w.settings as Settings
    expect(s.hooks.SessionStart).toBeUndefined()
    expect(s.hooks.PreCompact).toBeUndefined()
    expect(s.permissions.allow).toBeUndefined()
  })
  onCaseExactTmp('the launch spec moves with the staged state hook (an update restarts sessions)', () => {
    const a = start({ state: false }).p
    const b = start().p
    expect(a.specHash).not.toBe(b.specHash)
  })
})

/**
 * A model of Claude Code's matching of a `//abs` path rule (2.1.330), for the rules these tests are given. The package it uses
 * (`ignore`) is not in the lockfile and no dependency is added for a test. What it does, read from the CLI's bundle and the owner's
 * report of Edit and `sed -i` on a state file: only a trailing `/**` is stripped from the rule; the rest is a gitignore pattern, which
 * names a path when the path is the pattern or lies under it (a pattern that names a file names everything below it), without
 * regard to case; the directory checks also try the path with a trailing slash. So a rule `<p>/**` names `<p>` itself (the file
 * was refused: "File is in a directory that is denied by your permission settings"), allow and deny alike, while `<p>/*` names
 * the children of `<p>` (deeper ones through the parent walk) and neither `<p>` nor `<p>/`. The path is normalised first.
 */
const names = (pattern: string, path: string) => {
  const stripped = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
  const p = stripped.replace(/^\/\//, '/').toLowerCase()
  const x = posix.normalize(path).toLowerCase()
  if (p.endsWith('/*')) {
    const dir = p.slice(0, -1) // children only: something after the slash
    return x.startsWith(dir) && x.length > dir.length
  }
  return x === p || x.startsWith(`${p}/`)
}
const rulePath = (r: string) => r.slice(r.indexOf('(') + 1, -1)
/** The rule name Claude Code matches a file tool's path with: Edit( ) for every writing tool, Read( ) for every reading one. */
const ruleTool = (tool: string) =>
  ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)
    ? 'Edit'
    : ['Read', 'Grep', 'Glob'].includes(tool)
      ? 'Read'
      : tool
/** Allowed by the rules: some allow rule for that tool names it and no deny rule does (deny wins). */
const allowed = (allow: string[], deny: string[], tool: string, path: string) =>
  allow.some((r) => r.startsWith(`${ruleTool(tool)}(`) && names(rulePath(r), path)) &&
  !deny.some((r) => r.startsWith(`${ruleTool(tool)}(`) && names(rulePath(r), path))

describe('the allow rule covers the state file; its children and every sibling stay refused', () => {
  // the generated settings of a real start (allow and deny as a session gets them), not hand-written shapes
  const w = () => {
    const g = start()
    const perms = (g.settings as Settings).permissions
    return {
      agent: g.agentDir,
      file: `${g.agentDir}/threads/trip.state.md`,
      allow: perms.allow ?? [],
      deny: perms.deny,
    }
  }
  onCaseExactTmp('the allow is exactly one absolute path, the deny is its children', () => {
    const { agent, allow, deny } = w()
    expect(allow).toEqual([`Edit(/${agent}/threads/trip.state.md)`])
    expect(deny).toContain(`Edit(/${agent}/threads/trip.state.md/*)`)
    expect(stateFileDenyRules('/home/user/agent', 'trip')).toEqual(['Edit(//home/user/agent/threads/trip.state.md/*)'])
    expect(stateFileAllowRules('/home/user/agent', 'trip')).toEqual(['Edit(//home/user/agent/threads/trip.state.md)'])
  })
  it('both spellings, in allow and in deny, when the folder is reached through a link', () => {
    const root = tmp()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    for (const [rules, tail] of [
      [stateFileAllowRules(join(root, 'link'), 'trip'), ''],
      [stateFileDenyRules(join(root, 'link'), 'trip'), '/*'],
    ] as const)
      expect(rules).toEqual([
        `Edit(/${join(root, 'link')}/threads/trip.state.md${tail})`,
        `Edit(/${join(root, 'real')}/threads/trip.state.md${tail})`,
      ])
  })
  it('no glob in an allow rule: one literal path', () => {
    for (const r of stateFileAllowRules('/home/user/agent', 'trip')) {
      expect(r).not.toMatch(/[*?[\]{}]/)
      expect(r).not.toContain('..')
    }
  })
  for (const tool of ['Edit', 'Write'])
    onCaseExactTmp(`${tool}: the file itself is allowed; its children, a folder form and every sibling are not`, () => {
      const { agent, file, allow, deny } = w()
      expect(allowed(allow, deny, tool, file)).toBe(true)
      for (const path of [
        `${file}/x`, // a child (Write would make the parent folder)
        `${file}/a/b`,
        `${file}/planted/CLAUDE.md`,
        `${agent}/threads/TRIP.state.md/x`, // matching ignores case
        `${agent}/threads/other.state.md`, // another thread's file
        `${file}.bak`, // a backup beside it
        `${file}/../x`, // normalised to threads/x
        `${agent}/threads/trip/WORKER.md`,
        `${agent}/threads/trip.md`,
        `${agent}/threads/../memory/STATE.md`, // Main's state, by a `..` path
        `${agent}/memory/STATE.md`,
        `${agent}/CLAUDE.md`,
        `${agent}/hooks/guard.py`,
      ])
        expect(allowed(allow, deny, tool, path), path).toBe(false)
    })
  it('the case variant of the file name is covered too (a different file only on a case-sensitive disk, and allowed)', () => {
    const agent = '/home/user/agent'
    const allow = stateFileAllowRules(agent, 'trip')
    const deny = stateFileDenyRules(agent, 'trip')
    expect(allowed(allow, deny, 'Edit', `${agent}/threads/TRIP.state.md`)).toBe(true)
  })
  it('red on the old rules: a `<file>/**` deny refuses the file, a bare `<file>` deny does too, `/*` does not', () => {
    const agent = '/home/user/agent'
    const allow = stateFileAllowRules(agent, 'trip')
    const file = `${agent}/threads/trip.state.md`
    const g = `Edit(/${file}`
    expect(allowed(allow, [`${g}/**)`], 'Edit', file)).toBe(false)
    expect(allowed(allow, [`${g})`], 'Edit', file)).toBe(false)
    expect(allowed(allow, [`${g}/*)`], 'Edit', file)).toBe(true)
    // and the folder form of the path is named by none of the three: only the children are
    expect(names(`/${file}/*`, `${file}/`)).toBe(false)
    expect(names(`/${file}/*`, file)).toBe(false)
    expect(names(`/${file}/*`, `${file}/x`)).toBe(true)
  })
  it('a folder name with a rule metacharacter or a quote gets no rule (the session asks instead)', () => {
    for (const bad of [
      '/home/user/a*b',
      '/home/user/a[b]',
      '/home/user/a(b)',
      "/home/user/a'b",
      '/home/user/a"b',
      '/home/user/a\\b',
      '/home/user/a\nb',
      '/home/user/a{b}',
    ]) {
      expect(stateFileAllowRules(bad, 'trip')).toEqual([])
      expect(stateFileDenyRules(bad, 'trip')).toEqual([])
    }
  })
  it('a thread id that is not a thread id gets no rule', () => {
    for (const bad of ['../x', 'A', '', 'all x', 'a/b', 'a'.repeat(33)]) {
      expect(stateFileAllowRules('/home/user/agent', bad)).toEqual([])
      expect(stateFileDenyRules('/home/user/agent', bad)).toEqual([])
    }
  })
})

describe('the seed', () => {
  it('creates the template once (0600, threads/ 0700) and never overwrites it', () => {
    const agent = tmp()
    expect(seedThreadState(agent, 'trip', 'Trip')).toEqual({ ok: 'created' })
    const file = threadStatePath(agent, 'trip')
    expect(readFileSync(file, 'utf8')).toBe(threadStateTemplate('trip', 'Trip'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(agent, 'threads')).mode & 0o777).toBe(0o700)
    writeFileSync(file, 'my notes\n')
    expect(seedThreadState(agent, 'trip', 'Trip')).toEqual({ ok: 'exists' })
    expect(readFileSync(file, 'utf8')).toBe('my notes\n')
  })
  it('a folder where the file belongs is a problem, not "exists", with and without dry', () => {
    const agent = tmp()
    mkdirSync(join(agent, 'threads'))
    mkdirSync(threadStatePath(agent, 'trip'))
    writeFileSync(join(threadStatePath(agent, 'trip'), 'planted.md'), 'x')
    for (const dry of [false, true]) {
      const r = seedThreadState(agent, 'trip', 'Trip', dry)
      expect(r).toEqual({ problem: `${threadStatePath(agent, 'trip')} is not a regular file` })
    }
    // a regular file is still "exists", and nothing was changed
    expect(readFileSync(join(threadStatePath(agent, 'trip'), 'planted.md'), 'utf8')).toBe('x')
  })
  it('the template is the agreed one, named by the display name, else the id', () => {
    expect(threadStateTemplate('trip', 'Trip')).toBe(`# Trip live state (thread trip)
READ FIRST after any restart or compaction. Rule: update THIS file the same turn anything here changes (an owner ask, a
decision, a landing, a hold). Keep it under 8,000 characters; history goes in the thread or a log, not here.

## Owner asks open (newest first, dated)
## Waiting on the owner
## In flight
## CI (optional: leave empty if this thread does no builds)
## Rules learned
`)
    expect(threadStateTemplate('trip', null).startsWith('# trip live state (thread trip)\n')).toBe(true)
    expect(threadStateTemplate('trip', ' \n ').startsWith('# trip live state')).toBe(true)
    // a name with a line break stays one heading line
    expect(threadStateTemplate('trip', 'A\nB## x').split('\n')[0]).toBe('# A B## x live state (thread trip)')
  })
  it('refuses a symlinked threads/ and a symlinked state file, and writes through neither', () => {
    const agent = tmp()
    const out = tmp()
    symlinkSync(out, join(agent, 'threads'))
    expect('problem' in seedThreadState(agent, 'trip', 'Trip')).toBe(true)
    expect(existsSync(join(out, 'trip.state.md'))).toBe(false)
    rmSync(join(agent, 'threads'))
    mkdirSync(join(agent, 'threads'))
    symlinkSync(join(out, 'target.md'), join(agent, 'threads', 'trip.state.md'))
    expect('problem' in seedThreadState(agent, 'trip', 'Trip')).toBe(true)
    expect(existsSync(join(out, 'target.md'))).toBe(false)
  })
  it('an agent folder reached through a link still seeds (the realpath check is not fooled by the spelling)', () => {
    const root = tmp()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(seedThreadState(join(root, 'link'), 'trip', 'Trip')).toEqual({ ok: 'created' })
    expect(existsSync(join(root, 'real', 'threads', 'trip.state.md'))).toBe(true)
  })
  it('a dry run writes nothing, not even threads/', () => {
    const agent = tmp()
    expect(seedThreadState(agent, 'trip', 'Trip', true)).toEqual({ ok: 'created' })
    expect(existsSync(join(agent, 'threads'))).toBe(false)
  })
  onCaseExactTmp('a start makes it with the thread’s name; a dry plan makes nothing', () => {
    const dry = start({ dry: true, name: 'Dry' })
    expect(existsSync(threadStatePath(dry.agentDir, 'trip'))).toBe(false)
    expect(existsSync(join(dry.agentDir, 'threads'))).toBe(false)
    const w = start({ name: 'Ferry plans' })
    expect(readFileSync(threadStatePath(w.agentDir, 'trip'), 'utf8').split('\n')[0]).toBe(
      '# Ferry plans live state (thread trip)',
    )
  })
  onCaseExactTmp('a start never overwrites an existing file', () => {
    const w = start({
      setup: (agentDir) => {
        mkdirSync(join(agentDir, 'threads'))
        writeFileSync(join(agentDir, 'threads', 'trip.state.md'), 'kept\n')
      },
    })
    expect(readFileSync(threadStatePath(w.agentDir, 'trip'), 'utf8')).toBe('kept\n')
  })
  onCaseExactTmp('a seed failure is audited and never blocks the start', () => {
    const out = tmp()
    const w = start({ setup: (agentDir) => symlinkSync(out, join(agentDir, 'threads')) })
    expect(w.p).toHaveProperty('launch')
    expect(w.events.map((e) => e[0])).toContain('worker_state_seed_failed')
    expect(existsSync(join(out, 'trip.state.md'))).toBe(false)
  })
  onCaseExactTmp('an unwritable agent folder is audited and never blocks the start', () => {
    if (process.getuid?.() === 0) return
    const w = start({ setup: (agentDir) => chmodSync(agentDir, 0o500) })
    chmodSync(w.agentDir, 0o700)
    expect(w.p).toHaveProperty('launch')
    expect(w.events.map((e) => e[0])).toContain('worker_state_seed_failed')
  })
})

describe('the command, run for real', () => {
  // The start's own command, in a clean shell as Claude Code would start it: the copy staged from the sealed release, the python3
  // resolved for it, the agent folder and the thread fixed by the command (a session's own environment says nothing here).
  const py = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim()
  const run = (command: string, stdin: string, home: string, state: string) =>
    spawnSync('/bin/sh', ['-c', command], {
      input: stdin,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        XDG_STATE_HOME: state,
        TALOS_SESSION_ROLE: 'main',
        TALOS_APP_WORKER_THREAD: 'other',
      },
    })
  onCaseExactTmp(
    'SessionStart puts the thread’s file back, whatever the session’s own role and thread say; PreCompact saves its carry',
    () => {
      const w = start({ own: true })
      const s = w.settings as Settings
      const home = tmp()
      const state = join(home, 'state')
      mkdirSync(join(w.agentDir, '.learnings'), { recursive: true })
      // the guard keeps corrections dated in the hook's own last 3 days (compaction-guard.py, time.localtime), and the hook runs
      // under `env -i`: no TZ, so the machine's zone. Date the row the same way, not by this process's zone (CI's hostile run sets
      // TZ to Kiritimati or Pago Pago for every process, which can be a day away from the machine's).
      const day = spawnSync('/usr/bin/env', ['-i', '/bin/date', '+%Y-%m-%d'], { encoding: 'utf8' }).stdout.trim()
      writeFileSync(
        join(w.agentDir, '.learnings', 'LEARNINGS.md'),
        `# L\n\n## ${day} — keep every row (correction)\n**What happened:** x.\n**Rule (apply every time):** y.\n`,
      )
      writeFileSync(
        threadStatePath(w.agentDir, 'trip'),
        '# Trip live state (thread trip)\n- 2026-11-18 book the ferry\n',
      )
      const inject = (s.hooks.SessionStart as Hook[])[0]?.hooks[0]?.command as string
      const save = (s.hooks.PreCompact as Hook[])[0]?.hooks[0]?.command as string
      // the PATH the session's python3 was resolved on is the fixed /usr/bin:/bin of the command: use a command with that python
      const withPy = (c: string) =>
        c.replace(/exec \/usr\/bin\/env -i/, `exec /usr/bin/env -i`).replace(/'[^']*python[^']*'/, `'${py}'`)
      const out = run(withPy(inject), '{"source":"startup"}', home, state)
      expect(out.status).toBe(0)
      const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string
      expect(ctx).toContain(
        '# LIVE STATE for thread trip (from threads/trip.state.md; keep it current the same turn anything changes)',
      )
      expect(ctx).toContain('book the ferry')
      expect(run(withPy(save), '{"session_id":"s1"}', home, state).status).toBe(0)
      const after = run(withPy(inject), '{"source":"compact"}', home, state)
      const ctx2 = JSON.parse(after.stdout).hookSpecificOutput.additionalContext as string
      expect(ctx2).toContain('keep every row')
      expect(ctx2).toContain('These were carried across a compaction by a hook')
      // no bytecode was written beside the staged script
      expect(readdirSync(workerHookDir(w.talosHome)).filter((n) => n.endsWith('.pyc') || n === '__pycache__')).toEqual(
        [],
      )
    },
  )
  it('the command is a clean shell line: the copy, the python3, the mode and the folder only', () => {
    const c = threadStateHookCommand(
      '/h/_hook/thread-state.py',
      '/usr/bin/python3',
      'save',
      { talosHome: '/h', home: '/u', thread: 'trip' },
      "/a/it's",
    )
    expect(c).toContain(`'${STATE_HOOK_CLEAN_LINE}'`)
    expect(c).toContain("'/a/it'\\''s'") // quoted safely
    expect(c).toContain('"$f" \'/usr/bin/python3\' save')
  })
})
