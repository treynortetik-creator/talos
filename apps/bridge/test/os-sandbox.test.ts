// The opt-in OS sandbox (guards/os-sandbox.ts): the settings it builds, the hard-link preflight, Main's launch with the switch on and
// off, a worker's spec, and the `talos-app sandbox` command. Temp folders only; Claude Code is never run here (the real run is the
// verify step in the change's report). Paths are real paths: a temp folder may sit behind a link (a Mac's /tmp).
import { afterEach, describe, expect, test } from 'bun:test'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { osSandboxHelpLines } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { agentCliRefusal } from '../src/agent-cli.ts'
import { loadEnv } from '../src/config.ts'
import { osSandboxCheck } from '../src/doctor-sandbox.ts'
import { withGuardsSettings } from '../src/guards/install.ts'
import { mainLaunchArgs, mainLaunchPath } from '../src/guards/main-launch.ts'
import {
  OS_SANDBOX_DENY_READ,
  OS_SANDBOX_DENY_WRITE,
  OsSandboxError,
  osSandboxPreflight,
  osSandboxSettings,
  prepareOsSandbox,
  readOsSandboxSwitch,
  readOwnerExcludes,
  withOsSandbox,
} from '../src/guards/os-sandbox.ts'
import {
  buildGuardConfig,
  HOME_NEVER,
  HOME_READ_ONLY,
  HOME_WRITE_DENIED,
  KEY_FILES,
  SUPERVISOR_READ_ONLY,
} from '../src/guards/rules.ts'
import { CACHE_ENV } from '../src/lead/settings.ts'
import { cmdSandbox } from '../src/sandbox-cli.ts'
import { foldsCase, mainArgsWithGuards } from '../src/supervisor/worker-policy.ts'
import { buildWorkerSpec, validateSpec, type WorkerInputs, WorkerSpecRefused } from '../src/supervisor/worker-spec.ts'
import { agentUnlessLocked, terminalOnly } from '../src/talos.ts'
import { SETTINGS_LOCKED } from '../src/trust.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix = 'tsbx-') => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))
  dirs.push(d)
  return d
}
/** A Talos home with every protected file in place, link count 1. */
function makeHome(over: { on?: boolean } = {}) {
  const home = tmp('tsbx-home-')
  const cfg = { ...loadExampleConfig('default'), ...(over.on ? { os_sandbox: true } : {}) }
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
  writeFileSync(join(home, 'devices.json'), '{}')
  writeFileSync(join(home, 'bridge.key'), 'k')
  mkdirSync(join(home, 'secrets'))
  writeFileSync(join(home, 'secrets', 'item'), 's')
  mkdirSync(join(home, 'launch'))
  writeFileSync(join(home, 'launch', 'run.sh'), '#!/bin/sh\n')
  writeFileSync(join(home, 'supervisor.json'), '{}')
  return home
}
const folderOf = () => tmp('tsbx-folder-')
const noOwner = () => []

