// A thread session's launch (the Mac's WorkerSpec, WorkerFence, PrivilegeCeiling, SubThreadFolder, GuardsSettings), built from
// temp folders. Nothing is launched.
import { afterEach, describe, expect, it } from 'bun:test'
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
import { dirname, join } from 'node:path'
import {
  absolutize,
  checkCeiling,
  existingSubThreadFolder,
  FOLDER_NOT_NAMEABLE,
  fenceDenyRules,
  fenceSafe,
  foldsCase,
  mainArgsWithGuards,
  mainDefaultMode,
  mainDenyRules,
  modeOf,
  prepareSubThreadFolder,
  subThreadCheck,
  subThreadFence,
  subThreadProblem,
  subThreadTarget,
  workerFilesDenyRules,
  workerFolderProblem,
} from '../../src/supervisor/worker-policy.ts'
import {
  argvLooksLikeMain,
  buildWorkerSpec,
  noChannelDir,
  permissionHookCommand,
  THREAD_STATE_ENV,
  validateSpec,
  WORKER_EXTRA_DENY,
  type WorkerInputs,
  WorkerSpecRefused,
} from '../../src/supervisor/worker-spec.ts'

/**
 * The fence refuses a Talos home or folder on a file system that folds case, and a Mac's temp folder is one (APFS ignores
 * case by default): tests that build a launch from temp folders run where the temp folder is case-exact (Linux). On a Mac
 * the refusal itself is tested instead; Mac thread sessions are the Swift app's job.
 */
const TMP_FOLDS = foldsCase(realpathSync(tmpdir()))
const onCaseExactTmp = it.skipIf(TMP_FOLDS)

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-worker-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function inputs(over: Partial<WorkerInputs> = {}): WorkerInputs {
  const root = tmp()
  const agentDir = join(root, 'agent')
  const talosHome = join(root, 'talos')
  mkdirSync(agentDir)
  mkdirSync(talosHome)
  return {
    threadId: 'trip',
    sessionId: '11111111-2222-3333-4444-555555555555',
    resume: false,
    claudePath: '/usr/bin/claude',
    permissionHook: { script: join(talosHome, 'workers', '_hook', 'permission-relay.py'), python: '/usr/bin/python3' },
    baseEnv: {
      PATH: '/usr/bin',
      HOME: '/home/alex',
      CLAUDECODE: '1',
      TELEGRAM_BOT_TOKEN: 'tok',
      IMESSAGE_X: '1',
      TALOS_APP_BRIDGE: '1',
    },
    talosHome,
    agentDir,
    cwd: null,
    parentCwd: null,
    model: 'inherit',
    effort: null,
    nonce: 'ab'.repeat(16),
    permissionFlag: null,
    preamble: null,
    mcpConfigPath: null,
    main: { permissionArgs: [], defaultMode: null, mcpServers: [], denyRules: [] },
    ...over,
  }
}

const settingsOf = (s: { settingsJSON: string }) => JSON.parse(s.settingsJSON) as Record<string, any>

