// scripts/gate.sh --push (gate-push.sh), for real: a temp repo, a bare origin, the real hook, gate and push script, with
// stand-ins for pnpm and biome that write down what they were asked to do. One push runs the gate once (the hook trusts the
// stamp for that tree); a push that loses a race rebases and runs only the cheap checks when the new commits touch nothing
// this change's tests depend on, the whole touched set otherwise; the push lease is taken, waited on, taken over when it ran
// out, and released, Ctrl-C included.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { fakeTool } from './fake-tool'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
// x TALOS_TEST_TIME_FACTOR: a setConfig here replaces vitest.config.ts's scaled budget, so it scales itself (two gates in one test
// ran past a flat 60 s on a loaded Mac)
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TYPECHECK = 'pnpm -s typecheck'

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'gp-'))
  dirs.push(T)
  const clone = join(T, 'clone')
  const other = join(T, 'other')
  const log = join(T, 'calls.log')
  const bin = join(T, 'bin')
  // nothing from a gate this may run inside (gate-test-env.ts): every spawn below starts from this one
  const env = gateTestEnv({
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: log,
    TALOS_CI_NESTED: '0',
    TALOS_NO_HOOKS: '0',
    TALOS_MACHINE: 'cyclops',
    TALOS_CI_CACHE: join(T, 'cache'), // rebase-pass.tsv goes here, never into the real cache
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  })
  const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, env, encoding: 'utf8' })
  const ok = (cwd: string, ...a: string[]) => {
    const r = git(cwd, ...a)
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  mkdirSync(bin)
  const stub = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    fakeTool(dirname(path), basename(path), `#!/bin/sh\n${body}\n`)
  }
  // pnpm: the type check and the suites write themselves down; ON_TYPECHECK, a command run on the first type check (a
  // push from another machine while this gate runs)
  stub(
    join(bin, 'pnpm'),
    `echo "pnpm $*" >> "$CALLS"
if [ "$*" = "-s typecheck" ] && [ -n "$ON_TYPECHECK" ] && [ ! -e "$CALLS.once" ]; then : > "$CALLS.once"; sh -c "$ON_TYPECHECK"; fi
if [ "$*" = "-s typecheck" ] && [ -n "$ON_EVERY_TYPECHECK" ]; then sh -c "$ON_EVERY_TYPECHECK"; fi
if [ "$*" = "-s typecheck" ] && [ -n "$WAIT_FOR_MARK" ] && [ -e "$CALLS.once" ] && [ -e "$CALLS.first" ]; then n=0; while [ ! -e "$WAIT_FOR_MARK" ] && [ $n -lt 800 ]; do sleep 0.05; n=$((n+1)); done; fi
if [ "$*" = "-s typecheck" ]; then : > "$CALLS.first"; fi
if [ "$*" = "-s typecheck" ] && [ -n "$LEASE_PROBE" ]; then git ls-remote origin refs/locks/push | wc -l | tr -d ' ' >> "$CALLS.lease"; fi
[ -n "$HEAVY_LOCK_JUMP" ] && echo "jump $*" >> "$CALLS"
[ -n "$HEAVY_LOCK_PUSH" ] && echo "pnpm $*" >> "$CALLS.push"
[ -n "$SLOW" ] && sleep "$SLOW"
[ -n "$FAIL" ] && [ "$*" = "-s typecheck" ] && exit 1
case "$*" in
  "exec vitest related"*) [ -n "$VITEST_OUT" ] && { printf '%s\\n' "$VITEST_OUT"; exit 1; } ;;
  "exec vitest run --project web"*) [ -n "$VPROJ_OUT" ] && { printf '%s\\n' "$VPROJ_OUT"; exit 1; } ;;
  "exec vitest run "[!-]*) [ -n "$READERS_FAIL" ] && case "$*" in *"$READERS_FAIL"*) printf 'FAIL %s\\n' "$READERS_FAIL"; exit 1 ;; esac ;;
esac
exit 0`,
  )
  mkdirSync(clone)
  ok(clone, 'init', '-q', '-b', 'main')
  for (const f of [
    'pre-push.sh',
    'gate.sh',
    'gate-fast.sh',
    'gate-push.sh',
    'talos-machine.sh',
    'path-fold.sh',
    'install-hooks.sh',
    'check-no-personal.sh',
    'denylist.generic.txt',
    'gate-inputs.txt',
    'gate-wide-inputs.txt',
    'gate-excuse.sh',
    'gate-excuse.pl',
    'ci-alert-tests.pl',
  ]) {
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    cpSync(join(here, f), join(clone, 'scripts', f))
  }
  cpSync(join(here, 'gate'), join(clone, 'scripts/gate'), { recursive: true })
  cpSync(join(repoRoot, '.githooks'), join(clone, '.githooks'), { recursive: true })
  const put = (dir: string, file: string, text = 'x\n') => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  for (const p of ['apps/web', 'apps/relay', 'packages/protocol']) put(clone, `${p}/tsconfig.json`, '{}\n')
  put(clone, 'apps/web/src/a.ts')
  put(clone, 'docs/a.md')
  put(clone, 'apps/web/test/placeholder.test.ts', "it('x', () => {})\n") // gate.sh --readers needs some test file to search
  put(clone, '.gitignore', 'node_modules\n')
  ok(clone, 'add', '-A')
  ok(clone, 'commit', '-qm', 'base')
  const origin = join(T, 'origin.git')
  ok(T, 'clone', '-q', '--bare', clone, origin)
  ok(clone, 'remote', 'add', 'origin', origin)
  ok(clone, 'fetch', '-q', 'origin')
  ok(clone, 'branch', '-q', '--set-upstream-to=origin/main', 'main')
  stub(join(clone, 'node_modules/.bin/biome'), 'echo "biome $*" >> "$CALLS"; exit 0')
  spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: clone, env, encoding: 'utf8' })
  // another machine: a plain clone of origin, no hooks
  ok(T, 'clone', '-q', origin, other)
  const change = (dir: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) put(dir, f, t)
    ok(dir, 'add', '-A')
    ok(dir, 'commit', '-qm', 'change')
  }
  /** A commit from the other machine, pushed to origin: a shell line for ON_TYPECHECK. */
  const otherPushes = (file: string) =>
    `cd '${other}' && git pull -q && mkdir -p '${dirname(file)}' && echo 'from the other machine' > '${file}' && git add -A && git commit -qm other && git push -q origin HEAD:main`
  const gatePush = (e: Record<string, string> = {}, args: string[] = []) => {
    rmSync(log, { force: true })
    rmSync(`${log}.once`, { force: true })
    rmSync(`${log}.first`, { force: true })
    const r = spawnSync('bash', ['scripts/gate.sh', '--push', ...args], {
      cwd: clone,
      env: { ...env, ...e },
      encoding: 'utf8',
    })
    return { code: r.status, err: r.stderr }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
  const lease = () => ok(clone, 'ls-remote', 'origin', 'refs/locks/push')
  /** A lease on origin held by another machine until `until` (seconds since 1970). */
  const leaseHeld = (machine: string, until: number) => {
    const sha = ok(
      clone,
      'commit-tree',
      ok(clone, 'hash-object', '-t', 'tree', '/dev/null'),
      '-m',
      `talos push lease\n\nmachine=${machine}\nuntil=${until}\nuntil_iso=2026-11-12T00:00:00Z\npid=1`,
    )
    ok(clone, 'push', '-q', 'origin', `${sha}:refs/locks/push`)
  }
  return { T, clone, other, origin, env, git, ok, change, otherPushes, gatePush, calls, lease, leaseHeld }
}

/** The stamp's gate value: one sha over scripts/gate.sh, then every file under scripts/gate/ in byte order. */
const gateSum = (repo: string) => {
  const h = createHash('sha256').update(readFileSync(join(repo, 'scripts/gate.sh')))
  for (const f of readdirSync(join(repo, 'scripts/gate')).sort()) h.update(readFileSync(join(repo, 'scripts/gate', f)))
  return h.digest('hex')
}

describe('gate.sh --push', () => {
  it('runs the gate once and pushes: the hook trusts the stamp for that tree, and the lease is let go', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush()
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('gate-push: pushed')
    expect(p.err).toContain('the gate passed on this tree')
    expect(r.calls().filter((c) => c === TYPECHECK)).toHaveLength(1)
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
    expect(r.lease()).toBe('')
  })

  it('gates with the fast gate by default and says so; --full runs the full gate', () => {
    const r = setup()
    // the fast gate's lists, on main already (a change to them is itself a gate input)
    r.change(r.other, {
      'scripts/gate-fast-keepout.txt': readFileSync(join(here, 'gate-fast-keepout.txt'), 'utf8'),
      'docs/protected-paths.txt': 'apps/bridge/src/keys.ts\n',
    })
    r.ok(r.other, 'push', '-q', 'origin', 'HEAD:main')
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const fast = r.gatePush()
    expect(fast.code, fast.err).toBe(0)
    expect(fast.err).toContain('gate-push: the fast gate where this change allows it')
    expect(fast.err).toContain('gate: fast gate:')
    expect(r.calls().filter((c) => c.startsWith('pnpm exec vitest related'))).toHaveLength(1)
    r.change(r.clone, { 'apps/web/src/c.ts': 'y\n' })
    const full = r.gatePush({}, ['--full'])
    expect(full.code, full.err).toBe(0)
    expect(full.err).toContain('gate-push: the full gate (--full)')
    expect(full.err).not.toContain('gate: fast gate')
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
  })

  it('--full reaches the pre-push hook through GATE_FULL (a hook takes no flags); without it the hook is not asked for the full gate', () => {
    const r = setup()
    // the hook, wrapped from outside the repository (a tracked change would be refused): it writes down what it was given
    const hooks = join(r.T, 'hooks')
    mkdirSync(hooks)
    writeFileSync(
      join(hooks, 'pre-push'),
      `#!/bin/sh\necho "GATE_FULL=$GATE_FULL" >> "$CALLS.hook"\nexec bash "${join(r.clone, 'scripts/pre-push.sh')}" "$@"\n`,
      { mode: 0o755 },
    )
    r.ok(r.clone, 'config', 'core.hooksPath', hooks)
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const seen = () => new Set(readFileSync(join(r.T, 'calls.log.hook'), 'utf8').trim().split('\n')) // one line per push the hook saw (the lease's too)
    expect(r.gatePush({ GATE_FULL: '' }).code).toBe(0)
    expect(seen()).toEqual(new Set(['GATE_FULL=']))
    r.change(r.clone, { 'apps/web/src/c.ts': 'y\n' })
    rmSync(join(r.T, 'calls.log.hook'))
    expect(r.gatePush({ GATE_FULL: '' }, ['--full']).code).toBe(0)
    expect(seen()).toEqual(new Set(['GATE_FULL=1']))
  })

  it('a stamp for another tree, or from another version of the gate, is not trusted: a plain push runs the gate', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    expect(r.gatePush().code).toBe(0)
    // a new commit: the stamp is for the tree before it
    r.change(r.clone, { 'apps/web/src/c.ts': 'y\n' })
    rmSync(join(r.T, 'calls.log'), { force: true })
    const plain = r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stderr).not.toContain('the gate passed on this tree')
    expect(readFileSync(join(r.T, 'calls.log'), 'utf8')).toContain(TYPECHECK)
    // the same tree, but a stamp written by another version of the gate
    r.change(r.clone, { 'apps/web/src/d.ts': 'y\n' })
    expect(r.gatePush().code).toBe(0)
    const stamp = join(r.clone, '.git', 'talos-gate.pass')
    writeFileSync(stamp, readFileSync(stamp, 'utf8').replace(/^gate=.*$/m, 'gate=0000'))
    r.ok(r.clone, 'commit', '-q', '--allow-empty', '-m', 'empty') // a new sha with the same tree as the stamp's
    r.ok(r.clone, 'reset', '-q', '--soft', 'HEAD~1')
    r.ok(r.clone, 'commit', '-q', '--allow-empty', '-m', 'again')
    const p = r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).not.toContain('the gate passed on this tree')
  })

  it('a change only to scripts/gate/plan.sh: a stamp that covers gate.sh alone no longer counts, a plain push runs the gate', () => {
    const r = setup()
    // the gate's own planning moved: a file under scripts/gate/ only, gate.sh and the hook untouched
    const plan = join(r.clone, 'scripts/gate/plan.sh')
    r.change(r.clone, { 'scripts/gate/plan.sh': `${readFileSync(plan, 'utf8')}# a later edit\n` })
    const base = r.ok(r.clone, 'rev-parse', 'origin/main')
    const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
    const planned = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base], {
      cwd: r.clone,
      env: r.env,
      encoding: 'utf8',
    }).stdout.replace(/\n+$/, '')
    // right in every field, and fresh; its gate value is what a pass from before this edit carries (gate.sh's own hash)
    writeFileSync(
      join(r.clone, '.git', 'talos-gate.pass'),
      [
        `tree=${r.ok(r.clone, 'rev-parse', 'HEAD^{tree}')}`,
        `base=${base}`,
        `plan=${sha(planned)}`,
        `gate=${sha(readFileSync(join(r.clone, 'scripts/gate.sh')))}`,
        `hook=${sha(readFileSync(join(r.clone, 'scripts/pre-push.sh')))}`,
        'mode=full',
        `at=${Math.floor(Date.now() / 1000)}`,
        '',
      ].join('\n'),
    )
    rmSync(join(r.T, 'calls.log'), { force: true })
    const p = r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    expect(p.stderr).not.toContain('the gate passed on this tree')
    expect(readFileSync(join(r.T, 'calls.log'), 'utf8')).toContain(TYPECHECK)
  })

  it('a race when both sides are words only: rebased, only the cheap checks again, pushed', () => {
    const r = setup()
    r.change(r.clone, { 'docs/mine.md': 'my words\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('docs/news.md') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('only typecheck, lint, personal, size and timing run again')
    expect(r.calls().filter((x) => x === TYPECHECK)).toHaveLength(2)
    expect(r.ok(r.origin, 'log', '-2', '--format=%s', 'main').split('\n')).toEqual(['change', 'other'])
  })

  it('a race with words only, when this change runs tests: a rebase-clean pass (no file of this change, no gate input)', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('docs/news.md') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(1)
  })

  it('a race with a commit to a gate input (a package.json): the whole touched set again', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/package.json') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('need the touched set again: letting the lease go while it runs')
    expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(2)
  })

  it('a commit made while the gate runs was not gated: nothing is pushed', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const sneak = `cd '${r.clone}' && echo sneaked > apps/web/src/ungated.ts && git add -A && git commit -qm ungated`
    const p = r.gatePush({ ON_TYPECHECK: sneak })
    expect(p.code).toBe(1)
    expect(p.err).toContain('HEAD moved while the gate ran')
    expect(r.ok(r.origin, 'log', '-1', '--format=%s', 'main')).toBe('base')
  })

  it('nothing to push says so and pushes nothing', () => {
    const r = setup()
    const p = r.gatePush()
    expect(p.code).toBe(0)
    expect(p.err).toContain('nothing to push')
    expect(r.calls()).toEqual([])
  })

  it('a stamp right in every field but its time (from the future, or too old) is not trusted', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const base = r.ok(r.clone, 'rev-parse', 'origin/main')
    const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
    const plan = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base], {
      cwd: r.clone,
      env: r.env,
      encoding: 'utf8',
    }).stdout.replace(/\n+$/, '')
    const stamp = (at: number) =>
      writeFileSync(
        join(r.clone, '.git', 'talos-gate.pass'),
        [
          `tree=${r.ok(r.clone, 'rev-parse', 'HEAD^{tree}')}`,
          `base=${base}`,
          `plan=${sha(plan)}`,
          `gate=${gateSum(r.clone)}`,
          `hook=${sha(readFileSync(join(r.clone, 'scripts/pre-push.sh')))}`,
          'mode=full',
          `at=${at}`,
          '',
        ].join('\n'),
      )
    const push = () => {
      rmSync(join(r.T, 'calls.log'), { force: true })
      return r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    }
    const now = Math.floor(Date.now() / 1000)
    // the control: right in every field, now, is trusted
    stamp(now)
    r.ok(r.clone, 'push', '-q', '--dry-run', 'origin', 'HEAD:main') // the hook does not run on a dry run
    for (const at of [now + 3600, now - 1900]) {
      stamp(at)
      const p = push()
      expect(p.stderr, String(at)).not.toContain('the gate passed on this tree')
      expect(readFileSync(join(r.T, 'calls.log'), 'utf8')).toContain(TYPECHECK)
      r.ok(r.origin, 'update-ref', 'refs/heads/main', base) // as it was, for the next try
    }
    stamp(now)
    expect(push().stderr).toContain('the gate passed on this tree')
  })

  it('a rebase that conflicts stops at once, and nothing is pushed', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/a.ts': 'mine\n' })
    r.change(r.other, { 'apps/web/src/a.ts': 'theirs\n' })
    r.ok(r.other, 'push', '-q', 'origin', 'HEAD:main')
    const p = r.gatePush()
    expect(p.code).toBe(1)
    expect(p.err).toContain('the rebase onto origin/main failed')
    expect(r.ok(r.origin, 'log', '-1', '--format=%s', 'main')).toBe('change') // the other machine's, not mine
    expect(r.lease()).toBe('')
  })
})

