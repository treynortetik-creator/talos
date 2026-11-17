// What the project settings a thread session loads may carry (worker/project-settings.ts, from the one table in
// packages/protocol/tables/thread-folder-settings.json), which folders those are (its own and its git root), and the deny rules
// that keep a session's file tools off every settings file it loads (worker-policy.ts settingsFileDenyRules). Temp folders only.
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recheckSettings } from '../../src/hub/server.ts'
import {
  CONFIG_ALWAYS_DENIED,
  CONFIG_ASK_WHEN_FENCE_OFF,
  commandScripts,
  settingsFileDenyRules,
  settingsFileRules,
} from '../../src/supervisor/worker-policy.ts'
import {
  ALLOWED_ENV,
  FIX,
  gitRoots,
  projectSettingsProblem,
  readProjectCheck,
  sessionSettingsFolders,
  sessionSettingsProblem,
  writeProjectCheck,
} from '../../src/worker/project-settings.ts'

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-projset-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, '.claude', 'settings.json'), 0o600)
    } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})
const write = (d: string, files: { shared?: unknown; local?: unknown; raw?: string }) => {
  mkdirSync(join(d, '.claude'), { recursive: true })
  if (files.shared !== undefined) writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify(files.shared))
  if (files.raw !== undefined) writeFileSync(join(d, '.claude', 'settings.json'), files.raw)
  if (files.local !== undefined) writeFileSync(join(d, '.claude', 'settings.local.json'), JSON.stringify(files.local))
  return d
}
const folder = (files: { shared?: unknown; local?: unknown; raw?: string }) => write(tmp(), files)

