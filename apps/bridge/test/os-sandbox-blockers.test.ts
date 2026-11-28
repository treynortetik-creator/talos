// The OS sandbox review's four blockers (guards/os-sandbox.ts, guards/os-sandbox-folder.ts): ways a sandboxed session could run
// code OUTSIDE the sandbox. 1 Main's hook and script files in its own (writable) folder; 2 workers/** and the permission-hook copy;
// 3 bridge.env, mod.key and apps/catalog.json; 4 a project or local settings file that weakens the sandbox. Temp folders only.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { osSandboxCheck } from '../src/doctor-sandbox.ts'
import { mainLaunchArgs } from '../src/guards/main-launch.ts'
import {
  OS_SANDBOX_DENY_READ,
  OS_SANDBOX_DENY_WRITE,
  osSandboxSettings,
  planOsSandbox,
  prepareOsSandbox,
} from '../src/guards/os-sandbox.ts'
import { folderSettingsProblem } from '../src/guards/os-sandbox-folder.ts'
import { buildGuardConfig, guardDecision, HOME_NEVER, HOME_READ_ONLY, HOME_WRITE_DENIED } from '../src/guards/rules.ts'

const dirs: string[] = []
const KIT_HOME_WAS = process.env.TALOS_KIT_HOME
afterEach(() => {
  // the kit release the folder's links must lead into (talos.ts kitVendorDir reads this): makeAgent points it at its own
  if (KIT_HOME_WAS === undefined) delete process.env.TALOS_KIT_HOME
  else process.env.TALOS_KIT_HOME = KIT_HOME_WAS
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755)
    } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})
const tmp = (p = 'tsbx2-') => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), p)))
  dirs.push(d)
  return d
}
const w = (p: string, s = '') => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, s)
}
function makeHome(on = false) {
  const home = tmp('tsbx2-home-')
  w(join(home, 'config.json'), JSON.stringify({ ...loadExampleConfig('default'), ...(on ? { os_sandbox: true } : {}) }))
  return home
}
/** A Main folder as the kit installer makes it: hooks and scripts are links into a kit release, settings run the hooks. */
function makeAgent() {
  const agent = tmp('tsbx2-agent-')
  const rel = tmp('tsbx2-release-')
  process.env.TALOS_KIT_HOME = rel
  mkdirSync(join(rel, 'hooks'))
  mkdirSync(join(rel, 'scripts'))
  w(join(rel, 'hooks', 'pre-tool-guard.py'), 'print(1)')
  w(join(rel, 'hooks', 'status.py'), 'print(1)')
  w(join(rel, 'scripts', 'run.sh'), '#!/bin/sh\n')
  w(join(rel, 'mcp', 'mcp.py'), 'print(1)')
  symlinkSync(join(rel, 'hooks'), join(agent, 'hooks'))
  symlinkSync(join(rel, 'scripts'), join(agent, 'scripts'))
  w(join(agent, 'CLAUDE.md'), 'x')
  w(join(agent, 'AGENTS.md'), 'x')
  w(
    join(agent, '.mcp.json'),
    JSON.stringify({ mcpServers: { local: { command: 'python3', args: [join(rel, 'mcp', 'mcp.py')] } } }),
  )
  w(
    join(agent, '.claude', 'settings.json'),
    JSON.stringify({
      statusLine: { type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/hooks/status.py"' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/hooks/pre-tool-guard.py"' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: '"${CLAUDE_PROJECT_DIR}"/scripts/run.sh' }] }],
      },
    }),
  )
  return { agent, rel }
}
const input = (home: string, folder: string) => ({
  talosHome: home,
  userHome: '/home/alex',
  folder,
  platform: 'linux' as const,
})