describe('the settings it builds', () => {
  test('locked sandbox; the home is not writable and its protected names are denied; secrets and the key are unreadable', () => {
    const home = makeHome()
    const folder = folderOf()
    const p = osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder, platform: 'linux' })
    expect(p.sandbox.enabled).toBe(true)
    expect(p.sandbox.failIfUnavailable).toBe(true)
    expect(p.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(p.sandbox.filesystem.allowWrite).toEqual([]) // the home is NOT writable from a session
    expect(p.sandbox.filesystem.denyWrite).toContain(join(home, 'config.json'))
    expect(p.sandbox.filesystem.denyWrite).toContain(join(home, 'launch'))
    expect(p.sandbox.filesystem.denyWrite).toContain(join(home, 'sandbox'))
    expect(p.sandbox.filesystem.denyRead).toContain(join(home, 'secrets'))
    expect(p.sandbox.filesystem.denyRead).toContain(join(home, 'bridge.key'))
    // a file the session may read stays readable
    expect(p.sandbox.filesystem.denyRead).not.toContain(join(home, 'config.json'))
  })

  test('denyWrite covers every name the read-only list, the launch files and the guards protect: a new protected file cannot be forgotten', () => {
    const home = makeHome()
    const p = osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder: folderOf(), platform: 'linux' })
    const deny = new Set(p.sandbox.filesystem.denyWrite)
    for (const n of [...HOME_READ_ONLY, ...SUPERVISOR_READ_ONLY, ...HOME_WRITE_DENIED])
      expect(deny.has(join(home, n)), n).toBe(true)
    // and everything the guards' own write list names inside the home, from the real builder
    const checkout = tmp('tsbx-checkout-')
    const cfg = buildGuardConfig({
      home,
      checkout,
      claudeHome: tmp('tsbx-claude-'),
      userHome: '/home/alex',
      kitDir: tmp('tsbx-kit-'),
    })
    for (const w of cfg.writeDenied.filter((x) => x.startsWith(`${home}/`))) expect(deny.has(w), w).toBe(true)
    expect(OS_SANDBOX_DENY_WRITE).toContain('launch')
    // the names that may not be read are the guards' never-name list
    for (const n of HOME_NEVER) expect(OS_SANDBOX_DENY_READ).toContain(n)
    for (const n of KEY_FILES) expect(p.sandbox.filesystem.denyRead).toContain(join(home, n))
  })

  test('every rule path is the real one when the home and the folder are symlinks', () => {
    const home = makeHome()
    const folder = folderOf()
    const aside = tmp('tsbx-links-')
    const homeLink = join(aside, 'home-link')
    const folderLink = join(aside, 'folder-link')
    symlinkSync(home, homeLink)
    symlinkSync(folder, folderLink)
    // the user home is inside the test's tree too: a made-up /home/alex is another path on a Mac (/System/Volumes/Data/home/alex)
    const user = tmp('tsbx-user-')
    const p = osSandboxSettings({ talosHome: homeLink, userHome: user, folder: folderLink, platform: 'linux' })
    const all = [
      ...p.sandbox.filesystem.allowWrite,
      ...p.sandbox.filesystem.denyWrite,
      ...p.sandbox.filesystem.denyRead,
      p.excludes.path,
      p.env.GIT_CONFIG_VALUE_0 as string,
      ...Object.keys(CACHE_ENV).map((k) => p.env[k] as string),
    ]
    expect(all.length).toBeGreaterThan(20)
    for (const x of all) {
      // the home's names and the folder's, besides the two the lock adds (login items and the kit release, under the user home)
      expect(
        x.startsWith(home) ||
          x.startsWith(folder) ||
          x.startsWith(user) ||
          x.endsWith('/talos/kit') ||
          // another test file in this run may have named a kit folder (TALOS_KIT_HOME): the lock denies that one
          (process.env.TALOS_KIT_HOME !== undefined && x.endsWith(`/${basename(process.env.TALOS_KIT_HOME)}`)) ||
          x === resolve(import.meta.dir, '..', '..', '..'),
        x,
      ).toBe(true)
      expect(x.includes(aside), x).toBe(false)
    }
  })

  test('a protected name that is already a link is emitted by where it really leads, never by its own spelling', () => {
    const home = makeHome()
    const other = tmp('tsbx-other-')
    writeFileSync(join(other, 'real.json'), '{}')
    unlinkSync(join(home, 'devices.json'))
    symlinkSync(join(other, 'real.json'), join(home, 'devices.json'))
    const p = osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder: folderOf(), platform: 'linux' })
    expect(p.sandbox.filesystem.denyWrite).toContain(join(other, 'real.json'))
    expect(p.sandbox.filesystem.denyWrite).not.toContain(join(home, 'devices.json'))
  })

  test('a path it cannot resolve is refused: nothing is emitted', () => {
    const home = makeHome()
    expect(() =>
      osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder: join(home, 'no-such'), platform: 'linux' }),
    ).toThrow(OsSandboxError)
    expect(() =>
      osSandboxSettings({
        talosHome: join(home, 'no-such'),
        userHome: '/home/alex',
        folder: folderOf(),
        platform: 'linux',
      }),
    ).toThrow(OsSandboxError)
    // a link that leads nowhere in the place of a protected file
    symlinkSync(join(home, 'gone'), join(home, 'tripwire.json'))
    expect(() =>
      osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder: folderOf(), platform: 'linux' }),
    ).toThrow(OsSandboxError)
  })

  test('on macOS every path is also in lower case (its disks compare names without case)', () => {
    const base = tmp('tsbx-')
    const home = join(base, 'TalosHome')
    mkdirSync(home)
    writeFileSync(join(home, 'config.json'), '{}')
    const p = osSandboxSettings({ talosHome: home, userHome: '/Users/alex', folder: folderOf(), platform: 'darwin' })
    expect(p.sandbox.filesystem.denyWrite).toContain(join(home, 'config.json'))
    expect(p.sandbox.filesystem.denyWrite).toContain(join(home, 'config.json').toLowerCase())
    expect(p.sandbox.filesystem.allowWrite).toEqual([])
    const linux = osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder: folderOf(), platform: 'linux' })
    expect(linux.sandbox.filesystem.denyWrite).not.toContain(join(home, 'config.json').toLowerCase())
  })

  test('the caches go into the folder, git is pointed at the excludes file and never touches the owner’s git config', () => {
    const home = makeHome()
    const folder = folderOf()
    const p = osSandboxSettings({
      talosHome: home,
      userHome: '/home/alex',
      folder,
      platform: 'linux',
      ownerExcludes: ['*.swp', '.env'],
    })
    for (const [k, dir] of Object.entries(CACHE_ENV)) expect(p.env[k]).toBe(`${folder}/.cache/${dir}`)
    expect(p.env.GIT_CONFIG_COUNT).toBe('1')
    expect(p.env.GIT_CONFIG_KEY_0).toBe('core.excludesFile')
    expect(p.env.GIT_CONFIG_VALUE_0).toBe(join(home, 'sandbox', 'gitignore'))
    expect(p.excludes.path).toBe(join(home, 'sandbox', 'gitignore'))
    for (const n of [
      '.bashrc',
      '.bash_profile',
      '.profile',
      '.zshrc',
      '.zprofile',
      '.gitconfig',
      '.gitmodules',
      '.mcp.json',
      '.ripgreprc',
      '.idea',
      '.vscode',
      '.claude/',
      '.cache/',
    ])
      expect(p.excludes.lines).toContain(n)
    // the owner's own ignores still hold
    expect(p.excludes.lines).toContain('*.swp')
    expect(p.excludes.lines).toContain('.env')
    expect(Object.keys(p.env).some((k) => k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_CONFIG_SYSTEM')).toBe(false)
  })

  test('the owner’s own excludes file is read, from core.excludesFile or the default place (read only)', () => {
    const uh = tmp('tsbx-user-')
    mkdirSync(join(uh, '.config', 'git'), { recursive: true })
    writeFileSync(join(uh, '.config', 'git', 'ignore'), '*.log\n\n.direnv/\n')
    expect(readOwnerExcludes(uh, { gitConfig: () => null })).toEqual(['*.log', '.direnv/'])
    writeFileSync(join(uh, 'my-ignore'), 'notes.tmp\n')
    expect(readOwnerExcludes(uh, { gitConfig: () => '~/my-ignore' })).toEqual(['notes.tmp'])
    expect(readOwnerExcludes(tmp('tsbx-user2-'), { gitConfig: () => null })).toEqual([])
  })

  test('an owner’s own GIT_CONFIG_* entries stay: the sandbox’s is added after his', () => {
    const home = makeHome()
    const p = osSandboxSettings({
      talosHome: home,
      userHome: '/home/alex',
      folder: folderOf(),
      platform: 'linux',
      gitConfigCount: 2,
    })
    expect(p.env.GIT_CONFIG_COUNT).toBe('3')
    expect(p.env.GIT_CONFIG_KEY_2).toBe('core.excludesFile')
    expect(p.env.GIT_CONFIG_KEY_0).toBeUndefined()
  })

  test('a sandbox/ folder planted as a symlink is never written through', () => {
    const home = makeHome({ on: true })
    const other = tmp('tsbx-else-')
    symlinkSync(other, join(home, 'sandbox'))
    const r = prepareOsSandbox(
      { talosHome: home, userHome: '/home/alex', folder: folderOf() },
      { ownerExcludes: noOwner },
    )
    expect('refusal' in r && r.refusal).toMatch(/symbolic link/)
    expect(readdirSync(other)).toEqual([])
  })

  test('merged into settings: the block and env are added, an old sandbox keeps only its network', () => {
    const home = makeHome()
    const p = osSandboxSettings({ talosHome: home, userHome: '/home/alex', folder: folderOf(), platform: 'linux' })
    const out = withOsSandbox(
      {
        env: { A: '1' },
        sandbox: { enabled: false, excludedCommands: ['x'], network: { allowedDomains: ['example.com'] } },
      },
      p,
    ) as { env: Record<string, string>; sandbox: Record<string, unknown> }
    expect(out.env.A).toBe('1')
    expect(out.env.GIT_CONFIG_COUNT).toBe('1')
    expect(out.sandbox.enabled).toBe(true)
    expect(out.sandbox.excludedCommands).toBeUndefined()
    expect(out.sandbox.network).toEqual({ allowedDomains: ['example.com'] })
  })
})

