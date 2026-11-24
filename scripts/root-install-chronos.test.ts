// Chronos with every install (the owner, 2026-11-19: "Chronos runs with Talos every time"). The root ./install.sh sets it up on
// a Mac by default from the copy in this repository (apps/chronos): no clone of the frozen chronos repository, no flag. The
// Claude jobs are registered off. Schedules finds it, so a fresh Mac never says "No scheduler". --no-chronos stays, as a test
// switch only.
// gate-reads: install.sh kit/* apps/chronos/* scripts/*
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { REPO, run, sandbox } from './root-install-harness.ts'

const BUNDLED = join(REPO, 'apps', 'chronos')
const cfgOf = (home: string) => join(home, '.config', 'chronos', 'config.json')
const recordOf = (home: string) => join(home, '.config', 'talos', 'chronos-dir')
type Job = { id: string; enabled?: boolean }
const jobsOf = (home: string) =>
  JSON.parse(readFileSync(join(home, '.config', 'chronos', 'jobs.json'), 'utf8')) as Job[]

/** What `talos-app schedules` says on this install: the bridge's own discovery, as the app's Schedules tab gets it. */
function schedules(sb: ReturnType<typeof sandbox>): string {
  const r = spawnSync(
    join(sb.bin, 'bun'),
    ['--no-env-file', join(REPO, 'apps', 'bridge', 'src', 'cli.ts'), 'schedules'],
    {
      encoding: 'utf8',
      cwd: sb.home,
      env: { PATH: sb.bin, HOME: sb.home, TALOS_APP_HOME: join(sb.home, '.config', 'talos', 'app') },
      timeout: 60_000,
    },
  )
  return `${r.stdout}${r.stderr}`
}