describe('a worker’s launch', () => {
  onCaseExactTmp(
    'runs as a worker: no channel, no Telegram, no Main markers, the plugins off, the Talos home fenced',
    () => {
      const i = inputs()
      const s = buildWorkerSpec(i)
      expect(s.args).toEqual([
        '--settings',
        `${i.talosHome}/workers/trip/settings.json`,
        '--name',
        'talos-trip',
        '--system-prompt-snapshot=off',
        '--session-id',
        '11111111-2222-3333-4444-555555555555',
      ])
      expect(s.env).toMatchObject({
        PATH: '/usr/bin',
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_SESSION_ROLE: 'worker',
        TALOS_APP_HOME: i.talosHome,
        TALOS_APP_WORKER_NONCE: i.nonce,
        TELEGRAM_STATE_DIR: noChannelDir(i.talosHome),
        IMESSAGE_STATE_DIR: noChannelDir(i.talosHome),
      })
      for (const k of ['CLAUDECODE', 'TELEGRAM_BOT_TOKEN', 'IMESSAGE_X', 'TALOS_APP_BRIDGE'])
        expect(s.env[k]).toBeUndefined()
      const set = settingsOf(s)
      expect(set.enabledPlugins).toEqual({
        'telegram@claude-plugins-official': false,
        'imessage@claude-plugins-official': false,
      })
      for (const r of fenceDenyRules(i.talosHome)) expect(set.permissions.deny).toContain(r)
      for (const r of WORKER_EXTRA_DENY) expect(set.permissions.deny).toContain(r) // no `talos-app post` from a thread's shell
      expect(set.permissions.defaultMode).toBe('default')
      // no auto mode (an agent file's permissionMode: auto would put a classifier in the owner's place), no skill shell lines,
      // no worktree (it moves the folder whose settings the start checked)
      expect(set.permissions.disableAutoMode).toBe('disable')
      expect(set.disableSkillShellExecution).toBe(true)
      expect(set.permissions.deny).toContain('EnterWorktree')
      // the install's own kit hook, never a path guessed inside the agent folder (Delphi, 2026-11-11)
      // run under `env -i`: the Talos home, HOME and thread fixed here, never what the session's environment says
      const command: string = set.hooks.PermissionRequest[0].hooks[0].command
      expect(command.startsWith(`f='${i.permissionHook.script}'; exec /usr/bin/env -i `)).toBe(true)
      expect(command).toContain(` HOME='${i.baseEnv.HOME}' PATH=/usr/bin:/bin `)
      expect(command).toContain(` TALOS_APP_HOME='${i.talosHome}' TALOS_APP_WORKER_THREAD='trip' `)
      // the folder the hook reads again at every prompt: the session's own (the agent folder's own hooks are the kit's)
      expect(command).toContain(
        ` TALOS_APP_HOOK_CHECK_DIR='${i.cwd ?? i.agentDir}' TALOS_APP_HOOK_CHECK_HOOKS=${i.cwd === null ? 0 : 1} `,
      )
      expect(
        command.endsWith(` /bin/sh -c '[ -f "$0" ] || exit 0; exec "$1" -I -S "$0"' "$f" '/usr/bin/python3'`),
      ).toBe(true)
      expect(set.pluginConfigs['cc-plugin-agents-md@builtin'].options.instructionFiles).toBe('claude-md-and-agents-md')
      expect(argvLooksLikeMain(s.args)).toBe(false)
    },
  )
  onCaseExactTmp('resumes, picks the model and effort, and carries Main’s permission flag and mode', () => {
    const s = buildWorkerSpec(
      inputs({
        resume: true,
        model: 'opus',
        effort: 'high',
        permissionFlag: '--dangerously-skip-permissions',
        main: { permissionArgs: ['--dangerously-skip-permissions'], defaultMode: null, mcpServers: [], denyRules: [] },
      }),
    )
    expect(s.args.slice(-2)).toEqual(['--resume', '11111111-2222-3333-4444-555555555555'])
    expect(s.args).toContain('--model=opus')
    expect(s.args[0]).toBe('--dangerously-skip-permissions')
    expect(settingsOf(s)).toMatchObject({ effortLevel: 'high', permissions: { defaultMode: 'bypassPermissions' } })
  })
  onCaseExactTmp('refuses a permission flag that is not one, and a value that would read as a flag', () => {
    expect(() => buildWorkerSpec(inputs({ permissionFlag: '--append-system-prompt' }))).toThrow(/^forbidden_arg/)
    expect(() => buildWorkerSpec(inputs({ mcpConfigPath: 'relative.json' }))).toThrow(/^forbidden_arg/)
    const s = buildWorkerSpec(
      inputs({ preamble: '--permission-mode=bypassPermissions', permissionFlag: '--permission-mode=plan' }),
    )
    expect(s.args).toContain('--append-system-prompt=--permission-mode=bypassPermissions') // one element: a value, never a flag
    expect(settingsOf(s).env).toEqual({
      TELEGRAM_STATE_DIR: s.env.TELEGRAM_STATE_DIR,
      IMESSAGE_STATE_DIR: s.env.IMESSAGE_STATE_DIR,
    })
  })
  onCaseExactTmp('the folder launched is the resolved one; the thread id `all` is no thread', () => {
    const i = inputs()
    const real = join(i.agentDir, 'real')
    mkdirSync(real)
    symlinkSync(real, join(i.agentDir, 'via'))
    expect(buildWorkerSpec({ ...i, cwd: join(i.agentDir, 'via') }).cwd).toBe(real)
    expect(() => buildWorkerSpec(inputs({ threadId: 'all' }))).toThrow(/^bad_thread/)
  })
  it('refuses bad ids, models and efforts, and a Talos home no rule can name', () => {
    const bad = (over: Partial<WorkerInputs>, code: string) =>
      expect(() => buildWorkerSpec(inputs(over))).toThrow(new RegExp(`^${code}`))
    bad({ threadId: 'Trip' }, 'bad_thread')
    bad({ sessionId: 'nope' }, 'bad_session_id')
    bad({ model: '-x' }, 'bad_model')
    bad({ effort: 'MAX' }, 'bad_effort')
    expect(fenceSafe('/home/alex/ta*los')).toBe(false)
    for (const bad of ['/home/alex/ta\\los', '/home/alex/talos ', '/home//alex', '/home/./alex', '/home/../alex'])
      expect(fenceSafe(bad)).toBe(false)
    expect(fenceSafe('/home/alex/talos')).toBe(true)
  })
  onCaseExactTmp(
    'the guards ride in its settings, their relative path rules anchored where they were written; Main’s deny rules too',
    () => {
      const i = inputs()
      mkdirSync(join(i.talosHome, 'guards'))
      writeFileSync(
        join(i.talosHome, 'guards', 'settings.json'),
        JSON.stringify({
          permissions: { deny: ['Read(./.env)', 'Bash(rm -rf:*)'] },
          hooks: { PreToolUse: [{ x: 1 }] },
        }),
      )
      const s = buildWorkerSpec({ ...i, main: { ...i.main, denyRules: ['Edit(//etc/**)'] } })
      const set = settingsOf(s)
      expect(set.permissions.deny).toContain(`Read(/${i.agentDir}/**/.env)`) // any depth, as gitignore matches it
      expect(set.permissions.deny).toContain('Bash(rm -rf:*)')
      expect(set.permissions.deny).toContain('Edit(//etc/**)')
      expect(set.hooks.PreToolUse).toEqual([{ x: 1 }])
      writeFileSync(join(i.talosHome, 'guards', 'settings.json'), 'not json')
      expect(() => buildWorkerSpec(i)).toThrow(/^guards_unreadable/)
    },
  )
  onCaseExactTmp(
    'the last check refuses a spec changed after the build: a channel, headless, a token, a wider mode, no fence',
    () => {
      // a thread folder: only the user's settings (the flag the supervisor chose, held in its place)
      const i = inputs({ settingSources: 'user', systemPromptFile: true })
      const s = buildWorkerSpec(i)
      const trusted = {
        talosHome: i.talosHome,
        main: i.main,
        claudePath: i.claudePath,
        cwd: s.cwd,
        settingSources: 'user',
        outsideAgentFolder: true,
      }
      const broken = (f: (x: typeof s) => void, code: string) => {
        const c = structuredClone(s)
        f(c)
        expect(() => validateSpec(c, trusted)).toThrow(new RegExp(`^${code}`))
      }
      expect(() => validateSpec(s, trusted)).not.toThrow()
      // a sub-thread in its own folder: every deny rule of its parent's folder the supervisor read must be in the settings
      expect(() => validateSpec(s, { ...trusted, parentDeny: ['Read(//parent/private/**)'] })).toThrow(/^fence_missing/)
      // only the user's settings: the flag in its place, once, and never widened (project, local)
      broken((c) => c.args.splice(c.args.indexOf('--setting-sources=user'), 1), 'forbidden_arg')
      broken((c) => {
        c.args[c.args.indexOf('--setting-sources=user')] = '--setting-sources=user,project,local'
      }, 'forbidden_arg')
      broken((c) => c.args.splice(c.args.length - 2, 0, '--setting-sources=user'), 'forbidden_arg')
      // outside the agent folder the supervisor may only ever choose `user`
      expect(() => validateSpec(s, { ...trusted, settingSources: 'user,project' })).toThrow(/^forbidden_arg/)
      expect(() => validateSpec(s, { ...trusted, settingSources: null })).toThrow(/^forbidden_arg/)
      // one system prompt: the text or the pinned file, never both, never another file
      // the prompt file is the worker's own, replaced in its place; never both forms; never without the file outside it
      broken((c) => {
        const k = c.args.findIndex((a) => a.startsWith('--append-system-prompt-file='))
        c.args[k] = '--append-system-prompt-file=/etc/passwd'
      }, 'forbidden_arg')
      broken((c) => {
        const k = c.args.findIndex((a) => a.startsWith('--append-system-prompt-file='))
        c.args.splice(k, 0, '--append-system-prompt=x')
      }, 'forbidden_arg')
      broken((c) => {
        const k = c.args.findIndex((a) => a.startsWith('--append-system-prompt-file='))
        c.args[k] = '--append-system-prompt=x'
      }, 'forbidden_arg')
      // every worker: the prompt this start writes, never a replayed one
      broken((c) => c.args.splice(c.args.indexOf('--system-prompt-snapshot=off'), 1), 'forbidden_arg')
      broken((c) => {
        c.args[c.args.indexOf('--system-prompt-snapshot=off')] = '--system-prompt-snapshot=on'
      }, 'forbidden_arg')
      // what steers the shell a hook's command runs in never reaches the session
      for (const k of [
        'SHELLOPTS',
        'BASHOPTS',
        'PS4',
        'ENV',
        'BASH_ENV',
        'BASH_FUNC_exec%%',
        'LD_PRELOAD',
        'LD_AUDIT',
        'DYLD_INSERT_LIBRARIES',
        'GCONV_PATH',
        'CLAUDE_CODE_SHELL_PREFIX',
      ])
        broken((c) => {
          c.env[k] = 'x'
        }, 'forbidden_env')
      // the settings file it was checked with is the one loaded, once; the name too
      broken((c) => {
        const k = c.args.indexOf('--settings')
        c.args.splice(k, 2)
      }, 'forbidden_arg')
      broken((c) => {
        c.args[c.args.indexOf('--settings') + 1] = '/tmp/other.json'
      }, 'forbidden_arg')
      broken((c) => c.args.push('--settings', `${i.talosHome}/workers/trip/settings.json`), 'forbidden_arg')
      broken((c) => {
        c.args[c.args.indexOf('--name') + 1] = 'talos-other'
      }, 'forbidden_arg')
      // the home is the supervisor's, never the spec's
      broken((c) => {
        c.env.TALOS_APP_HOME = '/tmp/other'
        c.env.TELEGRAM_STATE_DIR = noChannelDir('/tmp/other')
        c.env.IMESSAGE_STATE_DIR = noChannelDir('/tmp/other')
      }, 'forbidden_env')
      broken((c) => {
        delete c.env.TALOS_APP_HOME
        delete c.env.TELEGRAM_STATE_DIR
        delete c.env.IMESSAGE_STATE_DIR
      }, 'forbidden_env')
      // and Main's ceiling is the supervisor's: widening spec.main changes nothing
      broken((c) => {
        c.args.unshift('--dangerously-skip-permissions')
        c.main = { ...c.main, permissionArgs: ['--dangerously-skip-permissions'] }
      }, 'escalation')
      broken((c) => {
        delete c.env.TALOS_SESSION_ROLE
      }, 'forbidden_env')
      broken((c) => {
        c.env.CLAUDE_CODE_SESSION_ID = 'x'
      }, 'forbidden_env')
      broken((c) => {
        c.settingsJSON = 'null'
      }, 'forbidden_env')
      broken((c) => {
        c.settingsJSON = JSON.stringify({ ...settingsOf(c), env: { TELEGRAM_BOT_TOKEN: 't' } })
      }, 'forbidden_env')
      broken((c) => c.args.push('--append-system-prompt', '--permission-mode=bypassPermissions'), 'forbidden_arg')
      // only the shape the build emits: no other flag, no second session flag, no resume of another conversation
      for (const extra of [
        ['-n', 'other'],
        ['-r', '22222222-3333-4444-5555-666666666666'],
        ['--continue'],
        ['--safe-mode'],
        ['--add-dir', i.talosHome],
        ['--system-prompt=x'],
        ['--model=opus'],
      ])
        broken((c) => c.args.push(...extra), 'forbidden_arg')
      broken((c) => {
        c.program = '/tmp/evil'
      }, 'forbidden_arg')
      broken((c) => {
        c.cwd = i.talosHome
      }, 'relative_cwd')
      broken((c) => {
        c.settingsJSON = JSON.stringify({ ...settingsOf(c), disableAllHooks: true })
      }, 'escalation')
      broken((c) => c.args.push('--channels', 'server:talos-app'), 'forbidden_arg')
      broken((c) => c.args.push('-pfoo'), 'forbidden_arg')
      broken((c) => c.args.push('--print'), 'forbidden_arg')
      broken((c) => {
        c.env.TELEGRAM_BOT_TOKEN = 'x'
      }, 'forbidden_env')
      broken((c) => {
        c.env.TELEGRAM_STATE_DIR = '/home/alex/.claude/channels/telegram'
      }, 'forbidden_env')
      broken((c) => c.args.push('--permission-mode', 'acceptEdits'), 'forbidden_arg') // only the one-element form exists
      broken((c) => c.args.unshift('--permission-mode=acceptEdits'), 'escalation') // in its place: the ceiling refuses it
      broken((c) => c.args.push('--permission-mode=acceptEdits'), 'forbidden_arg') // anywhere else: the shape does
      broken((c) => {
        c.settingsJSON = JSON.stringify({ ...settingsOf(c), permissions: { deny: [] } })
      }, 'fence_missing')
      expect(argvLooksLikeMain(['claude', '--dangerously-load-development-channels', 'server:talos-app'])).toBe(true)
    },
  )
  onCaseExactTmp('a sub-thread’s folder must be strictly inside its parent’s, resolved', () => {
    const root = tmp()
    const parent = join(root, 'p')
    mkdirSync(join(parent, 'child'), { recursive: true })
    mkdirSync(join(root, 'out'))
    symlinkSync(join(root, 'out'), join(parent, 'link'))
    expect(subThreadProblem(join(parent, 'child'), parent)).toBeNull()
    expect(subThreadProblem(parent, parent)).toContain('inside')
    expect(subThreadProblem(join(parent, 'link'), parent)).toContain('inside') // a link leads out
    expect(subThreadProblem(join(parent, 'gone'), parent)).toContain('does not exist')
    expect(prepareSubThreadFolder(join(parent, 'a', 'b'), parent)).toEqual({ folder: join(parent, 'a', 'b') })
    expect(prepareSubThreadFolder(join(parent, 'link', 'x'), parent)).toHaveProperty('refused') // never made outside
    expect(prepareSubThreadFolder(join(parent, '..', 'escape'), parent)).toHaveProperty('refused')
    // an existing folder outside, named as itself, is the sub-thread's own folder (Delphi c24c01f8): see the next test
    expect(() => buildWorkerSpec(inputs({ cwd: join(parent, 'link'), parentCwd: parent }))).toThrow(
      /^sub_thread_folder/,
    )
  })
  onCaseExactTmp(
    'a sub-thread may keep its own EXISTING folder outside its parent’s: used as it is, never made',
    () => {
      const root = tmp()
      const parent = join(root, 'p')
      const out = join(root, 'out')
      mkdirSync(join(parent, 'child'), { recursive: true })
      mkdirSync(out)
      writeFileSync(join(root, 'file'), 'x')
      symlinkSync(out, join(parent, 'link'))
      // accepted at every check: the start, the plan, the fence of a running session, the dry plan and the made folder
      expect(subThreadProblem(out, parent)).toBeNull()
      expect(subThreadCheck(out, parent)).toBeNull()
      expect(subThreadFence(out, parent)).toBe('inside') // a running own-folder sub-thread is not parked
      expect(subThreadTarget(out, parent)).toBe(out)
      expect(existingSubThreadFolder(out, parent)).toEqual({ folder: out })
      expect(prepareSubThreadFolder(`${out}/`, parent)).toEqual({ folder: out })
      expect(() => buildWorkerSpec(inputs({ cwd: out, parentCwd: parent }))).not.toThrow()
      // never made: a missing folder outside is refused, and is still not there after
      const gone = join(root, 'gone')
      expect(prepareSubThreadFolder(gone, parent)).toHaveProperty('refused')
      expect(existsSync(gone)).toBe(false)
      expect(subThreadProblem(gone, parent)).toContain('does not exist')
      // never an own folder: relative, a . or .. segment, written under the parent (a link inside it that leads out), the
      // parent itself, a file
      for (const cwd of ['out', `${parent}/../out`, `${root}/./out`, join(parent, 'link'), parent, `${parent}/`]) {
        expect(subThreadCheck(cwd, parent), cwd).not.toBeNull()
        expect(subThreadFence(cwd, parent), cwd).toBe('outside')
        expect(prepareSubThreadFolder(cwd, parent), cwd).toHaveProperty('refused')
      }
      expect(subThreadProblem(join(root, 'file'), parent)).not.toBeNull()
      // inside still works as before, and is still made
      expect(prepareSubThreadFolder(join(parent, 'new'), parent)).toEqual({ folder: join(parent, 'new') })
    },
  )
  onCaseExactTmp('a thread folder must be inside the home, not ~/.claude, not the Talos home', () => {
    const home = tmp()
    mkdirSync(join(home, 'proj'))
    mkdirSync(join(home, '.claude', 'x'), { recursive: true })
    mkdirSync(join(home, 'talos', 'x'), { recursive: true })
    const talos = join(home, 'talos')
    expect(workerFolderProblem(join(home, 'proj'), home, talos)).toBeNull()
    expect(workerFolderProblem(home, home, talos)).toContain('inside your home')
    expect(workerFolderProblem(join(home, '.claude', 'x'), home, talos)).toContain('.claude')
    expect(workerFolderProblem(join(home, 'talos', 'x'), home, talos)).toContain('Talos data')
    expect(workerFolderProblem(`${home}/proj/../proj`, home, talos)).toContain('without . or ..')
    expect(workerFolderProblem('/etc', home, talos)).toContain('inside your home')
  })
  onCaseExactTmp(
    'a folder no permission rule can name exactly (a glob character, a bracket, a paren, a backslash, a trailing space) is refused (Fable R1-4)',
    () => {
      const home = tmp()
      const talos = join(home, 'talos')
      for (const name of ['a*b', 'a?b', 'a[b]', 'a{b}', 'a(b)', 'trailing ']) {
        mkdirSync(join(home, name))
        expect(workerFolderProblem(join(home, name), home, talos), name).toBe(FOLDER_NOT_NAMEABLE)
      }
      // a backslash: Bun's realpathSync cannot resolve such a path at all (ENOENT, seen with 1.3.11), so it is refused before
      // the character check; refused either way
      mkdirSync(join(home, 'a\\b'))
      expect(workerFolderProblem(join(home, 'a\\b'), home, talos)).not.toBeNull()
      // a plain name with spaces, dots and dashes is fine
      mkdirSync(join(home, 'My Project-2.0'))
      expect(workerFolderProblem(join(home, 'My Project-2.0'), home, talos)).toBeNull()
    },
  )
})