describe('the preflight: every protected file has one name', () => {
  test('all fine: no refusal', () => {
    expect(osSandboxPreflight(makeHome())).toBeNull()
  })
  test('a hard link made before the launch is refused, naming the file and the fix', () => {
    const home = makeHome()
    const elsewhere = tmp('tsbx-else-')
    linkSync(join(home, 'config.json'), join(elsewhere, 'sneaky'))
    expect(osSandboxPreflight(home)).toBe(
      'config.json has another name on this disk (a hard link); remove the other link, then start again',
    )
  })
  test('a hard link to a file inside a protected folder is refused too', () => {
    const home = makeHome()
    linkSync(join(home, 'secrets', 'item'), join(tmp('tsbx-else-'), 'sneaky'))
    expect(osSandboxPreflight(home)).toMatch(/^secrets\/item has another name on this disk/)
  })
  test('a symlink in place of a protected file is refused', () => {
    const home = makeHome()
    const other = tmp('tsbx-else-')
    writeFileSync(join(other, 'real'), '{}')
    unlinkSync(join(home, 'devices.json'))
    symlinkSync(join(other, 'real'), join(home, 'devices.json'))
    expect(osSandboxPreflight(home)).toMatch(/^devices\.json is a symbolic link/)
  })
  test('a protected folder that is a symlink is refused', () => {
    const home = makeHome()
    const other = tmp('tsbx-else-')
    rmSync(join(home, 'launch'), { recursive: true })
    symlinkSync(other, join(home, 'launch'))
    expect(osSandboxPreflight(home)).toMatch(/^launch is a symbolic link/)
  })
  test('a protected file that is not there yet is no problem', () => {
    const home = tmp('tsbx-home-')
    writeFileSync(join(home, 'config.json'), '{}')
    expect(osSandboxPreflight(home)).toBeNull()
  })
  test('doctor says the same, and says off when the switch is off', () => {
    const home = makeHome({ on: true })
    expect(osSandboxCheck(home)).toMatchObject({ level: 'ok', detail: expect.stringContaining('on;') })
    linkSync(join(home, 'config.json'), join(tmp('tsbx-else-'), 'sneaky'))
    const c = osSandboxCheck(home)
    expect(c.level).toBe('FAIL')
    expect(c.detail).toContain('config.json has another name on this disk (a hard link)')
    const off = makeHome()
    expect(osSandboxCheck(off)).toMatchObject({ level: 'ok', detail: expect.stringContaining('off') })
  })
})

