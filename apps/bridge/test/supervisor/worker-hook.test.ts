// The PermissionRequest hook a thread session runs (worker-hook.ts): from the active SEALED kit release only, never the checkout
// (R1-1); copied into the fenced Talos home, never through a planted link (R1-9); run by a python3 from outside the session's
// own folders (R1-7). Each refusal says how to fix it. Delphi, 2026-11-11, is why: a hook that runs nothing leaves every prompt
// at the terminal, and a hook a thread can edit answers its own prompts.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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
import { dirname, join } from 'node:path'
import { realFileSync } from '../../src/real-file.ts'
import {
  ancestryChangeable,
  findPython3,
  installReleaseCommand,
  installWorkerHook,
  KIT_DIR,
  kitVendor,
  NO_PYTHON,
  PYTHON_RULES,
  releaseContentSha,
  releaseHook,
  workerHookDir,
} from '../../src/supervisor/worker-hook.ts'
import { HOOK_PASS_ENV, permissionHookCommand } from '../../src/supervisor/worker-spec.ts'
import { projectSettingsProblem } from '../../src/worker/project-settings.ts'
import { cleanupReleases, seal, sealedRelease, unseal } from './kit-release-fixture.ts'

// The stand-in python3 files these tests build in temp folders are this user's own: the two trust rules (the system's folder
// first, nothing the session's user could change) are off here and back after each test; worker-hook.test.ts tests them.
const savedPythonRules = { ...PYTHON_RULES }
beforeEach(() => Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 }))
afterEach(() => Object.assign(PYTHON_RULES, savedPythonRules))

// what the planner fixes for the hook's process (worker-spec.ts HookFixed)
// what the planner fixes for the hook's process: HOME a folder that exists (world's own)
const FIXED = (talosHome: string, home: string) => ({ talosHome, home, thread: 'trip' })
// a folder whose .claude/settings.json is `settings`
const writeSettings = (root: string, settings: unknown) => {
  const folder = join(root, 'proj')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify(settings))
  return folder
}
// /bin/sh is bash here (Arch, Fedora, macOS); dash (Debian, Ubuntu) imports no SHELLOPTS
const SH_IS_BASH = spawnSync('/bin/sh', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }).stdout.trim() !== ''

// the sealed kit releases this file made: writable again and removed (kit-release-fixture.ts)
afterAll(cleanupReleases)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      unseal(d)
    } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-hook-')))
  dirs.push(d)
  return d
}
/** A real python3 interpreter (its real file): a `#!` script stand-in would be passed over as a shim, by design. */
const REAL_PY = (() => {
  const p = findPython3({ PATH: process.env.PATH ?? '/usr/bin:/bin' })
  if (!p) throw new Error('these tests need a python3 interpreter')
  return p
})()
/**
 * Whether a COPY of that interpreter starts. Not on a Mac whose only python3 is the Command Line Tools one: a copy of Apple's
 * xcrun shim is killed (137), and a copy of the CLT interpreter dies in dyld (134: it loads @executable_path/../Python3).
 * There world() links to the real interpreter instead, and the one test that needs a copy's own mode bits is skipped.
 */
const COPY_RUNS = (() => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-hook-copy-')))
  try {
    cpSync(REAL_PY, join(d, 'python3'))
    chmodSync(join(d, 'python3'), 0o755)
    return spawnSync(join(d, 'python3'), ['-I', '-c', ''], { timeout: 20_000 }).status === 0
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})()
function world() {
  const root = tmp()
  const bin = join(root, 'bin')
  const talosHome = join(root, 'talos')
  // HOME for the hook's process: a folder that exists (Apple's python3 takes seconds to start without one)
  const home = join(root, 'home')
  for (const d of [bin, talosHome, home]) mkdirSync(d, { recursive: true })
  if (COPY_RUNS) {
    cpSync(REAL_PY, join(bin, 'python3')) // a copy: found by resolution, its own mode bits
    chmodSync(join(bin, 'python3'), 0o755)
  } else symlinkSync(REAL_PY, join(bin, 'python3'))
  const source = join(root, 'permission-relay.py')
  writeFileSync(source, '# hook\n')
  writeFileSync(join(root, '_talos_common.py'), '# helper\n')
  // the interpreter bin/ resolves to: the copy itself, or (linked) the real file it leads to
  const py = COPY_RUNS ? join(bin, 'python3') : (findPython3({ PATH: bin }) ?? REAL_PY)
  return { root, bin, home, py, source, talosHome, env: { PATH: `/nonexistent::rel:${bin}` } }
}