describe('the privilege ceiling', () => {
  it('ranks the modes, reads the last flag, and treats an unknown name or a reachable bypass as the widest', () => {
    expect(modeOf(['--permission-mode', 'plan'], null).rank).toBe(0)
    expect(modeOf([], 'acceptEdits').rank).toBe(2)
    expect(modeOf(['--permission-mode=nope'], null).rank).toBe(4)
    expect(modeOf(['--allow-dangerously-skip-permissions'], null).rank).toBe(4)
    expect(modeOf(['--settings', '--permission-mode', 'plan'], null).rank).toBe(1) // a value is never read as a flag
    expect(modeOf([], 'manual')).toEqual({ rank: 1, name: 'default' })
  })
  it('refuses a wider mode, an MCP server Main lacks, or missing deny rules', () => {
    const main = { permissionArgs: [], defaultMode: null, mcpServers: ['github'], denyRules: ['Read(//x)'] }
    expect(checkCeiling(['--permission-mode', 'acceptEdits'], {}, [], [], main)?.axis).toBe('permission_mode')
    expect(
      checkCeiling([], { permissions: { deny: ['Read(//x)'] } }, ['github', 'talos-app', 'slack'], [], main)?.axis,
    ).toBe('mcp')
    expect(checkCeiling([], { permissions: { deny: ['Read(//x)'] } }, ['slack'], ['slack'], main)).toBeNull()
    expect(checkCeiling([], {}, [], [], main)?.axis).toBe('deny_rules')
  })
  it('reads Main’s mode flags as Claude Code does: --resume takes a value only when it is not a flag; nothing after --', () => {
    expect(modeOf(['--resume', '--permission-mode', 'plan'], null).name).toBe('plan')
    expect(modeOf(['--resume', 'abc', '--permission-mode', 'plan'], null).name).toBe('plan')
    expect(modeOf(['--', '--permission-mode', 'bypassPermissions'], null).name).toBeNull()
  })
  it('anchors path rules where they were written', () => {
    expect(absolutize('Read(.env)', '/g', '/agent')).toBe('Read(//agent/**/.env)') // no slash: any depth
    expect(absolutize('Read(./a/b)', '/g', '/agent')).toBe('Read(//agent/a/b)')
    expect(absolutize('Edit(/secret)', '/home/alex/talos/guards', '/agent')).toBe(
      'Edit(//home/alex/talos/guards/secret)',
    )
    expect(absolutize('Read(//abs)', '/g', '/agent')).toBe('Read(//abs)')
    expect(absolutize('Bash(ls)', '/g', '/agent')).toBe('Bash(ls)')
    // a deny on the whole tool stays one: never narrowed to a folder (Main read-only with Edit(*) must not leave a worker able to edit)
    for (const r of ['Edit(*)', 'Write()', 'Read(*)']) expect(absolutize(r, '/g', '/agent')).toBe(r)
  })
  it('reads Main’s deny rules and default mode from the files it runs under', () => {
    const root = tmp()
    const agent = join(root, 'agent')
    const talos = join(root, 'talos')
    const claude = join(root, 'claude')
    mkdirSync(join(agent, '.claude'), { recursive: true })
    mkdirSync(join(talos, 'guards'), { recursive: true })
    mkdirSync(claude)
    writeFileSync(
      join(agent, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Read(.env)'], defaultMode: 'bypassPermissions' } }),
    )
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }))
    expect(mainDenyRules(agent, talos)).toEqual([`Read(/${agent}/**/.env)`])
    // bypass in a project file does not take effect: the built-in default applies, never the user's value
    expect(mainDefaultMode(agent, talos, claude)).toBeNull()
    writeFileSync(join(talos, 'guards', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }))
    expect(mainDefaultMode(agent, talos, claude)).toBe('plan')
  })
})