describe('1. Main’s hook and script files in its own folder cannot be replaced', () => {
  test('the folder’s hooks, scripts, kit, .claude, .mcp.json and instruction files are unwritable, the links by their own name', () => {
    const home = makeHome()
    const { agent } = makeAgent()
    mkdirSync(join(agent, 'kit'))
    const deny = osSandboxSettings(input(home, agent)).sandbox.filesystem.denyWrite
    for (const n of ['hooks', 'scripts', 'kit', '.claude', '.mcp.json', 'CLAUDE.md', 'AGENTS.md'])
      expect(deny, n).toContain(join(agent, n))
  })
  test('a folder reached through a symlink is protected by its real path', () => {
    const home = makeHome()
    const { agent } = makeAgent()
    const aside = tmp()
    symlinkSync(agent, join(aside, 'link'))
    const deny = osSandboxSettings(input(home, join(aside, 'link'))).sandbox.filesystem.denyWrite
    expect(deny).toContain(join(agent, '.claude'))
    expect(deny.some((p) => p.startsWith(aside))).toBe(false)
  })
  test('a lead’s folder: its .claude, its brief and its marker', () => {
    const home = makeHome()
    const lead = tmp('tsbx2-lead-')
    w(join(lead, '.claude', 'settings.json'), '{}')
    w(join(lead, 'CLAUDE.md'), 'x')
    w(join(lead, '.talos-lead'), '{}')
    const deny = osSandboxSettings(input(home, lead)).sandbox.filesystem.denyWrite
    for (const n of ['.claude', 'CLAUDE.md', '.talos-lead']) expect(deny, n).toContain(join(lead, n))
  })
  test('Main’s launch carries them', () => {
    const home = makeHome(true)
    const { agent } = makeAgent()
    const r = mainLaunchArgs([], home, {
      cwd: agent,
      userHome: '/home/alex',
      ownerExcludes: () => [],
      writableRoots: [],
    })
    expect(r.refusal).toBeUndefined()
    const s = JSON.parse(r.args[1] as string)
    expect(s.sandbox.filesystem.denyWrite).toContain(join(agent, 'hooks'))
  })
  test('a deleted kit link is a refused start: the hooks would silently not run', () => {
    const home = makeHome(true)
    const { agent } = makeAgent()
    rmSync(join(agent, 'hooks'))
    const r = prepareOsSandbox(
      { talosHome: home, userHome: '/home/alex', folder: agent, writableRoots: [] },
      { ownerExcludes: () => [] },
    )
    expect('refusal' in r && r.refusal).toMatch(/hooks/)
  })
})

describe('A. a hard link to a file in the session’s folder is refused', () => {
  const prepare = (folder: string) =>
    prepareOsSandbox(
      { talosHome: makeHome(true), userHome: '/home/alex', folder, writableRoots: [] },
      { ownerExcludes: () => [] },
    )
  test('a clean folder starts', () => {
    const { agent } = makeAgent()
    expect('pieces' in prepare(agent)).toBe(true)
  })
  test('a hard link to .claude/settings.local.json (made earlier, outside the sandbox) is refused with the plain line', () => {
    const { agent } = makeAgent()
    w(join(agent, '.claude', 'settings.local.json'), '{}')
    linkSync(join(agent, '.claude', 'settings.local.json'), join(tmp('tsbx2-else-'), 'sneaky'))
    const r = prepare(agent)
    expect('refusal' in r && r.refusal).toBe(
      '.claude/settings.local.json has another name on this disk (a hard link); remove the other link, then start again',
    )
  })
  test('so is a hard link to the instruction file or the servers file', () => {
    for (const f of ['CLAUDE.md', '.mcp.json']) {
      const { agent } = makeAgent()
      linkSync(join(agent, f), join(tmp('tsbx2-else-'), 'sneaky'))
      const r = prepare(agent)
      expect('refusal' in r && r.refusal, f).toContain(`${f} has another name on this disk`)
    }
  })
  test('the kit’s own links (hooks, scripts) are links on purpose and are not refused', () => {
    const { agent } = makeAgent()
    expect('pieces' in prepare(agent)).toBe(true)
  })
})

describe('A2. hooks, scripts and kit are links only into the kit release', () => {
  const prepare = (folder: string) =>
    prepareOsSandbox(
      { talosHome: makeHome(true), userHome: '/home/alex', folder, writableRoots: [] },
      { ownerExcludes: () => [] },
    )
  const relink = (agent: string, name: string, target: string) => {
    rmSync(join(agent, name), { recursive: true, force: true })
    symlinkSync(target, join(agent, name))
  }
  test('a link into the kit release starts', () => {
    const { agent } = makeAgent()
    expect('pieces' in prepare(agent)).toBe(true)
  })
  test('a link to a writable place outside the folder (tmp) is refused', () => {
    const { agent } = makeAgent()
    const x = tmp('tsbx2-x-')
    w(join(x, 'agent-log.py'), 'print(1)')
    relink(agent, 'hooks', x)
    const r = prepare(agent)
    expect('refusal' in r && r.refusal).toMatch(/^hooks is a symbolic link that does not lead into the kit release/)
  })
  test('a link back into the folder itself is refused', () => {
    const { agent } = makeAgent()
    mkdirSync(join(agent, 'mine'))
    relink(agent, 'scripts', join(agent, 'mine'))
    const r = prepare(agent)
    expect('refusal' in r && r.refusal).toMatch(/^scripts is a symbolic link that does not lead into the kit release/)
  })
  test('hooks as a real folder with a hard-linked file inside is refused', () => {
    const { agent } = makeAgent()
    rmSync(join(agent, 'hooks'))
    w(join(agent, '.claude', 'settings.json'), '{}')
    w(join(agent, 'hooks', 'pre-tool-guard.py'), 'print(1)')
    linkSync(join(agent, 'hooks', 'pre-tool-guard.py'), join(tmp('tsbx2-else-'), 'sneaky'))
    const r = prepare(agent)
    expect('refusal' in r && r.refusal).toBe(
      'hooks/pre-tool-guard.py has another name on this disk (a hard link); remove the other link, then start again',
    )
  })
  test('hooks as a real, clean folder starts and is denied for writing', () => {
    const { agent } = makeAgent()
    rmSync(join(agent, 'hooks'))
    w(join(agent, '.claude', 'settings.json'), '{}')
    w(join(agent, '.mcp.json'), '{}')
    w(join(agent, 'hooks', 'pre-tool-guard.py'), 'print(1)')
    const r = prepare(agent)
    expect('pieces' in r && r.pieces.sandbox.filesystem.denyWrite).toContain(join(agent, 'hooks'))
  })
})

