// CI's Macs run these installer tests on a real login session (scripts/ci-local/macos-only.sh), so no test may ever load into it, or
// remove from it. The proof is in the product, not in each test's stubs: the only two scripts that bootstrap or bootout Chronos ask
// launchd-guard.sh first, and it refuses the system launchctl for any HOME that is not the user's own. Here the launchctl stub stands
// as the system one (CHRONOS_SYSTEM_LAUNCHCTL) and HOME is a sandbox, as in every listed test; nothing is ever loaded or unloaded.
// gate-reads: install.sh kit/* apps/chronos/* scripts/*
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { REPO, refusingPath, sandbox } from './root-install-harness.ts'
import { install, kitRun, lcCalls, macSandbox, markerPath, type SB } from './root-install-sched-harness.ts'

// launchctl's verbs that change a login session (print and list only read it)
const CHANGES =
  /\blaunchctl["']?[,\s]+["']?(bootstrap|bootout|load|unload|submit|remove|kickstart|kill|enable|disable)\b/
const shipped = execFileSync('git', ['ls-files', 'install.sh', 'scripts/*.sh', 'kit', 'apps/chronos'], {
  cwd: REPO,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(
    (f) =>
      !/(^|\/)(tests?|fixtures|launchd|ui\/static)\/|\/test-[^/]*$|\.test\.ts$|\.(md|json|plist|tmpl|svg|png)$/.test(f),
  )

/** The lines that run it: not a comment, not a message a person reads. */
const callers = (f: string) =>
  readFileSync(join(REPO, f), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => CHANGES.test(l) && !/^(#|echo |say |\[ [^\]]*\] && echo )/.test(l))

/** The system launchctl: the sandbox's own stub, so a call that got past the guard is recorded, never made. */
const asSystem = (sb: SB) => ({ CHRONOS_SYSTEM_LAUNCHCTL: join(sb.bin, 'launchctl') })
const changed = (sb: SB) =>
  lcCalls(sb)
    .split('\n')
    .filter((l) => l !== '' && !/^(print|list)\b/.test(l))

describe("no test reaches a real login session's launchd", () => {
  it('only Chronos’s own installer and uninstaller change launchd, and both ask the guard before their first call', () => {
    expect(shipped.length).toBeGreaterThan(50)
    const found = shipped.filter((f) => callers(f).length > 0)
    // chronos_runlog.py's probe (a person's "try again") submits one, and asks pretend_home first: apps/chronos/tests/test_pretend_home.py
    expect(found.filter((f) => f !== 'apps/chronos/lib/chronos_runlog.py').sort()).toEqual([
      'apps/chronos/install.sh',
      'apps/chronos/uninstall.sh',
    ])
    for (const f of ['apps/chronos/install.sh', 'apps/chronos/uninstall.sh']) {
      const text = readFileSync(join(REPO, f), 'utf8')
      const guard = text.indexOf('chronos_launchd_refused')
      expect(guard, f).toBeGreaterThan(0)
      for (const line of callers(f)) expect(text.indexOf(line), `${f}: ${line}`).toBeGreaterThan(guard)
    }
  })

  it(
    'a fresh install (jobs and session hook too) loads nothing, is not failed by it, and says the scheduler was not added',
    () => {
      const sb = macSandbox()
      const r = install(sb, [], asSystem(sb))
      expect(r.code, r.out).toBe(0)
      expect(changed(sb)).toEqual([])
      expect(JSON.parse(readFileSync(markerPath(sb), 'utf8')).reason).toBe('launchctl')
      // asked for on purpose: loud, and still nothing
      const again = kitRun(sb, ['--agent-dir', sb.agent, '--add-to-existing', '--reinstall-chronos'], asSystem(sb))
      expect(again.code, again.out).toBe(13)
      expect(changed(sb)).toEqual([])
    },
    scaled(300_000),
  )

  it(
    'the uninstaller unloads nothing, and the control: a launchctl that is not the system one is asked',
    () => {
      const sb = macSandbox()
      expect(install(sb).code).toBe(0)
      expect(changed(sb).some((l) => l.startsWith('bootstrap'))).toBe(true) // the recorder records
      const before = changed(sb).length
      const un = (env: Record<string, string>) =>
        execFileSync('bash', [join(REPO, 'apps', 'chronos', 'uninstall.sh')], {
          encoding: 'utf8',
          cwd: sb.home,
          env: { PATH: sb.bin, HOME: sb.home, CHRONOS_TEST_MODE: '1', ...env },
        })
      expect(un(asSystem(sb))).toContain('not unloaded')
      expect(changed(sb).length).toBe(before)
      un({})
      expect(
        changed(sb)
          .slice(before)
          .every((l) => l.startsWith('bootout')),
      ).toBe(true)
      expect(changed(sb).length).toBeGreaterThan(before)
    },
    scaled(300_000),
  )

  it('chronos_runlog’s probe asks before it submits', () => {
    const text = readFileSync(join(REPO, 'apps/chronos/lib/chronos_runlog.py'), 'utf8')
    expect(text.indexOf('C.pretend_home()')).toBeGreaterThan(0)
    expect(text.indexOf('[launchctl, "submit"')).toBeGreaterThan(text.indexOf('C.pretend_home()'))
  })

  it('the PATHs those tests use find the stub: refusingPath’s refuses, and a sandbox has its own', () => {
    const at = (path: string) =>
      execFileSync('/bin/bash', ['-c', 'command -v launchctl; launchctl list >/dev/null 2>&1; echo $?'], {
        encoding: 'utf8',
        env: { ['PATH']: path },
      }).split('\n')
    const own = refusingPath()
    const [found, rc] = at(own)
    expect(found).toBe(join(own.split(':')[0] as string, 'launchctl'))
    expect(rc).toBe('1')
    const sb = sandbox()
    expect(at(sb.bin).slice(0, 2)).toEqual([join(sb.bin, 'launchctl'), '1'])
  })

  it('no listed installer test has a system folder in front of its launchctl stub on PATH', () => {
    const own = /PATH: (sb\.bin|bin|refusingPath\(\)|`\$\{bin\}:\$\{process\.env\.PATH\}`)/
    for (const f of readdirSync(join(REPO, 'scripts'))) {
      if (
        !/^(root-install-(harness|chronos|flags|bun-probe|sched)|install-bughunt|uninstall-bughunt|chronos-|kit-(chronos|copy|shipped))/.test(
          f,
        )
      )
        continue
      for (const m of readFileSync(join(REPO, 'scripts', f), 'utf8').matchAll(/^.*\bPATH: .*$/gm))
        if (!m[0].includes('own = /')) expect(own.test(m[0]), `${f}: ${m[0].trim()}`).toBe(true)
    }
    // the kit's self-test, which those run: every PATH it sets has the shim's folder first (pybin is python's, for a dry run of memory setup)
    for (const m of readFileSync(join(REPO, 'kit/scripts/test-install.sh'), 'utf8').matchAll(/\bPATH="([^"]*)"/g))
      expect(m[1], m[0]).toMatch(/^\$(HOME\/(bin|pybin):|ORIGPATH|PATH)/)
  })

  it('every installer test on the Mac list runs in a HOME of its own, which is what the guard goes by', () => {
    const list = execFileSync('bash', [join(REPO, 'scripts', 'ci-local', 'macos-only.sh'), REPO], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.slice(l.indexOf(' ') + 1))
      .filter((f) =>
        /^scripts\/(root-install|install-bughunt|uninstall-bughunt|chronos-|kit-(chronos|copy|shipped))/.test(f),
      )
    expect(list).toContain('scripts/root-install-chronos.test.ts')
    expect(list.length).toBeGreaterThan(12)
    for (const f of list) {
      expect(existsSync(join(REPO, f)), f).toBe(true)
      const text = readFileSync(join(REPO, f), 'utf8')
      const shared = /from '\.\/root-install-(sched-)?harness\.ts'/.test(text)
      expect(shared || /\bHOME: /.test(text), `${f}: neither the shared sandbox nor a HOME of its own`).toBe(true)
      expect(/\bHOME: (process\.env|homedir)/.test(text), `${f}: the real HOME`).toBe(false)
    }
  })
})