describe('Main and the guards', () => {
  it('the guards’ file is Main’s --settings when installed; args with their own --settings keep them and say so', () => {
    const talos = tmp()
    const plain = mainArgsWithGuards(['--x'], talos)
    expect(plain.warning).toBeNull()
    expect(plain.args).toEqual(['--settings', '{"deniedMcpServers":[{"serverName":"computer-use"}]}', '--x'])
    mkdirSync(join(talos, 'guards'))
    writeFileSync(join(talos, 'guards', 'settings.json'), '{}')
    expect(mainArgsWithGuards(['--x'], talos).args).toEqual([
      '--settings',
      join(talos, 'guards', 'main-launch.json'),
      '--x',
    ])
    expect(mainArgsWithGuards(['--settings', '/mine.json'], talos).warning).toContain('NOT active')
  })
})

describe('the developer thread fence, at the spec and its last check', () => {
  onCaseExactTmp(
    "off: no Talos-home fence in the spec; its last check takes the supervisor's own read, never the spec's",
    () => {
      const i = inputs({ threadFence: false })
      const spec = buildWorkerSpec(i)
      const deny = settingsOf(spec).permissions.deny as string[]
      for (const r of fenceDenyRules(i.talosHome)) expect(deny).not.toContain(r)
      // the sessions' own files (hook copy, settings, mcp.json, nonce) stay closed to the file tools (Delphi's review)
      const own = workerFilesDenyRules(i.talosHome)
      for (const r of own) expect(deny).toContain(r)
      expect(own).toContain(`Edit(/${i.talosHome}/workers/**)`)
      const trusted = {
        talosHome: i.talosHome,
        threadFence: false,
        main: i.main,
        claudePath: i.claudePath,
        cwd: spec.cwd,
      }
      expect(() => validateSpec(spec, trusted)).not.toThrow()
      // a spec that lost the workers/ deny is refused, fence off or on
      const stripped = {
        ...spec,
        settingsJSON: JSON.stringify({
          ...settingsOf(spec),
          permissions: { ...settingsOf(spec).permissions, deny: deny.filter((r) => !own.includes(r)) },
        }),
      }
      expect(() => validateSpec(stripped, trusted)).toThrow(WorkerSpecRefused)
      // a spec built with the fence off is refused where the supervisor read it on
      expect(() => validateSpec(spec, { ...trusted, threadFence: true })).toThrow(WorkerSpecRefused)
      expect(() =>
        validateSpec(spec, { talosHome: i.talosHome, main: i.main, claudePath: i.claudePath, cwd: spec.cwd }),
      ).toThrow(WorkerSpecRefused)
    },
  )
})