describe('2. workers/** is not writable from a session', () => {
  test('the home is not writable (the session has its folder and tmp, as by default), and workers and workers.json are denied by name', () => {
    const home = makeHome()
    const folder = tmp('tsbx2-folder-')
    const s = osSandboxSettings(input(home, folder)).sandbox.filesystem
    expect(s.allowWrite).toEqual([])
    expect(s.denyWrite).toContain(join(home, 'workers'))
    expect(s.denyWrite).toContain(join(home, 'workers.json'))
  })
  test('a worker whose folder is under <home>/workers/<id> still cannot write workers/_hook or its settings.json', () => {
    const home = makeHome()
    const cwd = join(home, 'workers', 'trip')
    mkdirSync(join(home, 'workers', '_hook'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    w(join(home, 'workers', 'trip', 'settings.json'), '{}')
    const deny = osSandboxSettings(input(home, cwd)).sandbox.filesystem.denyWrite
    // the denied parent covers _hook and settings.json: the sandbox's deny wins over a writable cwd below it
    expect(deny).toContain(join(home, 'workers'))
    const r = planOsSandbox(true, { talosHome: home, userHome: '/home/alex', folder: cwd }, true)
    expect('pieces' in r && r.pieces?.sandbox.filesystem.denyWrite).toContain(join(home, 'workers'))
  })
})

describe('3. bridge.env, mod.key and apps/catalog.json', () => {
  test('unwritable in the sandbox; mod.key unreadable', () => {
    const home = makeHome()
    const s = osSandboxSettings(input(home, tmp())).sandbox.filesystem
    for (const n of ['bridge.env', 'mod.key', 'apps/catalog.json']) expect(s.denyWrite, n).toContain(join(home, n))
    expect(s.denyRead).toContain(join(home, 'mod.key'))
    expect(OS_SANDBOX_DENY_WRITE).toContain('bridge.env')
    expect(OS_SANDBOX_DENY_READ).toContain('mod.key')
  })
  test('the shell guard (the floor with the switch off) protects them too', () => {
    expect(HOME_READ_ONLY).toContain('bridge.env')
    expect(HOME_READ_ONLY).toContain('apps/catalog.json')
    expect(HOME_NEVER).toContain('mod.key')
    for (const n of ['bridge.env', 'mod.key', 'apps/catalog.json']) expect(HOME_WRITE_DENIED).toContain(n)
    const user = tmp('tsbx2-user-')
    const home = join(user, '.config', 'talos')
    const checkout = tmp('tsbx2-co-')
    mkdirSync(join(home, 'apps'), { recursive: true })
    const cfg = buildGuardConfig({ home, checkout, claudeHome: join(user, '.claude'), userHome: user })
    const bash = (command: string) => guardDecision({ tool_name: 'Bash', tool_input: { command } }, cfg)
    const file = (file_path: string) => guardDecision({ tool_name: 'Write', tool_input: { file_path } }, cfg)
    expect(bash(`echo FFMPEG=/tmp/x >> ${home}/bridge.env`)).toBeDefined()
    expect(bash(`python3 -c "open('${home}/apps/catalog.json','w')"`)).toBeDefined()
    expect(bash(`cat ${home}/mod.key`)).toBeDefined()
    expect(file(join(home, 'bridge.env'))).toBeDefined()
    expect(file(join(home, 'mod.key'))).toBeDefined()
    expect(file(join(home, 'apps', 'catalog.json'))).toBeDefined()
    // reading the first and the last stays allowed
    expect(bash(`cat ${home}/bridge.env`)).toBeUndefined()
  })
})

describe('4. a settings file in the folder cannot weaken the sandbox', () => {
  const sandboxed = (folder: string, claudeDir = tmp('tsbx2-claude-')) =>
    folderSettingsProblem(folder, claudeDir, { loadsProject: true })
  test('no settings, or settings with no sandbox key and no allow list: fine', () => {
    const { agent } = makeAgent()
    expect(sandboxed(agent)).toBeNull()
    expect(sandboxed(tmp())).toBeNull()
  })
  test('a project or a local file with sandbox keys (excludedCommands, allowWrite, enabled) is refused, naming the file', () => {
    for (const name of ['settings.json', 'settings.local.json']) {
      const f = tmp()
      w(join(f, '.claude', name), JSON.stringify({ sandbox: { excludedCommands: ['python3'] } }))
      expect(sandboxed(f)).toBe(
        `${join(f, '.claude', name)} sets sandbox.excludedCommands, which the extra lock does not allow (it could take a command out of the sandbox); remove it, then start again`,
      )
    }
  })
  test('a Bash allow rule (what “Yes, don’t ask again” writes) is an ordinary folder: it starts', () => {
    const f = tmp()
    w(join(f, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(python3:*)'] } }))
    expect(sandboxed(f)).toBeNull()
  })
  test('a sandbox key counts only in a level the session loads: a thread session outside the agent folder loads user settings only', () => {
    const f = tmp()
    w(join(f, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: ['python3'] } }))
    expect(folderSettingsProblem(f, tmp('tsbx2-claude-'), { loadsProject: true })).toContain(
      'sets sandbox.excludedCommands',
    )
    expect(folderSettingsProblem(f, tmp('tsbx2-claude-'), { loadsProject: false })).toBeNull()
    // the user level is loaded either way
    const claude = tmp('tsbx2-claude-')
    w(join(claude, 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['git'] } }))
    expect(folderSettingsProblem(f, claude, { loadsProject: false })).toContain(join(claude, 'settings.json'))
  })
  test('the git root above the folder counts too', () => {
    const root = tmp()
    mkdirSync(join(root, '.git'))
    w(join(root, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: ['python3'] } }))
    const sub = join(root, 'packages', 'a')
    mkdirSync(sub, { recursive: true })
    expect(sandboxed(sub)).toContain('sets sandbox.excludedCommands')
  })
  test('the owner’s user settings that would weaken every session are refused (as lead check says)', () => {
    const claude = tmp('tsbx2-claude-')
    w(join(claude, 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['git'] } }))
    expect(sandboxed(tmp(), claude)).toContain(join(claude, 'settings.json'))
  })
  test('the refusal reaches Main’s launch, the thread-session start and doctor', () => {
    const home = makeHome(true)
    const f = tmp()
    w(join(f, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: ['python3'] } }))
    const r = mainLaunchArgs([], home, { cwd: f, userHome: '/home/alex', ownerExcludes: () => [], writableRoots: [] })
    expect(r.refusal).toContain('sets sandbox.excludedCommands')
    const p = planOsSandbox(true, { talosHome: home, userHome: '/home/alex', folder: f }, true)
    expect('refusal' in p && p.refusal).toContain('sets sandbox.excludedCommands')
    expect(osSandboxCheck(home, f)).toMatchObject({
      level: 'FAIL',
      detail: expect.stringContaining('sets sandbox.excludedCommands'),
    })
  })
})