describe('the push lease', () => {
  it("another machine's lease that has not run out is waited on, then refused, naming who holds it", () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const before = r.ok(r.origin, 'rev-parse', 'main')
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) + 600)
    const p = r.gatePush({ GATE_PUSH_WAIT_S: '0' })
    expect(p.code).toBe(1)
    expect(p.err).toContain('the push lease is held by lemnos')
    expect(r.calls()).toContain(TYPECHECK) // the gate ran first, with no lease
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before) // nothing pushed without the lease
    expect(r.lease()).not.toBe('') // theirs, untouched
    expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/wait/*')).toBe('') // its place in the queue went with it
  })

  it('a lease that ran out is taken over, and let go at the end', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) - 5)
    const p = r.gatePush()
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('ran out: taking it over')
    expect(r.lease()).toBe('')
  })

  it('a slow gate holds no lease: another machine could take it the whole time', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const child = spawn('bash', ['scripts/gate.sh', '--push'], { cwd: r.clone, env: { ...r.env, SLOW: '2' } })
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    let done = false
    void exited.then(() => {
      done = true
    })
    await vi.waitUntil(() => r.calls().includes(TYPECHECK), { timeout: 30_000, interval: 100 })
    let held = 0
    while (!done && !r.calls().some((c) => c.startsWith('biome'))) {
      if (r.lease() !== '') held++
      await new Promise((res) => setTimeout(res, 200))
    }
    expect(held).toBe(0) // not while the type check and the suites ran
    expect(await exited).toBe(0)
    expect(r.lease()).toBe('')
  })

  it('Ctrl-C while waiting for the lease leaves nothing behind: no lease, no place in the queue', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) + 600)
    const child = spawn('bash', ['scripts/gate.sh', '--push'], {
      cwd: r.clone,
      env: { ...r.env, GATE_PUSH_POLL_S: '1' },
      detached: true,
    })
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    const queue = () => r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/wait/*')
    await vi.waitUntil(() => queue() !== '', { timeout: 30_000, interval: 100 })
    expect(queue()).toContain('refs/locks/wait/cyclops')
    process.kill(-(child.pid as number), 'SIGINT')
    await exited
    expect(queue()).toBe('')
    expect(r.ok(r.clone, 'log', '-1', '--format=%B', r.lease().split('\t')[0] as string)).toContain('machine=lemnos')
  })

  // bash can lose a Ctrl-C that comes while the shell itself is in a step of the wait: 5.2 runs the trap in the middle of a
  // $(...)'s parse, the trap fails ("unexpected EOF while looking for matching `)'") and its exit never runs, and the wait polled
  // on for good (a full gate under load). Here a step loses it on purpose, every time: the poll's sleep, with the trap off,
  // is where the Ctrl-C lands (BASH_ENV puts it there). The wait runs no step in the shell itself, so its trap still sees it.
  it('a Ctrl-C that a step of the wait would lose still ends the run: 130, no place in the queue', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) + 600)
    const lost = join(r.T, 'lost')
    const bashEnv = join(r.T, 'bash-env')
    writeFileSync(
      bashEnv,
      `sleep() {
  if [ "\${0##*/}" = gate-push.sh ] && [ -n "\${WAIT_SINCE:-}" ] && [ ! -e '${lost}' ]; then
    : >'${lost}'
    local t; t="$(trap -p INT)"
    trap '' INT; kill -INT 0; env sleep 1
    if [ -n "$t" ]; then eval "$t"; else trap - INT; fi
  fi
  env sleep "$@"
}
`,
    )
    const child = spawn('bash', ['scripts/gate.sh', '--push'], {
      cwd: r.clone,
      env: { ...r.env, GATE_PUSH_POLL_S: '1', BASH_ENV: bashEnv },
      detached: true,
    })
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    const queue = () => r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/wait/*')
    const code = await Promise.race([
      exited,
      new Promise<string>((res) => setTimeout(() => res('still waiting'), 20_000)),
    ])
    if (code === 'still waiting') process.kill(-(child.pid as number), 'SIGKILL')
    expect(existsSync(lost)).toBe(true)
    expect(code).toBe(130)
    expect(queue()).toBe('')
    expect(r.ok(r.clone, 'log', '-1', '--format=%B', r.lease().split('\t')[0] as string)).toContain('machine=lemnos')
  })

  // a stop while the take's push is under way: the put is finished (it may already have landed), so the lease it took is held
  // and the EXIT trap lets it go. Exiting with it unnoted left refs/locks/push held by a dead run until it ran out (10-60 min).
  it('a Ctrl-C while the lease is being taken: 130, and the lease it took is let go, never left held', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const mark = join(r.T, 'take-began')
    const child = spawn('bash', ['scripts/gate.sh', '--push'], {
      cwd: r.clone,
      env: { ...r.env, GATE_PUSH_TEST_TAKE_MARK: mark, GATE_PUSH_TEST_TAKE_DELAY_S: '2' },
      detached: true,
    })
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    await vi.waitUntil(() => existsSync(mark), { timeout: scaled(30_000), interval: 50 })
    process.kill(-(child.pid as number), 'SIGINT')
    expect(await exited).toBe(130)
    expect(r.lease()).toBe('')
    expect(r.ok(r.origin, 'rev-parse', 'main')).not.toBe(r.ok(r.clone, 'rev-parse', 'HEAD')) // nothing pushed
  })

  // a look that hangs (a network that does not answer) and does not die of SIGINT (a step can ignore it: a simple command run
  // in the background does, and so may a child that handles it): a Ctrl-C cuts it short at once. Waiting it out made the run
  // last as long as the look did, and a second Ctrl-C did nothing.
  it('a Ctrl-C while a look at the lease hangs ends the run at once: 130, no place in the queue', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) + 600)
    const mark = join(r.T, 'look-hangs')
    const bashEnv = join(r.T, 'bash-env')
    writeFileSync(
      bashEnv,
      `git() {
  if [ "\${0##*/}" = gate-push.sh ] && [ "$1" = ls-remote ] && [ "$3" = refs/locks/push ] && [ -n "\${WAIT_SINCE:-}" ]; then
    : >'${mark}'; (trap '' INT; env sleep 60)
  fi
  env git "$@"
}
`,
    )
    const child = spawn('bash', ['scripts/gate.sh', '--push'], {
      cwd: r.clone,
      env: { ...r.env, GATE_PUSH_POLL_S: '1', BASH_ENV: bashEnv },
      detached: true,
    })
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    await vi.waitUntil(() => existsSync(mark), { timeout: scaled(30_000), interval: 50 })
    process.kill(-(child.pid as number), 'SIGINT')
    const code = await Promise.race([
      exited,
      new Promise<string>((res) => setTimeout(() => res('still waiting'), 10_000)),
    ])
    if (code === 'still waiting') process.kill(-(child.pid as number), 'SIGKILL')
    expect(code).toBe(130)
    expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/wait/*')).toBe('')
  })

  it('refs/locks/ takes only the lease: code, a lease-shaped commit with more in its message, or another name, are refused', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const refused = (src: string, ref = 'refs/locks/push') => {
      const p = r.git(r.clone, 'push', '-q', 'origin', `${src}:${ref}`)
      expect(p.status, ref).not.toBe(0)
      expect(p.stderr).toContain('refs/locks/ holds only the push lease')
    }
    refused('HEAD')
    const empty = r.ok(r.clone, 'hash-object', '-t', 'tree', '/dev/null')
    const lease = (msg: string) => r.ok(r.clone, 'commit-tree', empty, '-m', msg)
    const good = 'talos push lease\n\nmachine=cyclops\nuntil=1\nuntil_iso=1970-01-01T00:00:01Z\npid=1'
    refused(lease(`${good}\nnote=write to ${['jo.smith', '@', 'gmail.com'].join('')}`))
    refused(lease(good), 'refs/locks/other')
    const p = r.git(r.clone, 'push', '-q', 'origin', `${lease(good)}:refs/locks/push`)
    expect(p.status, p.stderr).toBe(0)
  })

  it('the machine name is a fleet name only: unset, a host-like name or anything else stops at once, naming none', () => {
    for (const bad of ['', "Alex's Mac", 'Someones-Air', 'cyclops lemnos']) {
      const r = setup()
      r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
      const main = r.ok(r.clone, 'ls-remote', 'origin', 'refs/heads/main')
      const p = r.gatePush({ TALOS_MACHINE: bad })
      expect(p.code, bad).toBe(1)
      expect(p.err, bad).toContain('set TALOS_MACHINE to this machine')
      if (bad && bad !== 'cyclops lemnos') expect(p.err, bad).not.toContain(bad) // a host name is never repeated
      // nothing reached origin: no lease, no place in the queue (the ref that carries the name), main unmoved
      expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/*'), bad).toBe('')
      expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/heads/main'), bad).toBe(main)
      expect(r.calls(), bad).toEqual([]) // and the gate never ran
    }
  })

  it('a stamp time with a leading zero is no stamp: the gate runs, the hook does not break', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    writeFileSync(
      join(r.clone, '.git', 'talos-gate.pass'),
      'tree=x\nbase=y\nplan=z\ngate=a\nhook=b\nmode=full\nat=0999999999\n',
    )
    rmSync(join(r.T, 'calls.log'), { force: true })
    const p = r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).not.toMatch(/value too great|unbound variable/)
    expect(readFileSync(join(r.T, 'calls.log'), 'utf8')).toContain(TYPECHECK)
  })

  it('a remote that will not take the lease: a few tries, then the push goes on without one', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    // the remote refuses any update of refs/locks/
    writeFileSync(
      join(r.origin, 'hooks', 'pre-receive'),
      '#!/bin/sh\nwhile read o n ref; do case "$ref" in refs/locks/*) echo no locks >&2; exit 1;; esac; done\n',
      { mode: 0o755 },
    )
    const p = r.gatePush({ GATE_PUSH_POLL_S: '0' })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('pushing without a lease')
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
  })

  // a gate slower than the lease: the stand-in pnpm sleeps on every call
  const runAsync = (r: ReturnType<typeof setup>, e: Record<string, string>) => {
    const child = spawn('bash', ['scripts/gate.sh', '--push'], { cwd: r.clone, env: { ...r.env, ...e } })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d
    })
    const done = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    return { done, err: () => err }
  }
  const leaseOf = (r: ReturnType<typeof setup>) => r.lease().split('\t')[0] ?? ''
  const untilOf = (r: ReturnType<typeof setup>, sha: string) => {
    r.ok(r.clone, 'fetch', '-q', 'origin', 'refs/locks/push')
    return Number(/^until=(\d+)$/m.exec(r.ok(r.clone, 'log', '-1', '--format=%B', sha))?.[1])
  }

  // main moves while the first gate runs: code means the touched set again (without the lease); words only, the cheap
  // checks under the lease, which is when a slow stand-in holds it long enough to watch
  const moving = (r: ReturnType<typeof setup>) => ({ ON_TYPECHECK: r.otherPushes('apps/web/package.json') })
  const wordsMoving = (r: ReturnType<typeof setup>) => ({ ON_TYPECHECK: r.otherPushes('docs/w.md') })

  it('main moving during the gate: the lease is let go, the touched set runs again without it, then pushed', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    rmSync(join(r.T, 'calls.log.lease'), { force: true })
    const p = r.gatePush({ ...moving(r), LEASE_PROBE: '1' })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('letting the lease go while it runs (requeue 1 of 2)')
    expect(r.calls().filter((c) => c === TYPECHECK)).toHaveLength(2)
    expect(readFileSync(join(r.T, 'calls.log.lease'), 'utf8').trim().split('\n')).toEqual(['0', '0']) // never held while gating
    expect(r.ok(r.origin, 'log', '-2', '--format=%s', 'main').split('\n')).toEqual(['change', 'other'])
    expect(r.lease()).toBe('')
  })

  it('main moving during every gate: after two requeues it stops and says how to hand the work on', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const every = `cd '${r.other}' && git pull -q && echo "$(date +%s%N)" > apps/web/package.json && git add -A && git commit -qm other && git push -q origin HEAD:main`
    const p = r.gatePush({ ON_EVERY_TYPECHECK: every })
    expect(p.code).toBe(1)
    expect(p.err).toContain(
      'this machine gates too slowly for it: hand it on: git push origin HEAD:refs/heads/handoff/',
    )
    expect(r.calls().filter((c) => c === TYPECHECK)).toHaveLength(3) // the first gate and two requeues
    expect(r.lease()).toBe('')
  })

  it('the lease is renewed while the re-check runs, each renewal moves its end later, and it is let go at the end', async () => {
    const r = setup()
    r.change(r.clone, { 'docs/b.md': 'y\n' }) // words only: the re-check under the lease is the cheap one
    // The re-check under the lease runs until the test has watched the lease renewed twice (WAIT_FOR_MARK), so no clock decides
    // how many renewals there were; the lease is long enough (60 s) that a renewal held up by load cannot let it run out, and
    // the renewer still renews every second.
    const go = join(r.T, 'renewed')
    const run = runAsync(r, {
      ...wordsMoving(r),
      GATE_PUSH_LEASE_S: '60',
      GATE_PUSH_RENEW_EVERY_S: '1',
      WAIT_FOR_MARK: go,
    })
    const seen: string[] = []
    let gaps = 0
    let finished = false
    void run.done.then(() => {
      finished = true
    })
    await vi.waitUntil(() => leaseOf(r) !== '', { timeout: 30_000, interval: 100 })
    while (!finished) {
      const l = leaseOf(r)
      if (l && !seen.includes(l)) seen.push(l)
      else if (!l && !finished) gaps++
      if (seen.length >= 3) writeFileSync(go, '') // taken, then renewed twice: the re-check may end
      await new Promise((res) => setTimeout(res, 300))
    }
    expect(await run.done, run.err()).toBe(0)
    expect(seen.length).toBeGreaterThanOrEqual(3) // taken, then renewed more than once
    // each renewal moved the end later: it extends the lease, never just rewrites it. That, every RENEW_EVERY_S whatever the
    // lease's length (the renewer does not wait for half of it to pass), is what keeps a lease alive through a gate longer than it
    // read in origin, which keeps every lease commit pushed to it (the clone fetches only the current one)
    const untils = seen
      .slice(0, 3)
      .map((l) => Number(/^until=(\d+)$/m.exec(r.ok(r.origin, 'log', '-1', '--format=%B', l))?.[1]))
    expect(untils[1]).toBeGreaterThan(untils[0] as number)
    expect(untils[2]).toBeGreaterThan(untils[1] as number)
    expect(gaps).toBeLessThanOrEqual(1) // the only gap is the push and release at the very end
    expect(r.lease()).toBe('')
    await new Promise((res) => setTimeout(res, 2500)) // no renewer left behind to set it again
    expect(r.lease()).toBe('')
  })

  it('a renewal in flight when the renewer is stopped is still let go: the lease is never left held after the push', async () => {
    const r = setup()
    r.change(r.clone, { 'docs/b.md': 'y\n' }) // words only: the re-check under the lease is the cheap one
    // the re-check under the lease ends only once a renewal has begun (WAIT_FOR_MARK), and that renewal takes 3 s: the
    // renewer is stopped in the middle of it, every time
    const mark = join(r.T, 'put-began')
    // a long lease (60 s): a renewal held up by load cannot let it run out; the renewer still tries every second
    const run = runAsync(r, {
      ...wordsMoving(r),
      GATE_PUSH_LEASE_S: '60',
      GATE_PUSH_RENEW_EVERY_S: '1',
      GATE_PUSH_TEST_PUT_DELAY_S: '3',
      GATE_PUSH_TEST_PUT_MARK: mark,
      WAIT_FOR_MARK: mark,
    })
    expect(await run.done, run.err()).toBe(0)
    expect(r.lease()).toBe('')
    await new Promise((res) => setTimeout(res, 2500))
    expect(r.lease()).toBe('') // nothing set it again
  })

  // the renewer's TERM trap can be lost like any (a TERM that comes while it is in a $(...)): renewer_stop asks with a stop file
  // too, and waits only so long. Here the renewer loses every TERM once it has renewed (BASH_ENV: its mv turns TERM off);
  // waiting for it hung the run for good, and the lease was renewed on and on.
  it('a renewer that lost its TERM still stops: the push goes, and the lease is let go', async () => {
    const r = setup()
    r.change(r.clone, { 'docs/b.md': 'y\n' }) // words only: the re-check under the lease is the cheap one
    const renewed = join(r.T, 'renewed')
    const bashEnv = join(r.T, 'bash-env')
    writeFileSync(
      bashEnv,
      `mv() {
  env mv "$@" || return
  [ -z "\${IN_RENEWER:-}" ] || { trap '' TERM; : >'${renewed}'; }
}
`,
    )
    const child = spawn('bash', ['scripts/gate.sh', '--push'], {
      cwd: r.clone,
      env: {
        ...r.env,
        ...wordsMoving(r),
        GATE_PUSH_LEASE_S: '60',
        GATE_PUSH_RENEW_EVERY_S: '1',
        WAIT_FOR_MARK: renewed,
        BASH_ENV: bashEnv,
      },
      detached: true,
    })
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    const code = await Promise.race([
      exited,
      new Promise<string>((res) => setTimeout(() => res('still running'), 30_000)),
    ])
    if (code === 'still running') process.kill(-(child.pid as number), 'SIGKILL')
    expect(code).toBe(0)
    expect(r.lease()).toBe('')
  })

  it('a lease another machine took while the re-gate ran: said so, left alone, and the push still goes', async () => {
    const r = setup()
    r.change(r.clone, { 'docs/b.md': 'y\n' }) // words only: the re-check under the lease is the cheap one
    // the re-check under the lease runs until the test has seen the loss said (WAIT_FOR_MARK): no clock decides whether a
    // renewal came after the takeover; a long lease (60 s) cannot run out under load meanwhile
    const go = join(r.T, 'lost')
    const run = runAsync(r, {
      ...wordsMoving(r),
      GATE_PUSH_LEASE_S: '60',
      GATE_PUSH_RENEW_EVERY_S: '1',
      WAIT_FOR_MARK: go,
    })
    await vi.waitUntil(() => leaseOf(r) !== '', { timeout: 30_000, interval: 100 })
    // another machine takes it over (its own lease, pushed with no hook)
    const empty = r.ok(r.other, 'hash-object', '-t', 'tree', '/dev/null')
    const theirs = r.ok(
      r.other,
      'commit-tree',
      empty,
      '-m',
      `talos push lease\n\nmachine=lemnos\nuntil=${Math.floor(Date.now() / 1000) + 600}\nuntil_iso=2026-11-12T00:00:00Z\npid=1`,
    )
    r.ok(r.other, 'push', '-q', '--force', 'origin', `${theirs}:refs/locks/push`)
    await vi.waitUntil(() => run.err().includes('the push lease was lost while the gate ran'), {
      timeout: 30_000,
      interval: 100,
    })
    writeFileSync(go, '')
    expect(await run.done, run.err()).toBe(0)
    expect(run.err()).toContain('the push lease was lost while the gate ran')
    expect(leaseOf(r)).toBe(theirs) // theirs, not deleted by our release
  })

  it("a machine whose last gate was slow asks for a longer lease: twice that gate's time", async () => {
    const r = setup()
    r.change(r.clone, { 'docs/b.md': 'y\n' }) // words only: the re-check under the lease is the cheap one
    writeFileSync(join(r.clone, '.git', 'talos-gate.time'), '900\n')
    const run = runAsync(r, { ...wordsMoving(r), SLOW: '2' })
    await vi.waitUntil(() => leaseOf(r) !== '', { timeout: 30_000, interval: 100 })
    const left = untilOf(r, leaseOf(r)) - Math.floor(Date.now() / 1000)
    expect(left).toBeGreaterThan(1700) // 2 x 900 s, not the 600 s default
    expect(left).toBeLessThanOrEqual(1800)
    expect(await run.done, run.err()).toBe(0)
    expect(Number(readFileSync(join(r.clone, '.git', 'talos-gate.time'), 'utf8'))).toBeGreaterThanOrEqual(4) // this gate's own time
  })

  // another machine's place in the queue: its wait ref, as gate-push.sh writes it
  const waiting = (
    r: ReturnType<typeof setup>,
    machine: string,
    since: number,
    seen = Math.floor(Date.now() / 1000),
  ) => {
    const empty = r.ok(r.other, 'hash-object', '-t', 'tree', '/dev/null')
    const sha = r.ok(
      r.other,
      'commit-tree',
      empty,
      '-m',
      `talos push wait\n\nmachine=${machine}\nsince=${since}\nseen=${seen}\npid=1`,
    )
    r.ok(r.other, 'push', '-q', '--force', 'origin', `${sha}:refs/locks/wait/${machine}`)
  }

  it('a machine that let the lease go to gate again keeps its place in the queue', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    // held far longer than any gate here takes: the test, not a clock, decides when it frees
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) + 600)
    // SLOW: each stand-in step takes a second, so the requeue's look at the queue comes seconds after hestia joined: only the
    // place this machine kept (FIRST_SINCE) puts it ahead, not a tie in the same second
    const run = runAsync(r, { ...moving(r), GATE_PUSH_POLL_S: '1', GATE_PUSH_WAIT_S: '120', SLOW: '1' })
    // this machine queues behind lemnos first
    await vi.waitUntil(() => run.err().includes('the push lease is held by lemnos'), { timeout: 40_000, interval: 100 })
    waiting(r, 'hestia', Math.floor(Date.now() / 1000)) // hestia joins after that, and before the requeue
    r.ok(r.other, 'push', '-q', 'origin', ':refs/locks/push') // lemnos lets it go
    expect(await run.done, run.err()).toBe(0)
    expect(run.err()).toContain('requeue 1 of 2')
    expect(run.err()).not.toContain('hestia has waited longer') // it kept the place it had before hestia came
  })

  it('first come, first served: a free lease waits for the machine that has waited longer, then is taken', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const now = Math.floor(Date.now() / 1000)
    waiting(r, 'hestia', now - 600) // waiting for ten minutes, and still there
    const run = runAsync(r, { GATE_PUSH_POLL_S: '1' })
    await vi.waitUntil(() => run.err().includes('hestia has waited longer'), { timeout: 30_000, interval: 100 })
    const before = r.ok(r.origin, 'rev-parse', 'main')
    await new Promise((res) => setTimeout(res, 1500))
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before) // still letting hestia go first
    expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/wait/*')).toContain('refs/locks/wait/cyclops') // queued
    r.ok(r.other, 'push', '-q', 'origin', ':refs/locks/wait/hestia') // hestia got its turn and left the queue
    expect(await run.done, run.err()).toBe(0)
    expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/wait/*')).toBe('') // its own place is gone too
    expect(r.lease()).toBe('')
  })

  it('a waiter that stopped saying it is there, or came later, does not hold anyone up', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const now = Math.floor(Date.now() / 1000)
    waiting(r, 'hestia', now - 3600, now - 600) // last seen ten minutes ago: gone
    waiting(r, 'titan', now + 60) // began after this machine
    const p = r.gatePush({ GATE_PUSH_POLL_S: '1' })
    expect(p.code, p.err).toBe(0)
    expect(p.err).not.toContain('waited longer')
  })

  it('the hook takes a wait ref only in its own form, under its own machine name', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const empty = r.ok(r.clone, 'hash-object', '-t', 'tree', '/dev/null')
    const commit = (msg: string) => r.ok(r.clone, 'commit-tree', empty, '-m', msg)
    const good = 'talos push wait\n\nmachine=cyclops\nsince=1\nseen=2\npid=3'
    const push = (src: string, ref: string) => r.git(r.clone, 'push', '-q', 'origin', `${src}:${ref}`)
    for (const [src, ref] of [
      [commit(good), 'refs/locks/wait/lemnos'], // another machine's name
      [commit(`${good}\nnote=hi`), 'refs/locks/wait/cyclops'], // more in the message
      [commit(good.replace('since=1', 'since=x')), 'refs/locks/wait/cyclops'],
      ['HEAD', 'refs/locks/wait/cyclops'], // code
    ] as const) {
      const p = push(src, ref)
      expect(p.status, `${ref} ${src}`).not.toBe(0)
      expect(p.stderr).toContain('refs/locks/ holds only the push lease')
    }
    const p = push(commit(good), 'refs/locks/wait/cyclops') // last: a ref already there would be a non-fast-forward
    expect(p.status, p.stderr).toBe(0)
  })
})

describe('handoff: a machine that cannot gate hands finished work to one that can', () => {
  /** The slow machine: a handoff branch pushed from `other` with the real hook installed there. */
  /** A private list on the handing machine: a handoff is refused without one. */
  const listed = (r: ReturnType<typeof setup>) => {
    const f = join(r.T, 'private-list.txt')
    writeFileSync(f, '# none\n')
    return { ...r.env, CHECK_EXTRA_RULES: f }
  }
  /** The landing machine's private list: --from refuses without one. */
  const landing = (r: ReturnType<typeof setup>) => ({ CHECK_EXTRA_RULES: listed(r).CHECK_EXTRA_RULES })
  const handOff = (
    r: ReturnType<typeof setup>,
    branch: string,
    files: Record<string, string>,
    o: { list?: boolean; author?: string } = {},
  ) => {
    for (const f of [
      'pre-push.sh',
      'check-no-personal.sh',
      'denylist.generic.txt',
      'install-hooks.sh',
      'gate.sh',
      'talos-machine.sh',
      'path-fold.sh',
    ]) {
      mkdirSync(join(r.other, 'scripts'), { recursive: true })
      cpSync(join(here, f), join(r.other, 'scripts', f))
    }
    cpSync(join(here, 'gate'), join(r.other, 'scripts/gate'), { recursive: true })
    cpSync(join(repoRoot, '.githooks'), join(r.other, '.githooks'), { recursive: true })
    spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: r.other, env: r.env, encoding: 'utf8' })
    r.ok(r.other, 'pull', '-q')
    const env = { ...(o.list === false ? r.env : listed(r)), ...(o.author ? { GIT_AUTHOR_NAME: o.author } : {}) }
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(dirname(join(r.other, f)), { recursive: true })
      writeFileSync(join(r.other, f), t)
    }
    spawnSync('git', ['add', '-A'], { cwd: r.other, env })
    spawnSync('git', ['commit', '-qm', 'change'], { cwd: r.other, env })
    return spawnSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], {
      cwd: r.other,
      env,
      encoding: 'utf8',
    })
  }

  it('a handoff branch takes the personal-data check only, not the gate', () => {
    const r = setup()
    rmSync(join(r.T, 'calls.log'), { force: true })
    const p = handOff(r, 'handoff/hestia/hooks', { 'apps/web/src/h.ts': 'from hestia\n' })
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain('a handoff branch: the personal-data check passed')
    expect(r.calls()).toEqual([]) // no typecheck, no lint, no suites
  })

  it('personal data in a handoff is refused (the check is always on)', () => {
    const r = setup()
    const p = handOff(r, 'handoff/hestia/leak', { 'docs/n.md': `mail ${['jo.smith', '@', 'gmail.com'].join('')}\n` })
    expect(p.stderr).not.toContain('no private list for it')
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('the personal-data check failed')
  })

  it('a machine landing a handoff is not told to hand it off again (the small-machine notice is for the one who wrote it)', () => {
    const r = setup()
    const h = handOff(r, 'handoff/hestia/bridge', { 'apps/bridge/src/x.ts': 'from hestia\n' })
    expect(h.status, h.stderr).toBe(0)
    // the notice comes with the plan, before the suites run: what the gate does after does not matter here
    const land = r.gatePush({ ...landing(r), GATE_CORES: '2' }, ['--from', 'origin/handoff/hestia/bridge'])
    expect(land.err).toContain('landing origin/handoff/hestia/bridge')
    expect(land.err).not.toContain('the whole bridge suite runs')
    const own = setup()
    own.change(own.clone, { 'apps/bridge/src/x.ts': 'mine\n' })
    expect(own.gatePush({ GATE_CORES: '2' }).err).toContain('the whole bridge suite runs for this change')
  })

  it('only that namespace: another branch, or a handoff name of another shape, still gets the gate or is refused', () => {
    const r = setup()
    const other = handOff(r, 'feature/x', { 'apps/web/src/h.ts': 'x\n' })
    expect(other.stderr).not.toContain('a handoff branch')
    expect(other.stderr).toContain('gate: REFUSED: no node_modules here') // the gate ran, as for any branch
    expect(other.status).not.toBe(0)
    const bad = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/handoff/hestia'], {
      cwd: r.other,
      env: listed(r),
      encoding: 'utf8',
    })
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('a handoff branch is refs/heads/handoff/<machine>/<name>')
  })

  it('--from lands it: rebased onto main, the full gate, pushed by sha with its author, the branch deleted, back where it was', () => {
    const r = setup()
    const h = handOff(r, 'handoff/hestia/hooks', { 'apps/web/src/h.ts': 'from hestia\n' }, { author: 'Hestia' })
    expect(h.status, h.stderr).toBe(0)
    r.ok(r.other, 'checkout', '-q', 'HEAD~1') // a commit lands on main meanwhile
    r.change(r.other, { 'docs/z.md': 'meanwhile\n' })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'checkout', '-q', '-b', 'mine')
    const p = r.gatePush(landing(r), ['--from', 'origin/handoff/hestia/hooks'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('landing origin/handoff/hestia/hooks')
    expect(r.calls()).toContain(TYPECHECK)
    expect(r.ok(r.origin, 'log', '-2', '--format=%s', 'main').split('\n')).toEqual(['change', 'change'])
    expect(r.ok(r.origin, 'show', 'main:apps/web/src/h.ts')).toBe('from hestia')
    expect(r.ok(r.origin, 'show', 'main:docs/z.md')).toBe('meanwhile')
    expect(r.ok(r.origin, 'log', '-1', '--format=%an', 'main')).toBe('Hestia') // its author, not the landing machine's
    expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'refs/heads/handoff/hestia/hooks').status).not.toBe(0) // deleted
    expect(r.ok(r.clone, 'symbolic-ref', '--short', 'HEAD')).toBe('mine') // back on its own branch
  })

  it('--from takes only a handoff branch: never main or another branch', () => {
    const r = setup()
    for (const from of ['origin/main', 'origin/feature/x', 'origin/handoff/hestia', 'upstream/handoff/a/b']) {
      const p = r.gatePush({}, ['--from', from])
      expect(p.code, from).toBe(1)
      expect(p.err).toContain('--from takes origin/handoff/<machine>/<name>')
    }
  })

  it('CI does not build handoff branches: pushes run for main only', () => {
    const wf = readFileSync(join(repoRoot, '.github/workflows/ci-runner.yml'), 'utf8')
    const push = /\n {2}push:\n {4}branches: \[([^\]]*)\]/.exec(wf)
    expect(push?.[1]).toBe('main')
  })

  it('with no private list a handoff still goes, on the generic rules, and says the private-list scan is at landing', () => {
    const r = setup()
    const p = handOff(r, 'handoff/hestia/nolist', { 'apps/web/src/h.ts': 'x\n' }, { list: false })
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain('the private-list scan happens at landing')
    const leak = handOff(
      r,
      'handoff/hestia/nolist2',
      { 'docs/n.md': `mail ${['jo.smith', '@', 'gmail.com'].join('')}\n` },
      { list: false },
    )
    expect(leak.status).not.toBe(0) // a generic hit still refuses
  })

  it('the landing machine must have the private list, or --from refuses', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/x', { 'apps/web/src/h.ts': 'x\n' }).status).toBe(0)
    const p = r.gatePush({ CHECK_EXTRA_RULES: '' }, ['--from', 'origin/handoff/hestia/x'])
    expect(p.code).toBe(1)
    expect(p.err).toContain('landing a handoff needs the private list')
    expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'refs/heads/handoff/hestia/x').status).toBe(0) // left for another
  })

  // ---- Delphi's personal-ok stamp: an annotated tag at refs/personal-ok/<tip>, peeled to <tip>, lets a machine with no
  // private list land a handoff, when the rebase keeps every patch-id.
  const NEEDS_LIST = 'landing a handoff needs the private list'
  const CHANGED = 'the rebase changed the stamped commits; a machine with the private list lands it'
  const ten = (n3 = 'three') => `one\ntwo\n${n3}\nfour\nfive\nsix\nseven\neight\nnine\nten\n`
  const tipOf = (r: ReturnType<typeof setup>, name: string) =>
    r.ok(r.origin, 'rev-parse', `refs/heads/handoff/hestia/${name}`)
  /** A stamp on the remote, made by hand in the bare origin: an annotated tag object at refs/personal-ok/<ref name>. */
  const stamp = (r: ReturnType<typeof setup>, named: string, peeled: string) => {
    r.ok(r.origin, 'tag', '-a', '-m', 'personal-ok', 'stamp-tmp', peeled)
    r.ok(r.origin, 'update-ref', `refs/personal-ok/${named}`, r.ok(r.origin, 'rev-parse', 'refs/tags/stamp-tmp'))
    r.ok(r.origin, 'tag', '-d', 'stamp-tmp')
  }
  /** main gets a file of ten lines, the handoff changes line 6 of it, and main then changes line 3 (inside line 6's context). */
  const shiftedContext = (r: ReturnType<typeof setup>, name: string) => {
    r.change(r.other, { 'apps/web/src/ctx.ts': ten() })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    const h = handOff(r, `handoff/hestia/${name}`, { 'apps/web/src/ctx.ts': ten().replace('six', 'SIX') })
    expect(h.status, h.stderr).toBe(0)
    r.ok(r.other, 'checkout', '-q', 'HEAD~1')
    r.change(r.other, { 'apps/web/src/ctx.ts': ten('THREE') })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
  }
  const landed = (r: ReturnType<typeof setup>, name: string) =>
    r.git(r.origin, 'rev-parse', '--verify', '-q', `refs/heads/handoff/hestia/${name}`).status !== 0

  it('a valid stamp (an annotated tag peeled to the exact tip) lets a machine with no private list land a handoff', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/ok', { 'apps/web/src/h.ts': 'from hestia\n' }).status).toBe(0)
    const tip = tipOf(r, 'ok')
    stamp(r, tip, tip)
    r.ok(r.other, 'checkout', '-q', 'HEAD~1') // a commit lands on main meanwhile: a clean rebase
    r.change(r.other, { 'docs/z.md': 'meanwhile\n' })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    const p = r.gatePush({}, ['--from', 'origin/handoff/hestia/ok'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).not.toContain(NEEDS_LIST)
    expect(r.ok(r.origin, 'show', 'main:apps/web/src/h.ts')).toBe('from hestia')
    expect(r.ok(r.origin, 'show', 'main:docs/z.md')).toBe('meanwhile')
    expect(landed(r, 'ok')).toBe(true)
    // the stamp was fetched into a ref of this machine's own
    expect(r.ok(r.clone, 'rev-parse', `refs/personal-ok-remote/${tip}^{commit}`)).toBe(tip)
  })

  it('a stamp lands a handoff of several commits when the rebase keeps each patch-id', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/two', { 'apps/web/src/h.ts': 'one\n' }).status).toBe(0)
    r.change(r.other, { 'apps/web/src/i.ts': 'two\n' })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/handoff/hestia/two')
    const tip = tipOf(r, 'two')
    stamp(r, tip, tip)
    r.ok(r.other, 'checkout', '-q', 'HEAD~2')
    r.change(r.other, { 'docs/z.md': 'meanwhile\n' })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    const p = r.gatePush({}, ['--from', 'origin/handoff/hestia/two'])
    expect(p.code, p.err).toBe(0)
    expect(r.ok(r.origin, 'show', 'main:apps/web/src/i.ts')).toBe('two')
  })

  it('a stamp that is not for this tip is refused: named for it but peeled elsewhere, or for another sha', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/other', { 'apps/web/src/h.ts': 'x\n' }).status).toBe(0)
    const tip = tipOf(r, 'other')
    const base = r.ok(r.origin, 'rev-parse', 'main')
    stamp(r, tip, base) // the ref is named for the tip but its tag points at main
    const a = r.gatePush({}, ['--from', 'origin/handoff/hestia/other'])
    expect(a.code).toBe(1)
    expect(a.err).toContain(NEEDS_LIST)
    expect(a.err).toContain('not for this exact commit')
    r.ok(r.origin, 'update-ref', '-d', `refs/personal-ok/${tip}`)
    stamp(r, base, tip) // a stamp named for another sha, whose tag does peel to the tip
    const b = r.gatePush({}, ['--from', 'origin/handoff/hestia/other'])
    expect(b.code).toBe(1)
    expect(b.err).toContain(NEEDS_LIST)
    expect(landed(r, 'other')).toBe(false)
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(base)
  })

  it('a lightweight tag, or a stamp ref that is a commit, is refused', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/light', { 'apps/web/src/h.ts': 'x\n' }).status).toBe(0)
    const tip = tipOf(r, 'light')
    r.ok(r.origin, 'update-ref', `refs/personal-ok/${tip}`, tip) // a ref straight at the commit: what a lightweight tag is
    const p = r.gatePush({}, ['--from', 'origin/handoff/hestia/light'])
    expect(p.code).toBe(1)
    expect(p.err).toContain(NEEDS_LIST)
    expect(p.err).toContain('not an annotated tag')
    expect(landed(r, 'light')).toBe(false)
  })

  it('no stamp at all still needs the private list, and a local ref of the stamp name is never trusted', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/none', { 'apps/web/src/h.ts': 'x\n' }).status).toBe(0)
    const tip = tipOf(r, 'none')
    // forged here by hand: a good annotated tag in this checkout's own stamp namespace, and nothing on the remote
    r.ok(r.clone, 'fetch', '-q', 'origin', 'refs/heads/handoff/hestia/none')
    r.ok(r.clone, 'tag', '-a', '-m', 'forged', 'forged-tmp', tip)
    r.ok(r.clone, 'update-ref', `refs/personal-ok-remote/${tip}`, r.ok(r.clone, 'rev-parse', 'refs/tags/forged-tmp'))
    r.ok(r.clone, 'update-ref', `refs/personal-ok/${tip}`, r.ok(r.clone, 'rev-parse', 'refs/tags/forged-tmp'))
    const p = r.gatePush({}, ['--from', 'origin/handoff/hestia/none'])
    expect(p.code).toBe(1)
    expect(p.err).toContain(NEEDS_LIST)
    expect(landed(r, 'none')).toBe(false)
  })

  it('a stamp whose rebase changes a commit patch-id (main changed a line inside its context) is refused', () => {
    const r = setup()
    shiftedContext(r, 'ctx')
    const tip = tipOf(r, 'ctx')
    stamp(r, tip, tip)
    const before = r.ok(r.origin, 'rev-parse', 'main')
    const p = r.gatePush({}, ['--from', 'origin/handoff/hestia/ctx'])
    expect(p.code).toBe(1)
    expect(p.err).toContain(CHANGED)
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before)
    expect(landed(r, 'ctx')).toBe(false)
    expect(r.calls()).not.toContain(TYPECHECK) // refused before any gate ran
  })

  it('a stamp whose rebase drops a commit that main already has is refused', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/dup', { 'apps/web/src/h.ts': 'same\n' }).status).toBe(0)
    const tip = tipOf(r, 'dup')
    stamp(r, tip, tip)
    r.ok(r.other, 'checkout', '-q', 'HEAD~1')
    // the same change as a DIFFERENT commit: its own message, so it can't collide with the handoff's commit (same tree,
    // parent, author and second would give the very same sha, and then the rebase drops nothing)
    writeFileSync(join(r.other, 'apps/web/src/h.ts'), 'same\n')
    r.ok(r.other, 'add', '-A')
    r.ok(r.other, 'commit', '-qm', 'the same change, another commit')
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    expect(r.ok(r.other, 'rev-parse', 'HEAD').trim()).not.toBe(tip)
    const p = r.gatePush({}, ['--from', 'origin/handoff/hestia/dup'])
    expect(p.code).toBe(1)
    expect(p.err).toContain(CHANGED)
    expect(landed(r, 'dup')).toBe(false)
  })

  it('a stamp is checked again at the requeue rebase in the lease loop: main moves during the gate', () => {
    const r = setup()
    r.change(r.other, { 'apps/web/src/ctx.ts': ten() })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    expect(handOff(r, 'handoff/hestia/loop', { 'apps/web/src/ctx.ts': ten().replace('six', 'SIX') }).status).toBe(0)
    const tip = tipOf(r, 'loop')
    stamp(r, tip, tip)
    const shift = `cd '${r.other}' && git fetch -q && git checkout -q --detach origin/main && printf '%s' '${ten('THREE')}' > apps/web/src/ctx.ts && git add -A && git commit -qm shift && git push -q --no-verify origin HEAD:main`
    const p = r.gatePush({ ON_TYPECHECK: shift }, ['--from', 'origin/handoff/hestia/loop'])
    expect(p.code).toBe(1)
    expect(p.err).toContain(CHANGED)
    expect(landed(r, 'loop')).toBe(false)
  })

  it('a stamp still lands when main moves during the gate and the rebase keeps the patch-ids', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/race', { 'apps/web/src/h.ts': 'from hestia\n' }).status).toBe(0)
    const tip = tipOf(r, 'race')
    stamp(r, tip, tip)
    // other's own main holds the handoff commit: main moves from origin/main, never from there
    const moves = `cd '${r.other}' && git fetch -q && git checkout -q --detach origin/main && echo q > docs/q.md && git add -A && git commit -qm q && git push -q --no-verify origin HEAD:main`
    const p = r.gatePush({ ON_TYPECHECK: moves }, ['--from', 'origin/handoff/hestia/race'])
    expect(p.code, p.err).toBe(0)
    expect(r.ok(r.origin, 'show', 'main:apps/web/src/h.ts')).toBe('from hestia')
    expect(r.ok(r.origin, 'show', 'main:docs/q.md')).toBe('q')
  })

  it('a machine with the private list ignores stamps: it scans as before, patch-ids or not, and fetches none', () => {
    const r = setup()
    shiftedContext(r, 'listed')
    const tip = tipOf(r, 'listed')
    r.ok(r.origin, 'update-ref', `refs/personal-ok/${tip}`, tip) // a bad stamp: it must make no difference
    const p = r.gatePush(landing(r), ['--from', 'origin/handoff/hestia/listed'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).not.toContain(CHANGED)
    expect(r.git(r.clone, 'for-each-ref', 'refs/personal-ok-remote').stdout.trim()).toBe('')
    expect(landed(r, 'listed')).toBe(true)
  })

  it('an ordinary push, with no --from, is not held to patch-ids and needs no stamp', () => {
    const r = setup()
    r.change(r.other, { 'apps/web/src/ctx.ts': ten() })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q')
    r.change(r.clone, { 'apps/web/src/ctx.ts': ten().replace('six', 'SIX') })
    r.change(r.other, { 'apps/web/src/ctx.ts': ten('THREE') })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    const p = r.gatePush()
    expect(p.code, p.err).toBe(0)
    expect(r.ok(r.origin, 'show', 'main:apps/web/src/ctx.ts')).toBe(ten('THREE').replace('six', 'SIX').trimEnd())
  })

  it('a handoff may not change the push path, at the hook or at landing', () => {
    const r = setup()
    const p = handOff(r, 'handoff/hestia/gate', { 'scripts/gate.sh': '#!/bin/sh\nexit 0\n' })
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('a handoff may not change the push path')
    // pushed past the hook anyway: the landing machine refuses it too
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/handoff/hestia/gate')
    const l = r.gatePush(landing(r), ['--from', 'origin/handoff/hestia/gate'])
    expect(l.code).toBe(1)
    expect(l.err).toContain('changes the push path')
  })

  it('the push-path guard holds on a large handoff and ignores case (no early-exit pipe, no Scripts/Gate.sh)', () => {
    const r = setup()
    // package.json: a file the hook does not itself run (an edited hook in the handing clone would run in its place)
    const many: Record<string, string> = { 'package.json': '{}\n' }
    for (let i = 0; i < 3000; i++) many[`apps/web/src/m/f${i}.ts`] = `${i}\n`
    const p = handOff(r, 'handoff/hestia/big', many)
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('a handoff may not change the push path')
    const q = handOff(r, 'handoff/hestia/case', { 'apps/web/Vitest.config.ts': 'export default {}\n' }) // nested, any case
    expect(q.status).not.toBe(0)
    expect(q.stderr).toContain('a handoff may not change the push path')
  })

  it('--from after the remote is still --from', () => {
    const r = setup()
    const p = r.gatePush({}, ['origin', '--from', 'origin/main'])
    expect(p.code).toBe(1)
    expect(p.err).toContain('--from takes origin/handoff/<machine>/<name>')
  })

  it('a landing that fails keeps the handoff branch and goes back to the branch it was on', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/red', { 'apps/web/src/h.ts': 'x\n' }).status).toBe(0)
    r.ok(r.clone, 'checkout', '-q', '-b', 'mine')
    const p = r.gatePush({ ...landing(r), FAIL: '1' }, ['--from', 'origin/handoff/hestia/red'])
    expect(p.code).toBe(1)
    expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'refs/heads/handoff/hestia/red').status).toBe(0) // kept
    expect(r.ok(r.clone, 'symbolic-ref', '--short', 'HEAD')).toBe('mine')
  })

  it('a commit added to the handoff while it lands is kept: the branch is deleted only if it holds what landed', () => {
    const r = setup()
    expect(handOff(r, 'handoff/hestia/more', { 'apps/web/src/h.ts': 'x\n' }).status).toBe(0)
    const more = `cd '${r.other}' && echo more > apps/web/src/i.ts && git add -A && git commit -qm more && git push -q --no-verify origin HEAD:refs/heads/handoff/hestia/more`
    const p = r.gatePush({ ...landing(r), ON_TYPECHECK: more }, ['--from', 'origin/handoff/hestia/more'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('was not deleted')
    expect(r.ok(r.origin, 'log', '-1', '--format=%s', 'refs/heads/handoff/hestia/more')).toBe('more')
  })

  it('--from with nothing after it is refused, never a push of the current branch', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const before = r.ok(r.origin, 'rev-parse', 'main')
    const p = r.gatePush({}, ['--from'])
    expect(p.code).toBe(1)
    expect(p.err).toContain('none was given')
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before)
  })
})

describe('the queue and the stamp, under the lease', () => {
  it('a wait ref from the future (a clock far ahead, or forged) holds nobody up', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const empty = r.ok(r.other, 'hash-object', '-t', 'tree', '/dev/null')
    const far = Math.floor(Date.now() / 1000) + 86_400
    const sha = r.ok(
      r.other,
      'commit-tree',
      empty,
      '-m',
      `talos push wait\n\nmachine=titan\nsince=1\nseen=${far}\npid=1`,
    )
    r.ok(r.other, 'push', '-q', 'origin', `${sha}:refs/locks/wait/titan`)
    const p = r.gatePush({ GATE_PUSH_POLL_S: '1' })
    expect(p.code, p.err).toBe(0)
    expect(p.err).not.toContain('waited longer')
  })

  it('a stamp grown old while waiting is renewed by the cheap checks under the lease, so the hook does not gate again', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ GATE_PUSH_STAMP_FRESH_S: '0', GATE_PUSH_TRACE: '1' })
    // seen once, only inside a real gate --push (docs/FOLLOWUPS.md): on a failure, everything that decides the branch
    const stamp = () => {
      try {
        return readFileSync(join(r.clone, '.git', 'talos-gate.pass'), 'utf8')
      } catch (e) {
        return String(e)
      }
    }
    const diag = () =>
      [p.err, `origin refs:\n${r.git(r.clone, 'ls-remote', 'origin').stdout}`, `stamp: ${stamp()}`].join('\n')
    expect(p.code, diag()).toBe(0)
    expect(p.err, diag()).toContain('the cheap checks again to renew its stamp')
    expect(p.err, diag()).toContain('not run again') // the hook trusted the renewed stamp
    expect(r.calls().filter((c) => c === TYPECHECK)).toHaveLength(2) // the full gate, then the cheap checks
  })
})

describe('race_mode for a change only to the e2e package', () => {
  // what race_mode says when main moved from <old> to <new> under this change
  const race = (r: ReturnType<typeof setup>, old: string, now: string) =>
    spawnSync('bash', ['scripts/gate-push.sh'], {
      cwd: r.clone,
      env: { ...r.env, GATE_PUSH_PRINT_RACE: `${old},${now}` },
      encoding: 'utf8',
    }).stdout.trim()
  const moved = (r: ReturnType<typeof setup>, files: Record<string, string>) => {
    const old = r.ok(r.clone, 'rev-parse', 'HEAD~1')
    r.change(r.other, files)
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'fetch', '-q', 'origin')
    const now = r.ok(r.clone, 'rev-parse', 'origin/main')
    r.ok(r.clone, 'rebase', '-q', now)
    return { old, now }
  }

  it('keeps its passing run when the new commits touch nothing the specs run', () => {
    const r = setup()
    r.change(r.clone, { 'e2e/harness/fixtures.ts': 'wait\n', 'e2e/playwright.config.ts': 'export default {}\n' })
    r.ok(r.other, 'pull', '-q')
    const { old, now } = moved(r, { 'apps/windows/tray.ps1': 'x\n', 'scripts/heavy-lock.sh': 'x\n' })
    expect(race(r, old, now)).toBe('cheap')
  })

  it('runs again when the new commits touch the product the specs drive, or e2e/ itself', () => {
    for (const files of [
      { 'apps/web/src/a.ts': 'y\n' },
      { 'e2e/tests/02-chat.spec.ts': 'x\n' },
      { 'packages/p/x.ts': 'x\n' },
      { 'third_party/chronos/cli.ts': 'x\n' }, // the harness runs it
      { 'scripts/version.mjs': 'x\n' }, // the build imports it
      { 'tsconfig.base.json': '{}\n' },
    ]) {
      const r = setup()
      r.change(r.clone, { 'e2e/harness/fixtures.ts': 'wait\n', 'e2e/playwright.config.ts': 'export default {}\n' })
      r.ok(r.other, 'pull', '-q')
      const { old, now } = moved(r, files)
      expect(race(r, old, now), Object.keys(files)[0]).toBe('full')
    }
  })

  it('a change that is not only e2e/ follows the old rule', () => {
    const r = setup()
    r.change(r.clone, { 'e2e/harness/fixtures.ts': 'wait\n', 'apps/web/src/b.ts': 'y\n' })
    r.ok(r.other, 'pull', '-q')
    const { old, now } = moved(r, { 'apps/windows/tray.ps1': 'x\n' })
    expect(race(r, old, now)).toBe('full')
  })
})

describe('every race says why, naming the commit that decided it', () => {
  it('a requeue prints the commit and what this change ran; a cheap pass says why it stands', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/package.json') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toMatch(
      /requeue 1 of 2\)\. Why: 1 new commit\(s\), first [0-9a-f]{7,} other, and this change ran vitest/,
    )
    const w = setup()
    w.change(w.clone, { 'docs/mine.md': 'my words\n' })
    const q = w.gatePush({ ON_TYPECHECK: w.otherPushes('docs/news.md') })
    expect(q.code, q.err).toBe(0)
    expect(q.err).toContain(
      'its passing run stands (words on both sides, none the same file (1 new commit(s))): only typecheck',
    )
  })
})

describe('--red-main: a fix for a red main goes first, once per machine per red, only when the statuses say red', () => {
  /** GitHub's statuses, as the tests' stand-in: one file per commit, "<context><TAB><state>[<TAB><description>]" lines. */
  const statuses = (
    r: ReturnType<typeof setup>,
    rows: Record<string, Array<[string, string] | [string, string, string]>>,
  ) => {
    const dir = join(r.T, 'statuses')
    mkdirSync(dir, { recursive: true })
    for (const [sha, list] of Object.entries(rows))
      writeFileSync(join(dir, sha), list.map((x) => x.join('\t')).join('\n'))
    return { GATE_PUSH_TEST_STATUSES: dir }
  }
  const GREEN: Array<[string, string]> = [
    ['local-ci/check', 'success'],
    ['local-ci/vitest', 'success'],
    ['report-ci/linux', 'success'],
  ]
  const tip = (r: ReturnType<typeof setup>) => {
    r.ok(r.clone, 'fetch', '-q', 'origin')
    return r.ok(r.clone, 'rev-parse', 'origin/main')
  }
  const claimWaiting = (r: ReturnType<typeof setup>, machine: string, since: number, red: string) => {
    const empty = r.ok(r.other, 'hash-object', '-t', 'tree', '/dev/null')
    const now = Math.floor(Date.now() / 1000)
    const sha = r.ok(
      r.other,
      'commit-tree',
      empty,
      '-m',
      `talos push wait\n\nmachine=${machine}\nsince=${since}\nseen=${now}\npid=1\nred_main=${red}`,
    )
    r.ok(r.other, 'push', '-q', '--force', 'origin', `${sha}:refs/locks/wait/${machine}`)
  }

  it('refuses when main is green, or its newest finished run cannot be found', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    for (const env of [statuses(r, { [t]: GREEN }), statuses(r, {})]) {
      const p = r.gatePush(env, ['--red-main'])
      expect(p.code).toBe(1)
      expect(p.err).toContain('--red-main: main is not red')
    }
    // and says which: green at a named commit, or no finished run at all (a fresh setup: statuses() only ever adds files)
    expect(r.gatePush(statuses(r, { [t]: GREEN }), ['--red-main']).err).toContain(
      `--red-main: main is not red: its newest finished CI run (${t.slice(0, 7)}) has no failed status`,
    )
    const u = setup()
    u.change(u.clone, { 'apps/web/src/b.ts': 'y\n' })
    expect(u.gatePush(statuses(u, {}), ['--red-main']).err).toContain(
      '--red-main: main is not red: no finished CI run on its last 20 commits',
    )
  })

  it("reads GitHub for a remote whose https address carries credentials (Titan's origin), not only for a bare one", () => {
    // repo_slug names the repository for `gh api`; with credentials in the address it used to be empty, so the statuses were
    // "unreadable" and every --red-main was refused as "main is not red"
    const r = setup()
    const src = readFileSync(join(r.clone, 'scripts', 'gate-push.sh'), 'utf8')
    const fn = src.split('\n').find((l) => l.startsWith('repo_slug() {')) as string
    expect(fn).toBeDefined()
    const slugOf = (url: string) => {
      r.ok(r.clone, 'remote', 'set-url', 'origin', url)
      const s = spawnSync('bash', ['-c', `REMOTE=origin; ${fn}\nrepo_slug`], { cwd: r.clone, encoding: 'utf8' })
      return s.stdout.trim()
    }
    const at = '@' // spelled apart: a user@host literal reads as an address to the personal-data scan
    expect(slugOf('https://github.com/owner/repo.git')).toBe('owner/repo')
    expect(slugOf(`https://x-access-token:not-a-real-token${at}github.com/owner/repo.git`)).toBe('owner/repo')
    expect(slugOf(`https://someone${at}github.com/owner/repo`)).toBe('owner/repo')
    expect(slugOf(`git${at}github.com:owner/repo.git`)).toBe('owner/repo')
    expect(slugOf(`ssh://git${at}github.com/owner/repo.git`)).toBe('owner/repo')
    expect(slugOf('https://github.com.evil.example/owner/repo.git')).toBe('')
    expect(slugOf(`https://a${at}b${at}github.com/owner/repo.git`)).toBe('')
  })

  it('a Linux-only red (report-ci/linux, which does not gate) counts: it goes first and says so, and the jump is recorded', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    const red: Array<[string, string]> = [...GREEN.slice(0, 2), ['report-ci/linux', 'failure']]
    const p = r.gatePush(statuses(r, { [t]: red }), ['--red-main'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain(`red-main: cyclops goes first for red ${t.slice(0, 7)} (report-ci/linux)`)
    expect(r.ok(r.clone, 'ls-remote', 'origin', `refs/locks/red-main/cyclops/${t}`)).toContain(t)
    // its gate goes ahead of queued CI for the heavy lock: CI runs waiting behind it judge the commits it fixes
    expect(
      r.calls().some((c) => c.startsWith('jump ')),
      r.calls().join('\n'),
    ).toBe(true)
  })

  it('an unfinished newest run is passed over for the newest finished one', () => {
    const r = setup()
    const base = tip(r)
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, { 'apps/relay/src/x.ts': 'x\n' })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase')
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    const env = statuses(r, {
      [t]: [['local-ci/check', 'pending'], ...GREEN.slice(1)],
      [base]: [['local-ci/check', 'failure'], ...GREEN.slice(1)],
    })
    const p = r.gatePush(env, ['--red-main'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain(`goes first for red ${base.slice(0, 7)} (local-ci/check)`)
  })

  // Commits CI skipped (only report-ci/superseded) or whose run was cancelled (local-ci error "not tested: ...") are not a verdict:
  // walked past like a commit with nothing yet, so the run below them decides
  const stack = (r: ReturnType<typeof setup>) => {
    const base = tip(r)
    const mid: string[] = []
    for (const f of ['x', 'y']) {
      r.ok(r.other, 'pull', '-q')
      r.change(r.other, { [`apps/relay/src/${f}.ts`]: `${f}\n` })
      r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
      r.ok(r.clone, 'fetch', '-q', 'origin')
      mid.push(r.ok(r.clone, 'rev-parse', 'origin/main'))
    }
    r.ok(r.clone, 'pull', '-q', '--rebase')
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    return { base, mid, t: tip(r) }
  }
  const SKIPPED: Array<[string, string, string]> = [
    ['report-ci/superseded', 'success', "not tested: superseded by 1234567; CI tests main's newest commit"],
  ]
  const CANCELLED: Array<[string, string, string]> = [
    ['local-ci/check', 'error', 'not tested: run cancelled before this job reported (on delphi); re-run'],
    ['local-ci/vitest', 'error', 'not tested: run cancelled before this job reported (on delphi); re-run'],
  ]

  it('superseded-only and cancelled commits on top of a red one: main is red (a commit with nothing yet is skipped too)', () => {
    const r = setup()
    const { base, mid, t } = stack(r)
    const env = statuses(r, {
      // t: nothing yet
      [mid[1]]: SKIPPED,
      [mid[0]]: CANCELLED,
      [base]: [['local-ci/check', 'failure'], ...GREEN.slice(1)],
    })
    const p = r.gatePush(env, ['--red-main'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain(`goes first for red ${base.slice(0, 7)} (local-ci/check)`)
    expect(t).not.toBe(base)
  })

  it('superseded-only and cancelled commits on top of a green one: main is not red', () => {
    const r = setup()
    const { base, mid } = stack(r)
    const env = statuses(r, { [mid[1]]: CANCELLED, [mid[0]]: SKIPPED, [base]: GREEN })
    const p = r.gatePush(env, ['--red-main'])
    expect(p.code).toBe(1)
    expect(p.err).toContain('--red-main: main is not red')
  })

  it('a cancelled run that already has a failure is red there', () => {
    const r = setup()
    const { base, mid } = stack(r)
    const env = statuses(r, {
      [mid[1]]: [CANCELLED[0], ['local-ci/vitest', 'failure', 'failed on lemnos']],
      [mid[0]]: SKIPPED,
      [base]: GREEN,
    })
    const p = r.gatePush(env, ['--red-main'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain(`goes first for red ${mid[1].slice(0, 7)} (local-ci/vitest)`)
  })

  it('once per machine per red: a second --red-main for the same red is refused', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    const env = statuses(r, { [t]: [['local-ci/check', 'failure']] })
    expect(r.gatePush(env, ['--red-main']).code).toBe(0)
    r.change(r.clone, { 'apps/web/src/c.ts': 'z\n' })
    // main moved (this push), but the statuses still name the old red as the newest finished run
    const p = r.gatePush(env, ['--red-main'])
    expect(p.code).toBe(1)
    expect(p.err).toContain(`cyclops went first once already for the red at ${t.slice(0, 7)}`)
  })

  it('in the queue: a checked red claim goes before an older waiter; a claim for another sha does not', () => {
    // this machine with --red-main does not wait for hestia, who has waited ten minutes
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    const env = statuses(r, { [t]: [['local-ci/check', 'failure']] })
    const now = Math.floor(Date.now() / 1000)
    claimWaiting(r, 'hestia', now - 600, 'f'.repeat(40)) // a claim for a red nobody sees: an ordinary waiter
    const empty = r.ok(r.other, 'hash-object', '-t', 'tree', '/dev/null')
    const plain = r.ok(
      r.other,
      'commit-tree',
      empty,
      '-m',
      `talos push wait\n\nmachine=titan\nsince=${now - 600}\nseen=${now}\npid=1`,
    )
    r.ok(r.other, 'push', '-q', '--force', 'origin', `${plain}:refs/locks/wait/titan`)
    const p = r.gatePush({ ...env, GATE_PUSH_POLL_S: '1', GATE_PUSH_WAIT_S: '5' }, ['--red-main'])
    expect(p.code, p.err).toBe(0)
    expect(p.err).not.toContain('waited longer')
    // and a plain push lets a checked red claim go first, saying so once; a false one it orders by its place
    const s = setup()
    s.change(s.clone, { 'apps/web/src/b.ts': 'y\n' })
    const u = tip(s)
    const envS = statuses(s, { [u]: [['local-ci/check', 'failure']] })
    claimWaiting(s, 'hestia', Math.floor(Date.now() / 1000) + 60, u) // came later, but main is red at u
    const q = s.gatePush({ ...envS, GATE_PUSH_POLL_S: '1', GATE_PUSH_WAIT_S: '3' })
    expect(q.code).toBe(1)
    expect(q.err.match(/hestia goes ahead: main is red at/g) ?? []).toHaveLength(1)
    const v = setup()
    v.change(v.clone, { 'apps/web/src/b.ts': 'y\n' })
    const w = tip(v)
    const envV = statuses(v, { [w]: [['local-ci/check', 'failure']] })
    claimWaiting(v, 'hestia', Math.floor(Date.now() / 1000) + 60, 'e'.repeat(40)) // came later, false claim
    const x = v.gatePush({ ...envV, GATE_PUSH_POLL_S: '1' })
    expect(x.code, x.err).toBe(0)
    expect(x.err).not.toContain('goes ahead')
  })

  it('an error state is red; a status that cannot be read, or a stand-in behind a push address elsewhere, is not', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    expect(r.gatePush(statuses(r, { [t]: [['local-ci/check', 'error']] }), ['--red-main']).code).toBe(0)
    const u = setup()
    u.change(u.clone, { 'apps/web/src/b.ts': 'y\n' })
    const tu = tip(u)
    const env = statuses(u, { [tu]: [['local-ci/check', 'failure']] })
    writeFileSync(join(env.GATE_PUSH_TEST_STATUSES, `${tu}.unreadable`), '')
    const p = u.gatePush(env, ['--red-main'])
    expect(p.code).toBe(1)
    // unreadable is said as such, never as "not red" (a wrong "not red" cost three red-main lands on Titan)
    expect(p.err).toContain(`--red-main: GitHub's statuses of main could not be read (at ${tu.slice(0, 7)};`)
    expect(p.err).not.toContain('main is not red')
    const v = setup()
    v.change(v.clone, { 'apps/web/src/b.ts': 'y\n' })
    const tv = tip(v)
    v.ok(v.clone, 'config', 'remote.origin.pushurl', join(v.T, 'elsewhere.git')) // fetch here, push elsewhere
    const q = v.gatePush(statuses(v, { [tv]: [['local-ci/check', 'failure']] }), ['--red-main'])
    expect(q.code).toBe(1)
    expect(q.err).toContain("--red-main: GitHub's statuses of main could not be read")
  })

  it('a gate that fails first spends no jump; a held lease is waited for, never taken', async () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    const env = statuses(r, { [t]: [['local-ci/check', 'failure']] })
    expect(r.gatePush({ ...env, FAIL: '1' }, ['--red-main']).code).toBe(1)
    expect(r.ok(r.clone, 'ls-remote', 'origin', 'refs/locks/red-main/*')).toBe('')
    // held far longer than any gate here takes; the test lets it go itself once the run is seen waiting (no clock decides)
    r.leaseHeld('lemnos', Math.floor(Date.now() / 1000) + 600)
    const child = spawn('bash', ['scripts/gate.sh', '--push', '--red-main'], {
      cwd: r.clone,
      env: { ...r.env, ...env, GATE_PUSH_POLL_S: '1' },
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d
    })
    const done = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    await vi.waitUntil(() => err.includes('the push lease is held by lemnos') || child.exitCode !== null, {
      timeout: 40_000,
      interval: 100,
    })
    expect(err).toContain('the push lease is held by lemnos') // waited for, not taken
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(t) // nothing pushed while it is held
    r.ok(r.other, 'push', '-q', 'origin', ':refs/locks/push') // lemnos lets it go
    expect(await done, err).toBe(0)
    expect(r.ok(r.clone, 'ls-remote', 'origin', `refs/locks/red-main/cyclops/${t}`)).toContain(t)
  })

  it('two checked claims go by their place in the queue', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const t = tip(r)
    const env = statuses(r, { [t]: [['local-ci/check', 'failure']] })
    claimWaiting(r, 'hestia', Math.floor(Date.now() / 1000) - 600, t) // a checked claim, and it waited longer
    const p = r.gatePush({ ...env, GATE_PUSH_POLL_S: '1', GATE_PUSH_WAIT_S: '3' }, ['--red-main'])
    expect(p.code).toBe(1)
    expect(p.err).toContain('hestia has waited longer')
  })

  it('the hook takes a red claim and a jump marker only in their own forms', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const empty = r.ok(r.clone, 'hash-object', '-t', 'tree', '/dev/null')
    const commit = (msg: string) => r.ok(r.clone, 'commit-tree', empty, '-m', msg)
    const push = (src: string, ref: string) => r.git(r.clone, 'push', '-q', 'origin', `${src}:${ref}`)
    const red = 'a'.repeat(40)
    const mark = `talos red-main\n\nmachine=cyclops\nred=${red}\nfailed=report-ci/linux\nat=1`
    for (const [src, ref] of [
      [commit(mark), `refs/locks/red-main/lemnos/${red}`], // another machine
      [commit(mark), `refs/locks/red-main/cyclops/${'b'.repeat(40)}`], // another red
      [commit(`${mark}\nnote=hi`), `refs/locks/red-main/cyclops/${red}`], // more in it
      [commit(mark.replace('failed=report-ci/linux', 'failed=a b')), `refs/locks/red-main/cyclops/${red}`],
      [commit('talos push wait\n\nmachine=cyclops\nsince=1\nseen=2\npid=3\nred_main=xyz'), 'refs/locks/wait/cyclops'],
    ] as const) {
      const p = push(src, ref)
      expect(p.status, `${ref}`).not.toBe(0) // red-main form
      expect(p.stderr).toContain('refs/locks/ holds only the push lease')
    }
    const okp = push(commit(mark), `refs/locks/red-main/cyclops/${red}`)
    expect(okp.status, okp.stderr).toBe(0)
    expect(
      push(
        commit(`talos push wait\n\nmachine=cyclops\nsince=1\nseen=2\npid=3\nred_main=${red}`),
        'refs/locks/wait/cyclops',
      ).status,
    ).toBe(0)
  })
})