describe('the source: the active sealed kit release, never the checkout (R1-1)', () => {
  it('finds the release’s hook: VENDOR/current -> releases/<v>/talos-kit/hooks/permission-relay.py, not the checkout’s', () => {
    const vendor = sealedRelease({ fresh: true })
    const r = releaseHook(vendor)
    expect(r).toMatchObject({
      source: join(realpathSync(vendor), 'releases', '9.9.9-test', 'talos-kit', 'hooks', 'permission-relay.py'),
      release: join(realpathSync(vendor), 'releases', '9.9.9-test'),
    })
    expect('source' in r && r.source.startsWith(KIT_DIR)).toBe(false)
  })
  it('the vendor folder is found exactly as plugin-release.py finds it (empty is unset; always absolute)', () => {
    // a HOME that exists: Apple's python3 (its xcrun shim) takes seconds per start without one
    const h = tmp()
    for (const env of [
      { HOME: h },
      { HOME: h, XDG_DATA_HOME: `${h}/.data` },
      { HOME: h, TALOS_VENDOR_DIR: '/opt/talos' },
      { HOME: h, TALOS_KIT_HOME: '/opt/kit' },
      { HOME: h, TALOS_VENDOR_DIR: '', XDG_DATA_HOME: '' },
      { HOME: h, TALOS_KIT_HOME: 'rel/kit' },
    ]) {
      const out = spawnSync('python3', [join(KIT_DIR, 'scripts', 'plugin-release.py'), 'paths'], {
        env: { PATH: process.env.PATH ?? '/usr/bin', ...env },
        cwd: '/',
        encoding: 'utf8',
      })
      const python = /^vendor=(.*)$/m.exec(out.stdout)?.[1]
      expect(python, JSON.stringify(env)).toBeDefined()
      const saved = process.cwd()
      process.chdir('/')
      try {
        expect(kitVendor(env), JSON.stringify(env)).toBe(python as string)
      } finally {
        process.chdir(saved)
      }
    }
  })
  it('no release: refused, naming the one command that installs one (and that command really does)', () => {
    const vendor = join(tmp(), 'kit')
    const r = releaseHook(vendor)
    expect('problem' in r && r.problem).toBe(
      `this install has no sealed kit release (${join(vendor, 'current')}); install a sealed release with: ${installReleaseCommand(vendor)}`,
    )
    // the command, run against this vendor folder, makes a release this check accepts
    const out = spawnSync(
      'python3',
      [join(KIT_DIR, 'scripts', 'plugin-release.py'), 'build', '--source', KIT_DIR, '--activate'],
      { env: { ...process.env, TALOS_KIT_HOME: vendor }, encoding: 'utf8' },
    )
    expect(out.status, out.stderr).toBe(0)
    dirs.push(vendor)
    expect('source' in releaseHook(vendor)).toBe(true)
    expect(installReleaseCommand(vendor)).toBe(
      `python3 ${KIT_DIR}/scripts/plugin-release.py build --source ${KIT_DIR} --vendor ${vendor} --activate`,
    )
  }, 60_000)
  it('an unsealed release (a file or a folder that can be written) is refused', () => {
    for (const target of ['talos-kit/hooks/permission-relay.py', 'talos-kit/hooks', 'talos-kit', '']) {
      const vendor = sealedRelease({ fresh: true })
      const p = join(vendor, 'releases', '9.9.9-test', target)
      chmodSync(p, statSync(p).mode | 0o200)
      const r = releaseHook(vendor)
      expect('problem' in r && r.problem, target).toContain('can be written, so the release is not sealed')
    }
  })
  it('a `current` that points outside releases/, or at a link in place of the hook, is refused', () => {
    const vendor = sealedRelease({ fresh: true })
    const elsewhere = sealedRelease({ fresh: true })
    rmSync(join(vendor, 'current'))
    symlinkSync(join(elsewhere, 'releases', '9.9.9-test'), join(vendor, 'current'))
    expect(JSON.stringify(releaseHook(vendor))).toContain('does not point at one of')
  })
  it('a release inside a folder a thread session works in is refused', () => {
    const vendor = sealedRelease({ fresh: true })
    const r = releaseHook(vendor, [vendor])
    expect('problem' in r && r.problem).toContain('a folder a thread session works in')
  })
  it('a release edited after it was built (even sealed again) is refused: its content no longer matches its record', () => {
    const vendor = sealedRelease({ fresh: true })
    const release = join(vendor, 'releases', '9.9.9-test')
    expect('source' in releaseHook(vendor)).toBe(true)
    unseal(release)
    writeFileSync(join(release, 'talos-kit', 'hooks', 'permission-relay.py'), 'print("allow")\n')
    seal(release)
    const r = releaseHook(vendor)
    expect('problem' in r && r.problem).toContain('does not match its own record')
  })
  it('the content hash is plugin-release.py’s own (a release it built verifies)', () => {
    const vendor = join(tmp(), 'kit')
    const out = spawnSync(
      'python3',
      [join(KIT_DIR, 'scripts', 'plugin-release.py'), 'build', '--source', KIT_DIR, '--activate'],
      { env: { ...process.env, TALOS_KIT_HOME: vendor }, encoding: 'utf8' },
    )
    expect(out.status, out.stderr).toBe(0)
    const plugin = join(realpathSync(join(vendor, 'current')), 'talos-kit')
    const recorded = /content_sha256=([0-9a-f]{64})/.exec(readFileSync(join(plugin, '.talos-release'), 'utf8'))?.[1]
    expect(releaseContentSha(plugin)).toBe(recorded as string)
  }, 60_000)
})

