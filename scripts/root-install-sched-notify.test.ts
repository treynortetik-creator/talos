// gate-reads: install.sh kit/* apps/chronos/* scripts/*
// Chronos runs "notify" as a shell command, so the kit stores the path shell-quoted when it needs it (a home with a space or a quote
// in it) and leaves a plain path exactly as it was. Every reader of the value (uninstall.sh, the watcher) knows both forms.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { BUNDLED, install, KIT, macSandbox, type SB, snapshot } from './root-install-sched-harness.ts'

const notifyOf = (home: string) =>
  JSON.parse(readFileSync(join(home, '.config', 'chronos', 'config.json'), 'utf8')).notify as string

/** A sandbox whose HOME has a space (and, if asked, a quote) in its name. */
function oddHome(name: string): { sb: SB; home: string } {
  const sb = macSandbox()
  const home = join(sb.root, name)
  mkdirSync(home)
  return { sb, home }
}
const withHome = (sb: SB, home: string): SB => ({ ...sb, home, agent: join(home, 'talos-agent') })

describe('the notify command is stored so that Chronos can run it', () => {
  it(
    'a plain path is stored exactly as before (byte-identical)',
    () => {
      const sb = macSandbox()
      const r = install(sb, ['--notify', 'macos'])
      expect(r.code, r.out).toBe(0)
      expect(notifyOf(sb.home)).toBe(join(sb.home, '.config', 'talos', 'notify', 'macos.sh'))
    },
    scaled(300_000),
  )

  for (const name of ['my home', "o'brien home"])
    it(
      `a home called "${name}": quoted in the config, and Chronos's own notify call really runs the script`,
      () => {
        const { sb, home } = oddHome(name)
        const sb2 = withHome(sb, home)
        const r = install(sb2, ['--notify', 'macos', '--no-load'], { HOME: home })
        expect(r.code, r.out).toBe(0)
        const stored = notifyOf(home)
        const script = join(home, '.config', 'talos', 'notify', 'macos.sh')
        expect(stored).not.toBe(script) // it needed quoting
        // Chronos's own path to the command: bin/chronos-notify reads the config and runs it with the message
        const c = spawnSync('bash', [join(BUNDLED, 'bin', 'chronos-notify'), 'hello there'], {
          encoding: 'utf8',
          env: { PATH: sb.bin, HOME: home, CHRONOS_CONFIG: join(home, '.config', 'chronos', 'config.json') },
        })
        expect(c.status, `${c.stdout}${c.stderr}`).toBe(0)
        expect(readFileSync(sb.log, 'utf8')).toContain('osascript') // macos.sh ran and called the (stubbed) osascript
        expect(readFileSync(sb.log, 'utf8')).toContain('hello there')
      },
      scaled(300_000),
    )

  it(
    'uninstall.sh clears the notify it set, in the quoted form and in the old unquoted one',
    () => {
      for (const quoted of [true, false]) {
        const { sb, home } = oddHome('my home')
        const sb2 = withHome(sb, home)
        expect(install(sb2, ['--notify', 'macos', '--no-load'], { HOME: home }).code).toBe(0)
        const cfg = join(home, '.config', 'chronos', 'config.json')
        const script = join(home, '.config', 'talos', 'notify', 'macos.sh')
        const j = JSON.parse(readFileSync(cfg, 'utf8'))
        j.notify = quoted ? `'${script}'` : script
        writeFileSync(cfg, JSON.stringify(j))
        const u = spawnSync('bash', [join(KIT, 'uninstall.sh'), '--agent-dir', sb2.agent, '--yes'], {
          encoding: 'utf8',
          env: { PATH: sb.bin, HOME: home, TALOS_INSTALL_OS: 'Darwin' },
        })
        expect(u.stdout + u.stderr).toContain("cleared Chronos's notify")
        expect(JSON.parse(readFileSync(cfg, 'utf8')).notify).toBe('')
        expect(existsSync(script)).toBe(false)
      }
    },
    scaled(300_000),
  )

  it(
    'a notify command someone else set is left as it is (and so is the file)',
    () => {
      const sb = macSandbox()
      expect(install(sb, ['--no-load']).code).toBe(0)
      const cfg = join(sb.home, '.config', 'chronos', 'config.json')
      const j = JSON.parse(readFileSync(cfg, 'utf8'))
      j.notify = '/usr/local/bin/mine'
      writeFileSync(cfg, JSON.stringify(j))
      const before = snapshot(join(sb.home, '.config', 'chronos'))
      const r = install(sb, ['--notify', 'macos', '--no-load'])
      expect(r.code, r.out).toBe(0)
      expect(notifyOf(sb.home)).toBe('/usr/local/bin/mine')
      expect(snapshot(join(sb.home, '.config', 'chronos'))).toEqual(before)
    },
    scaled(300_000),
  )
})
