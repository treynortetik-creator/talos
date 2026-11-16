// The root ./install.sh: kit flags, the bridge step, Chronos on an existing agent, vaults and relay hosts. Harness:
// root-install-harness.ts.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO, run, type Sandbox, sandbox, snapshot } from './root-install-harness.ts'

describe('root install.sh', () => {
  describe('kit flags, the bridge step and Chronos on an existing agent (SETUP.md promises these)', () => {
    const STUB_CHRONOS = join(REPO, 'kit', 'scripts', 'fixtures', 'fake-chronos')
    const stubTalosApp = (sb: Sandbox) => {
      writeFileSync(join(sb.bin, 'talos-app'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(sb.bin, 'talos-app'), 0o755)
    }

    it('every flag the kit docs quote is accepted, not "unknown option" (exit 2)', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'private-agent-vault')
      const r = run(sb, [
        '--dry-run',
        '--no-app',
        '--no-chronos',
        '--with-vault',
        vault,
        '--with-memory-search',
        '--embed-model',
        'small',
        '--with-reranker',
        '--with-voice',
        '--with-qwen-voice',
        '--with-parakeet',
        '--with-diarize',
        '--global-pointer',
        '--allow-synced-folder',
        '--allow-protected-folder',
      ])
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('unknown option')
      expect(r.out).toContain(`--with-vault ${join(realpathSync(sb.home), 'private-agent-vault')}`)
      expect(r.out).toContain('--with-memory-search --embed-model small')
      expect(existsSync(vault)).toBe(false)
    })

    it('the exact line from the task: --dry-run --with-vault <new folder> --no-chronos exits 0 and changes nothing', () => {
      const sb = sandbox()
      const before = snapshot(sb.home)
      const r = run(sb, ['--dry-run', '--with-vault', join(sb.home, 'x'), '--no-chronos'])
      expect(r.code, r.out).toBe(0)
      expect(snapshot(sb.home)).toEqual(before)
    })

    it('a flag the kit does not have is still refused (exit 2)', () => {
      expect(run(sandbox(), ['--dry-run', '--with-teleportation']).code).toBe(2)
    })

    it('a Chronos-only flag without --with-chronos is refused loudly, never silently dropped', () => {
      const sb = sandbox()
      for (const flag of [['--notify', 'talos'], ['--no-jobs'], ['--no-load'], ['--chronos-path', STUB_CHRONOS]]) {
        const r = run(sb, ['--dry-run', '--no-app', ...flag])
        expect(r.code, flag.join(' ')).toBe(2)
        expect(r.out).toContain('--with-chronos')
      }
      expect(run(sb, ['--dry-run', '--no-app', '--with-chronos', '--no-chronos']).code).toBe(2)
    })

    it('a flag that needs a value says so instead of eating the next flag', () => {
      const r = run(sandbox(), ['--dry-run', '--no-app', '--with-vault'])
      expect(r.code).toBe(2)
      expect(r.out).toContain('--with-vault needs a value')
    })

    it('--with-vault reaches the kit: a real run creates the vault next to the agent', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'private-agent-vault')
      const r = run(sb, ['--no-app', '--yes', '--with-vault', vault])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(vault, 'CLAUDE.md'))).toBe(true)
      expect(existsSync(join(sb.agent, '.talos-version'))).toBe(true)
    }, 120_000)

    it('--with-chronos on an agent that already exists adds Chronos and the jobs, and leaves the agent alone', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const tuned = '# Tuned by Alex Example\nKeep replies short.\n'
      writeFileSync(join(sb.agent, 'CLAUDE.md'), tuned)
      const cfg = join(sb.home, '.config', 'chronos', 'config.json')
      expect(existsSync(cfg)).toBe(false)
      const r = run(sb, ['--no-app', '--yes', '--with-chronos', '--chronos-path', STUB_CHRONOS, '--no-load'])
      expect(r.code, r.out).toBe(0)
      expect(JSON.parse(readFileSync(cfg, 'utf8')).workspace).toBe(sb.agent)
      const jobs = JSON.parse(readFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), 'utf8')) as {
        id: string
        enabled?: boolean
      }[]
      expect(jobs.filter((j) => j.id.startsWith('talos-')).length).toBeGreaterThan(0)
      // only the zero-cost weekly jobs this run registered are on (plain commands); every Claude job is off
      expect(
        jobs
          .filter((j) => j.enabled)
          .map((j) => j.id)
          .sort(),
      ).toEqual(['talos-weekly-snapshot', 'talos-weekly-wiki-lint'])
      expect(readFileSync(join(sb.agent, 'CLAUDE.md'), 'utf8')).toBe(tuned)
      // the old behaviour was exit 0 with Chronos silently not installed: say it ran
      expect(r.out).toContain('added to the existing agent')
    }, 180_000)

    it('--notify talos is reachable from the root installer and records where talos-app lives', () => {
      const sb = sandbox()
      stubTalosApp(sb)
      const r = run(sb, [
        '--no-app',
        '--yes',
        '--with-chronos',
        '--chronos-path',
        STUB_CHRONOS,
        '--no-load',
        '--notify',
        'talos',
      ])
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(sb.home, '.config', 'talos', 'talos-app-bin'), 'utf8').trim()).toBe(
        join(sb.bin, 'talos-app'),
      )
      const cfg = JSON.parse(readFileSync(join(sb.home, '.config', 'chronos', 'config.json'), 'utf8'))
      expect(cfg.notify).toBe(join(sb.home, '.config', 'talos', 'notify', 'talos.sh'))
    }, 180_000)

    it('--relay-url runs the bridge step: key, bridge.env and the BRIDGE_PUBKEY line for Railway', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes', '--relay-url', 'https://relay.example.test'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('BRIDGE_PUBKEY=')
      const env = readFileSync(join(sb.home, '.config', 'talos', 'app', 'bridge.env'), 'utf8')
      expect(env).toContain('TALOS_APP_RELAY_URL=https://relay.example.test')
      // a second run with the same url keeps the key (init keeps what exists) and still succeeds
      const again = run(sb, ['--no-app', '--yes', '--relay-url', 'https://relay.example.test'])
      expect(again.code, again.out).toBe(0)
    }, 180_000)

    it('without --relay-url it prints the exact bridge command for this agent folder, and writes no bridge settings', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(
        `apps/bridge/scripts/install.sh --agent-dir ${sb.agent} --relay-url https://<your relay host>`,
      )
      expect(existsSync(join(sb.home, '.config', 'talos', 'app', 'bridge.env'))).toBe(false)
    }, 120_000)

    it('refuses a relay url that is not a bare https origin, before changing anything', () => {
      const sb = sandbox()
      for (const bad of [
        'http://relay.example.test',
        'https://relay.example.test/app',
        'relay.example.test',
        'http://localhost:8080',
        'https://relay.example.test?x=1',
        'https://relay.example.test/?x=1',
        'https://relay.example.test#frag',
        'https://user:pw@example.com',
        'https://relay.example.test;x',
        'https://relay.example.test/a/',
        'https://relay example.test',
      ]) {
        const r = run(sb, ['--no-app', '--yes', '--relay-url', bad])
        expect(r.code, bad).toBe(2)
        expect(r.out).toContain('--relay-url')
      }
      expect(existsSync(sb.agent)).toBe(false)
    })

    it('the closing hints no longer run two lines together, and name start-talos.sh as the way to start', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes'], { TALOS_INSTALL_OS: 'Darwin' })
      expect(r.code, r.out).toBe(0)
      const lines = r.out.split('\n')
      expect(lines.filter((l) => l.includes('Mac app:')).length).toBe(1)
      expect(lines.filter((l) => l.includes('First run:')).length).toBe(1)
      expect(lines.some((l) => l.includes('Mac app:') && l.includes('First run:'))).toBe(false)
      expect(lines.some((l) => l.includes('Start:') && l.includes('start-talos.sh'))).toBe(true)
    }, 120_000)
  })
  describe('review fixes on the setup path', () => {
    const STUB_CHRONOS = join(REPO, 'kit', 'scripts', 'fixtures', 'fake-chronos')
    const cleanClone = () => {
      for (const d of ['vault', 'vault2']) rmSync(join(REPO, d), { recursive: true, force: true })
    }

    it('1. a vault inside the clone is refused, relative or absolute, and nothing is created there', () => {
      try {
        for (const v of ['vault', './vault', join(REPO, 'vault2'), REPO]) {
          const sb = sandbox()
          const r = run(sb, ['--dry-run', '--no-app', '--with-vault', v])
          expect(r.code, v).toBe(2)
          expect(r.out, v).toContain('inside this clone')
          expect(existsSync(join(REPO, 'vault')), v).toBe(false)
          expect(existsSync(join(REPO, 'vault2')), v).toBe(false)
        }
      } finally {
        cleanClone()
      }
    })

    it('1. a relative vault is resolved against where you run it, so a folder next to the clone still works', () => {
      const sb = sandbox()
      const r = run(sb, ['--dry-run', '--no-app', '--with-vault', join(sb.home, 'v')])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`--with-vault ${join(realpathSync(sb.home), 'v')}`)
    })

    it('2. a dry run on an existing agent runs the kit dry run, so its refusals fail it (bad --notify)', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const r = run(sb, [
        '--dry-run',
        '--no-app',
        '--with-chronos',
        '--chronos-path',
        STUB_CHRONOS,
        '--notify',
        'slack',
      ])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('--notify must be')
      expect(existsSync(join(sb.home, '.config', 'chronos'))).toBe(false)
    }, 180_000)

    it('2. a dry run on an existing agent fails on a foreign non-empty vault', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const vault = join(sb.home, 'notes')
      mkdirSync(vault)
      writeFileSync(join(vault, 'mine.txt'), 'Alex Example keeps notes here\n')
      const r = run(sb, ['--dry-run', '--no-app', '--with-vault', vault])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('is not empty')
    }, 180_000)

    it('3. the same flags again, plus --with-chronos, succeed: the vault the kit made is recognised, not refused', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'private-agent-vault')
      expect(run(sb, ['--no-app', '--yes', '--with-vault', vault]).code).toBe(0)
      writeFileSync(join(vault, 'my-note.md'), 'a note that must survive\n')
      const again = run(sb, ['--no-app', '--yes', '--with-vault', vault])
      expect(again.code, again.out).toBe(0)
      const cfg = join(sb.home, '.config', 'chronos', 'config.json')
      const r = run(sb, [
        '--no-app',
        '--yes',
        '--with-vault',
        vault,
        '--with-chronos',
        '--chronos-path',
        STUB_CHRONOS,
        '--no-load',
      ])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(cfg)).toBe(true)
      expect(readFileSync(join(vault, 'my-note.md'), 'utf8')).toBe('a note that must survive\n')
    }, 240_000)

    it('3. a foreign non-empty folder is still refused as a vault', () => {
      const sb = sandbox()
      const vault = join(sb.home, 'foreign')
      mkdirSync(vault)
      writeFileSync(join(vault, 'x.txt'), 'x')
      const r = run(sb, ['--no-app', '--yes', '--with-vault', vault])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('is not empty')
    }, 120_000)

    it('4. a flag that needs a value refuses the next flag as that value', () => {
      for (const flags of [
        ['--with-vault', '--dry-run'],
        ['--agent-dir', '--yes'],
        ['--relay-url', '--yes'],
        ['--with-chronos', '--notify', '--no-app'],
      ]) {
        const r = run(sandbox(), ['--dry-run', ...flags])
        expect(r.code, flags.join(' ')).toBe(2)
        expect(r.out, flags.join(' ')).toContain('needs a value')
      }
    })

    it('5. a bare https origin is accepted, with or without one trailing slash', () => {
      for (const ok of [
        'https://relay.example.test',
        'https://relay.example.test/',
        'https://relay.example.test:8443',
      ]) {
        const r = run(sandbox(), ['--no-app', '--dry-run', '--relay-url', ok])
        expect(r.code, `${ok}: ${r.out}`).toBe(0)
      }
    }, 60_000) // three whole install.sh dry runs, about 10 s each on a busy Mac

    it('9. an old ~/my-agent and no ~/talos-agent: stops and asks instead of creating a second agent', () => {
      const sb = sandbox()
      const old = join(sb.home, 'my-agent')
      mkdirSync(old)
      writeFileSync(join(old, '.talos-version'), 'version=1.0.0\n')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('my-agent')
      expect(r.out).toContain('--agent-dir')
      expect(existsSync(sb.agent)).toBe(false)
      // choosing on purpose goes ahead as before
      expect(run(sb, ['--no-app', '--dry-run', '--agent-dir', old]).code).toBe(0)
    })
  })
  describe('round-2 review fixes', () => {
    it('R2-2. a dry run with an agent folder whose parent does not exist yet succeeds and creates nothing', () => {
      const sb = sandbox()
      const agent = join(sb.home, 'a', 'b', 'agent')
      const r = run(sb, ['--dry-run', '--no-app', '--agent-dir', agent])
      expect(r.code, r.out).toBe(0)
      expect(existsSync(join(sb.home, 'a'))).toBe(false)
      // a real run is not told the parent is fine by that: it creates it (the root installer always did) and succeeds
      const real = run(sb, ['--yes', '--no-app', '--agent-dir', agent])
      expect(real.code, real.out).toBe(0)
    }, 120_000)

    it('R2-3. a vault under the clone is refused when its letters differ only in case (case-insensitive volumes)', () => {
      const swapped = (p: string) =>
        p.replace(/[A-Za-z]+$/, (m) =>
          [...m].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join(''),
        )
      const alt = swapped(REPO)
      if (alt === REPO || !existsSync(alt)) return // a case-sensitive volume: the two paths are different folders
      const r = run(sandbox(), ['--dry-run', '--no-app', '--with-vault', join(alt, 'zz-vault')])
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('inside this clone')
    })

    it('R2-5. a vault inside any git work tree that has a remote is refused, GitLab or self-hosted too', () => {
      const sb = sandbox()
      const repo = join(sb.home, 'work')
      mkdirSync(repo)
      spawnSync('git', ['init', '-q'], { cwd: repo })
      spawnSync('git', ['remote', 'add', 'origin', 'https://git.example.com/alex/notes.git'], { cwd: repo })
      const r = run(sb, ['--dry-run', '--no-app', '--with-vault', join(repo, 'vault')])
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('has a remote')
    })

    it('R2-8. a relay host with an empty label (.., a leading or trailing dot) is refused', () => {
      for (const bad of [
        'https://a..example.com',
        'https://.example.com',
        'https://example.com.',
        'https://a.-b.example.com',
        'https://-a.example.com',
      ]) {
        const r = run(sandbox(), ['--no-app', '--dry-run', '--relay-url', bad])
        expect(r.code, bad).toBe(2)
        expect(r.out, bad).toContain('--relay-url')
      }
      expect(run(sandbox(), ['--no-app', '--dry-run', '--relay-url', 'https://my-relay.up.railway.app']).code).toBe(0)
    })
  })
})