describe('the copy in the fenced Talos home', () => {
  it('the session runs a copy (0600, with its helper) and the python3 resolved now', () => {
    const w = world()
    const got = installWorkerHook(w.talosHome, w.source, w.env)
    expect(got).toMatchObject({
      script: join(workerHookDir(w.talosHome), 'permission-relay.py'),
      python: w.py,
    })
    // and the bytes it copied, for the launch spec (launch-spec.ts): a new hook is a new spec
    if ('problem' in got) throw new Error(got.problem)
    expect(got.hook).toEqual(readFileSync(w.source))
    expect(statSync(join(workerHookDir(w.talosHome), 'permission-relay.py')).mode & 0o777).toBe(0o600)
    expect(statSync(join(workerHookDir(w.talosHome), '_talos_common.py')).mode & 0o777).toBe(0o600)
    expect(statSync(workerHookDir(w.talosHome)).mode & 0o777).toBe(0o700)
    writeFileSync(w.source, '# hook v2\n')
    installWorkerHook(w.talosHome, w.source, w.env)
    expect(readFileSync(join(workerHookDir(w.talosHome), 'permission-relay.py'), 'utf8')).toBe('# hook v2\n')
  })
  it('a missing or unreadable source is refused by name', () => {
    const w = world()
    const missing = join(w.root, 'agent', 'hooks', 'permission-relay.py')
    expect(installWorkerHook(w.talosHome, missing, w.env)).toEqual({
      problem: `the permission hook ${missing} is missing or cannot be read`,
    })
    expect(JSON.stringify(installWorkerHook(w.talosHome, 'rel/permission-relay.py', w.env))).toContain(
      'not an absolute path',
    )
  })
  it('R1-9: a link planted at workers/ (or at workers/_hook) is refused, and nothing is made through it', () => {
    const w = world()
    const elsewhere = join(w.root, 'project')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(w.talosHome, 'workers'))
    expect(installWorkerHook(w.talosHome, w.source, w.env)).toEqual({
      problem: `the permission hook's folder ${join(w.talosHome, 'workers')} is not a plain folder`,
    })
    expect(readdirSync(elsewhere)).toEqual([]) // no _hook made through the link
    rmSync(join(w.talosHome, 'workers'))
    mkdirSync(join(w.talosHome, 'workers'), { mode: 0o700 })
    symlinkSync(elsewhere, workerHookDir(w.talosHome))
    expect(installWorkerHook(w.talosHome, w.source, w.env)).toEqual({
      problem: `the permission hook's folder ${workerHookDir(w.talosHome)} is not a plain folder`,
    })
    expect(readdirSync(elsewhere)).toEqual([])
  })
  it('a folder other accounts can write is refused; one they can only read (an older install’s) is fine', () => {
    const w = world()
    mkdirSync(join(w.talosHome, 'workers'), { mode: 0o700 })
    chmodSync(join(w.talosHome, 'workers'), 0o777)
    expect(JSON.stringify(installWorkerHook(w.talosHome, w.source, w.env))).toContain(
      'can be written by other accounts',
    )
    chmodSync(join(w.talosHome, 'workers'), 0o755)
    expect('script' in installWorkerHook(w.talosHome, w.source, w.env)).toBe(true)
  })
  it('a source with no helper leaves no old helper behind (it would be imported in its place)', () => {
    const w = world()
    installWorkerHook(w.talosHome, w.source, w.env)
    rmSync(join(w.root, '_talos_common.py'))
    installWorkerHook(w.talosHome, w.source, w.env)
    expect(readdirSync(workerHookDir(w.talosHome))).toEqual(['permission-relay.py'])
  })
})