describe('a thread folder’s project settings: allow-lists, never deny-lists', () => {
  it('none, or plain preferences, deny/ask rules and Claude Code’s own tunables: fit', () => {
    expect(projectSettingsProblem(tmp(), false)).toBeNull()
    expect(
      projectSettingsProblem(
        folder({
          shared: {
            model: 'sonnet',
            env: { BASH_DEFAULT_TIMEOUT_MS: '600000', MAX_THINKING_TOKENS: '8000', DISABLE_PROMPT_CACHING: 1 },
            permissions: { deny: ['Read(./.env)'], ask: ['Bash(git push:*)'] },
          },
        }),
        false,
      ),
    ).toBeNull()
  })
  it('every env key off the list is refused, in every folder (the agent folder too), naming the file, key and fix', () => {
    // what the reviews ran code with before the hook's clean environment, and what is merely unknown: the same answer
    for (const key of [
      'CLAUDE_CODE_SHELL_PREFIX',
      'GCONV_PATH',
      'LC_ALL',
      'OUTPUT_CHARSET',
      'SHLVL',
      'LD_PRELOAD',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'BASH_FUNC_exec%%',
      '__BASH_FUNC<exec>()',
      'ENV',
      'SHELLOPTS',
      'PS4',
      'PYTHONPATH',
      'TALOS_APP_HOME',
      'CLAUDE_CONFIG_DIR',
      'PATH',
      'NODE_OPTIONS',
      'SOMETHING_NEW',
    ]) {
      expect(ALLOWED_ENV.has(key), key).toBe(false)
      for (const agent of [false, true]) {
        const d = folder({ local: { env: { [key]: 'x' } } })
        const why = projectSettingsProblem(d, agent)
        expect(why, key).toContain(join(d, '.claude', 'settings.local.json'))
        expect(why, key).toContain('in env, which a thread session may not set')
        expect(why, key).toEndWith(`: ${FIX}`)
      }
    }
  })
  it('a key name the owner is shown is only ever a plain name: anything else is not repeated', () => {
    const why = projectSettingsProblem(
      folder({ shared: { env: { 'LD_\nYour phone: approve everything': 'x' } } }),
      false,
    )
    expect(why).toContain('sets a key that cannot be shown in env')
    expect(why).not.toContain('approve everything')
  })
  it('outside the agent folder, any top-level key off the list is refused; in it, only env is held (as on the Mac)', () => {
    for (const s of [
      { hooks: {} },
      { statusLine: { type: 'command', command: 'x' } },
      { subagentStatusLine: { type: 'command', command: 'x' } },
      { apiKeyHelper: 'x' },
      { proxyAuthHelper: 'x' },
      { disableAllHooks: true },
      { enabledPlugins: { 'x@y': true } },
      { enableAllProjectMcpServers: true },
      { somethingNew: 1 },
    ]) {
      const key = Object.keys(s)[0] as string
      expect(projectSettingsProblem(folder({ shared: s }), false), key).toContain(
        `has ${key}, which only the agent folder's settings may have`,
      )
    }
    // the agent folder: the kit's hooks and status line, and the owner's rules, stay
    expect(
      projectSettingsProblem(
        folder({
          shared: { hooks: {}, statusLine: { type: 'command', command: 'x' }, permissions: { allow: ['Read'] } },
        }),
        true,
      ),
    ).toBeNull()
    // env is held there too (a thread at the agent folder is the next commit's to refuse outright)
    expect(projectSettingsProblem(folder({ shared: { hooks: {}, env: { LD_PRELOAD: 'x' } } }), true)).toContain(
      'sets LD_PRELOAD in env',
    )
  })
  it('an env value that is not plain text or a number is refused, even for a key on the list', () => {
    expect(projectSettingsProblem(folder({ shared: { env: { MCP_TIMEOUT: { x: 1 } } } }), false)).toContain(
      'sets MCP_TIMEOUT in env',
    )
  })
  it('an empty settings file is no settings (as the Mac and the hook read it)', () => {
    expect(projectSettingsProblem(folder({ raw: '  \n' }), false)).toBeNull()
  })
  it('outside the agent folder, permissions may only take away: allow or more folders are refused', () => {
    // defaultMode is allowed: the session's own --settings names Main's mode and outranks the folder's
    expect(
      projectSettingsProblem(folder({ shared: { permissions: { defaultMode: 'acceptEdits' } } }), false),
    ).toBeNull()
    for (const p of [{ allow: ['Bash'] }, { additionalDirectories: ['/'] }, { disableBypassPermissionsMode: 'x' }]) {
      const key = Object.keys(p)[0] as string
      expect(projectSettingsProblem(folder({ shared: { permissions: p } }), false), key).toContain(
        `has permissions ${key}`,
      )
    }
  })
  it('a file there that cannot be read as a settings object: refused (never guessed)', () => {
    expect(projectSettingsProblem(folder({ raw: '{not json' }), false)).toContain('is not valid JSON')
    expect(projectSettingsProblem(folder({ raw: '[1]' }), false)).toContain('is not a settings object')
    expect(projectSettingsProblem(folder({ shared: { env: ['LD_PRELOAD'] } }), false)).toContain(
      'env that is not an object',
    )
    if (process.getuid?.() !== 0) {
      const d = folder({ shared: {} })
      chmodSync(join(d, '.claude', 'settings.json'), 0)
      expect(projectSettingsProblem(d, false)).toContain('cannot be read')
    }
  })
})