describe('the switch', () => {
  test('only config.os_sandbox === true is on', () => {
    const home = tmp('tsbx-home-')
    expect(readOsSandboxSwitch(home)).toBe(false) // no file
    for (const [v, on] of [
      [true, true],
      [false, false],
      ['true', false],
      [1, false],
    ] as const) {
      writeFileSync(join(home, 'config.json'), JSON.stringify({ os_sandbox: v }))
      expect(readOsSandboxSwitch(home), String(v)).toBe(on)
    }
    // a file that cannot be read as settings keeps what the last good reading said (here: off); never on by itself (test/os-sandbox-r1.test.ts)
    writeFileSync(join(home, 'config.json'), 'not json')
    expect(readOsSandboxSwitch(home)).toBe(false)
  })
})

describe('Main’s launch', () => {
  const run = (home: string, args: string[], folder: string) =>
    mainLaunchArgs(args, home, { cwd: folder, userHome: '/home/alex', ownerExcludes: noOwner })

  test('switch off: byte-identical to a launch with no switch at all (no guards, and with the guards)', () => {
    for (const withGuards of [false, true]) {
      const a = makeHome()
      const b = makeHome()
      writeFileSync(join(b, 'config.json'), JSON.stringify({ ...loadExampleConfig('default'), os_sandbox: false }))
      for (const h of [a, b])
        if (withGuards) {
          mkdirSync(join(h, 'guards'))
          writeFileSync(join(h, 'guards', 'settings.json'), '{"permissions":{"deny":["Bash(rm:*)"]}}')
        }
      const f = folderOf()
      const ra = run(a, ['--x', '--', 'hi'], f)
      const rb = run(b, ['--x', '--', 'hi'], f)
      const norm = (r: typeof ra, h: string) => JSON.stringify(r).replaceAll(h, '<home>')
      expect(norm(rb, b)).toBe(norm(ra, a))
      const text = withGuards ? readFileSync(mainLaunchPath(a), 'utf8') : (ra.args[1] as string)
      expect(text).not.toContain('sandbox')
      expect('refusal' in ra).toBe(false)
    }
  })

  test('switch on, no guards: the one settings text carries the sandbox block and env, and the excludes file is written', () => {
    const home = makeHome({ on: true })
    const folder = folderOf()
    const r = run(home, ['--x'], folder)
    expect(r.refusal).toBeUndefined()
    expect(r.args[0]).toBe('--settings')
    const s = JSON.parse(r.args[1] as string)
    expect(s.sandbox.enabled).toBe(true)
    expect(s.sandbox.failIfUnavailable).toBe(true)
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(s.sandbox.filesystem.denyWrite).toContain(join(home, 'config.json'))
    expect(s.env.GIT_CONFIG_VALUE_0).toBe(join(home, 'sandbox', 'gitignore'))
    expect(s.env.XDG_CACHE_HOME).toBe(`${folder}/.cache/xdg`)
    expect(readFileSync(join(home, 'sandbox', 'gitignore'), 'utf8')).toContain('.zshrc\n')
    expect(r.args.slice(2)).toEqual(['--x'])
  })

  test('switch on, guards installed: the private launch file carries it beside the guards', () => {
    const home = makeHome({ on: true })
    mkdirSync(join(home, 'guards'))
    writeFileSync(join(home, 'guards', 'settings.json'), '{"permissions":{"deny":["Bash(rm:*)"]}}')
    const r = run(home, [], folderOf())
    expect(r.refusal).toBeUndefined()
    expect(r.args).toEqual(['--settings', mainLaunchPath(home)])
    const o = JSON.parse(readFileSync(mainLaunchPath(home), 'utf8'))
    expect(o.sandbox.enabled).toBe(true)
    expect(o.permissions.deny).toContain('Bash(rm:*)')
  })

  test('switch on and a hard link made before the launch: the launch is refused, args untouched', () => {
    const home = makeHome({ on: true })
    linkSync(join(home, 'config.json'), join(tmp('tsbx-else-'), 'sneaky'))
    const r = run(home, ['--x'], folderOf())
    expect(r.refusal).toBe(
      'config.json has another name on this disk (a hard link); remove the other link, then start again',
    )
    expect(r.args).toEqual(['--x'])
  })

  test('switch on, a symlink in place of a protected file: refused', () => {
    const home = makeHome({ on: true })
    const other = tmp('tsbx-else-')
    writeFileSync(join(other, 'real'), 'k')
    unlinkSync(join(home, 'bridge.key'))
    symlinkSync(join(other, 'real'), join(home, 'bridge.key'))
    expect(run(home, [], folderOf()).refusal).toMatch(/^bridge\.key is a symbolic link/)
  })

  test('switch on and the owner’s own --settings: the guards and the sandbox are both off for that launch, said in words', () => {
    const home = makeHome({ on: true })
    const r = run(home, ['--settings', '/home/alex/own.json', '--x'], folderOf())
    expect(r.refusal).toBeUndefined()
    expect(r.args).toContain('/home/alex/own.json')
    expect(r.args.join(' ')).not.toContain('"sandbox"')
    expect(r.warnings.join(' ')).toContain('the extra lock on protected files (OS sandbox) is NOT active')
  })

  test('switch on and the guards’ file cannot be read: Main is not started (never a launch without the lock that was asked for)', () => {
    const home = makeHome({ on: true })
    mkdirSync(join(home, 'guards'))
    writeFileSync(join(home, 'guards', 'settings.json'), 'not json')
    expect(run(home, [], folderOf()).refusal).toContain('is NOT active')
  })

  test('talos-app start and the supervisor path carry the refusal too', () => {
    const home = makeHome({ on: true })
    linkSync(join(home, 'config.json'), join(tmp('tsbx-else-'), 'sneaky'))
    expect(withGuardsSettings(['--x'], home, folderOf()).refusal).toContain('has another name')
    // the supervisor: a throw is a launch that did not happen (it backs off and says why)
    expect(() => mainArgsWithGuards(['--x'], home, folderOf())).toThrow(/has another name/)
  })

  test('prepareOsSandbox: the same, as one call', () => {
    const home = makeHome({ on: true })
    const r = prepareOsSandbox(
      { talosHome: home, userHome: '/home/alex', folder: folderOf() },
      { ownerExcludes: noOwner },
    )
    expect('pieces' in r).toBe(true)
  })
})