describe('python3 (R1-7: never from inside the session’s own folders)', () => {
  it('absolute PATH entries only; none is refused', () => {
    const w = world()
    expect(findPython3(w.env)).toBe(w.py)
    expect(installWorkerHook(w.talosHome, w.source, { PATH: '/nonexistent:rel' })).toEqual({ problem: NO_PYTHON })
  })
  // needs a copy of its own to take the exec bit off (never the real interpreter through a link): see COPY_RUNS
  it.skipIf(!COPY_RUNS)(
    'a python3 that is not executable is passed over (skipped where a copy of python3 cannot start)',
    () => {
      const w = world()
      chmodSync(join(w.bin, 'python3'), 0o644)
      expect(findPython3(w.env)).toBeNull()
    },
  )
  it('a python3 in the thread’s folder (or the agent folder), or a link on PATH leading into it, is passed over', () => {
    const w = world()
    const thread = join(w.root, 'thread')
    mkdirSync(join(thread, 'bin'), { recursive: true })
    cpSync(REAL_PY, join(thread, 'bin', 'python3')) // a real interpreter: only the fence may pass it over
    chmodSync(join(thread, 'bin', 'python3'), 0o755)
    const linkDir = join(w.root, 'links')
    mkdirSync(linkDir)
    symlinkSync(join(thread, 'bin', 'python3'), join(linkDir, 'python3'))
    const env = { PATH: `${join(thread, 'bin')}:${linkDir}:${w.bin}` }
    expect(findPython3(env)).toBe(join(thread, 'bin', 'python3')) // control: with no fence it would be taken
    expect(findPython3(env, [thread])).toBe(w.py)
    expect(findPython3({ PATH: `${join(thread, 'bin')}:${linkDir}` }, [thread])).toBeNull()
    const got = installWorkerHook(w.talosHome, w.source, env, findPython3, [thread])
    expect('python' in got && got.python).toBe(w.py)
  })
})