describe('errors', () => {
  it('carry a code', () => {
    try {
      buildWorkerSpec(inputs({ threadId: 'X' }))
    } catch (e) {
      expect(e).toBeInstanceOf(WorkerSpecRefused)
      expect((e as WorkerSpecRefused).code).toBe('bad_thread')
    }
  })
})

describe('case folding, and the plan-only sub-thread check', () => {
  it('a part of the path that answers to its case-swapped name is a case-folding file system (checked part by part)', () => {
    // a casefold mount at /home/alex/usb under a case-sensitive root
    const inode: Record<string, number> = {
      '/home': 1,
      '/home/alex': 2,
      '/home/alex/usb': 3,
      '/home/alex/USB': 3,
      '/home/alex/usb/talos': 4,
    }
    const stat = (p: string) => (p in inode ? { dev: 1, ino: inode[p] as number } : null)
    expect(foldsCase('/home/alex/usb/talos', stat)).toBe(true)
    expect(foldsCase('/home/alex', stat)).toBe(false)
    // the real path is what counts for a linked home: the link's own name folds nothing
    expect(foldsCase('/home/alex/.talos', stat)).toBe(false)
    expect(foldsCase('/home/alex/usb/talos', stat)).toBe(true)
  })
  onCaseExactTmp('a case-exact temp folder does not fold', () => {
    expect(foldsCase(tmp())).toBe(false)
  })
  it.if(TMP_FOLDS)('on a case-folding temp folder (a Mac) a launch and a thread folder are refused', () => {
    expect(() => buildWorkerSpec(inputs())).toThrow(/^unsafe_talos_home/)
    expect(workerFolderProblem(tmp(), '/', '/nowhere')).toContain('ignores letter case')
  })
  it('subThreadCheck plans without making anything', () => {
    const root = tmp()
    const parent = join(root, 'p')
    mkdirSync(parent)
    expect(subThreadCheck(join(parent, 'new', 'deep'), parent)).toBeNull()
    expect(subThreadCheck(join(root, 'elsewhere'), parent)).toContain('inside')
    expect(subThreadCheck(join(parent, '..', 'x'), parent)).toContain('inside')
    expect(() => statSync(join(parent, 'new'))).toThrow() // nothing was made
  })
  onCaseExactTmp('Main on --permission-mode=manual can start workers', () => {
    const s = buildWorkerSpec(
      inputs({
        permissionFlag: '--permission-mode=manual',
        main: { permissionArgs: ['--permission-mode=manual'], defaultMode: null, mcpServers: [], denyRules: [] },
      }),
    )
    expect(s.args[0]).toBe('--permission-mode=manual')
  })
})