/**
 * A thread session's spec is refused for a Talos home on a file system that folds case, and a Mac's temp folder is one (APFS
 * ignores case by default). These spec tests run where the temp folder is case-exact (Linux), as worker-spec.test.ts's do; Mac
 * thread sessions are the Swift app's job.
 */
const onCaseExactTmp = test.skipIf(foldsCase(realpathSync(tmpdir())))

describe('a thread session’s spec', () => {
  function inputs(over: Partial<WorkerInputs> = {}): WorkerInputs {
    const root = tmp('tsbx-w-')
    const agentDir = join(root, 'agent')
    const talosHome = join(root, 'talos')
    mkdirSync(agentDir)
    mkdirSync(talosHome)
    return {
      threadId: 'trip',
      sessionId: '11111111-2222-3333-4444-555555555555',
      resume: false,
      claudePath: '/usr/bin/claude',
      permissionHook: {
        script: join(talosHome, 'workers', '_hook', 'permission-relay.py'),
        python: '/usr/bin/python3',
      },
      baseEnv: { PATH: '/usr/bin', HOME: '/home/alex' },
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
  const trustedOf = (i: WorkerInputs, spec: { cwd: string }, osSandbox: unknown) => ({
    talosHome: i.talosHome,
    threadFence: true,
    main: i.main,
    claudePath: i.claudePath,
    cwd: spec.cwd,
    mcp: null,
    settingSources: null,
    outsideAgentFolder: false,
    osSandbox: osSandbox as never,
  })

  onCaseExactTmp('switch off: the spec is exactly what it was (no sandbox key, no new env)', () => {
    const i = inputs()
    const a = buildWorkerSpec(i)
    const b = buildWorkerSpec({ ...i, osSandbox: null })
    expect(b.settingsJSON).toBe(a.settingsJSON)
    expect(a.settingsJSON).not.toContain('sandbox')
  })

  onCaseExactTmp('switch on: the settings carry the block and env, and validateSpec accepts it', () => {
    const i = inputs()
    const pieces = osSandboxSettings({
      talosHome: i.talosHome,
      userHome: '/home/alex',
      folder: i.agentDir,
      platform: 'linux',
    })
    const spec = buildWorkerSpec({ ...i, osSandbox: pieces })
    const s = JSON.parse(spec.settingsJSON)
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(s.env.GIT_CONFIG_COUNT).toBe('1')
    expect(() => validateSpec(spec, trustedOf(i, spec, pieces))).not.toThrow()
  })

  onCaseExactTmp(
    'validateSpec refuses a spec without the block while the switch is on, and one whose block was weakened',
    () => {
      const i = inputs()
      const pieces = osSandboxSettings({
        talosHome: i.talosHome,
        userHome: '/home/alex',
        folder: i.agentDir,
        platform: 'linux',
      })
      const bare = buildWorkerSpec(i)
      expect(() => validateSpec(bare, trustedOf(i, bare, pieces))).toThrow(WorkerSpecRefused)
      const spec = buildWorkerSpec({ ...i, osSandbox: pieces })
      const weak = JSON.parse(spec.settingsJSON)
      weak.sandbox.allowUnsandboxedCommands = true
      expect(() => validateSpec({ ...spec, settingsJSON: JSON.stringify(weak) }, trustedOf(i, spec, pieces))).toThrow(
        /OS sandbox/,
      )
      const noEnv = JSON.parse(spec.settingsJSON)
      delete noEnv.env.GIT_CONFIG_VALUE_0
      expect(() => validateSpec({ ...spec, settingsJSON: JSON.stringify(noEnv) }, trustedOf(i, spec, pieces))).toThrow(
        /GIT_CONFIG_VALUE_0/,
      )
    },
  )
})

describe('talos-app sandbox on|off|status', () => {
  const lines = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
  }
  const envOf = (home: string) => loadEnv({ TALOS_APP_HOME: home } as Record<string, string>)

  test('off by default; on and off write config.json; status says which', () => {
    const home = makeHome()
    const o = lines()
    expect(cmdSandbox(envOf(home), ['status'], o.io)).toBe(0)
    expect(o.out[0]).toContain(': off')
    expect(cmdSandbox(envOf(home), ['on'], o.io)).toBe(0)
    expect(readOsSandboxSwitch(home)).toBe(true)
    expect(cmdSandbox(envOf(home), ['status'], o.io)).toBe(0)
    expect(o.out.at(-1)).toContain(': on')
    expect(cmdSandbox(envOf(home), ['off'], o.io)).toBe(0)
    expect(readOsSandboxSwitch(home)).toBe(false)
    expect(cmdSandbox(envOf(home), ['bogus'], o.io)).toBe(2)
  })

  test('on says it is experimental and what it does not stop; off and status do not', () => {
    const home = makeHome()
    const o = lines()
    expect(cmdSandbox(envOf(home), ['on'], o.io)).toBe(0)
    expect(o.err).toEqual([])
    expect(o.out).toEqual(expect.arrayContaining(osSandboxHelpLines()))
    expect(o.out).toContain("Experimental. It doesn't stop everything:")
    expect(o.out.join('\n')).toContain('claude mcp add')
    expect(o.out.join('\n')).toContain('contains the Talos code folder')
    expect(o.out).toContain("- a hook written in a project's own settings")
    const q = lines()
    cmdSandbox(envOf(home), ['status'], q.io)
    cmdSandbox(envOf(home), ['off'], q.io)
    expect(q.out.join('\n')).not.toContain('Experimental')
  })

  test('status names a hard link that would refuse the next start', () => {
    const home = makeHome({ on: true })
    linkSync(join(home, 'devices.json'), join(tmp('tsbx-else-'), 'sneaky'))
    const o = lines()
    cmdSandbox(envOf(home), ['status'], o.io)
    expect(o.out.join('\n')).toContain('devices.json has another name on this disk')
  })

  test('the command class: the agent runs it unless settings are locked, like the other settings commands', () => {
    for (const a of [
      ['sandbox', 'on'],
      ['sandbox', 'off'],
      ['sandbox', 'status'],
    ]) {
      expect(agentUnlessLocked(a), a.join(' ')).toBeDefined()
      expect(terminalOnly(a), a.join(' ')).toBe('sandbox') // the guards (when installed) keep denying it, as for peer
    }
    expect(agentUnlessLocked(['sandbox', 'bogus'])).toBeUndefined()
  })

  test('lock on: refused for the agent with the one sentence, allowed in a terminal; lock off: allowed', () => {
    const home = makeHome()
    const env = envOf(home)
    const gate = (argv: string[], terminal = false) =>
      agentCliRefusal(env, argv, { terminal, raw: {}, cwd: tmp('tsbx-c-') })
    // off the lock: `on` and `status` need nothing else; `off` weakens a lock, so it also needs the message history (outside-text check)
    expect(gate(['sandbox', 'on'])).toBeUndefined()
    expect(gate(['sandbox', 'status'])).toBeUndefined()
    expect(gate(['sandbox', 'off'])).toMatch(/message history is missing/)
    expect(gate(['sandbox', 'off'], true)).toBeUndefined()
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...loadExampleConfig('default'), settings_lock: true }))
    for (const a of ['on', 'off', 'status']) {
      expect(gate(['sandbox', a])).toBe(SETTINGS_LOCKED)
      expect(gate(['sandbox', a], true)).toBeUndefined()
    }
  })
})