describe('root install.sh: Chronos comes with Talos', () => {
  it(
    'a fresh Mac install sets up the bundled Chronos with the Claude jobs off, and Schedules finds it',
    () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true })
      expect(r.code, r.out).toBe(0)
      // from this repository's copy, never a clone of the frozen repository
      expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(BUNDLED)
      expect(r.out).not.toMatch(/git clone|cloning/i)
      expect(r.out).not.toContain('github.com/treynortetik-creator/chronos')
      expect(JSON.parse(readFileSync(cfgOf(sb.home), 'utf8')).workspace).toBe(sb.agent)
      const jobs = jobsOf(sb.home).filter((j) => j.id.startsWith('talos-'))
      expect(jobs.length).toBeGreaterThan(0)
      // only the two zero-cost plain-command jobs run by themselves; every Claude job waits for the owner to enable it
      expect(
        jobs
          .filter((j) => j.enabled)
          .map((j) => j.id)
          .sort(),
      ).toEqual(['talos-weekly-snapshot', 'talos-weekly-wiki-lint'])
      expect(r.out).toMatch(/Chronos: +installed/)
      // the app's Schedules tab: a scheduler, never "No scheduler is installed"
      const s = schedules(sb)
      expect(s).not.toContain('No scheduler')
      expect(s).toContain('Chronos')
    },
    scaled(300_000),
  )

  it(
    'a second run changes nothing and says so',
    () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true }).code).toBe(0)
      // no Chronos flag the second time: Chronos is current, so nothing runs (a Chronos flag would start an add-only run)
      const r = run(sb, ['--no-app', '--yes'], {}, { chronos: true })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('Nothing to change')
    },
    scaled(300_000),
  )

  it(
    'a Chronos flag on an agent whose Chronos is current is acted on, never dropped',
    () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true }).code).toBe(0)
      const r = run(sb, ['--no-app', '--yes', '--no-load', '--set-chronos-workspace'], {}, { chronos: true })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('added to the existing agent')
      expect(r.out).toContain('--set-chronos-workspace')
    },
    scaled(300_000),
  )

  it(
    'an agent made before Chronos came with Talos gets it on the next run',
    () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0) // the harness's --no-chronos: an agent without Chronos
      expect(existsSync(cfgOf(sb.home))).toBe(false)
      const r = run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true })
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(BUNDLED)
      expect(JSON.parse(readFileSync(cfgOf(sb.home), 'utf8')).workspace).toBe(sb.agent)
    },
    scaled(300_000),
  )

  it(
    'an agent on the old Chronos clone moves to this copy: Chronos is installed again, config and jobs kept, the clone left',
    () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true }).code).toBe(0)
      // as an older install left it: the kit's record names its clone in ~/.local/share/talos/chronos
      const old = join(sb.home, '.local', 'share', 'talos', 'chronos')
      mkdirSync(old, { recursive: true })
      writeFileSync(join(old, 'README.md'), 'an old clone\n')
      writeFileSync(recordOf(sb.home), `${old}\n`)
      // and as that install registered its hook: the agent's SessionStart runs the clone's copy
      mkdirSync(join(old, 'hooks'), { recursive: true })
      writeFileSync(join(old, 'hooks', 'chronos-session-start.py'), 'print("{}")\n')
      const sp = join(sb.agent, '.claude', 'settings.json')
      writeFileSync(sp, readFileSync(sp, 'utf8').split(join(BUNDLED, 'hooks')).join(join(old, 'hooks')))
      expect(readFileSync(sp, 'utf8')).toContain(join(old, 'hooks'))
      const cfg = readFileSync(cfgOf(sb.home), 'utf8')
      const jobs = readFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), 'utf8')
      const r = run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true })
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(BUNDLED)
      expect(r.out).toContain("running Chronos's installer") // the plists move to this copy
      expect(readFileSync(cfgOf(sb.home), 'utf8')).toBe(cfg)
      expect(readFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), 'utf8')).toBe(jobs)
      expect(readFileSync(join(old, 'README.md'), 'utf8')).toBe('an old clone\n')
      const after = readFileSync(sp, 'utf8')
      expect(after).toContain(join(BUNDLED, 'hooks', 'chronos-session-start.py'))
      expect(after).not.toContain(join(old, 'hooks'))
      expect(r.out).toContain(old) // said, so the owner can remove it
    },
    scaled(300_000),
  )

  it(
    'a Chronos the owner set up by hand (a config, no record) is left alone by a plain rerun',
    () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
      const mine = '{"workspace": "/somewhere/else", "notify": ""}\n'
      writeFileSync(cfgOf(sb.home), mine)
      const r = run(sb, ['--no-app', '--yes'], {}, { chronos: true })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('Nothing to change')
      expect(readFileSync(cfgOf(sb.home), 'utf8')).toBe(mine)
      expect(existsSync(recordOf(sb.home))).toBe(false)
      // a Chronos flag alone does not take it over either: refused, and --reinstall-chronos named
      const flag = run(sb, ['--no-app', '--yes', '--notify', 'talos'], {}, { chronos: true })
      expect(flag.code, flag.out).toBe(2)
      expect(flag.out).toContain('--reinstall-chronos')
      expect(readFileSync(cfgOf(sb.home), 'utf8')).toBe(mine)
    },
    scaled(300_000),
  )

  describe("a Chronos that is not Talos's own is never taken over without --reinstall-chronos", () => {
    const MINE_CFG = '{"workspace": "/somewhere/else", "notify": ""}\n'
    const MINE_JOBS = '[{"id": "mine", "enabled": true, "schedule": "0 9 * * *", "command": "echo hi"}]\n'
    const handMade = (home: string) => {
      mkdirSync(join(home, '.config', 'chronos'), { recursive: true })
      writeFileSync(cfgOf(home), MINE_CFG)
      writeFileSync(join(home, '.config', 'chronos', 'jobs.json'), MINE_JOBS)
    }
    const untouched = (home: string, agent: string) => {
      expect(readFileSync(cfgOf(home), 'utf8')).toBe(MINE_CFG)
      expect(readFileSync(join(home, '.config', 'chronos', 'jobs.json'), 'utf8')).toBe(MINE_JOBS)
      expect(existsSync(recordOf(home))).toBe(false)
      const sp = join(agent, '.claude', 'settings.json')
      if (existsSync(sp)) expect(readFileSync(sp, 'utf8')).not.toContain('chronos-session-start.py')
    }

    it(
      'a fresh install leaves it alone: no jobs, no enabled jobs, no hook, and says so',
      () => {
        const sb = sandbox()
        handMade(sb.home)
        const r = run(sb, ['--no-app', '--yes'], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        untouched(sb.home, sb.agent)
        expect(r.out).toContain('--reinstall-chronos')
        expect(r.out).not.toMatch(/Chronos: +installed/)
      },
      scaled(300_000),
    )

    it(
      '--with-chronos alone is not that choice: left alone, and told how to opt in',
      () => {
        const sb = sandbox()
        handMade(sb.home)
        const r = run(sb, ['--no-app', '--yes', '--with-chronos'], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        untouched(sb.home, sb.agent)
        expect(r.out).toContain('--reinstall-chronos')
      },
      scaled(300_000),
    )

    it(
      'a feature flag on an existing agent (--with-vault) leaves it alone',
      () => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
        handMade(sb.home)
        const vault = join(sb.root, 'vault')
        const r = run(sb, ['--no-app', '--yes', '--with-vault', vault], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        untouched(sb.home, sb.agent)
      },
      scaled(300_000),
    )

    it(
      '--reinstall-chronos is the choice: it moves to this copy, its config and jobs kept',
      () => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
        handMade(sb.home)
        const r = run(sb, ['--no-app', '--yes', '--no-load', '--reinstall-chronos'], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(BUNDLED)
        expect(JSON.parse(readFileSync(cfgOf(sb.home), 'utf8')).workspace).toBe('/somewhere/else') // his setting kept
        expect(jobsOf(sb.home).some((j) => j.id === 'mine')).toBe(true)
        expect(jobsOf(sb.home).some((j) => j.id.startsWith('talos-'))).toBe(true)
      },
      scaled(300_000),
    )

    it.each([['a moved Talos checkout (its kit is there)', true]])(
      "a record at %s counts as Talos's own: moved to this copy, not left on a dead folder",
      (_name, exists) => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true }).code).toBe(0)
        const oldTalos = join(sb.root, 'old-talos')
        if (exists) {
          mkdirSync(join(oldTalos, 'kit'), { recursive: true })
          writeFileSync(join(oldTalos, 'kit', 'install.sh'), '#!/bin/sh\n')
          mkdirSync(join(oldTalos, 'apps', 'chronos'), { recursive: true })
        }
        writeFileSync(recordOf(sb.home), `${join(oldTalos, 'apps', 'chronos')}\n`)
        const r = run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(BUNDLED)
        expect(r.out).toContain("running Chronos's installer")
        expect(r.out).not.toContain('left it alone')
      },
      scaled(300_000),
    )

    it(
      'a record at a folder that is gone (an unplugged disk) says nothing about whose it was: left alone, not moved',
      () => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true }).code).toBe(0)
        const gone = join(sb.root, 'unplugged', 'work', 'apps', 'chronos')
        writeFileSync(recordOf(sb.home), `${gone}\n`)
        const r = run(sb, ['--no-app', '--yes'], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(gone)
        expect(r.out).not.toContain("running Chronos's installer")
        expect(r.out).toContain('--reinstall-chronos')
      },
      scaled(300_000),
    )

    it(
      "a Chronos of the owner's own path (recorded) is not moved back by a plain rerun",
      () => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes', '--no-load'], {}, { chronos: true }).code).toBe(0)
        const own = join(sb.root, 'my-chronos')
        mkdirSync(own, { recursive: true })
        writeFileSync(recordOf(sb.home), `${own}\n`)
        const r = run(sb, ['--no-app', '--yes'], {}, { chronos: true })
        expect(r.code, r.out).toBe(0)
        expect(readFileSync(recordOf(sb.home), 'utf8').trim()).toBe(own)
        expect(r.out).not.toContain("running Chronos's installer")
        expect(r.out).toContain('--reinstall-chronos')
      },
      scaled(300_000),
    )
  })

  it(
    '--no-chronos still installs without Chronos, and the help no longer offers it',
    () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes', '--no-chronos'])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(cfgOf(sb.home))).toBe(false)
      const help = spawnSync('bash', [join(REPO, 'install.sh'), '--help'], { encoding: 'utf8' })
      expect(`${help.stdout}${help.stderr}`).not.toContain('--no-chronos')
      expect(`${help.stdout}${help.stderr}`).not.toMatch(/--chronos-(repo|ref)/)
    },
    scaled(300_000),
  )
})