describe('the session never inherits what steers the shell its hooks run in', () => {
  onCaseExactTmp(
    'SHELLOPTS, BASHOPTS, PS4, ENV, BASH_ENV, imported functions, the loader, GCONV_PATH and the shell prefix are dropped',
    () => {
      const i = inputs()
      const s = buildWorkerSpec({
        ...i,
        baseEnv: {
          ...i.baseEnv,
          SHELLOPTS: 'xtrace',
          BASHOPTS: 'extglob',
          PS4: '$(x)',
          ENV: '/x',
          BASH_ENV: '/x',
          'BASH_FUNC_exec%%': '() { :; }',
          LD_PRELOAD: '/x.so',
          LD_LIBRARY_PATH: '/x',
          DYLD_INSERT_LIBRARIES: '/x',
          GCONV_PATH: '/x',
          CLAUDE_CODE_SHELL_PREFIX: '/x',
          BASH_DEFAULT_TIMEOUT_MS: '1000',
        },
      })
      for (const k of [
        'SHELLOPTS',
        'BASHOPTS',
        'PS4',
        'ENV',
        'BASH_ENV',
        'BASH_FUNC_exec%%',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'GCONV_PATH',
        'CLAUDE_CODE_SHELL_PREFIX',
      ])
        expect(s.env[k], k).toBeUndefined()
      expect(s.env.BASH_DEFAULT_TIMEOUT_MS).toBe('1000') // a tunable named BASH_ stays
    },
  )
})

