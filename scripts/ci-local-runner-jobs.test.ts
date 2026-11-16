// The runner, part 2: the desktop and mobile jobs on main, e2e workers, status contexts (split from ci-local-runner.test.ts so the parts run side by side; the setup below is the same).
// scripts/ci-local.sh as the self-hosted runner uses it (docs/CI-LOCAL.md, "On the self-hosted runner"): what a cancelled run leaves behind
// (nothing: no held lock, no stale container, no half-started colima, no status stuck pending), what a status says and links to,
// where the scratch goes, and a Mac that slept warning by default. The same harness as ci-local-jobs.test.ts: a local
// "origin", a fake `gh` that records the statuses it is asked to post, fake `pnpm`/`docker`/`colima`/`sysctl`.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ciLocalSource, cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
vi.setConfig({ testTimeout: 60_000 })

const dirs: string[] = []
const live: ChildProcess[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const _alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
const started = (f: string) =>
  vi.waitUntil(() => existsSync(f) && readFileSync(f, 'utf8').trim() !== '', { timeout: 30_000, interval: 25 })

const BUN_PIN = /bun-version: ([\d.]+)/.exec(
  readFileSync(join(dirname(script), '../.github/workflows/ci.yml'), 'utf8'),
)?.[1]
function repo(jobs = '', tools: Record<string, string> = {}) {
  const T = mkdtempSync(join(tmpdir(), 'cilr-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(src, { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  mkdirSync(join(clone, 'scripts'))
  const copy = join(clone, 'scripts', 'ci-local.sh')
  writeFileSync(copy, readFileSync(script, 'utf8').replace('\ncd "$WT"\n', `\n${jobs}\ncd "$WT"\n`))
  copyCiLocalParts(join(clone, 'scripts')) // the parts ci-local.sh sources in place
  // the helpers ci-local.sh runs from its own folder
  for (const h of ['ci-swift-retry.sh', 'ci-flake-vitest.ts'])
    writeFileSync(join(clone, 'scripts', h), readFileSync(join(dirname(script), h), 'utf8'))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const tool = (name: string, body: string) => fakeTool(bin, name, `#!/bin/bash\n${body}\n`)
  // `gh repo view` fails: a runner run gives the repository in CI_REPO and must not need it.
  tool('gh', 'case "$1" in repo) exit 1 ;; api) echo "$*" >> "$GH_LOG" ;; esac')
  tool('pnpm', 'exit 0')
  // the pinned bun when asked its version (ci-runner.sh run runs only that one), else nothing
  tool('bun', `[ "$1" = --version ] && echo ${BUN_PIN}; exit 0`)
  for (const [n, b] of Object.entries(tools)) tool(n, b)
  const env: Record<string, string> = {
    ...cleanEnv(),
    CI_MAX_LOAD: '0',
    CI_POLL: '0.05',
    CI_LOCK_TIMEOUT: '30',
    TALOS_CI_NESTED: '0',
    CI_SLOTS: '1',
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: join(T, 'gh.log'),
    CALLS: join(T, 'calls'),
    TMPDIR: T,
  }
  const start = (args: string[], extra: Record<string, string> = {}) => {
    const child = spawn('bash', [copy, ...args], { cwd: clone, env: { ...env, ...extra } })
    live.push(child)
    let out = ''
    child.stdout?.on('data', (d) => {
      out += d
    })
    child.stderr?.on('data', (d) => {
      out += d
    })
    const done = new Promise<number>((r) => child.on('exit', (c, s) => r(c ?? (s ? 128 : -1))))
    return { child, done, out: () => out }
  }
  const cache = join(home, '.cache/talos-ci')
  const posted = () => (existsSync(env.GH_LOG as string) ? readFileSync(env.GH_LOG as string, 'utf8') : '')
  return {
    T,
    home,
    clone,
    git,
    start,
    env,
    cache,
    posted,
    tool,
    runs: () => readdirSync(join(cache, 'runs')),
    locks: () => (existsSync(join(cache, 'locks')) ? readdirSync(join(cache, 'locks')) : []),
  }
}
const repoArgs = { CI_REPO: 'owner/repo' }
const withStatus = ['--ref', 'HEAD']

describe('the desktop and mobile jobs on a commit that is already on main (push, dispatch or hand run)', () => {
  // The real job_desktop and job_mobile with the real path gate (scripts/ci-desktop-gate.sh), fake swift/xcode tools whose scripts
  // only leave markers. HEAD is pushed to origin/main first, as a push to main leaves it: the commit is its own merge-base with
  // main, so a path gate sees an empty diff.
  const swiftRepo = () => {
    const r = repo('', {
      swift: 'exit 0',
      xcodegen: 'exit 0',
      xcodebuild: 'echo "$@" >> "$HOME/xcodebuild-calls"',
      xcrun: 'exit 0', // the job boots and waits for its simulator through xcrun; never the real one
    })
    cpSync(join(here, 'ci-desktop-gate.sh'), join(r.clone, 'scripts/ci-desktop-gate.sh'))
    mkdirSync(join(r.clone, 'apps/desktop/scripts'), { recursive: true })
    writeFileSync(join(r.clone, 'apps/desktop/scripts/ci.sh'), '#!/bin/bash\ntouch "$HOME/desktop-ci-ran"\n')
    for (const d of ['App', 'BridgeGuard', 'TalosAudioCore', 'TalosCrashCore', 'TalosPushCore', 'TalosShareCore'])
      mkdirSync(join(r.clone, 'apps/mobile/ios', d), { recursive: true }) // git keeps a folder only if it holds a file
    for (const d of ['App', 'BridgeGuard', 'TalosAudioCore', 'TalosCrashCore', 'TalosPushCore'])
      writeFileSync(join(r.clone, 'apps/mobile/ios', d, 'keep'), '')
    writeFileSync(join(r.clone, 'apps/mobile/ios/TalosShareCore/test.sh'), '#!/bin/bash\ntouch "$HOME/mobile-ci-ran"\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'swift apps')
    r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    const tmux = join(r.T, 'tmux')
    writeFileSync(tmux, "#!/bin/bash\necho 'tmux 3.5'\n")
    chmodSync(tmux, 0o755)
    return { r, env: { ...repoArgs, CI_TMUX_PATHS: tmux, TALOS_IOS_SIM: 'Test Phone' } }
  }
  const ran = (r: { home: string }, f: string) => existsSync(join(r.home, f))
  const both = [...withStatus, '--jobs', 'desktop,mobile']

  it('a commit already on origin/main runs both jobs with no flag set, and posts "passed on", not "skipped"', async () => {
    const { r, env } = swiftRepo()
    const run = r.start(both, env)
    expect(await run.done, run.out()).toBe(0)
    expect(ran(r, 'desktop-ci-ran')).toBe(true)
    expect(ran(r, 'mobile-ci-ran')).toBe(true)
    expect(r.posted()).toMatch(/passed on .*local-ci\/desktop|local-ci\/desktop.*passed on/)
    expect(r.posted()).not.toContain('skipped (')
  })

  it('the desktop job logs its pty use: the peak of /dev/ttys* while it ran and kern.tty.ptmx_max, in its log and timings.tsv', async () => {
    const { r, env } = swiftRepo()
    const dev = join(r.T, 'dev')
    mkdirSync(dev)
    writeFileSync(join(dev, 'ttys000'), '') // one there before the job: counted, it is the machine's use
    writeFileSync(join(dev, 'tty.other'), '')
    // the job's ci.sh opens four more for a moment, then closes three
    writeFileSync(
      join(r.clone, 'apps/desktop/scripts/ci.sh'),
      // it closes them only once the job's sampler has seen all five (its peak file), so no sleep decides what was seen
      `#!/bin/bash\nfor i in 1 2 3 4; do : > "${dev}/ttys00$i"; done\nn=0\nuntil grep -qx 5 "$HOME"/.cache/talos-ci/runs/*/results/desktop.ptypeak 2>/dev/null || [ $n -ge 600 ]; do sleep 0.1; n=$((n + 1)); done\nfor i in 1 2 3; do mv "${dev}/ttys00$i" "${dev}/gone$i"; done\n`,
    )
    r.git(r.clone, 'commit', '-qam', 'pty ci.sh')
    r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    r.tool('sysctl', 'case "$*" in *kern.tty.ptmx_max*) echo 511 ;; *) exit 1 ;; esac')
    const run = r.start([...withStatus, '--jobs', 'desktop'], { ...env, CI_PTY_DEV: dev, CI_PTY_POLL: '0.1' })
    expect(await run.done, run.out()).toBe(0)
    const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
    expect(readFileSync(join(r.cache, 'logs', `${sha}-desktop.log`), 'utf8')).toContain(
      'pty: peak 5 /dev/ttys* while the desktop job ran; kern.tty.ptmx_max 511',
    )
    const cols = (readFileSync(join(r.cache, 'logs/timings.tsv'), 'utf8').trim().split('\n').pop() as string).split(
      '\t',
    )
    expect(cols[9]).toBe('pty=5/511')
  })

  it('so does a dispatch of a main commit by sha, and a main commit that main has since moved past', async () => {
    const { r, env } = swiftRepo()
    const sha = r.git(r.clone, 'rev-parse', 'HEAD')
    writeFileSync(join(r.clone, 'later.txt'), 'later\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'later')
    r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main') // main moved on; sha is now an ancestor of origin/main
    expect(await r.start(['--ref', sha, '--jobs', 'desktop,mobile'], env).done).toBe(0)
    expect(ran(r, 'desktop-ci-ran')).toBe(true)
    expect(ran(r, 'mobile-ci-ran')).toBe(true)
  })

  it("pin: an ordinary branch with no Swift changes keeps today's skip for both jobs", async () => {
    const { r, env } = swiftRepo()
    writeFileSync(join(r.clone, 'a.txt'), 'changed\n')
    r.git(r.clone, 'commit', '-qam', 'docs only') // ahead of origin/main, touches nothing Swift
    expect(await r.start(both, env).done).toBe(0)
    expect(ran(r, 'desktop-ci-ran')).toBe(false)
    expect(ran(r, 'mobile-ci-ran')).toBe(false)
    expect(r.posted()).toContain('skipped (no desktop changes)')
    expect(r.posted()).toContain('skipped (no mobile changes)')
  })

  it('a branch that does change Swift code still runs both', async () => {
    const { r, env } = swiftRepo()
    writeFileSync(join(r.clone, 'apps/desktop/x.swift'), 'x\n')
    writeFileSync(join(r.clone, 'apps/mobile/y.swift'), 'y\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'swift')
    expect(await r.start(both, env).done).toBe(0)
    expect(ran(r, 'desktop-ci-ran')).toBe(true)
    expect(ran(r, 'mobile-ci-ran')).toBe(true)
  })

  it('a branch that changes only the TypeScript half of the push seal still runs the mobile job (the Swift half reads it)', async () => {
    for (const path of [
      'packages/protocol/src/push-rich.ts',
      'packages/protocol/src/push.ts',
      'packages/protocol/fixtures/push-rich/vectors.json',
    ]) {
      const { r, env } = swiftRepo()
      mkdirSync(join(r.clone, path, '..'), { recursive: true })
      writeFileSync(join(r.clone, path), 'changed\n')
      r.git(r.clone, 'add', '-A')
      r.git(r.clone, 'commit', '-qm', 'seal change')
      expect(await r.start([...withStatus, '--jobs', 'mobile'], env).done, path).toBe(0)
      expect(ran(r, 'mobile-ci-ran'), path).toBe(true)
      expect(r.posted(), path).not.toContain('skipped (no mobile changes)')
    }
  })

  it('TALOS_CI_FORCE_DESKTOP, kept for hand runs, still forces a branch, and no job child process inherits it', async () => {
    const { r, env } = swiftRepo()
    writeFileSync(join(r.clone, 'a.txt'), 'changed\n')
    writeFileSync(
      join(r.clone, 'apps/desktop/scripts/ci.sh'),
      '#!/bin/bash\necho "force=[${TALOS_CI_FORCE_DESKTOP:-}]" > "$HOME/desktop-env"\n',
    )
    r.git(r.clone, 'commit', '-qam', 'docs only')
    expect(await r.start(both, { ...env, TALOS_CI_FORCE_DESKTOP: '1' }).done).toBe(0)
    expect(readFileSync(join(r.home, 'desktop-env'), 'utf8').trim()).toBe('force=[]')
  })

  it("the mobile job runs the app's own tests on a simulator, and no simulator is a failure, never a pass", async () => {
    const { r, env } = swiftRepo()
    writeFileSync(join(r.clone, 'apps/mobile/y.swift'), 'y\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'swift')
    expect(await r.start([...withStatus, '--jobs', 'mobile'], env).done).toBe(0)
    const calls = readFileSync(join(r.home, 'xcodebuild-calls'), 'utf8').trim().split('\n')
    expect(calls.filter((c) => /\btest$/.test(c))).toHaveLength(1)
    expect(calls.find((c) => /\btest$/.test(c))).toContain('platform=iOS Simulator,name=Test Phone')

    // xcrun finds no iPhone: fail, with the reason in the status
    const none = swiftRepo()
    writeFileSync(join(none.r.clone, 'apps/mobile/y.swift'), 'y\n')
    none.r.git(none.r.clone, 'add', '-A')
    none.r.git(none.r.clone, 'commit', '-qm', 'swift')
    none.r.tool('xcrun', 'exit 0')
    const run = none.r.start([...withStatus, '--jobs', 'mobile'], { ...none.env, TALOS_IOS_SIM: '' })
    expect(await run.done).toBe(1)
    expect(none.r.posted()).toMatch(/state=failure .*local-ci\/mobile/)
  })

  it('missing xcodegen or xcodebuild is a failure on a Mac, and a recorded skip elsewhere; never "passed on"', async () => {
    for (const [os, state, text] of [
      ['Darwin', 'failure', 'FAILED'],
      ['Linux', 'success', 'skipped (xcodegen or xcodebuild is not installed'],
    ] as const) {
      const { r, env } = swiftRepo()
      r.tool('uname', `[ "$1" = -s ] && echo ${os} || /usr/bin/uname "$@"`)
      const run = r.start([...withStatus, '--jobs', 'mobile'], { ...env, CI_XCODE_TOOLS: 'no-such-xcode-tool' })
      expect(await run.done, os).toBe(os === 'Darwin' ? 1 : 0)
      const posted = r.posted()
      expect(posted, os).toMatch(new RegExp(`state=${state} .*local-ci/mobile`))
      expect(posted, os).not.toContain('passed on')
      if (os === 'Linux') expect(posted).toContain(text)
    }
  })

  it('end to end: ci-runner.sh run for a push to main builds both through the real gates, with no flags in the environment', async () => {
    const { r, env } = swiftRepo()
    const sha = r.git(r.clone, 'rev-parse', 'HEAD')
    const wrapper = join(r.T, 'ci-local-two-jobs.sh')
    writeFileSync(
      wrapper,
      `#!/bin/bash\nexec bash "${join(r.clone, 'scripts/ci-local.sh')}" "$@" --jobs desktop,mobile\n`,
    )
    const child = spawn('bash', [join(here, 'ci-runner.sh'), 'run'], {
      cwd: r.clone,
      env: {
        ...r.env,
        ...env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha,
        GH_TOKEN: 't',
        CI_LOCAL_SCRIPT: wrapper,
      },
    })
    live.push(child)
    expect(await new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)))).toBe(0)
    expect(ran(r, 'desktop-ci-ran')).toBe(true)
    expect(ran(r, 'mobile-ci-ran')).toBe(true)
  })
})

describe('ci_e2e_workers: e2e workers follow the machine', () => {
  const w = (cores: number, gb: number) =>
    spawnSync('bash', ['-c', `. "${script}"\nci_e2e_workers ${cores} ${gb}`], { encoding: 'utf8' }).stdout.trim()
  it('3 on a 10-core Mac (what it always ran), 5 on an 18-core runner', () => {
    expect(w(10, 32)).toBe('3')
    expect(w(18, 128)).toBe('5')
  })
  it('memory can be the limit; never fewer than 1, never more than 8', () => {
    expect(w(18, 12)).toBe('2')
    expect(w(18, 0)).toBe('1') // memory unreadable: one worker, not a guess upward
    expect(w(2, 64)).toBe('1')
    expect(w(128, 1024)).toBe('8')
  })
  it('is what the browser job hands the e2e suite, and E2E_WORKERS still wins', () => {
    const text = ciLocalSource() // ci-local.sh and the parts it sources
    expect(text).toMatch(/E2E_WORKERS="\$\{E2E_WORKERS:-\$\(ci_e2e_workers "\$CI_CPUS" "\$\{CI_MEM_GB:-0\}"\)\}"/)
  })
})

describe('CI_STATUS_PREFIX: a part of check, or a report-only job, posts outside the six (docs/CI-MACHINES.md)', () => {
  it('ci-part/<job> for a part, pending then its answer, never under local-ci/', async () => {
    const r = repo('job_vitest() { :; }')
    const run = r.start([...withStatus, '--jobs', 'vitest'], { ...repoArgs, CI_STATUS_PREFIX: 'ci-part' })
    expect(await run.done, run.out()).toBe(0)
    expect(r.posted()).toMatch(/state=pending .*context=ci-part\/vitest /)
    expect(r.posted()).toMatch(/state=success .*context=ci-part\/vitest .*description=passed on /)
    expect(r.posted()).not.toContain('context=local-ci/')
  })

  it('report-ci/linux for the report-only Linux job', async () => {
    const r = repo('job_linux() { :; }')
    const run = r.start([...withStatus, '--jobs', 'linux'], { ...repoArgs, CI_STATUS_PREFIX: 'report-ci' })
    expect(await run.done, run.out()).toBe(0)
    expect(r.posted()).toMatch(/state=success .*context=report-ci\/linux /)
  })

  it('a part or report-only job is refused under local-ci/ (the default), so it can never post into a gating context', async () => {
    for (const job of ['bridge-shard-1', 'bridge-shard-2', 'vitest', 'linux', 'stock-mac']) {
      const r = repo(`job_${job}() { :; }`)
      const run = r.start([...withStatus, '--jobs', job], repoArgs)
      expect(await run.done, job).toBe(64)
      expect(run.out(), job).toContain(`${job} cannot post under local-ci/`)
      expect(r.posted(), job).toBe('')
    }
  })

  it('a job name with a slash, a bad CI_PART_WAIT or CI_PART_POLL, and a part listed twice are refused', async () => {
    const cases: [string[], Record<string, string>][] = [
      [['--jobs', 'local-ci/x'], {}],
      [['--jobs', 'x'], { CI_PART_WAIT: 'soon' }],
      [['--jobs', 'x'], { CI_PART_POLL: '-1' }],
      [['--jobs', 'x'], { CI_REMOTE_PARTS: 'vitest:delphi vitest:cyclops' }],
    ]
    for (const [args, extra] of cases) {
      const r = repo('job_x() { :; }')
      const run = r.start([...withStatus, ...args], { ...repoArgs, ...extra })
      expect(await run.done, JSON.stringify([args, extra])).toBe(64)
      expect(r.posted()).toBe('')
    }
  })

  // docs/CI-MACHINES.md, "Tools a test file needs": a part machine dealt a file that needs a tool it lacks refuses the part.
  it('a bridge shard whose pile needs tmux, on a machine without it: error under ci-part/, its tests never run', async () => {
    // the commit's runner knows --shard and --pile-tools; asked --needs, this pile needs tmux
    const r = repo('', {
      bun: `echo "bun $*" >> "$CALLS"; case "$*" in *--needs*) echo tmux ;; esac; exit 0`,
    })
    mkdirSync(join(r.clone, 'apps/bridge/scripts'), { recursive: true })
    writeFileSync(join(r.clone, 'apps/bridge/scripts/test-parallel.ts'), '// knows --shard K/N and --pile-tools\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'runner with --pile-tools')
    const run = r.start([...withStatus, '--jobs', 'bridge-shard-2'], {
      ...repoArgs,
      CI_STATUS_PREFIX: 'ci-part',
      CI_STATUS_WHERE: 'cyclops',
      CI_SHARD_TOOLS: 'tmux|',
      CI_TMUX_PATHS: '/nonexistent/tmux',
    })
    // a refusal is not a failure: the job ends green, the error status says why, and Lemnos takes the part
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('bridge-shard-2 refused')
    expect(run.out()).toContain('::warning::ci-local: bridge-shard-2 needs tmux 3.2+')
    expect(r.posted()).toMatch(
      /state=error .*context=ci-part\/bridge-shard-2 .*description=bridge-shard-2 needs tmux 3.2\+, which cyclops does not have/,
    )
    expect(r.posted()).not.toMatch(/state=(success|failure) .*context=ci-part\/bridge-shard-2/)
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
      .split('\n')
      .filter((l) => l.includes('test-parallel.ts'))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((l) => l.includes('--needs'))).toBe(true) // asked, never run
    expect(calls[0]).toContain('--shard 2/2 --pile-tools tmux|')
  })

  it('a bad CI_SHARD_TOOLS is refused before anything runs; an older runner (no --pile-tools) gets no flag', async () => {
    const r = repo('', { bun: `echo "bun $*" >> "$CALLS"; exit 0` })
    const bad = r.start([...withStatus, '--jobs', 'bridge-shard-1'], {
      ...repoArgs,
      CI_STATUS_PREFIX: 'ci-part',
      CI_SHARD_TOOLS: 'tmux;rm',
    })
    expect(await bad.done).toBe(64)
    mkdirSync(join(r.clone, 'apps/bridge/scripts'), { recursive: true })
    writeFileSync(join(r.clone, 'apps/bridge/scripts/test-parallel.ts'), '// knows --shard K/N only\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'an older runner')
    const old = r.start([...withStatus, '--jobs', 'bridge-shard-1'], {
      ...repoArgs,
      CI_STATUS_PREFIX: 'ci-part',
      CI_SHARD_TOOLS: 'tmux|',
    })
    expect(await old.done, old.out()).toBe(0)
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
      .split('\n')
      .filter((l) => l.includes('test-parallel.ts'))
    expect(calls).toEqual([expect.stringMatching(/--shard 1\/2$/)])
  })

  it('with tmux there, or nothing needed, the shard runs with the same --pile-tools on every machine', async () => {
    const r = repo('', { bun: `echo "bun $*" >> "$CALLS"; exit 0` })
    mkdirSync(join(r.clone, 'apps/bridge/scripts'), { recursive: true })
    writeFileSync(join(r.clone, 'apps/bridge/scripts/test-parallel.ts'), '// knows --shard K/N and --pile-tools\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'runner with --pile-tools')
    const run = r.start([...withStatus, '--jobs', 'bridge-shard-1'], {
      ...repoArgs,
      CI_STATUS_PREFIX: 'ci-part',
      CI_SHARD_TOOLS: 'tmux|',
    })
    expect(await run.done, run.out()).toBe(0)
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
      .split('\n')
      .filter((l) => l.includes('test-parallel.ts') && !l.includes('--needs'))
    expect(calls).toEqual([expect.stringMatching(/--shard 1\/2 --pile-tools tmux\|/)])
    expect(r.posted()).toMatch(/state=success .*context=ci-part\/bridge-shard-1 /)
  })

  it('only local-ci, ci-part and report-ci are prefixes', async () => {
    const r = repo('job_x() { :; }')
    const run = r.start([...withStatus, '--jobs', 'x'], { ...repoArgs, CI_STATUS_PREFIX: 'local-ci/../x' })
    expect(await run.done).toBe(64)
    expect(r.posted()).toBe('')
  })

  it('a cancel closes the pending part under its own prefix', async () => {
    const r = repo('job_vitest() { sleep 120 & echo "$!" > "$HOME/child"; wait; }')
    const run = r.start([...withStatus, '--jobs', 'vitest'], { ...repoArgs, CI_STATUS_PREFIX: 'ci-part' })
    await started(join(r.home, 'child'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(r.posted()).toMatch(
      /state=error .*context=ci-part\/vitest .*not tested: run cancelled before this job reported/,
    )
    expect(r.posted()).not.toContain('context=local-ci/vitest')
  })
})
