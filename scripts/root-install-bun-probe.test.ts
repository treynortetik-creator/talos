// gate-reads: install.sh scripts/*
// The root installer's pre-flight runs a trivial script with the bun it found (scripts/install-js.sh, bun_runs_or_problem), so a bun
// that answers --version and then runs nothing is refused before anything is copied, in plain words, instead of failing at the MCP
// server step with a half-made agent. Hostile bunfig.toml/.env files cannot change the answer; a hung bun ends, with its children.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { run, sandbox, snapshot, which } from './root-install-harness.ts'
import { put, type SB } from './root-install-sched-harness.ts'

const realBun = () => which('bun') as string
const brokenBun = (sb: SB) => put(sb, 'bun', `case "$1" in --version) exec "${realBun()}" --version ;; esac\nexit 1`)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('root install.sh pre-flight: bun must run a script, not only answer --version', () => {
  it(
    'a bun that runs nothing is refused before anything is copied, with the problem and the fix in plain words',
    () => {
      const sb = sandbox()
      brokenBun(sb)
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code, r.out).not.toBe(0)
      expect(r.out).toMatch(/Bun .* answers --version but cannot run a script/)
      expect(r.out).toContain('Reinstall it: curl -fsSL https://bun.sh/install | bash')
      expect(r.out).toContain('Nothing was changed')
      expect(existsSync(sb.agent)).toBe(false)
    },
    scaled(120_000),
  )

  it(
    'a bun that hangs is stopped at the time limit, and so are its children',
    () => {
      const sb = sandbox()
      const pids = join(sb.root, 'hang.pids')
      put(
        sb,
        'bun',
        `case "$1" in --version) exec "${realBun()}" --version ;; esac\necho $$ > "${pids}"\nsleep 300 &\necho $! >> "${pids}"\nwait`,
      )
      const t0 = Date.now()
      const r = run(sb, ['--no-app', '--yes'], { TALOS_INSTALL_BUN_PROBE_SECS: '2' })
      expect(r.code, r.out).not.toBe(0)
      expect(r.out).toContain('did not finish a one-line script within 2 seconds')
      expect(Date.now() - t0).toBeLessThan(scaled(60_000))
      for (const pid of readFileSync(pids, 'utf8').trim().split('\n').map(Number))
        expect(alive(pid), `pid ${pid}`).toBe(false)
      expect(existsSync(sb.agent)).toBe(false)
    },
    scaled(120_000),
  )

  it(
    'a hostile bunfig.toml and .env in the home folder change nothing: the probe passes',
    () => {
      const sb = sandbox()
      for (const f of ['.bunfig.toml', 'bunfig.toml'])
        writeFileSync(join(sb.home, f), 'preload = ["/nonexistent/preload.ts"]\n')
      writeFileSync(join(sb.home, '.env'), 'BUN_CONFIG_VERBOSE_FETCH=curl\nNODE_OPTIONS=--bad\n')
      // proof that the files are hostile: bun run from there with that home does not print the line
      const direct = spawnSync(realBun(), ['-e', 'console.log("talos-bun-ok")'], {
        cwd: sb.home,
        encoding: 'utf8',
        env: { PATH: sb.bin, HOME: sb.home },
      })
      expect(direct.stdout.trim()).not.toBe('talos-bun-ok')
      const r = run(sb, ['--no-app', '--dry-run'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('cannot run a script')
    },
    scaled(120_000),
  )

  it(
    'a slow but working bun still passes',
    () => {
      const sb = sandbox()
      put(sb, 'bun', `case "$1" in --version) ;; *) sleep 2 ;; esac\nexec "${realBun()}" "$@"`)
      const r = run(sb, ['--no-app', '--dry-run'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('cannot run a script')
    },
    scaled(120_000),
  )

  it(
    'a dry run writes nothing, with a good bun and with a broken one',
    () => {
      for (const broken of [false, true]) {
        const sb = sandbox()
        if (broken) brokenBun(sb)
        const before = snapshot(sb.home)
        const r = run(sb, ['--no-app', '--dry-run'])
        expect(r.code === 0, r.out).toBe(!broken)
        expect(snapshot(sb.home)).toEqual(before)
      }
    },
    scaled(120_000),
  )
})

describe('root install.sh pre-flight: a good bun that the isolated try cannot judge', () => {
  it(
    'a version-manager shim that needs the real HOME passes (the probe tries once with it)',
    () => {
      const sb = sandbox()
      put(
        sb,
        'bun',
        `case "$*" in *--version*) exec "${realBun()}" "$@" ;; esac
[ "$HOME" = "${sb.home}" ] || { echo "shim: no version selected here" >&2; exit 126; }
exec "${realBun()}" "$@"`,
      )
      const r = run(sb, ['--no-app', '--dry-run'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('cannot run a script')
    },
    scaled(120_000),
  )

  it(
    'a good bun that warns on stderr passes (only stdout is compared)',
    () => {
      const sb = sandbox()
      put(
        sb,
        'bun',
        `echo "warning: a config file looks old" >&2
exec "${realBun()}" "$@"`,
      )
      const r = run(sb, ['--no-app', '--dry-run'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('cannot run a script')
    },
    scaled(120_000),
  )
})