describe('the folders a session loads project settings from: its own, and its repo roots (Claude Code loads the canonical one)', () => {
  const folders = (f: string, agent = '/not/the/agent') => {
    const r = sessionSettingsFolders(f, agent)
    if (!('folders' in r)) throw new Error(r.problem)
    return r.folders
  }
  it('a folder below a repo’s root: the root is checked too, and what it carries refuses the start', () => {
    const repo = tmp()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'sub', 'deep')
    mkdirSync(sub, { recursive: true })
    expect(gitRoots(sub)).toEqual({ roots: [repo] })
    const loaded = folders(sub)
    expect(loaded).toEqual([
      { folder: sub, agent_folder: false },
      { folder: repo, agent_folder: false },
    ])
    expect(sessionSettingsProblem(loaded)).toBeNull()
    // the parent thread's repo root gets a hook of its own: the sub-thread folder below it is refused
    write(repo, { local: { hooks: { PermissionRequest: [] } } })
    expect(sessionSettingsProblem(loaded)).toContain(join(repo, '.claude', 'settings.local.json'))
  })
  it('a worktree: its .git file is followed (gitdir, commondir) to the main checkout, whose settings are checked too', () => {
    const main = tmp()
    mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
    const wt = tmp()
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'w')}\n`)
    expect(gitRoots(wt)).toEqual({ roots: [wt, main, join(main, '.git')] })
    write(main, { local: { env: { CLAUDE_CODE_SHELL_PREFIX: '/x' } } })
    expect(sessionSettingsProblem(folders(wt))).toContain(join(main, '.claude', 'settings.local.json'))
  })
  it('the review’s case: a worktree a thread fakes INSIDE its own folder names a root there, and that root is checked', () => {
    const x = tmp()
    mkdirSync(join(x, 'r', '.git', 'worktrees', 'w'), { recursive: true })
    writeFileSync(join(x, '.git'), `gitdir: ${join(x, 'r', '.git', 'worktrees', 'w')}\n`)
    writeFileSync(join(x, 'r', '.git', 'worktrees', 'w', 'commondir'), '../..\n')
    writeFileSync(join(x, 'r', '.git', 'worktrees', 'w', 'gitdir'), `${join(x, '.git')}\n`)
    write(join(x, 'r'), { local: { env: { GCONV_PATH: join(x, 'gc') }, hooks: {} } })
    expect(sessionSettingsProblem(folders(x))).toContain(join(x, 'r', '.claude', 'settings.local.json'))
  })
  it('a relative gitdir, and one with no commondir (a plain gitdir file): followed the same way', () => {
    const x = tmp()
    mkdirSync(join(x, 'store', 'repo.git'), { recursive: true })
    writeFileSync(join(x, '.git'), 'gitdir: store/repo.git\n')
    // a bare repo: the common folder itself and its parent (more than Claude Code loads is safe)
    expect(gitRoots(x)).toEqual({ roots: [x, join(x, 'store', 'repo.git'), join(x, 'store')] })
  })
  it('a .git that is a link, or a pointer that cannot be followed: the start is refused, never guessed past', () => {
    const a = tmp()
    symlinkSync('/', join(a, '.git'))
    expect(gitRoots(a)).toMatchObject({ problem: expect.stringContaining('.git is a link') })
    expect(sessionSettingsFolders(a, '/x')).toMatchObject({ problem: expect.stringContaining(FIX) })
    for (const text of ['not a pointer\n', 'gitdir: /no/such/place\n']) {
      const b = tmp()
      writeFileSync(join(b, '.git'), text)
      expect(gitRoots(b), text).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
    }
    const c = tmp()
    mkdirSync(join(c, 'g'))
    writeFileSync(join(c, 'g', 'commondir'), '/no/such/common\n')
    writeFileSync(join(c, '.git'), `gitdir: ${join(c, 'g')}\n`)
    expect(gitRoots(c)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
  })
  it('the review’s B1a: a path with a line break in it is read whole (as Claude Code reads it), and refused', () => {
    for (const sep of ['\n', '\r', '\u2028', '\u2029', '\u0000']) {
      const f = tmp()
      mkdirSync(join(f, 'x'))
      writeFileSync(join(f, '.git'), `gitdir: ${join(f, 'x')}${sep}y/.git/worktrees/w\n`)
      expect(gitRoots(f), JSON.stringify(sep)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
    }
  })
  it('the review’s B1b: a link anywhere on the pointer’s way is refused (Claude Code resolves it lexically, not through it)', () => {
    // c3: the folder's .git is a link to the real admin folder
    const f = tmp()
    mkdirSync(join(f, 'e', 'x', 'worktrees', 'w'), { recursive: true })
    mkdirSync(join(f, 'sub'))
    symlinkSync(join(f, 'e', 'x'), join(f, 'sub', '.git'))
    const wt = join(f, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(f, 'sub', '.git', 'worktrees', 'w')}\n`)
    expect(gitRoots(wt)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
    // c4: the worktree's admin folder is a link elsewhere, so `commondir` would land somewhere else lexically
    const g = tmp()
    mkdirSync(join(g, 'e', 'deep', 'er'), { recursive: true })
    writeFileSync(join(g, 'e', 'deep', 'er', 'commondir'), '../..\n')
    mkdirSync(join(g, 'sub', '.git', 'worktrees'), { recursive: true })
    symlinkSync(join(g, 'e', 'deep', 'er'), join(g, 'sub', '.git', 'worktrees', 'w'))
    const wt2 = join(g, 'wt')
    mkdirSync(wt2)
    writeFileSync(join(wt2, '.git'), `gitdir: ${join(g, 'sub', '.git', 'worktrees', 'w')}\n`)
    expect(gitRoots(wt2)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
  })
  it.skipIf(process.getuid?.() === 0)('a pointer that cannot be read (mode 000): a refusal, never a throw', () => {
    const f = tmp()
    writeFileSync(join(f, '.git'), 'gitdir: /x\n')
    chmodSync(join(f, '.git'), 0)
    try {
      expect(gitRoots(f)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
    } finally {
      chmodSync(join(f, '.git'), 0o600)
    }
  })
  it('a real folder whose name holds a line separator, and a commondir through a link: refused (defence in depth)', () => {
    const f = tmp()
    const odd = join(f, 'a\u2028b')
    mkdirSync(odd)
    writeFileSync(join(f, '.git'), `gitdir: ${odd}\n`)
    expect(gitRoots(f)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
    // the admin folder is real, but its absolute commondir goes through a link
    const g = tmp()
    mkdirSync(join(g, 'admin'))
    mkdirSync(join(g, 'real-common'))
    symlinkSync(join(g, 'real-common'), join(g, 'linked'))
    writeFileSync(join(g, 'admin', 'commondir'), `${join(g, 'linked')}\n`)
    writeFileSync(join(g, '.git'), `gitdir: ${join(g, 'admin')}\n`)
    expect(gitRoots(g)).toMatchObject({ problem: expect.stringContaining('cannot be followed') })
  })
  it.skipIf(!existsSync('/proc/kallsyms'))(
    'a file whose size says 0 but whose content is large: the read stops at the cap',
    () => {
      const d = tmp()
      mkdirSync(join(d, '.claude'))
      symlinkSync('/proc/kallsyms', join(d, '.claude', 'settings.json'))
      expect(projectSettingsProblem(d, false)).toContain('is not a plain file of at most 256 KB')
    },
  )
  it('a folder that is its own root, or in no repo, is one folder', () => {
    const r = tmp()
    mkdirSync(join(r, '.git'))
    expect(folders(r, r)).toEqual([{ folder: r, agent_folder: true }])
    expect(gitRoots('/')).toEqual({ roots: [] })
  })
  it.skipIf(process.platform === 'win32')(
    'a FIFO, a device or a file over 256 KB at a settings path is refused without being read (it would stall the bridge)',
    () => {
      const d = tmp()
      mkdirSync(join(d, '.claude'))
      execFileSync('mkfifo', [join(d, '.claude', 'settings.json')])
      expect(projectSettingsProblem(d, false)).toContain('is not a plain file of at most 256 KB')
      const e = tmp()
      mkdirSync(join(e, '.claude'))
      symlinkSync('/dev/zero', join(e, '.claude', 'settings.local.json'))
      expect(projectSettingsProblem(e, false)).toContain('is not a plain file of at most 256 KB')
      const f = folder({ raw: `{"model":"${'x'.repeat(1024 * 1024)}"}` })
      expect(projectSettingsProblem(f, false)).toContain('is not a plain file of at most 256 KB')
    },
  )
  it('the start’s record for the bridge: every folder, written in the worker’s folder, refused when not that shape', () => {
    const home = tmp()
    expect(readProjectCheck(home, 'trip')).toBeNull()
    const c = {
      v: 1 as const,
      folders: [
        { folder: '/w/trip', agent_folder: false },
        { folder: '/w', agent_folder: false },
      ],
    }
    writeProjectCheck(home, 'trip', c)
    expect(readProjectCheck(home, 'trip')).toEqual(c)
    for (const bad of [
      { v: 1, folders: [] },
      { v: 1, folders: [{ folder: 'rel', agent_folder: false }] },
      { v: 1, folder: '/w/trip', agent_folder: false },
      { v: 2, folders: c.folders },
    ]) {
      writeFileSync(join(home, 'workers', 'trip', 'project-check.json'), JSON.stringify(bad))
      expect(readProjectCheck(home, 'trip'), JSON.stringify(bad)).toBeNull()
    }
    expect(readFileSync(join(home, 'workers', 'trip', 'project-check.json'), 'utf8')).toContain('"v":2')
  })
})

