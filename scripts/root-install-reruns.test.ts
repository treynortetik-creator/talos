// The root ./install.sh: reruns, verify-install, the running app, smaller fixes (split from root-install.test.ts so the two
// halves run side by side; the imports are the same).
// The root ./install.sh: dry run, real run, refusals, the Mac app step, reruns and verify-install. The harness (a private PATH
// of real tools and stubs, a sandbox HOME) is root-install-harness.ts; the suite is split over the root-install*.test.ts files
// so vitest runs them side by side.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calls, flag, MOD, mac, REPO, run, SCRIPT, sandbox, snapshot, treeHash } from './root-install-harness.ts'

describe('root install.sh', () => {
  describe('reruns', () => {
    it('a failed first commit says what was done, and the rerun finishes the commit', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'fail-commit'), '')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('first commit')
      expect(r.stderr).toContain('git init')
      expect(existsSync(join(sb.agent, '.git'))).toBe(true)
      rmSync(flag(sb, 'fail-commit'))
      const again = run(sb, ['--no-app', '--yes'])
      expect(again.code, again.out).toBe(0)
      const head = spawnSync('git', ['-C', sb.agent, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
      expect(head.status, head.stderr).toBe(0)
    }, 120_000)

    it('a killed kit copy stops with the move-aside message, and a rerun is refused with the folder byte-identical', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'fail-tar'), '')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(
        `The kit copy stopped part-way. ${sb.agent} now holds a partial copy. Move it aside (for example: mv ${sb.agent} ${sb.agent}.partial) and run ./install.sh again.`,
      )
      expect(existsSync(join(sb.agent, '.talos-version'))).toBe(false)
      expect(readdirSync(sb.agent).length).toBeGreaterThan(0)
      expect(readdirSync(sb.home).filter((n) => n.includes('partial'))).toEqual([]) // no marker file next to the folder
      rmSync(flag(sb, 'fail-tar'))
      const before = treeHash(sb.agent)
      const again = run(sb, ['--no-app', '--yes'])
      expect(again.code).toBe(1)
      expect(again.out).toContain('not a Talos agent')
      expect(treeHash(sb.agent)).toBe(before)
      // the owner follows the message and it works
      renameSync(sb.agent, `${sb.agent}.partial`)
      const fresh = run(sb, ['--no-app', '--yes'])
      expect(fresh.code, fresh.out).toBe(0)
    }, 120_000)

    it("a kit that refuses before copying never makes the owner's later files deletable", () => {
      const sb = sandbox()
      const agent = join(sb.home, 'Dropbox', 'agent')
      mkdirSync(agent, { recursive: true })
      const first = run(sb, ['--no-app', '--yes', '--agent-dir', agent])
      expect(first.code).toBe(1)
      expect(first.out).toContain('cloud-synced')
      expect(first.out).not.toContain('part-way')
      // the owner starts using the folder: files whose names match the kit's, plus a git history
      writeFileSync(join(agent, 'CLAUDE.md'), '# Alex Example keeps this\n')
      mkdirSync(join(agent, 'memory'))
      writeFileSync(join(agent, 'memory', 'notes.md'), 'Alex Example: fictional note\n')
      const g = (...a: string[]) =>
        spawnSync('git', ['-C', agent, '-c', 'user.name=A', '-c', 'user.email=a@example.com', ...a], {
          encoding: 'utf8',
        })
      g('init', '-q')
      g('add', '.')
      expect(g('commit', '-qm', 'mine').status).toBe(0)
      const before = treeHash(agent)
      const again = run(sb, ['--no-app', '--yes', '--agent-dir', agent])
      expect(again.code).toBe(1)
      expect(treeHash(agent)).toBe(before)
      expect(readFileSync(join(agent, 'memory', 'notes.md'), 'utf8')).toBe('Alex Example: fictional note\n')
    }, 120_000)

    it('a non-empty folder with no .talos-version is refused even if it looks like the kit', () => {
      const sb = sandbox()
      mkdirSync(join(sb.agent, 'hooks'), { recursive: true })
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('not a Talos agent')
    })

    it('the installer source has no marker file and no rm of anything', () => {
      const src = readFileSync(SCRIPT, 'utf8')
      expect(src).not.toMatch(/talos-install-partial/)
      expect(src).not.toMatch(/rm -rf|-exec rm|\brm\b[^\n]*(AGENT_DIR|PARTIAL)/)
    })
  })

  describe('verify-install', () => {
    it('is a warning on an agent that existed before this run', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      writeFileSync(join(sb.agent, 'CLAUDE.md'), '# mine\nyou are the tutor\n')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code, r.out).toBe(0)
      // her own files: said as notes, not part of the install, and the install goes on to done
      expect(r.out).toMatch(/\d+ notes? about your own files, not part of the install/)
      expect(r.out).toContain('verify-install')
      expect(r.out).toMatch(/Also: \d+ notes? about your own files \(above\); the install itself is done\./)
    }, 120_000)

    it('stays a hard gate on a fresh install', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'fail-render'), '')
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('verify-install')
    }, 120_000)
  })

  describe('the running app is never quit', () => {
    it('with Talos running, builds and installs with --no-quit and says the update applies at the next start', () => {
      const sb = sandbox()
      writeFileSync(flag(sb, 'app-running'), '')
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(calls(sb)).toContain('app-install.sh --no-open --no-quit')
      expect(calls(sb).filter((c) => c.startsWith('osascript') && /quit/.test(c))).toEqual([])
      expect(r.out).toContain('next app start')
      expect(r.out).toContain('/home/alex/Applications/Talos.app')
    }, 120_000)

    it('with Talos not running, nothing is said about a running app', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('next app start')
    }, 120_000)
  })

  describe('smaller fixes', () => {
    it('no --yes and no TTY: refuses and says to use --yes, changing nothing', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app'])
      expect(r.code).toBe(2)
      expect(r.out).toContain('--yes')
      expect(existsSync(sb.agent)).toBe(false)
    })

    it('a dry run needs no --yes', () => {
      expect(run(sandbox(), ['--no-app', '--dry-run']).code).toBe(0)
    })

    it('the closing hints carry the flags and quote a clone path with spaces', () => {
      const sb = sandbox()
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.out).not.toMatch(/cd .* && claude\s*\)/)
      const upd = r.out.split('\n').find((l) => l.includes('Update:')) as string
      expect(upd).toContain(REPO.includes(' ') ? `'` : REPO)
    }, 120_000)

    it('a failing mktemp is reported, not ignored', () => {
      const sb = sandbox()
      rmSync(join(sb.bin, 'mktemp'))
      writeFileSync(join(sb.bin, 'mktemp'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(sb.bin, 'mktemp'), 0o755)
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('FAILED')
    }, 120_000)
  })
})