describe('the rooted guards refusal and the computer-use deny hold together (kit-update rebased onto the screen helper)', () => {
  onCaseExactTmp(
    'a rooted session with a guards file is refused; a plain session still carries computer-use in deniedMcpServers',
    () => {
      const r = inputs({ rooted: true })
      mkdirSync(join(r.talosHome, 'guards'), { recursive: true })
      writeFileSync(join(r.talosHome, 'guards', 'settings.json'), '{}')
      expect(() => buildWorkerSpec(r)).toThrow(/^forbidden_env.*guards file/)
      const plain = settingsOf(buildWorkerSpec(inputs()))
      expect(plain.deniedMcpServers).toContainEqual({ serverName: 'computer-use' })
    },
  )
})

describe('TALOS_APP_THREAD_STATE: set exactly when the thread-state hook is registered', () => {
  const hook = (i: WorkerInputs, state: unknown) => ({ ...i.permissionHook, state })
  onCaseExactTmp('a session with the staged hook has it, and its settings run the hook', () => {
    const i = inputs()
    const s = buildWorkerSpec({ ...i, permissionHook: hook(i, {}) })
    expect(s.env.TALOS_APP_THREAD_STATE).toBe('1')
    expect(settingsOf(s).hooks.SessionStart).toHaveLength(1)
  })
  onCaseExactTmp(
    'a session without it (an older kit) has no variable and no hook, even if the login environment had one',
    () => {
      const i = inputs()
      const s = buildWorkerSpec({ ...i, baseEnv: { ...i.baseEnv, TALOS_APP_THREAD_STATE: '1' } })
      expect(s.env.TALOS_APP_THREAD_STATE).toBeUndefined()
      expect(settingsOf(s).hooks?.SessionStart).toBeUndefined()
    },
  )
  onCaseExactTmp('a rooted spec has no variable and no thread-state hook', () => {
    const i = inputs({ rooted: true })
    const s = buildWorkerSpec({ ...i, permissionHook: hook(i, {}) })
    expect(s.env.TALOS_APP_THREAD_STATE).toBeUndefined()
    expect(settingsOf(s).hooks?.SessionStart).toBeUndefined()
    expect(settingsOf(s).permissions.allow).toBeUndefined()
  })
})