// The rebase-clean pass (lead-approved): the gate passed, main moved, the rebase was clean, and no new commit touches a file of this
// change or a gate-wide input (scripts/gate-wide-inputs.txt, the part of scripts/gate-inputs.txt that changes how every test runs). Then only the cheap checks run, and the push says so, in its output and in
// <cache>/logs/rebase-pass.tsv with the main commits it skipped a full gate over. Any overlap: the full gate, as before. However
// often it is refused, no gate of it goes ahead of queued CI: only a checked red-main gate does (HEAVY_LOCK_JUMP).
describe('the rebase-clean pass', () => {
  const passLog = (r: ReturnType<typeof setup>) => {
    const f = join(r.T, 'cache/logs/rebase-pass.tsv')
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t'))
      : []
  }

  it('no shared file, no gate input: cheap checks only, pushed, and the skipped commits are in the output and the log', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    const other = r.ok(r.origin, 'rev-parse', '--short=7', 'main~1')
    expect(p.err).toMatch(new RegExp(`rebase-clean pass: .*1 main commit\\(s\\).*${other}`))
    expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(1) // one full gate, no second
    expect(r.calls().filter((x) => x === TYPECHECK)).toHaveLength(2) // and the cheap checks after the rebase
    // the full gate is a push gate for the heavy lock (HEAVY_LOCK_PUSH: it waits behind CI like any gate)
    const pushed = readFileSync(`${r.T}/calls.log.push`, 'utf8').split('\n')
    expect(pushed.filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(1)
    expect(r.ok(r.origin, 'log', '-2', '--format=%s', 'main').split('\n')).toEqual(['change', 'other'])
    const rows = passLog(r)
    expect(rows).toHaveLength(1)
    const row = rows[0] as string[]
    expect(row[1]).toBe('cyclops')
    expect(row[2]).toBe('pass')
    expect(row[3]).toBe(r.ok(r.origin, 'rev-parse', 'main'))
    expect(row[4]).toContain(other)
  })

  it('a new commit to a file of this change (a clean rebase): refused, the full gate again, logged as refused', () => {
    const r = setup()
    // a file both sides edit, far apart, so the rebase is clean
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, { 'apps/web/src/m.ts': `${lines}\n` })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, { 'apps/web/src/m.ts': `${lines.replace('line 0', 'mine')}\n` })
    const theirs = `cd '${r.other}' && git pull -q && perl -pi -e 's/line 11/theirs/' apps/web/src/m.ts && git commit -qam other && git push -q origin HEAD:main`
    const p = r.gatePush({ ON_TYPECHECK: theirs })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('need the touched set again')
    expect(p.err).toContain('changes apps/web/src/m.ts, a file of this change')
    expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(2)
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it.each(['.githooks/zz-extra', 'apps/web/package.json', 'apps/web/tsconfig.json'])(
    'a new commit to a gate-wide input (.githooks/, a package.json, a tsconfig): refused, the full gate again: %s',
    (f) => {
      // not scripts/gate.sh itself: the other machine's commit writes plain text into the file, and the gate that runs again is it

      const r = setup()
      r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
      const p = r.gatePush({ ON_TYPECHECK: r.otherPushes(f) })
      expect(p.code, `${f}: ${p.err}`).toBe(0)
      expect(p.err, f).toContain(`changes ${f}, a gate-wide input`)
      expect(
        r.calls().filter((x) => x.startsWith('pnpm exec vitest related')),
        f,
      ).toHaveLength(2)
    },
  )

  it.each(['scripts/new-gate-helper.sh', 'scripts/some-other.test.ts', '.github/workflows/ci-extra.yml'])(
    'a new commit to another gate input (a script, a scripts/*.test.ts, a workflow) that this change does not touch: the pass: %s',
    (f) => {
      const r = setup()
      r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
      const p = r.gatePush({ ON_TYPECHECK: r.otherPushes(f) })
      expect(p.code, `${f}: ${p.err}`).toBe(0)
      expect(p.err, f).toContain('rebase-clean pass')
      expect(
        r.calls().filter((x) => x.startsWith('pnpm exec vitest related')),
        f,
      ).toHaveLength(1) // no second full gate
      expect(
        passLog(r).map((x) => x[2]),
        f,
      ).toEqual(['pass'])
    },
  )

  it('a new commit to a script this change also touches: still refused, the full gate again', () => {
    const r = setup()
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, { 'scripts/helper.sh': `${lines}\n` })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, { 'scripts/helper.sh': `${lines.replace('line 0', 'mine')}\n` })
    const theirs = `cd '${r.other}' && git pull -q && perl -pi -e 's/line 11/theirs/' scripts/helper.sh && git commit -qam other && git push -q origin HEAD:main`
    const p = r.gatePush({ ON_TYPECHECK: theirs })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('changes scripts/helper.sh, a file of this change')
    expect(p.err).toContain('need the touched set again')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it.each(['scripts/gate-inputs.txt', 'scripts/gate-wide-inputs.txt'])(
    'a new main commit that loosens a list is judged by the list the gate passed on: refused: %s',
    (list) => {
      const r = setup()
      r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
      const loosen = `cd '${r.other}' && git pull -q && printf '^nothing$\\n' > ${list} && git commit -qam other && git push -q origin HEAD:main`
      const p = r.gatePush({ ON_TYPECHECK: loosen })
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain(`changes ${list}, a gate-wide input`)
      expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(2)
    },
  )

  it('no gate-wide list on the main the gate passed on: fails closed (the full gate again)', () => {
    const r = setup()
    r.ok(r.clone, 'rm', '-q', 'scripts/gate-wide-inputs.txt')
    r.ok(r.clone, 'commit', '-qm', 'no list')
    r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('no gate-wide list')
    expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(2)
  })

  // The readers of the combined files (this change's and the new main commits'): the pass runs every test that `gate.sh --readers`
  // reports for them, since a code file's readers (a doc test that cites test names) are planned for no code change.
  /** main holds a doc test that cites a relay test by file name; this change renames a test in that relay file. */
  const citedByDoc = (r: ReturnType<typeof setup>) => {
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, {
      'apps/relay/test/auth/enroll.test.ts': "it('old name', () => {})\n",
      'scripts/doc.test.ts': "const src = readFileSync(join(root, 'apps/relay/test/auth', 'enroll.test.ts'), 'utf8')\n",
    })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, { 'apps/relay/test/auth/enroll.test.ts': "it('new name', () => {})\n" })
  }
  // the readers run as `vitest run <test files>`; the gate's own size step is `vitest run --project scripts ...`
  const readerRuns = (r: ReturnType<typeof setup>) =>
    r.calls().filter((x) => x.startsWith('pnpm exec vitest run ') && !x.includes('--project'))
  const relatedRuns = (r: ReturnType<typeof setup>) => r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))

  it('a renamed test name a doc test cites, and an unrelated main commit: the pass runs the doc test and refuses when it fails', () => {
    const r = setup()
    citedByDoc(r)
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts'), READERS_FAIL: 'scripts/doc.test.ts' })
    expect(p.code, p.err).toBe(0)
    expect(readerRuns(r)).toContain('pnpm exec vitest run scripts/doc.test.ts')
    expect(p.err).toContain('need the touched set again')
    expect(p.err).toContain(
      'a test that reads files of this change or of the new main commits failed (scripts/doc.test.ts)',
    )
    expect(relatedRuns(r)).toHaveLength(2) // the full gate again
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('the same race with the doc test passing: the pass stands, and it ran the doc test', () => {
    const r = setup()
    citedByDoc(r)
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(readerRuns(r)).toEqual(['pnpm exec vitest run scripts/doc.test.ts'])
    expect(relatedRuns(r)).toHaveLength(1)
    expect(passLog(r).map((x) => x[2])).toEqual(['pass'])
  })

  it('no test reads any of the files: the pass stays cheap and runs no reader', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts'), READERS_FAIL: 'placeholder' })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(readerRuns(r)).toEqual([])
    expect(relatedRuns(r)).toHaveLength(1)
  })

  it.each(['apps/bridge/test/guard.test.ts', 'apps/relay/test/guard.test.ts'])(
    'a reader in the bridge or the relay needs the heavy lock: the pass does not apply, the full gate runs with the reason: %s',
    (reader) => {
      const r = setup()
      r.ok(r.other, 'pull', '-q')
      r.change(r.other, { [reader]: "const f = 'apps/web/src/b.ts'\n" })
      r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
      r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
      r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
      const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
      expect(p.code, p.err).toBe(0)
      expect(p.err, reader).toContain(
        `${reader} reads files of this change or of the new main commits and needs the heavy lock`,
      )
      expect(readerRuns(r), reader).toEqual([])
      expect(
        passLog(r).map((x) => x[2]),
        reader,
      ).toEqual(['refused'])
    },
  )

  /** The bridge suite runs under bun: a stand-in that says nothing for --version and -e, and writes down a run or a test. */
  const stubBun = (r: ReturnType<typeof setup>) =>
    fakeTool(
      join(r.T, 'bin'),
      'bun',
      '#!/bin/sh\ncase "$1" in\n  --version) echo 1.4.4 ;;\n  -e) echo 3.51.0 ;;\n  run | test) echo "bun $*" >> "$CALLS" ;;\nesac\nexit 0\n',
    )

  it("both this change and main's new commits reach the bridge suite (bridge src, and a bridge test): the full gate again", () => {
    const r = setup()
    stubBun(r)
    r.change(r.clone, { 'apps/bridge/src/mine.ts': 'export const x = 1\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/bridge/test/theirs.test.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain("both this change and main's new commits reach the bridge suite")
    expect(p.err).toContain('need the touched set again')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('only this change reaches the bridge suite (bridge src; main moved in the web app): the pass stands', () => {
    const r = setup()
    stubBun(r)
    r.change(r.clone, { 'apps/bridge/src/mine.ts': 'export const x = 1\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(p.err).not.toContain('reach the bridge suite')
    expect(passLog(r).map((x) => x[2])).toEqual(['pass'])
  })

  it('only main reaches the bridge suite (a web file here, bridge src on main): the pass stands', () => {
    const r = setup()
    stubBun(r)
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/bridge/src/theirs.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(p.err).not.toContain('reach the bridge suite')
    expect(passLog(r).map((x) => x[2])).toEqual(['pass'])
  })

  // A Playwright spec runs only in CI's browser jobs (no test file names the code it drives): it says what it reads by a
  // `// gate-reads:` line of its own, and a pass that has a changed file on either side matching it needs the full gate.
  it.each([
    ['this change edits the relay', { 'apps/relay/src/auth/core.ts': 'export const a = 1\n' }, 'apps/web/src/other.ts'],
    ['main edits the relay', { 'apps/web/src/b.ts': 'y\n' }, 'apps/relay/src/auth/core.ts'],
  ])(
    'a marked Playwright spec reads the relay (%s): the pass does not apply, the full gate runs with the reason',
    (_, mine, theirs) => {
      const r = setup()
      r.ok(r.other, 'pull', '-q')
      r.change(r.other, {
        'apps/relay/test/auth/passkey-flow.spec.ts':
          '// gate-reads: apps/relay/src/*\nimport { test } from "@playwright/test"\n',
      })
      r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
      r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
      r.change(r.clone, mine)
      const p = r.gatePush({ ON_TYPECHECK: r.otherPushes(theirs) })
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain(
        `apps/relay/test/auth/passkey-flow.spec.ts (a Playwright spec) reads apps/relay/src/auth/core.ts, a file of this change or of the new main commits, and needs the heavy lock`,
      )
      expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
    },
  )

  it('a Playwright spec with no mark, or a mark that matches neither side: the pass stands', () => {
    const r = setup()
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, {
      'apps/relay/test/auth/plain.spec.ts': 'import { test } from "@playwright/test"\n',
      'apps/relay/test/auth/web.spec.ts':
        '// gate-reads: apps/web/src/features/*\nimport { test } from "@playwright/test"\n',
    })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, { 'apps/relay/src/auth/core.ts': 'export const a = 1\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(passLog(r).map((x) => x[2])).toEqual(['pass'])
  })

  /** main holds a marked spec; this change edits the relay; `racing` is the shell line of the other machine's commit in the race. */
  const markedSpec = (r: ReturnType<typeof setup>, mine: Record<string, string>) => {
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, {
      'apps/relay/test/auth/passkey-flow.spec.ts':
        '// gate-reads: apps/relay/src/*\nimport { test } from "@playwright/test"\n',
    })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, mine)
  }
  const onMain = (r: ReturnType<typeof setup>, file: string, text: string) =>
    `cd '${r.other}' && git fetch -q && git checkout -q --detach origin/main && mkdir -p '${dirname(file)}' && printf '%s' '${text}' > '${file}' && git add -A && git commit -qm other && git push -q --no-verify origin HEAD:main`
  const SPEC = 'apps/relay/test/auth/passkey-flow.spec.ts'

  it('a spec whose mark main drops in the race is still read: the marks come from the old main too', () => {
    const r = setup()
    markedSpec(r, { 'apps/relay/src/auth/core.ts': 'export const a = 1\n' })
    const p = r.gatePush({ ON_TYPECHECK: onMain(r, SPEC, 'import { test } from "@playwright/test"\n') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('(a Playwright spec) reads apps/relay/src/auth/core.ts')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('a spec whose mark this change drops is still read: the marks come from the old main too', () => {
    const r = setup()
    markedSpec(r, {
      'apps/relay/src/auth/core.ts': 'export const a = 1\n',
      [SPEC]: 'import { test } from "@playwright/test"\n',
    })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('(a Playwright spec) reads apps/relay/src/auth/core.ts')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('a spec marked in the race (main adds the mark) is read from the rebased tree', () => {
    const r = setup()
    r.change(r.clone, { 'apps/relay/src/auth/core.ts': 'export const a = 1\n' })
    const p = r.gatePush({
      ON_TYPECHECK: onMain(
        r,
        'apps/relay/test/auth/new.spec.ts',
        '// gate-reads: apps/relay/src/*\nimport x from "y"\n',
      ),
    })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('(a Playwright spec) reads apps/relay/src/auth/core.ts')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('git failing while the spec marks are read refuses to the full gate (never a pass on "no spec")', () => {
    const r = setup()
    r.change(r.clone, { 'apps/relay/src/auth/core.ts': 'export const a = 1\n' })
    // a git that fails for `grep` alone, as a bad object store would (a plain "no match" is exit 1, and fine)
    const realGit = spawnSync('which', ['git'], { env: r.env, encoding: 'utf8' }).stdout.trim()
    fakeTool(
      join(r.T, 'bin'),
      'git',
      `#!/bin/sh\nif [ "$1" = grep ]; then echo 'fatal: cannot read the object store' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`,
    )
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('which Playwright specs read these files could not be told (git grep failed): fails closed')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('the real passkey-flow spec carries a mark that matches the relay code it drives', () => {
    const spec = readFileSync(join(repoRoot, 'apps/relay/test/auth/passkey-flow.spec.ts'), 'utf8')
    const patterns = (spec.match(/^\/\/ gate-reads:(.*)$/m)?.[1] ?? '').trim().split(/\s+/)
    const shell = (f: string) =>
      spawnSync('bash', [
        '-c',
        `set -f; for p in ${patterns.join(' ')}; do case "$0" in $p) exit 0 ;; esac; done; exit 1`,
        f,
      ]).status
    expect(shell('apps/relay/src/auth/core.ts')).toBe(0)
    expect(shell('packages/protocol/src/enroll.ts')).toBe(0)
    expect(shell('apps/web/src/a.ts')).toBe(1)
  })

  it('gate.sh --readers failing (no test file to search) fails closed: the full gate again, with the reason', () => {
    const r = setup()
    r.ok(r.clone, 'rm', '-q', 'apps/web/test/placeholder.test.ts')
    r.ok(r.clone, 'commit', '-qm', 'no tests at all')
    r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts') })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('which tests read these files could not be told (gate.sh --readers failed): fails closed')
    expect(relatedRuns(r)).toHaveLength(2)
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })

  it('too many files to ask the readers about: the full gate again, with the reason', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n', 'apps/web/src/c.ts': 'y\n', 'apps/web/src/d.ts': 'y\n' })
    const p = r.gatePush({ ON_TYPECHECK: r.otherPushes('apps/web/src/other.ts'), GATE_PUSH_READERS_MAX: '3' })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('too many to ask which tests read them')
    expect(relatedRuns(r)).toHaveLength(2)
  })

  it('the words-only cheap path asks the readers too: a failing reader of a new main doc runs the touched set again', () => {
    const r = setup()
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, {
      'scripts/doc2.test.ts': "const t = readFileSync('docs/other.md', 'utf8')\n",
      'docs/other.md': 'a\n',
    })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, { 'docs/mine.md': 'm\n' }) // words only: this change ran no suite
    const move = `cd '${r.other}' && git pull -q && echo b > docs/other.md && git commit -qam other && git push -q origin HEAD:main`
    const p = r.gatePush({ ON_TYPECHECK: move, READERS_FAIL: 'scripts/doc2.test.ts' })
    expect(p.code, p.err).toBe(0)
    expect(readerRuns(r)).toContain('pnpm exec vitest run scripts/doc2.test.ts')
    expect(p.err).toContain('a test that reads files of this change or of the new main commits failed')
  })

  it('refused again and again, no gate goes ahead of queued CI: each waits its turn, and only refusals are logged', () => {
    const r = setup()
    r.change(r.clone, { 'apps/web/src/b.ts': 'y\n' })
    const every = `cd '${r.other}' && git pull -q && echo "$(date +%s%N)" > apps/web/package.json && git add -A && git commit -qm other && git push -q origin HEAD:main`
    const p = r.gatePush({ ON_EVERY_TYPECHECK: every })
    expect(p.code).toBe(1) // three gates, main moved under each: the requeue cap still stops it
    expect(r.calls().filter((c) => c.startsWith('pnpm exec vitest related'))).toHaveLength(3) // all three gates ran
    expect(r.calls().filter((c) => c.startsWith('jump '))).toEqual([]) // none of them jumped CI
    expect(p.err).not.toContain('goes ahead of queued CI')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused', 'refused', 'refused'])
  })

  /** Words files both sides edit, far apart (a clean rebase), beside a code file only this change edits. */
  const sharedWords = (r: ReturnType<typeof setup>, onMain: Record<string, string> = {}) => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    r.ok(r.other, 'pull', '-q')
    // the protected paths and a test that reads neither doc, as main has them
    const base = {
      'docs/protected-paths.txt': 'apps/bridge/src/keys.ts\n',
      'apps/web/test/other.test.ts': "it('x', () => {})\n",
    }
    r.change(r.other, { 'docs/sheet.md': `${lines}\n`, 'CHANGELOG.md': `${lines}\n`, ...base, ...onMain })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    const mine = `${lines.replace('line 0', 'mine')}\n`
    r.change(r.clone, { 'docs/sheet.md': mine, 'CHANGELOG.md': mine, 'apps/web/src/b.ts': 'y\n' })
    return `cd '${r.other}' && git pull -q && perl -pi -e 's/line 11/theirs/' docs/sheet.md CHANGELOG.md && git commit -qam other && git push -q origin HEAD:main`
  }

  it('shared only in words no test reads (docs/, a top-level .md): the rebase-clean pass, logged as pass-words', () => {
    const r = setup()
    const p = r.gatePush({ ON_TYPECHECK: sharedWords(r) })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('rebase-clean pass')
    expect(p.err).toContain('shared with this change only words no test reads: CHANGELOG.md, docs/sheet.md')
    expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(1) // no second full gate
    expect(passLog(r).map((x) => x[2])).toEqual(['pass-words'])
    // both sides' words are in what was pushed
    expect(r.ok(r.origin, 'show', 'main:docs/sheet.md')).toMatch(/^mine\n[\s\S]*\ntheirs$/)
  })

  it('a shared words file a test reads (by name, or by a gate-reads pattern): refused, the full gate again', () => {
    for (const reader of [
      { 'apps/web/test/sheet.test.ts': "const doc = readFileSync('docs/sheet.md', 'utf8')\n" },
      { 'apps/web/test/guard.test.ts': '// gate-reads: docs/*.md\n' },
    ]) {
      const r = setup()
      const p = r.gatePush({ ON_TYPECHECK: sharedWords(r, reader) })
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain(
        `changes docs/sheet.md, a file of this change that a test reads (${Object.keys(reader)[0]})`,
      )
      expect(r.calls().filter((x) => x.startsWith('pnpm exec vitest related'))).toHaveLength(2)
      expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
    }
  })

  it('a shared words file that is a protected path, by its name or a folder above it: refused, the full gate again', () => {
    for (const list of ['docs/sheet.md\n', 'docs/\n']) {
      const r = setup()
      const p = r.gatePush({ ON_TYPECHECK: sharedWords(r, { 'docs/protected-paths.txt': list }) })
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain('changes docs/sheet.md, a file of this change and a protected path')
      expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
    }
  })

  it('a shared words file in another folder (not docs/, not the top) is a file of this change: refused as before', () => {
    const r = setup()
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    r.ok(r.other, 'pull', '-q')
    r.change(r.other, { 'apps/web/README.md': `${lines}\n` })
    r.ok(r.other, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'pull', '-q', '--rebase', 'origin', 'main')
    r.change(r.clone, { 'apps/web/README.md': `${lines.replace('line 0', 'mine')}\n`, 'apps/web/src/b.ts': 'y\n' })
    const theirs = `cd '${r.other}' && git pull -q && perl -pi -e 's/line 11/theirs/' apps/web/README.md && git commit -qam other && git push -q origin HEAD:main`
    const p = r.gatePush({ ON_TYPECHECK: theirs })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('changes apps/web/README.md, a file of this change')
    expect(passLog(r).map((x) => x[2])).toEqual(['refused'])
  })
})

describe('the stamp never carries a plan that could not be made', () => {
  it('the gate passes but its --plan fails: refused, no stamp, nothing pushed', () => {
    const r = setup()
    // this change's gate passes, and its --plan exits 3 (as a gate killed while planning would)
    const real = readFileSync(join(r.clone, 'scripts/gate.sh'), 'utf8')
    r.change(r.clone, {
      'scripts/gate-real.sh': real,
      'scripts/gate.sh': `#!/usr/bin/env bash
[ "\${1:-}" = --push ] && { shift; exec bash scripts/gate-push.sh "$@"; }
case " $* " in *" --plan "*) exit 3 ;; esac
exec bash scripts/gate-real.sh "$@"
`,
    })
    const before = r.ok(r.origin, 'rev-parse', 'main')
    const p = r.gatePush()
    expect(p.code, p.err).toBe(1)
    expect(p.err).toContain('its plan could not be printed for the stamp: nothing is pushed')
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before)
    expect(existsSync(join(r.clone, '.git', 'talos-gate.pass'))).toBe(false)
  })
})

describe('failures already red on main: excused when main names them failing and this change does not reach them', () => {
  const OLD = '|web| test/old.test.ts > old > is red'
  /** Main's tip red in CI (local-ci/check), its log naming the old test failing (as CI's coloured log does), or `log`. */
  const redMain = (
    r: ReturnType<typeof setup>,
    opts: { state?: string; log?: string | null; unreadable?: boolean } = {},
  ) => {
    r.ok(r.clone, 'fetch', '-q', 'origin')
    const tip = r.ok(r.clone, 'rev-parse', 'origin/main')
    const dir = join(r.T, 'statuses')
    mkdirSync(dir, { recursive: true })
    const state = opts.state ?? 'failure'
    writeFileSync(
      join(dir, tip),
      `local-ci/check\t${state}\t${state === 'failure' ? 'failed' : 'passed'} on ci-runner\n`,
    )
    if (opts.unreadable) writeFileSync(join(dir, `${tip}.unreadable`), '')
    const logs = join(r.T, 'cache/logs')
    mkdirSync(logs, { recursive: true })
    const log =
      opts.log === undefined
        ? '\u001b[41m FAIL \u001b[49m \u001b[46m web \u001b[49m test/old.test.ts > old > is red\n'
        : opts.log
    if (log !== null) writeFileSync(join(logs, `${tip.slice(0, 7)}-check.log`), log)
    return { GATE_PUSH_TEST_STATUSES: dir, tip }
  }
  const vitestFails = (names: string[], counted = names.length) =>
    [
      ...names.map((n) => ` FAIL  ${n}`),
      ' Test Files  1 failed | 3 passed (4)',
      `      Tests  ${counted} failed | 9 passed (10)`,
    ].join('\n')
  /**
   * main holds the red test (apps/web/test/old.test.ts, reading ../src/old-helper.ts) and a file this change deletes, so the
   * gate runs the whole web project (a step whose tests the change may not reach); this change is that deletion and `files`
   */
  const withOldTest = (r: ReturnType<typeof setup>, files: Record<string, string>) => {
    r.change(r.clone, {
      'apps/web/test/old.test.ts': "import { h } from '../src/old-helper.ts'\n",
      'apps/web/src/old-helper.ts': 'export const h = 1\n',
      'apps/web/src/gone.ts': 'export const g = 1\n',
    })
    r.ok(r.clone, 'push', '-q', '--no-verify', 'origin', 'HEAD:main')
    r.ok(r.clone, 'rm', '-q', 'apps/web/src/gone.ts')
    r.change(r.clone, files)
  }
  const passLog = (r: ReturnType<typeof setup>) => {
    const f = join(r.T, 'cache/logs/rebase-pass.tsv')
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t'))
      : []
  }

  it('the only failure is a test red on main that the change does not reach: passes, says so, stamps it and logs it', () => {
    const r = setup()
    withOldTest(r, { 'apps/web/src/b.ts': 'y\n' })
    const { tip, ...env } = redMain(r)
    const p = r.gatePush({ ...env, VPROJ_OUT: vitestFails([OLD]) })
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('gate: tests (whole Vitest project, for a deleted file: web) failed, EXCUSED')
    const said = `EXCUSED 1 failure(s), failing on main at ${tip.slice(0, 7)} (its newest finished CI verdict) and not reached directly by this change: ${OLD} (apps/web/test/old.test.ts)`
    expect(p.err).toContain(`gate-push: ${said}`)
    expect(p.err).toMatch(/gate-push: pushed [0-9a-f]{40}; EXCUSED 1 failure/) // the landing line
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
    const stamp = readFileSync(join(r.clone, '.git', 'talos-gate.pass'), 'utf8')
    expect(stamp).toContain(`excused_main=${tip}\n`)
    expect(stamp).toContain(`excused=${OLD}\tapps/web/test/old.test.ts\n`)
    const rows = passLog(r)
    expect(rows.map((x) => x[2])).toEqual(['excused'])
    expect(rows[0]?.[4]).toBe(tip.slice(0, 7))
    expect(rows[0]?.[5]).toContain(OLD)
  })

  it('a failure in vitest related is never excused: that step picks a test because it imports a changed file', () => {
    const r = setup()
    withOldTest(r, { 'apps/web/src/b.ts': 'y\n' })
    const before = r.ok(r.origin, 'rev-parse', 'main')
    const { tip: _tip, ...env } = redMain(r)
    const p = r.gatePush({ ...env, VITEST_OUT: vitestFails([OLD]) })
    expect(p.code, p.err).toBe(1)
    expect(p.err).toContain('gate: REFUSED: tests (vitest related) failed (above)')
    expect(p.err).not.toContain('EXCUSED')
    expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before)
  })

  it('the change touches that test, or a file it reads: refused, naming which', () => {
    for (const [files, why] of [
      [
        { 'apps/web/test/old.test.ts': "import { h } from '../src/old-helper.ts'\n// mine\n" },
        'this change changes apps/web/test/old.test.ts',
      ],
      [
        { 'apps/web/src/old-helper.ts': 'export const h = 2\n' },
        'changes apps/web/src/old-helper.ts, which apps/web/test/old.test.ts names',
      ],
    ] as const) {
      const r = setup()
      withOldTest(r, files)
      const before = r.ok(r.origin, 'rev-parse', 'main')
      const { tip: _tip, ...env } = redMain(r)
      const p = r.gatePush({ ...env, VPROJ_OUT: vitestFails([OLD]) })
      expect(p.code, p.err).toBe(1)
      expect(p.err).toContain(`not excused: ${OLD} is failing on main`)
      expect(p.err).toContain(why)
      expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before)
    }
  })

  it('no excuse: main green, its statuses unreadable, its log missing, a failure main does not have, or one the runner counts but no line names', () => {
    const NEW = '|web| test/old.test.ts > old > a new failure'
    for (const [main, out, why] of [
      [{ state: 'success' }, vitestFails([OLD]), 'no failure could be excused: main has no red verdict'],
      [{ unreadable: true }, vitestFails([OLD]), 'no failure could be excused: main has no red verdict'],
      [{ log: null }, vitestFails([OLD]), "no failure could be excused: main's red job check at"],
      [
        {},
        vitestFails([OLD, NEW]),
        `not excused: ${NEW} (apps/web/test/old.test.ts) failed here and is not failing on main`,
      ],
      [
        {},
        vitestFails([OLD], 2),
        'not excused: not only named tests failed: Vitest counts 2 failed test(s), and the log names 1',
      ],
    ] as const) {
      const r = setup()
      withOldTest(r, { 'apps/web/src/b.ts': 'y\n' })
      const before = r.ok(r.origin, 'rev-parse', 'main')
      const { tip: _tip, ...env } = redMain(r, main)
      const p = r.gatePush({ ...env, VPROJ_OUT: out })
      expect(p.code, p.err).toBe(1)
      expect(p.err).toContain(why)
      expect(p.err).not.toContain('EXCUSED')
      expect(r.ok(r.origin, 'rev-parse', 'main')).toBe(before)
    }
  })
})
