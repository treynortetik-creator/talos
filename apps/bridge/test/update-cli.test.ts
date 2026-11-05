// D61: `talos-app update` against a throwaway repository (a bare origin and two clones). pnpm is a recorder; git is real.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { tempHome } from './helpers.ts'

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@e.x', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'talos-upd-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const install = join(root, 'install')
  mkdirSync(seed)
  sh(seed, 'init', '-q', '-b', 'main')
  mkdirSync(join(seed, 'apps', 'bridge', 'src'), { recursive: true })
  writeFileSync(join(seed, 'apps', 'bridge', 'package.json'), '{"name":"x","version":"0.0.0"}')
  writeFileSync(join(seed, 'apps', 'bridge', 'src', 'version.ts'), '// stand-in')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-q', '-m', 'one')
  sh(root, 'clone', '-q', '--bare', seed, origin)
  sh(root, 'clone', '-q', origin, install)
  const push = (name: string) => {
    writeFileSync(join(seed, name), name)
    sh(seed, 'add', '.')
    sh(seed, 'commit', '-q', '-m', name)
    sh(seed, 'push', '-q', origin, 'HEAD:main')
  }
  return { root, install, seed, origin, push, sha: (dir = install) => sh(dir, 'rev-parse', '--short=7', 'HEAD') }
}

function harness(repoDir: string, pnpmCode = 0) {
  const calls: string[][] = []
  const out: string[] = []
  const err: string[] = []
  const deps = {
    update: {
      repoDir,
      run: (cmd: string[], cwd: string) => {
        calls.push(cmd)
        if (cmd[0] === 'git') {
          const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
          return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}`.trim() }
        }
        return { code: pnpmCode, out: pnpmCode ? 'ERR_PNPM_OUTDATED_LOCKFILE' : '' }
      },
    },
  }
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    prompt: async () => '',
    sleep: async () => {},
    now: () => Date.now(),
  }
  const run = () => runCli(['update'], io, { TALOS_APP_HOME: tempHome() }, deps)
  return { calls, out, err, run }
}

describe('talos-app update', () => {
  test('pulls, installs with the frozen lockfile, prints old and new versions and what is left', async () => {
    const w = world()
    const old = w.sha()
    w.push('two')
    const h = harness(w.install)
    expect(await h.run()).toBe(0)
    expect(w.sha()).not.toBe(old)
    expect(h.out[0]).toBe(`updated: ${old} -> ${w.sha()}`)
    expect(h.calls.some((c) => c.join(' ') === 'pnpm install --frozen-lockfile')).toBe(true)
    const text = h.out.join('\n')
    expect(text).toContain('Restart the agent')
    expect(text).toContain('never restarts the agent')
    expect(text).toContain('Railway')
    expect(text).toContain('apps/desktop/scripts/build-app.sh')
    expect(text).toContain('kit/scripts/upgrade.sh')
    expect(text).toContain('--into <your agent folder> --dry-run')
    expect(text).toContain('docs/ios.md')
    expect(text).not.toContain('arrives through TestFlight')
    // it ran git and pnpm and nothing else: no kill, no restart, no push
    expect(h.calls.every((c) => c[0] === 'git' || c[0] === 'pnpm')).toBe(true)
    expect(h.calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(false)
  })

  test('already up to date: says so, and still runs the install (a failed one can be repeated)', async () => {
    const w = world()
    const h = harness(w.install)
    expect(await h.run()).toBe(0)
    expect(h.out[0]).toBe(`already up to date: ${w.sha()} (packages checked)`)
    expect(h.calls.some((c) => c.join(' ') === 'pnpm install --frozen-lockfile')).toBe(true)
  })

  test('rerunning after an install that failed does not skip the install', async () => {
    const w = world()
    w.push('two')
    const failing = harness(w.install, 1)
    expect(await failing.run()).toBe(1)
    const again = harness(w.install, 0) // the pull already happened: the commit does not move on this run
    expect(await again.run()).toBe(0)
    expect(again.calls.some((c) => c.join(' ') === 'pnpm install --frozen-lockfile')).toBe(true)
  })

  test('step 3 names both scripts, because build-app.sh alone leaves the old app installed', async () => {
    const w = world()
    const h = harness(w.install)
    await h.run()
    const text = h.out.join('\n')
    expect(text).toContain('build-app.sh')
    expect(text).toContain(join(w.install, 'apps', 'desktop', 'scripts', ['install', 'sh'].join('.')))
  })

  test('refuses a dirty tree with a plain message and pulls nothing', async () => {
    const w = world()
    w.push('two')
    writeFileSync(join(w.install, 'apps', 'bridge', 'package.json'), '{"name":"changed"}')
    const before = w.sha()
    const h = harness(w.install)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('changes that are not committed')
    expect(w.sha()).toBe(before)
    expect(h.calls.some((c) => c[1] === 'pull')).toBe(false)
  })

  test('refuses a detached HEAD', async () => {
    const w = world()
    w.push('two')
    sh(w.install, 'checkout', '-q', '--detach')
    const h = harness(w.install)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('detached HEAD')
    expect(h.calls.some((c) => c[1] === 'pull')).toBe(false)
  })

  test('refuses a branch that follows nothing', async () => {
    const w = world()
    sh(w.install, 'checkout', '-q', '-b', 'lonely')
    const h = harness(w.install)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('does not follow a remote branch')
  })

  test('a diverged branch fails the fast-forward and nothing changes', async () => {
    const w = world()
    writeFileSync(join(w.install, 'mine'), 'mine')
    sh(w.install, 'add', '.')
    sh(w.install, 'commit', '-q', '-m', 'mine')
    w.push('two')
    const before = w.sha()
    const h = harness(w.install)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('git pull --ff-only failed')
    expect(w.sha()).toBe(before)
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
  })

  test('a failed install is reported with the new version and the fix, not as success', async () => {
    const w = world()
    w.push('two')
    const h = harness(w.install, 1)
    expect(await h.run()).toBe(1)
    const e = h.err.join('\n')
    expect(e).toContain(`now at ${w.sha()}`)
    expect(e).toContain('pnpm install --frozen-lockfile failed')
    expect(h.out.join('\n')).not.toContain('updated:')
  })

  test('a folder that is not the checkout is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-nogit-'))
    const h = harness(dir)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('not running from its own git checkout')
  })

  test('it is in the help text', async () => {
    const out: string[] = []
    await runCli(['help'], {
      out: (l) => out.push(l),
      err: () => {},
      prompt: async () => '',
      sleep: async () => {},
      now: () => 0,
    })
    expect(out.join('\n')).toContain('  update')
  })
})