describe('the review’s holes, closed', () => {
  it('a version manager’s shim (a `#!` script) is passed over for the real interpreter after it; mise’s link too', () => {
    const w = world()
    const shims = join(w.root, 'shims')
    mkdirSync(shims)
    writeFileSync(join(shims, 'python3'), '#!/bin/sh\nexec python3 "$@"\n', { mode: 0o755 })
    expect(findPython3({ PATH: `${shims}:${w.bin}` })).toBe(w.py)
    const mise = join(w.root, 'mise-shims')
    mkdirSync(mise)
    cpSync(REAL_PY, join(w.root, 'mise'))
    symlinkSync(join(w.root, 'mise'), join(mise, 'python3')) // what mise's shims are: links to `mise` itself
    expect(findPython3({ PATH: `${mise}:${w.bin}` })).toBe(w.py)
    expect(findPython3({ PATH: shims })).toBeNull()
  })
  it('a python3 with other names (hard links) is found by its own name (a Mac’s /usr/bin)', async () => {
    // The Mac's /usr/bin/python3 is one file with 77 other names, git and make among them. On macOS a file's realpath can come
    // back as another of its hard-linked names, so findPython3 could pass over /usr/bin/python3, and a start was refused with
    // NO_PYTHON (the M5's gate, workers-wiring.test.ts, 2026-11-12). Here a second name of the file is used concurrently.
    const bin = join(tmp(), 'bin')
    mkdirSync(bin)
    copyFileSync('/usr/bin/true', join(bin, 'python3')) // not a `#!` script, and it runs as a copy (the CLT python3 does not)
    chmodSync(join(bin, 'python3'), 0o755)
    linkSync(join(bin, 'python3'), join(bin, 'other'))
    const until = Date.now() + 1500
    const runs: Promise<void>[] = []
    const loop = async () => {
      while (Date.now() < until)
        await new Promise<void>((r) => spawn(join(bin, 'other'), [], { stdio: 'ignore' }).on('close', () => r()))
    }
    for (let i = 0; i < 4; i++) runs.push(loop())
    const wrong = new Set<string | null>()
    while (Date.now() < until) {
      for (let i = 0; i < 50; i++) {
        const got = findPython3({ PATH: bin })
        if (got !== join(bin, 'python3')) wrong.add(got)
      }
      await new Promise((r) => setTimeout(r, 1))
    }
    await Promise.all(runs)
    expect([...wrong]).toEqual([])
  })
  it('the copy is made only of the bytes the release check saw: a hook changed in between is refused', () => {
    const vendor = sealedRelease({ fresh: true })
    const r = releaseHook(vendor)
    if (!('verified' in r)) throw new Error('control: a sealed release')
    const w = world()
    expect('script' in installWorkerHook(w.talosHome, r.source, w.env, findPython3, [], r.verified)).toBe(true)
    // the same check's hashes, other bytes (the swap a check-then-copy gap would let through)
    expect(installWorkerHook(w.talosHome, w.source, w.env, findPython3, [], r.verified)).toEqual({
      problem: `the permission hook ${w.source} changed after its release was checked`,
    })
  })
  it('a release that cannot even be read (a FIFO in it) is refused, never a start that throws', () => {
    const vendor = sealedRelease({ fresh: true })
    const plugin = join(vendor, 'releases', '9.9.9-test', 'talos-kit')
    unseal(join(vendor, 'releases', '9.9.9-test'))
    const made = spawnSync('mkfifo', [join(plugin, 'pipe')])
    if (made.status !== 0) return // no mkfifo here
    seal(join(vendor, 'releases', '9.9.9-test'))
    const r = releaseHook(vendor)
    expect('problem' in r && r.problem).toContain('the kit release cannot be checked')
  })
  it('a link to a folder inside the release is hashed as os.walk walks it (listed, not entered), as plugin-release.py does', () => {
    const root = tmp()
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'a.txt'), 'a')
    writeFileSync(join(root, 'top.txt'), 't')
    symlinkSync(join(root, 'real'), join(root, 'linked'))
    const py = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util,sys; s=importlib.util.spec_from_file_location('pr', ${JSON.stringify(join(KIT_DIR, 'scripts', 'plugin-release.py'))}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.content_sha(sys.argv[1]))`,
        root,
      ],
      { encoding: 'utf8' },
    )
    expect(py.status, py.stderr).toBe(0)
    expect(releaseContentSha(root)).toBe(py.stdout.trim())
  })
})

/** What macOS's xcrun stub for /usr/bin/python3 (Command Line Tools without Xcode) puts in the environment of the python it runs. */
const XCRUN_STUB_ENV = ['SDKROOT', 'CPATH', 'LIBRARY_PATH', 'MANPATH']

describe('the command, run by a shell as Claude Code runs it', () => {
  it('starts that python3 isolated on that copy, marked as the session’s own', () => {
    const w = world()
    const out = join(w.root, 'ran')
    // the hook records what it was started as: the marker, isolated mode, and its own path
    writeFileSync(
      w.source,
      `import os, sys\nopen(${JSON.stringify(out)}, 'w').write(os.environ.get('TALOS_APP_PERM_HOOK_SOURCE', '') + ' ' + str(sys.flags.isolated) + ' ' + sys.argv[0])\n`,
    )
    const hook = installWorkerHook(w.talosHome, w.source, w.env)
    if (!('script' in hook)) throw new Error(hook.problem)
    const r = spawnSync(
      '/bin/sh',
      ['-c', permissionHookCommand(hook.script, hook.python, FIXED(w.talosHome, w.home))],
      {
        env: { PATH: '/nonexistent' },
      },
    )
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf8').trim()).toBe(`worker 1 ${hook.script}`)
  })
  it('a thread’s own environment never reaches the hook: only the fixed values and the named pass-through', () => {
    const w = world()
    const out = join(w.root, 'env.json')
    writeFileSync(w.source, `import json, os\nopen(${JSON.stringify(out)}, 'w').write(json.dumps(dict(os.environ)))\n`)
    const hook = installWorkerHook(w.talosHome, w.source, w.env)
    if (!('script' in hook)) throw new Error(hook.problem)
    // what a thread's settings env could set for the hook's process: a preload, a module path, a Talos home of its choosing
    const evil = join(w.root, 'evil')
    mkdirSync(evil)
    const r = spawnSync(
      '/bin/sh',
      ['-c', permissionHookCommand(hook.script, hook.python, FIXED(w.talosHome, w.home))],
      {
        env: {
          PATH: `${evil}:/usr/bin:/bin`,
          LD_PRELOAD: join(evil, 'evil.so'),
          LD_LIBRARY_PATH: evil,
          PYTHONPATH: evil,
          PYTHONHOME: evil,
          PYTHONSTARTUP: join(evil, 'start.py'),
          TALOS_APP_HOME: evil,
          TALOS_APP_WORKER_THREAD: 'other',
          HOME: evil,
          BASH_ENV: join(evil, 'env.sh'),
          TALOS_APP_WORKER_NONCE: 'n0nce',
          CLAUDE_PROJECT_DIR: '/proj',
          // the names a Mac may add itself: the session's own value never gets through
          __CF_USER_TEXT_ENCODING: 'planted-by-the-session',
          ...Object.fromEntries(XCRUN_STUB_ENV.map((k) => [k, 'planted-by-the-session'])),
        },
      },
    )
    expect(r.status).toBe(0)
    const seen = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>
    expect(seen.__CF_USER_TEXT_ENCODING).not.toBe('planted-by-the-session')
    // contains, not equals: the stub prepends its own folders to MANPATH, which would hide a leaked value at the end
    for (const k of XCRUN_STUB_ENV) expect(seen[k] ?? '', k).not.toContain('planted-by-the-session')
    for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'BASH_ENV']) {
      expect(seen[k], k).toBeUndefined()
    }
    expect(seen.TALOS_APP_HOME).toBe(w.talosHome)
    expect(seen.TALOS_APP_WORKER_THREAD).toBe('trip')
    expect(seen.HOME).toBe(w.home)
    expect(seen.PATH).toBe('/usr/bin:/bin')
    // the pass-through the hook reads from Claude Code's side, and nothing else beyond the fixed set
    expect(seen.TALOS_APP_WORKER_NONCE).toBe('n0nce')
    expect(seen.CLAUDE_PROJECT_DIR).toBe('/proj')
    const allowed = new Set([
      ...HOOK_PASS_ENV,
      'PATH',
      'LANG',
      'HOME',
      'TALOS_APP_HOME',
      'TALOS_APP_WORKER_THREAD',
      'TALOS_APP_PERM_HOOK_SOURCE',
      // set by the clean second shell itself (its own folder and depth), never taken from the session
      'PWD',
      'SHLVL',
      // macOS adds its text encoding to every process it starts (seen in a clean shell on the Mac): this one name, there only
      ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
      // and on a Mac with only the Command Line Tools, /usr/bin/python3 is an xcrun stub that exports these four into the
      // python it starts: the Mac's own values, never the session's (planted above, checked not to get through)
      ...(process.platform === 'darwin' ? XCRUN_STUB_ENV : []),
    ])
    expect(Object.keys(seen).filter((k) => !allowed.has(k))).toEqual([])
  })
  it('the shell Claude Code starts it in (/bin/sh -c: POSIX mode) cannot be taken over by what the session imports', () => {
    // Claude Code runs a hook's command as `/bin/sh -c <command>` with the session's environment (seen on this box: bash in
    // POSIX mode). Each of these runs code in that shell if the command gives it a way: functions named for what the command
    // calls (`exec`, `[`, `env`, `sh`), startup files (ENV, BASH_ENV), and xtrace on with a PS4 that only prints. Every one
    // hostile; the real hook must still be what answers, and nothing they print may reach its stdout.
    const w = world()
    const evil = join(w.root, 'evil')
    mkdirSync(evil)
    const pwned = join(evil, 'pwned')
    const startup = join(evil, 'startup.sh')
    writeFileSync(
      startup,
      `echo startup >> ${JSON.stringify(pwned)}\necho '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}'\n`,
    )
    writeFileSync(w.source, `import sys\nsys.stdout.write("REAL HOOK " + str(sys.flags.isolated))\n`)
    const hook = installWorkerHook(w.talosHome, w.source, w.env)
    if (!('script' in hook)) throw new Error(hook.problem)
    const takeover = `() { echo taken >> ${JSON.stringify(pwned)}; echo '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}'; }`
    const r = spawnSync(
      '/bin/sh',
      ['-c', permissionHookCommand(hook.script, hook.python, FIXED(w.talosHome, w.home))],
      {
        env: {
          PATH: `${evil}:/usr/bin:/bin`,
          'BASH_FUNC_exec%%': takeover,
          'BASH_FUNC_[%%': takeover,
          'BASH_FUNC_env%%': takeover,
          'BASH_FUNC_sh%%': takeover,
          ENV: startup,
          BASH_ENV: startup,
          SHELLOPTS: 'xtrace',
          PS4: '+trace ',
        },
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('REAL HOOK 1')
    expect(existsSync(pwned)).toBe(false)
  })
  // What no command string can stop, so the folder check refuses it (worker/project-settings.ts): xtrace with a PS4 that
  // expands a command runs it in the first shell, before `exec`. Pinned so the reason that check exists stays visible.
  it.skipIf(!SH_IS_BASH)(
    'a PS4 that runs a command does run in the first shell: why the folder may not set SHELLOPTS or PS4',
    () => {
      const w = world()
      const pwned = join(w.root, 'pwned')
      writeFileSync(w.source, 'import sys\nsys.stdout.write("REAL HOOK")\n')
      const hook = installWorkerHook(w.talosHome, w.source, w.env)
      if (!('script' in hook)) throw new Error(hook.problem)
      spawnSync('/bin/sh', ['-c', permissionHookCommand(hook.script, hook.python, FIXED(w.talosHome, w.home))], {
        env: { PATH: '/usr/bin:/bin', SHELLOPTS: 'xtrace', PS4: `$(touch ${pwned})` },
      })
      expect(existsSync(pwned)).toBe(true)
      expect(
        projectSettingsProblem(writeSettings(w.root, { env: { SHELLOPTS: 'xtrace', PS4: 'x' } }), false),
      ).toContain('sets SHELLOPTS, PS4 in env')
    },
  )
  it('a path with a quote in it is still one word to the shell', () => {
    const w = world()
    const odd = join(w.root, "it's here")
    mkdirSync(odd)
    const out = join(w.root, 'ran')
    symlinkSync(REAL_PY, join(odd, 'python3'))
    writeFileSync(join(odd, 'hook.py'), `import sys\nopen(${JSON.stringify(out)}, 'w').write(sys.argv[0])\n`)
    const r = spawnSync(
      '/bin/sh',
      ['-c', permissionHookCommand(join(odd, 'hook.py'), join(odd, 'python3'), FIXED(odd, odd))],
      {},
    )
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf8').trim()).toBe(join(odd, 'hook.py'))
  })
})

describe('the python3 the hook runs: never one the session’s user could change (Fable R1-1)', () => {
  // a stand-in interpreter: a copy of the system's, in a temp folder this user owns
  const standIn = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    cpSync(realpathSync('/usr/bin/python3'), join(dir, 'python3'))
    return join(dir, 'python3')
  }
  it('the owner’s home is walled off: a ~/.local/bin python3 is passed over (control: the same copy outside home is taken)', () => {
    const root = tmp()
    const home = join(root, 'home')
    const inHome = standIn(join(home, '.local', 'bin'))
    const outside = standIn(join(root, 'opt', 'bin'))
    Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 })
    expect(findPython3({ PATH: `${dirname(inHome)}:${dirname(outside)}`, HOME: home })).toBe(realpathSync(outside))
    expect(findPython3({ PATH: dirname(inHome), HOME: home })).toBeNull()
  })
  it('a python3, or its folder, owned by the session’s user is passed over (control: the same as another user’s is taken)', () => {
    const p = standIn(join(tmp(), 'bin'))
    Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: -1 })
    expect(findPython3({ PATH: dirname(p), HOME: '/nonexistent-home' })).toBeNull()
    Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 })
    expect(findPython3({ PATH: dirname(p), HOME: '/nonexistent-home' })).toBe(realpathSync(p))
  })
  it('a python3 or a folder writable by group or others is passed over, whoever owns it', () => {
    Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 })
    const a = standIn(join(tmp(), 'bin'))
    chmodSync(a, 0o757)
    expect(findPython3({ PATH: dirname(a), HOME: '/nonexistent-home' })).toBeNull()
    const b = standIn(join(tmp(), 'bin'))
    chmodSync(dirname(b), 0o775)
    expect(findPython3({ PATH: dirname(b), HOME: '/nonexistent-home' })).toBeNull()
  })
  it('a folder anywhere above the interpreter that others can write is refused too (its folder could be swapped; Codex)', () => {
    Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 })
    const top = tmp()
    const p = standIn(join(top, 'open', 'tools', 'bin'))
    // control: every folder on the way closed
    expect(findPython3({ PATH: dirname(p), HOME: '/nonexistent-home' })).toBe(realpathSync(p))
    chmodSync(join(top, 'open'), 0o777)
    expect(findPython3({ PATH: dirname(p), HOME: '/nonexistent-home' })).toBeNull()
  })
  it('a folder above the interpreter that the session’s own user owns is refused too (Codex)', () => {
    const p = standIn(join(tmp(), 'mine', 'bin'))
    // the stand-in's folders are this user's: with the session's user taken as this user, nothing on the way is trusted
    Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: -1 })
    chmodSync(p, 0o755)
    expect(findPython3({ PATH: dirname(p), HOME: '/nonexistent-home' })).toBeNull()
  })
  it.skipIf(!existsSync('/usr/bin/python3'))('/usr/bin/python3 comes first, whatever the PATH names before it', () => {
    const p = standIn(join(tmp(), 'bin'))
    Object.assign(PYTHON_RULES, { preferredDir: '/usr/bin', trustedOwner: process.getuid?.() ?? 0 })
    const got = findPython3({ PATH: `${dirname(p)}:/usr/local/bin`, HOME: '/nonexistent-home' })
    // the same file as /usr/bin/python3, by identity: on a Mac it is the xcrun stub, hard-linked under many names, and
    // realpathSync may report any of them (/usr/bin/git, Delphi's flake); the code resolves it with realFileSync
    expect(got).toBe(realFileSync('/usr/bin/python3'))
    const [a, b] = [statSync(got ?? '/nonexistent'), statSync('/usr/bin/python3')]
    expect([a.dev, a.ino]).toEqual([b.dev, b.ino])
    expect(got).not.toBe(realFileSync(p))
  })
  it('the folders above: any owner but root (or the one trusted owner) makes them changeable (Fable R2-3)', () => {
    const d = tmp() // this user's own, under a root-owned sticky /tmp
    expect(ancestryChangeable(d, process.getuid?.() ?? 0)).toBe(false) // control: this user trusted
    expect(ancestryChangeable(d, -1)).toBe(true) // only root trusted: this user's folder is not
    expect(ancestryChangeable(d, (process.getuid?.() ?? 0) + 1)).toBe(true) // a third owner is not trusted either
  })
  it('the defaults: the system’s folder first, and root the only owner trusted', () => {
    expect(savedPythonRules).toEqual({ preferredDir: '/usr/bin', trustedOwner: -1 })
  })
})
