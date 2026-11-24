// No test or stray run may ever load or remove Chronos's plists in the real user's launchd. The Chronos installer and uninstaller refuse
// to call the system launchctl (/bin/launchctl) when HOME is not this user's real home from the user database: a pretend HOME's plist
// is not the user's. Here a launchctl stub stands as "the system one" (CHRONOS_SYSTEM_LAUNCHCTL, honoured only with CHRONOS_TEST_MODE=1),
// CHRONOS_REAL_HOME stands in for the user database (same condition), and a uname stub makes the macOS branch run on Linux.
// gate-reads: apps/chronos/*
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const CHRONOS = resolve(__dirname, '..', 'apps', 'chronos')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function world() {
  const root = mkdtempSync(join(tmpdir(), 'talos-launchd-guard-'))
  made.push(root)
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const calls = join(root, 'launchctl.calls')
  for (const d of [bin, home]) mkdirSync(d)
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  stub('launchctl', `echo "launchctl $*" >> "${calls}"\nexit 0`)
  stub('plutil', 'exit 0')
  stub('uname', 'case "$1" in -s) echo Darwin ;; *) exec /usr/bin/uname "$@" ;; esac')
  const sh = (script: string, args: string[], extra: Record<string, string> = {}) => {
    const h = extra.HOME ?? home
    const r = spawnSync('bash', [join(CHRONOS, script), ...args], {
      encoding: 'utf8',
      input: '',
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: '/dev/null',
        PYTHONDONTWRITEBYTECODE: '1',
        CHRONOS_TEST_MODE: '1',
        CHRONOS_SYSTEM_LAUNCHCTL: join(bin, 'launchctl'),
        CHRONOS_LAUNCHAGENTS_DIR: join(home, 'LaunchAgents'),
        ...extra,
        HOME: h,
      },
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const bootstraps = () =>
    (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []).filter((c) => c.includes('bootstrap'))
      .length
  const bootouts = () =>
    (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []).filter((c) => c.includes('bootout'))
      .length
  const anyCall = () => existsSync(calls)
  const plists = () => {
    const d = join(home, 'LaunchAgents')
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.plist')) : []
  }
  const other = () => {
    mkdirSync(join(root, 'someone-else'), { recursive: true }) // another user's real home: it exists and is not HOME
    return join(root, 'someone-else')
  }
  return { root, home, other, sh, bootstraps, bootouts, anyCall, plists }
}

const install = ['--workspace', 'ws']

describe('the system launchctl and a pretend HOME', () => {
  it('the installer refuses to load, says so in one line, exits 13 and leaves no plist', () => {
    const w = world()
    const r = w.sh('install.sh', install, { CHRONOS_REAL_HOME: w.other() })
    expect(r.code, r.out).toBe(13)
    expect(r.out.split('\n').filter((l) => /Nothing was loaded/.test(l))).toHaveLength(1)
    expect(w.anyCall()).toBe(false)
    expect(w.plists()).toEqual([])
  })

  it('--no-load never calls launchctl and is not refused', () => {
    const w = world()
    const r = w.sh('install.sh', [...install, '--no-load'], { CHRONOS_REAL_HOME: w.other() })
    expect(r.code, r.out).toBe(0)
    expect(w.anyCall()).toBe(false)
    expect(w.plists()).toHaveLength(2)
  })

  it('a launchctl that is not the system one is used as before (every other fake in the tests)', () => {
    const w = world()
    const r = w.sh('install.sh', install, {
      CHRONOS_REAL_HOME: w.other(),
      CHRONOS_SYSTEM_LAUNCHCTL: '/bin/launchctl-not-this',
    })
    expect(r.code, r.out).toBe(0)
    expect(w.bootstraps()).toBe(2)
  })

  it('the stand-in variables do nothing without CHRONOS_TEST_MODE=1', () => {
    const w = world()
    const r = w.sh('install.sh', install, {
      CHRONOS_TEST_MODE: '0',
      CHRONOS_REAL_HOME: w.other(),
    })
    // the real /bin/launchctl is the system one on a Mac, and the stub on PATH is not it: used as before
    expect(r.code, r.out).toBe(0)
    expect(w.bootstraps()).toBe(2)
  })

  it('the uninstaller skips the bootout, says so, and still removes its plists', () => {
    const w = world()
    expect(w.sh('install.sh', [...install, '--no-load']).code).toBe(0)
    expect(w.plists()).toHaveLength(2)
    const r = w.sh('uninstall.sh', [], { CHRONOS_REAL_HOME: w.other() })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/not unloaded/)
    expect(w.anyCall()).toBe(false)
    expect(w.plists()).toEqual([])
  })
})

describe('the real user is not affected', () => {
  const cases: Array<[string, (w: ReturnType<typeof world>) => { HOME?: string; real: string }]> = [
    ['the very same folder', (w) => ({ real: w.home })],
    ['a trailing slash', (w) => ({ real: `${w.home}/` })],
    [
      'a database home that is a link to HOME',
      (w) => {
        symlinkSync(w.home, join(w.root, 'link'))
        return { real: join(w.root, 'link') }
      },
    ],
    [
      'a HOME that is a link to the database home',
      (w) => {
        mkdirSync(join(w.root, 'real'))
        symlinkSync(join(w.root, 'real'), join(w.root, 'homelink'))
        return { HOME: join(w.root, 'homelink'), real: join(w.root, 'real') }
      },
    ],
    ['a database home that cannot be read', () => ({ real: '' })],
    ['a database home folder that does not exist', (w) => ({ real: join(w.root, 'gone') })],
  ]
  for (const [name, setup] of cases) {
    it(`installs and loads both agents: ${name}`, () => {
      const w = world()
      const { real, HOME } = setup(w)
      const r = w.sh('install.sh', install, { CHRONOS_REAL_HOME: real, ...(HOME ? { HOME } : {}) })
      expect(r.code, r.out).toBe(0)
      expect(w.bootstraps()).toBe(2)
    })
  }

  it('the uninstaller unloads when HOME is the real home', () => {
    const w = world()
    expect(w.sh('install.sh', [...install, '--no-load'], { CHRONOS_REAL_HOME: w.home }).code).toBe(0)
    const r = w.sh('uninstall.sh', [], { CHRONOS_REAL_HOME: w.home })
    expect(r.code, r.out).toBe(0)
    expect(w.bootouts()).toBe(2)
  })
})