describe('no file-tool edit of a settings file a session loads', () => {
  it('each folder’s whole .claude, .mcp.json and .env files, each config folder’s settings, skills, commands, agents', () => {
    const rules = settingsFileDenyRules(['/w/trip', '/w/agent'], ['/h/.claude'], ['/h/.claude.json'])
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      for (const f of ['/w/trip', '/w/agent'])
        for (const p of ['.claude', '.claude/**', '.mcp.json', '.env*']) expect(rules).toContain(`${tool}(/${f}/${p})`)
      for (const p of [
        'settings.json',
        'settings.local.json',
        'skills/**',
        'commands/**',
        'agents/**',
        'plugins/**',
        'hooks/**',
        'CLAUDE.md',
        'rules/**',
        'output-styles/**',
        'workflows/**',
        'routines/**',
      ])
        expect(rules).toContain(`${tool}(//h/.claude/${p})`)
      expect(rules).toContain(`${tool}(//h/.claude.json)`)
    }
    expect(rules).toHaveLength(4 * (2 * 4 + 12 + 1))
  })
  it('with the fence on the output is the pinned list, in order', () => {
    const rules = settingsFileDenyRules(['/w/trip'], ['/h/.claude'], ['/h/.claude.json'])
    const tools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
    const paths = [
      '/w/trip/.claude',
      '/w/trip/.claude/**',
      '/w/trip/.mcp.json',
      '/w/trip/.env*',
      ...[
        'settings.json',
        'settings.local.json',
        'skills/**',
        'commands/**',
        'agents/**',
        'plugins/**',
        'hooks/**',
        'CLAUDE.md',
        'rules/**',
        'output-styles/**',
        'workflows/**',
        'routines/**',
      ].map((f) => `/h/.claude/${f}`),
      '/h/.claude.json',
    ]
    expect(rules).toEqual(paths.flatMap((p) => tools.map((t) => `${t}(/${p})`)))
    expect(settingsFileRules(['/w/trip'], ['/h/.claude'], ['/h/.claude.json'], { fenceOff: false })).toEqual({
      deny: rules,
      ask: [],
    })
  })
  it('with the fence off the ask paths move from deny to ask, nothing else', () => {
    const on = settingsFileRules(['/w/trip'], ['/h/.claude'], ['/h/.claude.json'])
    const off = settingsFileRules(['/w/trip'], ['/h/.claude'], ['/h/.claude.json'], { fenceOff: true })
    expect([...off.deny, ...off.ask].sort()).toEqual([...on.deny].sort())
    expect(off.ask).toHaveLength(4 * CONFIG_ASK_WHEN_FENCE_OFF.length)
    for (const f of CONFIG_ALWAYS_DENIED) expect(off.deny).toContain(`Edit(//h/.claude/${f})`)
    for (const f of CONFIG_ASK_WHEN_FENCE_OFF) expect(off.ask).toContain(`Edit(//h/.claude/${f})`)
    expect(off.deny).toContain('Edit(//h/.claude.json)')
    expect(off.deny).toContain('Edit(//w/trip/.claude/**)')
  })
  it('a script a config folder’s own settings run is denied, fence on or off, and the rest is as it was', () => {
    const c = tmp()
    mkdirSync(join(c, 'skills', 'h'), { recursive: true })
    writeFileSync(
      join(c, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `bash ${c}/skills/h/run.sh --x` }] }] },
      }),
    )
    const none = tmp()
    const tools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
    const script = tools.map((t) => `${t}(/${c}/skills/h/run.sh)`)
    const base = settingsFileDenyRules([], [none], [], '/home/nobody')
    // a config folder with no hooks: exactly the rules as before (no script rules)
    expect(base.some((r) => r.includes('run.sh'))).toBe(false)
    const on = settingsFileRules([], [c], [], { home: '/home/nobody' })
    const off = settingsFileRules([], [c], [], { home: '/home/nobody', fenceOff: true })
    for (const r of script) {
      expect(on.deny).toContain(r)
      expect(off.deny).toContain(r)
      expect(off.ask).not.toContain(r)
    }
    // with the fence on, the script rules are the only addition to the rules of a folder with no hooks
    const bare = settingsFileDenyRules([], [tmp()], [], '/home/nobody').length
    expect(on.deny).toHaveLength(bare + script.length)
  })
  it('a folder no rule can name exactly (a glob character, a relative path, none): left out, never a wider rule', () => {
    expect(settingsFileDenyRules(['/w/a*b', 'rel', ''], [''])).toEqual([])
  })
})