describe('talos-app from sandboxed Bash, with the home read-only', () => {
  const lines = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: {
        isTerminal: true,
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: () => Date.now(),
      },
    }
  }
  function readOnlyHome() {
    const home = makeHome()
    w(join(home, 'devices.json'), '{}')
    chmodSync(join(home, 'config.json'), 0o444)
    chmodSync(home, 0o555)
    return home
  }
  test('a command that truly writes the home says so in one line, no stack', async () => {
    const home = readOnlyHome()
    const o = lines()
    const code = await runCli(['sandbox', 'on'], o.io, { TALOS_APP_HOME: home })
    expect(code).toBe(1)
    // the history copy's own warning may come first; the command's last word is the one line, and there is no stack
    expect(o.err.at(-1)).toBe("This lock is on, so I'll ask Talos to change that setting.")
    expect(o.err.join('\n')).not.toMatch(/\n\s+at /)
  })
  test('the audit line to bridge.log is best effort: a command that only reads goes on', async () => {
    const home = readOnlyHome()
    const o = lines()
    // an agent run (no terminal): the audit write fails, the command still answers
    const code = await runCli(['sandbox', 'status'], { ...o.io, isTerminal: false }, { TALOS_APP_HOME: home })
    expect(code).toBe(0)
    expect(o.out.join('\n')).toContain('extra lock on protected files')
    expect(o.err).toEqual([])
  })
})