describe('validateSpec: TALOS_APP_THREAD_STATE if and only if the settings run the thread-state hook', () => {
  const trustedOf = (i: WorkerInputs) => ({
    talosHome: i.talosHome,
    main: i.main,
    claudePath: i.claudePath,
    cwd: realpathSync(i.agentDir),
    settingSources: null,
  })
  const withState = (i: WorkerInputs) => ({ ...i, permissionHook: { ...i.permissionHook, state: {} } })
  onCaseExactTmp('a spec built with the hook and the variable passes; a plain one passes', () => {
    const a = withState(inputs())
    expect(() => validateSpec(buildWorkerSpec(a), trustedOf(a))).not.toThrow()
    const b = inputs()
    expect(() => validateSpec(buildWorkerSpec(b), trustedOf(b))).not.toThrow()
  })
  onCaseExactTmp('the variable without the hook in the settings is refused', () => {
    const i = inputs()
    const s = buildWorkerSpec(i)
    expect(() => validateSpec({ ...s, env: { ...s.env, [THREAD_STATE_ENV]: '1' } }, trustedOf(i))).toThrow(
      /thread-state/,
    )
  })
  onCaseExactTmp('the hook in the settings without the variable is refused', () => {
    const i = withState(inputs())
    const s = buildWorkerSpec(i)
    const { [THREAD_STATE_ENV]: _gone, ...env } = s.env
    expect(() => validateSpec({ ...s, env }, trustedOf(i))).toThrow(/thread-state/)
  })
  onCaseExactTmp('one of the two commands without the other, or a value other than 1, is refused', () => {
    const i = withState(inputs())
    const s = buildWorkerSpec(i)
    const settings = settingsOf(s)
    delete settings.hooks.PreCompact
    expect(() => validateSpec({ ...s, settingsJSON: JSON.stringify(settings) }, trustedOf(i))).toThrow(/thread-state/)
    expect(() => validateSpec({ ...s, env: { ...s.env, [THREAD_STATE_ENV]: 'yes' } }, trustedOf(i))).toThrow()
  })
})