describe('the scripts a hook or status line command names (worker-policy.ts commandScripts)', () => {
  it('quotes, assignments, every spelling of the project folder and of home, relative paths: the path under the agent folder', () => {
    const d = '/a/agent'
    const h = '/home/u'
    const cases: Array<[string, string[]]> = [
      ['f="$CLAUDE_PROJECT_DIR/hooks/x.py"; [ -f "$f" ] || exit 0; python3 "$f"', ['hooks/x.py']],
      ['"$CLAUDE_PROJECT_DIR"/scripts/g.sh', ['scripts/g.sh']],
      ['${CLAUDE_PROJECT_DIR}/a.py && ${CLAUDE_PROJECT_DIR:-.}/b.py', ['a.py', 'b.py']],
      ['cd "$CLAUDE_PROJECT_DIR" && ./tools/run.sh', ['tools/run.sh']],
      ['sh $HOME/../../a/agent/bin/s.sh', ['bin/s.sh']],
      ['sh ${HOME}/x.sh', []], // not under the agent folder
      ['node "/a/agent/my dir/t.js"', ['my dir/t.js']],
      ['python3 local.py', ['local.py']],
      ['echo "$UNKNOWN/x.py"', []], // a variable it cannot know is not guessed at
    ]
    for (const [c, want] of cases) expect(commandScripts(c, d, h), c).toEqual(want)
  })
})

describe('the check at each request: the folders a start recorded, as recorded', () => {
  it('the check at each request compares the strings a start recorded: a folder that now resolves elsewhere is new', () => {
    const real = tmp()
    mkdirSync(join(real, '.claude'))
    writeFileSync(join(real, '.claude', 'settings.json'), '{}')
    // a start records real paths: the same folder is the same folder
    expect(recheckSettings({ v: 1, folders: [{ folder: real, agent_folder: true }], sources: null })).toBeNull()
    // a recorded path that resolves elsewhere (a link swapped in since the start) is never taken for the folder it was
    const via = join(tmp(), 'via')
    symlinkSync(real, via)
    expect(recheckSettings({ v: 1, folders: [{ folder: via, agent_folder: true }], sources: null })).toContain(
      'which its start did not check',
    )
  })
})
