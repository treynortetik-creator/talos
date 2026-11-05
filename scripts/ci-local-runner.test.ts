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
import { cleanEnv } from './ci-test-env'

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
const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
const started = (f: string) =>
  vi.waitUntil(() => existsSync(f) && readFileSync(f, 'utf8').trim() !== '', { timeout: 30_000, interval: 25 })

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
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  // `gh repo view` fails: a runner run gives the repository in CI_REPO and must not need it.
  tool('gh', 'case "$1" in repo) exit 1 ;; api) echo "$*" >> "$GH_LOG" ;; esac')
  tool('pnpm', 'exit 0')
  tool('bun', 'exit 0')
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

describe('the statuses a runner run posts', () => {
  it('say where they ran and link to the workflow run; CI_REPO means `gh repo view` is not needed', async () => {
    const r = repo('job_ok() { :; }')
    const run = r.start([...withStatus, '--jobs', 'ok'], {
      ...repoArgs,
      CI_STATUS_WHERE: 'ci-runner',
      CI_STATUS_URL: 'https://example.test/runs/9',
    })
    expect(await run.done).toBe(0)
    const p = r.posted()
    expect(p).toMatch(
      /repos\/owner\/repo\/statuses\/[0-9a-f]{40} .*state=pending .*description=running on ci-runner .*target_url=https:\/\/example.test\/runs\/9/,
    )
    expect(p).toMatch(
      /state=success .*context=local-ci\/ok .*description=passed on ci-runner in \d+s .*target_url=https:\/\/example.test\/runs\/9/,
    )
  })

  it('on a hand run they name the machine (its own name), with no link: two Macs are told apart', async () => {
    const r = repo('job_ok() { :; }', { scutil: 'echo Mac-One' })
    const run = r.start([...withStatus, '--jobs', 'ok'], repoArgs)
    expect(await run.done).toBe(0)
    expect(r.posted()).toContain('description=running on Mac-One')
    expect(r.posted()).toContain('description=passed on Mac-One in')
    expect(r.posted()).not.toContain('target_url')
  })

  it('a failure says which machine to look on for the log', async () => {
    const r = repo('job_bad() { echo boom >&2; return 1; }', { scutil: 'echo Mac-One' })
    const run = r.start([...withStatus, '--jobs', 'bad'], repoArgs)
    expect(await run.done).toBe(1)
    expect(r.posted()).toMatch(
      /state=failure .*description=failed on Mac-One; see ~\/\.cache\/talos-ci\/logs\/[0-9a-f]{7}-bad\.log/,
    )
  })

  it('a machine that names itself (the runner) wins over its hostname', async () => {
    const r = repo('job_ok() { :; }', { scutil: 'echo Mac-One' })
    const run = r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_STATUS_WHERE: 'ci-runner' })
    expect(await run.done).toBe(0)
    expect(r.posted()).toContain('description=passed on ci-runner in')
    expect(r.posted()).not.toContain('Mac-One')
  })

  it('CI_SHA_FILE gets the commit actually tested, and the scratch worktree is under CI_WT_BASE', async () => {
    const r = repo('job_probe() { pwd -P > "$HOME/wt"; }')
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const shaFile = join(r.T, 'sha')
    const run = r.start([...withStatus, '--jobs', 'probe'], { ...repoArgs, CI_WT_BASE: wtBase, CI_SHA_FILE: shaFile })
    expect(await run.done).toBe(0)
    expect(readFileSync(shaFile, 'utf8').trim()).toBe(r.git(r.clone, 'rev-parse', 'HEAD'))
    expect(readFileSync(join(r.home, 'wt'), 'utf8')).toContain(
      `${execFileSync('realpath', [wtBase], { encoding: 'utf8' }).trim()}/talos-ci-`,
    )
    expect(readdirSync(wtBase)).toEqual([]) // and it is gone at the end
  })
})

describe('ci_where: what a status says it ran on', () => {
  const src = (code: string, extra: Record<string, string> = {}, tools: Record<string, string> = {}) => {
    const b = mkdtempSync(join(tmpdir(), 'ciw-'))
    dirs.push(b)
    for (const [n, body] of Object.entries(tools)) {
      writeFileSync(join(b, n), `#!/bin/bash\n${body}\n`)
      chmodSync(join(b, n), 0o755)
    }
    const r = spawnSync('bash', ['-c', `. "${script}"\n${code}`], {
      env: { ...cleanEnv(), PATH: `${b}:${process.env.PATH}`, ...extra },
      encoding: 'utf8',
    })
    return { out: r.stdout, code: r.status }
  }
  it('is the name the machine gives itself, unless the environment says otherwise', () => {
    expect(src('ci_where', {}, { scutil: 'echo Mac-One' }).out).toBe('Mac-One')
    expect(src('ci_where', { CI_STATUS_WHERE: 'ci-runner' }, { scutil: 'echo Mac-One' }).out).toBe('ci-runner')
  })
  it('falls back to hostname, then to "the owner\'s Mac" when no name can be read', () => {
    expect(src('ci_where', {}, { scutil: 'exit 1', hostname: 'echo box.local' }).out).toBe('box.local')
    expect(src('ci_where', {}, { scutil: 'exit 1', hostname: 'exit 1' }).out).toBe("the owner's Mac")
  })
  it('keeps only plain characters and at most 40 of them (it goes into a 140-character status)', () => {
    expect(src('ci_where', {}, { scutil: "echo 'Evil; $(id) `x`'" }).out).toBe('Evil? ??id? ?x?')
    expect(src('ci_where', {}, { scutil: `echo ${'a'.repeat(100)}` }).out).toHaveLength(40)
  })
})

describe('ci_tmux_ok: the desktop job needs the tmux the desktop tests look for', () => {
  const ok = (versions: Array<string | null>) => {
    const b = mkdtempSync(join(tmpdir(), 'cit-'))
    dirs.push(b)
    const paths = versions.map((v, i) => {
      const f = join(b, `tmux${i}`)
      if (v !== null) {
        writeFileSync(f, `#!/bin/bash\n[ "$1" = -V ] && echo '${v}'\n`)
        chmodSync(f, 0o755)
      }
      return f
    })
    return spawnSync('bash', ['-c', `. "${script}"\nci_tmux_ok`], {
      env: { ...cleanEnv(), CI_TMUX_PATHS: paths.join(' ') },
    }).status
  }
  it('is true for 3.2 or newer, with the odd version strings tmux has', () => {
    for (const v of ['tmux 3.2', 'tmux 3.3a', 'tmux 3.8', 'tmux 10.0', 'tmux next-3.5', 'tmux 4.0'])
      expect(ok([v]), v).toBe(0)
  })
  it('is false for older, for garbage, and for a missing file', () => {
    for (const v of ['tmux 3.1c', 'tmux 2.9', 'tmux 3.1', 'nonsense', '']) expect(ok([v]), v).toBe(1)
    expect(ok([null])).toBe(1)
  })
  it('looks at every path: an old one first does not hide a good one after it', () => {
    expect(ok(['tmux 3.0', 'tmux 3.4'])).toBe(0)
    expect(ok([null, 'tmux 3.4'])).toBe(0)
  })
})

describe('ci_ios_sim_dest: the simulator the app tests run on', () => {
  // The runner's real shape: "iPhone 17 Pro" only under an older runtime, a newer runtime without it (the run that failed).
  const listing = (rows: string[]) => `== Devices ==\n${rows.join('\n')}\n`
  const OLD =
    '-- iOS 26.3 --\n    iPhone 17 Pro (AAAAAAAA-0000-4000-8000-000000000001) (Shutdown) \n    iPad Air (AAAAAAAA-0000-4000-8000-000000000009) (Shutdown) '
  const NEW = '-- iOS 27.2 --\n    iPhone 18 Pro (BBBBBBBB-0000-4000-8000-000000000002) (Booted) '
  const dest = (out: string, env: Record<string, string> = {}) => {
    const b = mkdtempSync(join(tmpdir(), 'cis-'))
    dirs.push(b)
    writeFileSync(join(b, 'out'), out)
    writeFileSync(join(b, 'xcrun'), `#!/bin/bash\ncat "${join(b, 'out')}"\n`)
    chmodSync(join(b, 'xcrun'), 0o755)
    return spawnSync('bash', ['-c', `. "${script}"\nci_ios_sim_dest`], {
      env: { ...cleanEnv(), PATH: `${b}:${process.env.PATH}`, ...env },
      encoding: 'utf8',
    }).stdout.trim()
  }
  it('names the device by id, never by a name that may exist on one runtime only', () => {
    expect(dest(listing([OLD]))).toBe('platform=iOS Simulator,id=AAAAAAAA-0000-4000-8000-000000000001')
  })
  it('prefers a booted iPhone, and never picks an iPad', () => {
    expect(dest(listing([OLD, NEW]))).toBe('platform=iOS Simulator,id=BBBBBBBB-0000-4000-8000-000000000002')
    expect(dest(listing(['-- iOS 27.2 --\n    iPad Air (AAAAAAAA-0000-4000-8000-000000000009) (Booted) ']))).toBe('')
  })
  it('prints nothing when there is no iPhone, and TALOS_IOS_SIM wins when set', () => {
    expect(dest(listing([]))).toBe('')
    expect(dest(listing([OLD]), { TALOS_IOS_SIM: 'Test Phone' })).toBe('platform=iOS Simulator,name=Test Phone')
  })
})

describe('ci_ios_sim_dest: a name with parentheses', () => {
  const dest = (out: string) => {
    const b = mkdtempSync(join(tmpdir(), 'cis-'))
    dirs.push(b)
    writeFileSync(join(b, 'out'), out)
    writeFileSync(join(b, 'xcrun'), `#!/bin/bash\ncat "${join(b, 'out')}"\n`)
    chmodSync(join(b, 'xcrun'), 0o755)
    return spawnSync('bash', ['-c', `. "${script}"\nci_ios_sim_dest`], {
      env: { ...cleanEnv(), PATH: `${b}:${process.env.PATH}` },
      encoding: 'utf8',
    }).stdout.trim()
  }
  it('finds an iPhone whose own name has a bracket in it, with the whole row read from its end', () => {
    const row = (name: string, id: string, state: string) => `    ${name} (${id}) (${state}) `
    const SE = row('iPhone SE (3rd generation)', 'AAAAAAAA-0000-4000-8000-000000000005', 'Shutdown')
    expect(dest(`== Devices ==\n-- iOS 26.3 --\n${SE}\n`)).toBe(
      'platform=iOS Simulator,id=AAAAAAAA-0000-4000-8000-000000000005',
    )
    // and it still prefers a booted one over it
    const booted = row('iPhone 17', 'BBBBBBBB-0000-4000-8000-000000000001', 'Booted')
    expect(dest(`== Devices ==\n-- iOS 26.3 --\n${SE}\n${booted}\n`)).toBe(
      'platform=iOS Simulator,id=BBBBBBBB-0000-4000-8000-000000000001',
    )
  })
})

describe('ci_ios_test: the app tests on a simulator that may still be settling', () => {
  // Stub `xcrun` and `xcodebuild` on PATH. xcrun records every call (and hangs on the one named in HANG); xcodebuild answers from a
  // script of exit codes and output.
  const rig = (xcodebuild: string, listing = '    iPhone 17 Pro (DEV) (Shutdown) ', before = '') => {
    const b = mkdtempSync(join(tmpdir(), 'cit-'))
    dirs.push(b)
    const calls = join(b, 'calls')
    const log = join(b, 'job.log')
    writeFileSync(join(b, 'listing'), `${listing}\n`)
    writeFileSync(
      join(b, 'xcrun'),
      `#!/bin/bash\necho "xcrun $*" >> "${calls}"\n[ "$HANG" = "$1 $2" ] && exec sleep 600\n[ "$CANCEL" = "$1 $2" ] && { kill -TERM $PPID; exit 143; }\n[ -n "$SIGREC" ] && [ "$1 $2" = "simctl shutdown" ] && { for s in INT TERM HUP; do trap "echo got $s >> \\"$SIGREC\\"; exit 0" $s; done; kill -$SIGSEND $$; sleep 1; echo ignored $SIGSEND >> "$SIGREC"; exit 0; }\n[ "$1 $2" = "simctl list" ] && cat "${join(b, 'listing')}"\nexit 0\n`,
    )
    writeFileSync(
      join(b, 'xcodebuild'),
      `#!/bin/bash\necho "xcodebuild" >> "${calls}"\nn=$(grep -c '^xcodebuild$' "${calls}")\n${xcodebuild}\n`,
    )
    for (const f of ['xcrun', 'xcodebuild']) chmodSync(join(b, f), 0o755)
    writeFileSync(log, before)
    const run = (env: Record<string, string> = {}, dev = 'DEV', after = '') => {
      const r = spawnSync(
        'bash',
        ['-c', `set -o pipefail\n. "${script}"\nci_ios_test "${log}" "${dev}" xcodebuild test\n${after}`],
        {
          env: { ...cleanEnv(), PATH: `${b}:${process.env.PATH}`, ...env },
          encoding: 'utf8',
          timeout: 60_000, // only caps a hang: a call with no limit sleeps for 600 s and the run is killed here, status null
        },
      )
      const seen = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
      return { rc: r.status, seen, log: readFileSync(log, 'utf8'), out: r.stdout }
    }
    return { run }
  }
  const BUSY =
    'Testing failed:\\n\\tSimulator device failed to launch app.talos.shell. The request was denied by service delegate (SBMainWorkspace) for reason: Busy ("Application failed preflight checks").'
  const xcodeCalls = (seen: string[]) => seen.filter((c) => c === 'xcodebuild').length
  const shutdowns = (seen: string[]) => seen.filter((c) => c.startsWith('xcrun simctl shutdown')).length
  const withoutList = (seen: string[]) => seen.filter((c) => c !== 'xcrun simctl list devices')

  it('waits for the device to be ready before the tests start, and puts it back off afterwards', () => {
    const { rc, seen } = rig('exit 0').run()
    expect(rc).toBe(0)
    expect(withoutList(seen)).toEqual(['xcrun simctl bootstatus DEV -b', 'xcodebuild', 'xcrun simctl shutdown DEV'])
  })
  it('leaves a device that was already booted booted', () => {
    const { seen } = rig('exit 0', '    iPhone 17 Pro (DEV) (Booted) ').run()
    expect(shutdowns(seen)).toBe(0)
  })
  it('on the Busy message only: makes the device ready again and runs the tests once more; one that was off is shut down first', () => {
    const r = rig(`if [ "$n" = 1 ]; then printf '${BUSY}\\n'; exit 65; fi\necho second run ok; exit 0`).run()
    expect(r.rc).toBe(0)
    expect(withoutList(r.seen)).toEqual([
      'xcrun simctl bootstatus DEV -b',
      'xcodebuild',
      'xcrun simctl shutdown DEV',
      'xcrun simctl bootstatus DEV -b',
      'xcodebuild',
      'xcrun simctl shutdown DEV',
    ])
    expect(r.log).toContain('trying the tests once more')
  })
  it('never shuts down a device that was already booted, not even for the retry', () => {
    const r = rig(
      `if [ "$n" = 1 ]; then printf '${BUSY}\\n'; exit 65; fi\nexit 0`,
      '    iPhone 17 Pro (DEV) (Booted) ',
    ).run()
    expect(r.rc).toBe(0)
    expect(xcodeCalls(r.seen)).toBe(2)
    expect(shutdowns(r.seen)).toBe(0)
  })
  it('tries only once more: a second Busy is the answer', () => {
    const r = rig(`printf '${BUSY}\\n'; exit 65`).run()
    expect(r.rc).toBe(65)
    expect(xcodeCalls(r.seen)).toBe(2)
  })
  it('does not run again for any other failure, even with the Busy message earlier in the log', () => {
    const r = rig(
      "echo 'Test Case failed: something real'; exit 65",
      undefined,
      `${BUSY.replaceAll('\\n', '\n')}\n`,
    ).run()
    expect(r.rc).toBe(65)
    expect(xcodeCalls(r.seen)).toBe(1)
    expect(shutdowns(r.seen)).toBe(1) // only the put-back-off at the end
  })
  it.each([
    ['another Busy reason', 'for reason: Busy ("Something else")'],
    ['the check text without Busy', 'Application failed preflight checks'],
    ['Busy in other words', 'the device is Busy (application failed preflight checks)'],
  ])('a near miss is not the message: %s', (_name, line) => {
    const r = rig(`echo '${line}'; exit 65`).run()
    expect(r.rc).toBe(65)
    expect(xcodeCalls(r.seen)).toBe(1)
  })
  it('sees the message however long the output after it is (a pipe that ends early would miss it)', () => {
    const r = rig(`printf '${BUSY}\\n'; head -c 3500000 /dev/zero | tr '\\\\0' 'x'; echo; exit 65`).run()
    expect(r.rc).toBe(65)
    expect(xcodeCalls(r.seen)).toBe(2)
  })
  it('a name is the whole name: iPhone 17 is not a booted iPhone 17 Pro', () => {
    const r = rig('exit 0', '    iPhone 17 Pro (OTHER) (Booted) \n    iPhone 17 (DEV) (Shutdown) ').run({}, 'iPhone 17')
    expect(shutdowns(r.seen)).toBe(1)
    const booted = rig('exit 0', '    iPhone 17 Pro (OTHER) (Booted) \n    iPhone 17 (DEV) (Booted) ').run(
      {},
      'iPhone 17',
    )
    expect(shutdowns(booted.seen)).toBe(0)
  })
  it('stops a test run that outlasts the limit and says so', () => {
    const r = rig('exec sleep 30').run({ CI_XCODE_TEST_LIMIT: '1' })
    expect(r.rc).toBe(142)
    expect(r.log).toContain('stopped after 1s, the time limit')
  })
  const stops = (log: string) => log.split('the time limit').length - 1
  it('a hung simctl list holds nothing for ever, and a listing that fails leaves the device running', () => {
    const r = rig('exit 0').run({ CI_SIMCTL_LIMIT: '1', HANG: 'simctl list' })
    expect(r.rc).toBe(0)
    expect(shutdowns(r.seen)).toBe(0) // could not see it: not shut down
  })
  it('a hung bootstatus is stopped at the test limit, said so, and the tests go on', () => {
    const r = rig('exit 0').run({ CI_XCODE_TEST_LIMIT: '1', HANG: 'simctl bootstatus' })
    expect(r.rc).toBe(0)
    expect(r.log).toContain('the simulator did not report booted (exit 142)')
    expect(stops(r.log)).toBe(1)
    expect(xcodeCalls(r.seen)).toBe(1)
  })
  it('a hung shutdown is stopped, at the end and before the retry', () => {
    const end = rig('exit 0').run({ CI_SIMCTL_LIMIT: '1', HANG: 'simctl shutdown' })
    expect(end.rc).toBe(0)
    expect(stops(end.log)).toBe(1)
    const retry = rig(`if [ "$n" = 1 ]; then printf '${BUSY}\\n'; exit 65; fi\nexit 0`).run({
      CI_SIMCTL_LIMIT: '1',
      HANG: 'simctl shutdown',
    })
    expect(retry.rc).toBe(0)
    expect(xcodeCalls(retry.seen)).toBe(2)
    expect(stops(retry.log)).toBe(2) // the one before the second run and the one at the end
  })
  // A cancel is the run's own group getting INT, then TERM (ci_stop_groups). The stubs deliver it the way the runner does: to the
  // shell that is waiting for the call, while that call ends. bash runs its trap once the call it waits for has ended.
  // For INT the call must die of the INT too: a shell that sees its child end by exit code carries on after an INT, as a real
  // cancel never lets it (the whole group gets the signal).
  it.each([
    ['TERM', 143, 'kill -TERM $PPID; exit 143'],
    ['INT', 130, 'kill -INT $PPID; kill -INT $$; sleep 5'],
    ['HUP', 129, 'kill -HUP $PPID; exit 129'],
  ])('a run cancelled by %s during the tests puts a device it had to boot back off', (_signal, code, body) => {
    const r = rig(body).run()
    expect(r.rc).toBe(code)
    expect(withoutList(r.seen)).toEqual(['xcrun simctl bootstatus DEV -b', 'xcodebuild', 'xcrun simctl shutdown DEV'])
  })
  it('a run cancelled while the device is still booting puts it back off and never starts the tests', () => {
    const r = rig('exit 0').run({ CANCEL: 'simctl bootstatus' })
    expect(r.rc).toBe(143)
    expect(withoutList(r.seen)).toEqual(['xcrun simctl bootstatus DEV -b', 'xcrun simctl shutdown DEV'])
    expect(xcodeCalls(r.seen)).toBe(0)
  })
  it('a cancelled run never shuts down a device that was already booted', () => {
    const r = rig('kill -TERM $PPID; exit 143', '    iPhone 17 Pro (DEV) (Booted) ').run()
    expect(r.rc).toBe(143)
    expect(shutdowns(r.seen)).toBe(0)
  })
  it('a cancel during the retry shuts the device down once more, and only a device that was off', () => {
    const r = rig(`if [ "$n" = 1 ]; then printf '${BUSY}\\n'; exit 65; fi\nkill -TERM $PPID; exit 143`).run()
    expect(r.rc).toBe(143)
    expect(shutdowns(r.seen)).toBe(2) // before the retry, and the cancel
  })
  it('a second signal while the cancel is shutting the device down does not shut it down twice', () => {
    const r = rig('kill -TERM $PPID; kill -INT $PPID; exit 143').run()
    expect(shutdowns(r.seen)).toBe(1)
  })
  it('the cancel handler is gone once the tests have ended', () => {
    const r = rig('exit 0').run({}, 'DEV', 'trap -p INT TERM HUP')
    expect(r.rc).toBe(0)
    expect(r.out.trim()).toBe('')
  })
  it('a simulator step that hangs everywhere still ends before a run waiting for the suites mutex gives up', () => {
    // The mobile job holds the machine-wide suites mutex through these calls. A waiter gives up after CI_LOCK_TIMEOUT, so the
    // worst case must be under it. Per ci_ios_test: the listing that picks the device and the one that checks it, two shutdowns
    // (before the Busy retry, at the end) = 4 calls on CI_SIMCTL_LIMIT; a boot wait and a test run, each done twice (the
    // retry) = 4 on CI_XCODE_TEST_LIMIT. The call sites are counted too, so a new limited call cannot be added unnoticed: the two
    // listings and the one shutdown function that the retry, the end and a cancel all call (a cancel is not a wait for the mutex).
    const text = readFileSync(script, 'utf8')
    expect(text.match(/ci_with_limit "\$CI_SIMCTL_LIMIT"/g)).toHaveLength(3)
    expect(text.match(/ci_with_limit "\$CI_XCODE_TEST_LIMIT"/g)).toHaveLength(2)
    // The 4 shutdowns/listings above assume ci_ios_test calls ci_ios_off exactly twice (the Busy retry and the end), and that the
    // cancel handler's one call is the only other. Any further ci_ios_off call, anywhere, adds time the sum does not cover.
    const fn = (name: string) => text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
    const offCalls = (t: string) => t.match(/\bci_ios_off\s+["$]/g) ?? []
    expect(offCalls(fn('ci_ios_test'))).toHaveLength(2)
    expect(offCalls(fn('ci_ios_cancelled'))).toHaveLength(1)
    expect(offCalls(text)).toHaveLength(3) // and none in any other function or in a job
    const env = cleanEnv()
    for (const k of ['CI_SIMCTL_LIMIT', 'CI_XCODE_TEST_LIMIT', 'CI_LOCK_TIMEOUT']) delete env[k]
    const r = spawnSync(
      'bash',
      ['-c', `. "${script}"\necho "$CI_SIMCTL_LIMIT $CI_XCODE_TEST_LIMIT $CI_LOCK_TIMEOUT"`],
      {
        env,
        encoding: 'utf8',
      },
    )
    const [simctl, xcode, lock] = r.stdout.trim().split(' ').map(Number) as [number, number, number]
    expect(lock).toBe(3600)
    expect(4 * simctl + 4 * xcode).toBeLessThan(lock)
  })
  it('the listing that picks the simulator is limited too', () => {
    const b = mkdtempSync(join(tmpdir(), 'cis-'))
    dirs.push(b)
    writeFileSync(join(b, 'xcrun'), '#!/bin/bash\nexec sleep 600\n')
    chmodSync(join(b, 'xcrun'), 0o755)
    const r = spawnSync('bash', ['-c', `. "${script}"\nci_ios_sim_dest`], {
      env: { ...cleanEnv(), PATH: `${b}:${process.env.PATH}`, CI_SIMCTL_LIMIT: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status).toBe(0) // null when the 600 s sleep had to be killed
    expect(r.stdout.trim()).toBe('')
  })
})

describe('the desktop job on a machine without a usable tmux', () => {
  // The real job_desktop, with a fake swift and a desktop app whose ci.sh only leaves a marker.
  const desktopRepo = () => {
    const r = repo('', { swift: 'exit 0' })
    mkdirSync(join(r.clone, 'apps/desktop/scripts'), { recursive: true })
    writeFileSync(join(r.clone, 'apps/desktop/scripts/ci.sh'), '#!/bin/bash\ntouch "$HOME/desktop-ci-ran"\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'desktop app')
    r.git(r.clone, 'push', '-q', 'origin', 'HEAD:main')
    return r
  }
  const go = (r: ReturnType<typeof desktopRepo>, tmux: string) =>
    r.start([...withStatus, '--jobs', 'desktop'], { ...repoArgs, TALOS_CI_FORCE_DESKTOP: '1', CI_TMUX_PATHS: tmux })

  it('fails before the tests, says why in the log, and posts a failure, not a green', async () => {
    const r = desktopRepo()
    const run = go(r, join(r.T, 'no-such-tmux'))
    expect(await run.done).toBe(1)
    expect(existsSync(join(r.home, 'desktop-ci-ran'))).toBe(false)
    expect(r.posted()).toMatch(/state=failure .*context=local-ci\/desktop/)
    expect(r.posted()).not.toMatch(/state=success/)
    expect(
      readFileSync(join(r.cache, 'logs', `${r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')}-desktop.log`), 'utf8'),
    ).toContain('no usable tmux')
  })
  it('runs the tests when a usable tmux is there', async () => {
    const r = desktopRepo()
    const t = join(r.T, 'tmux')
    writeFileSync(t, "#!/bin/bash\necho 'tmux 3.5'\n")
    chmodSync(t, 0o755)
    const run = go(r, t)
    expect(await run.done).toBe(0)
    expect(existsSync(join(r.home, 'desktop-ci-ran'))).toBe(true)
  })
})

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
    const text = readFileSync(script, 'utf8')
    expect(text).toMatch(/E2E_WORKERS="\$\{E2E_WORKERS:-\$\(ci_e2e_workers "\$CI_CPUS" "\$\{CI_MEM_GB:-0\}"\)\}"/)
  })
})

describe('a cancelled run leaves nothing behind', () => {
  const LONG = `
job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }
job_mx() { ci_mutex "$LOCKS" docker sleep 120; }`

  it("no status is left pending: the job it never finished is closed as an error, with the run's link", async () => {
    const r = repo(LONG)
    const run = r.start([...withStatus, '--jobs', 'long'], {
      ...repoArgs,
      CI_STATUS_WHERE: 'ci-runner',
      CI_STATUS_URL: 'https://example.test/runs/9',
    })
    await started(join(r.home, 'child'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    const p = r.posted()
    expect(p).toMatch(/state=pending .*context=local-ci\/long/)
    expect(p).toMatch(
      /state=error .*context=local-ci\/long .*cancelled or interrupted.*target_url=https:\/\/example.test\/runs\/9/,
    )
    expect(p).not.toContain('state=success')
  })

  it('a job that already reported keeps its answer; only the unfinished one is closed', async () => {
    const r = repo(`${LONG}\njob_quick() { :; }`)
    const run = r.start([...withStatus, '--jobs', 'quick,long'], repoArgs)
    await started(join(r.home, 'child'))
    await vi.waitUntil(() => /state=success .*local-ci\/quick/.test(r.posted()), { timeout: 30_000, interval: 25 })
    // The marker is written just after the post. A kill between the two is closed by the check against GitHub (a status that is
    // no longer pending is left alone, see the dead-run test below); this test is about the marker, so it waits for it.
    await vi.waitUntil(() => r.runs().some((d) => existsSync(join(r.cache, 'runs', d, 'reported/quick'))), {
      timeout: 30_000,
      interval: 25,
    })
    run.child.kill('SIGTERM')
    await run.done
    const p = r.posted()
    expect(p).toMatch(/state=error .*context=local-ci\/long/)
    expect(p).not.toMatch(/state=error .*context=local-ci\/quick/)
  })

  it('a mutex a job was holding is released, not left with a dead owner', async () => {
    const r = repo(LONG)
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'mx'])
    await vi.waitUntil(() => r.locks().includes('mutex-docker'), { timeout: 30_000, interval: 25 })
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(r.locks()).toEqual([]) // no slot, no sha lock, no mutex
  })

  it('killed outright: the watchdog does it all: statuses closed, locks released, worktree and temp dir gone', async () => {
    const r = repo(LONG)
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const run = r.start([...withStatus, '--jobs', 'long,mx'], { ...repoArgs, CI_WT_BASE: wtBase })
    await started(join(r.home, 'child'))
    await vi.waitUntil(() => r.locks().includes('mutex-docker'), { timeout: 30_000, interval: 25 })
    expect(readdirSync(wtBase)).toHaveLength(1)
    const child = Number(readFileSync(join(r.home, 'child'), 'utf8'))
    run.child.kill('SIGKILL')
    await run.done
    await vi.waitUntil(() => !alive(child) && r.runs().length === 0, { timeout: 20_000, interval: 50 })
    expect(r.locks()).toEqual([])
    expect(readdirSync(wtBase)).toEqual([])
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1'))).toBe(false)
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/long/)
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/mx/)
  })

  it('a runner that signals every process under a cancelled job (INT, then TERM, then KILL) cannot take the watchdog with it', async () => {
    const r = repo(LONG)
    const run = r.start([...withStatus, '--jobs', 'long'], repoArgs)
    await started(join(r.home, 'child'))
    // Everything under the run, found the way a runner finds it: by parent pid.
    const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number) as [number, number])
    const under = new Set<number>([run.child.pid as number])
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, ppid] of table) {
        if (under.has(ppid) && !under.has(pid)) {
          under.add(pid)
          grew = true
        }
      }
    }
    under.delete(run.child.pid as number)
    expect(under.size).toBeGreaterThan(2) // job group, its sleep, the watchdog, ...
    run.child.kill('SIGKILL') // the run is gone before it can clean up itself
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
      for (const pid of under) spawnSync('kill', [`-${sig.slice(3)}`, String(pid)])
    await run.done
    await vi.waitUntil(() => r.runs().length === 0, { timeout: 20_000, interval: 50 })
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/long/)
    expect(r.locks()).toEqual([])
  })

  it('--reap does the same for a run nothing was left to clean up after (both it and its watchdog killed)', async () => {
    const r = repo()
    const rec = join(r.cache, 'runs/dead-run')
    const wtBase = join(r.T, 'wt-base')
    const wt = join(wtBase, 'talos-ci-abc1234.XXXX')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    mkdirSync(join(wt, 'node_modules'), { recursive: true })
    mkdirSync(join(r.cache, 'tmp/talos-ci-s1'), { recursive: true })
    const owner = '999999\nlong ago\nnonce-1' // a pid that is not running
    writeFileSync(join(rec, 'owner'), owner)
    writeFileSync(join(rec, 'worktree'), wt)
    writeFileSync(join(rec, 'tmp'), join(r.cache, 'tmp/talos-ci-s1'))
    writeFileSync(join(rec, 'repo'), r.clone)
    const sha = 'c'.repeat(40)
    writeFileSync(
      join(rec, 'posted'),
      `owner/repo\tci-runner\thttps://example.test/runs/3\n${sha}\tcheck\n${sha}\tmod\n`,
    )
    writeFileSync(join(rec, 'reported/mod'), '') // mod had its answer
    // A lock that run held, and a lock a live run holds.
    for (const [name, text] of [
      ['slot-1', owner],
      ['slot-2', `${process.pid}\n\nlive`],
    ]) {
      mkdirSync(join(r.cache, 'locks', name!), { recursive: true })
      writeFileSync(join(r.cache, 'locks', name!, 'owner'), text!)
    }
    mkdirSync(join(r.cache, 'runs/live-run'))
    writeFileSync(join(r.cache, 'runs/live-run/owner'), `${process.pid}\n\nlive`)

    const reap = r.start(['--reap'])
    expect(await reap.done).toBe(0)
    expect(existsSync(rec)).toBe(false)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1'))).toBe(false)
    expect(r.locks()).toEqual(['slot-2']) // the dead run's lock is released, the live one's is not
    expect(existsSync(join(r.cache, 'runs/live-run'))).toBe(true)
    const p = r.posted()
    expect(p).toMatch(
      new RegExp(`statuses/${sha} .*state=error .*context=local-ci/check .*target_url=https://example.test/runs/3`),
    )
    expect(p).not.toContain('local-ci/mod')
  })

  it('a stale container and image of the run are removed; Docker already up means colima is not touched', async () => {
    const docker = `echo "docker $*" >> "$CALLS"
case "$1" in
  info) exit 0 ;;
  build) cat > /dev/null; echo "$$" > "$HOME/building"; sleep 120 ;;
  *) exit 0 ;;
esac`
    const r = repo('', { docker, colima: 'echo "colima $*" >> "$CALLS"; exit 0' })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await started(join(r.home, 'building'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
    expect(calls).toMatch(/docker rm -f talos-ci-s1-[0-9a-f]{7}-\d+/)
    expect(calls).toMatch(/docker image rm -f talos-relay:ci-[0-9a-f]{7}-s1/)
    expect(calls).not.toContain('colima')
    expect(r.runs()).toEqual([])
  })

  it('cut off in the middle of `colima start`, the half-started VM is stopped; a start that finished is left running', async () => {
    const docker = `echo "docker $*" >> "$CALLS"; [ -f "$HOME/up" ] && exit 0; exit 1`
    const colima = `echo "colima $*" >> "$CALLS"
case "$1" in start) echo "$$" > "$HOME/starting"; sleep 120 ;; *) exit 0 ;; esac`
    const r = repo('', { docker, colima })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await started(join(r.home, 'starting'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(readFileSync(r.env.CALLS as string, 'utf8')).toContain('colima stop --force')

    // The same job when the start completes: nothing stops it.
    const ok = repo('', {
      docker: `echo "docker $*" >> "$CALLS"; case "$1" in info) [ -f "$HOME/up" ]; exit ;; build) cat > /dev/null; exit 1 ;; *) exit 0 ;; esac`,
      colima: 'echo "colima $*" >> "$CALLS"; touch "$HOME/up"; exit 0',
    })
    const done = ok.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await done.done
    const calls = readFileSync(ok.env.CALLS as string, 'utf8')
    expect(calls).toContain('colima start')
    expect(calls).not.toContain('colima stop')
  })
})

describe('what stays inside the run', () => {
  it('no job sees the runner settings or the token, though the run itself still uses them', async () => {
    const r = repo('job_env() { env | sort > "$HOME/jobenv"; }', {
      gh: 't=none; [ -n "$GH_TOKEN" ] && t=$GH_TOKEN; case "$1" in repo) exit 1 ;; api) echo "$* token=$t" >> "$GH_LOG" ;; esac',
    })
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const run = r.start([...withStatus, '--jobs', 'env'], {
      ...repoArgs,
      CI_STATUS_WHERE: 'ci-runner',
      CI_STATUS_URL: 'https://example.test/runs/9',
      CI_SHA_FILE: join(r.T, 'sha'),
      CI_WT_BASE: wtBase,
      CI_SLEEP_GUARD: '0',
      GH_TOKEN: 'a-token',
      GITHUB_TOKEN: 'a-token',
    })
    expect(await run.done).toBe(0)
    // Every test a job starts that runs its own ci-local.sh (a fake repo, a fake gh) would otherwise post to this one's commit,
    // write this one's sha file, call itself ci-runner, and a job could post a pass for any commit with the token.
    expect(readFileSync(join(r.home, 'jobenv'), 'utf8')).not.toMatch(
      /^(CI_REPO|CI_STATUS_WHERE|CI_STATUS_URL|CI_SHA_FILE|CI_WT_BASE|CI_SLEEP_GUARD|GH_TOKEN|GITHUB_TOKEN)=/m,
    )
    // ... while the run's own statuses still carry all of it.
    expect(r.posted()).toMatch(
      /description=passed on ci-runner .*target_url=https:\/\/example.test\/runs\/9 token=a-token/,
    )
    expect(readFileSync(join(r.T, 'sha'), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('the token is out of the jobs only: the statuses of a run killed outright are still closed with it', async () => {
    const r = repo('job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }', {
      gh: 't=none; [ -n "$GH_TOKEN" ] && t=$GH_TOKEN; case "$1" in repo) exit 1 ;; api) echo "$* token=$t" >> "$GH_LOG" ;; esac',
    })
    const run = r.start([...withStatus, '--jobs', 'long'], { ...repoArgs, GH_TOKEN: 'a-token' })
    await started(join(r.home, 'child'))
    run.child.kill('SIGKILL')
    await run.done
    await vi.waitUntil(() => r.runs().length === 0, { timeout: 20_000, interval: 50 })
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/long .* token=a-token/)
  })

  it('--keep keeps the worktree, and still empties the slot temp dir', async () => {
    const r = repo('job_ok() { :; }')
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'ok', '--keep'], { CI_WT_BASE: wtBase })
    expect(await run.done).toBe(0)
    expect(readdirSync(wtBase)).toHaveLength(1)
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1'))).toBe(false)
  })

  it('the slot temp dir is emptied before the slot is let go, never after: the next run may already be using it', async () => {
    // Stand in for "the next run took the slot": the first time locks are released, a new run's temp dir appears. Cleanup that wipes
    // the dir AFTER that moment deletes the live one.
    const hook = `ci_release_owned() { [ -e "$HOME/released" ] && return 0; : > "$HOME/released"; mkdir -p "$SLOT_TMP" && : > "$SLOT_TMP/next-run"; }`
    const r = repo(`job_ok() { :; }\n${hook}`)
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'ok'])
    expect(await run.done).toBe(0)
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1/next-run'))).toBe(true)
  })

  it('a scratch worktree that cannot be made stops the run with a reason, and kills nothing', async () => {
    const r = repo('job_ok() { :; }')
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'ok'], { CI_WT_BASE: join(r.T, 'no-such-dir') })
    expect(await run.done).toBe(1)
    expect(run.out()).toContain("cannot make a scratch worktree under '")
    expect(r.runs()).toEqual([])
    expect(r.locks()).toEqual([])
  })
})

describe('ci_kill_inside only ever kills what is inside a run worktree', () => {
  // The function with `lsof` and `kill` replaced: lsof lists a process whose cwd is wherever the test says, kill writes down who.
  const kills = (target: string, procCwd: string, cwd: string) => {
    const T = mkdtempSync(join(tmpdir(), 'cilk-'))
    dirs.push(T)
    const out = join(T, 'killed')
    const r = spawnSync(
      'bash',
      [
        '-c',
        `. "${script}"
lsof() { printf 'p4242\\nn%s\\n' "$PROC_CWD"; }
kill() { echo "$@" >> "$OUT"; }
ci_kill_inside "$TARGET"`,
      ],
      { cwd, env: { ...cleanEnv(), PROC_CWD: procCwd, OUT: out, TARGET: target }, encoding: 'utf8' },
    )
    expect(r.status).toBe(0)
    return existsSync(out) ? readFileSync(out, 'utf8').trim() : ''
  }
  const real = (d: string) => execFileSync('realpath', [d], { encoding: 'utf8' }).trim()

  it('an empty path is no path: it must not become the current directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'cilk-d-'))
    dirs.push(d)
    expect(kills('', real(d), d)).toBe('')
  })
  it('and neither is the root: every process started from / would be a target', () => {
    expect(kills('/', '/', '/tmp')).toBe('')
  })
  it('a path that is not there kills nothing', () => {
    expect(kills('/no/such/worktree', '/no/such/worktree', '/tmp')).toBe('')
  })
  it('a real worktree: its processes, and only they', () => {
    const d = mkdtempSync(join(tmpdir(), 'cilk-wt-'))
    dirs.push(d)
    expect(kills(d, `${real(d)}/apps/web`, '/tmp')).toBe('-KILL 4242')
    expect(kills(d, '/elsewhere', '/tmp')).toBe('')
  })
})

describe('a status that someone else answered is not overwritten by a dead run', () => {
  it('closes only the pending ones that still carry its own link', async () => {
    // GET answers with what GitHub holds now; the POSTs are what the dead run does about it.
    const gh = `case "$1" in repo) exit 1 ;; api) case "$*" in *"-X POST"*) echo "$*" >> "$GH_LOG" ;; *) cat "$HOME/rows" ;; esac ;; esac`
    const r = repo('', { gh })
    const url = 'https://example.test/runs/3'
    const sha = 'c'.repeat(40)
    const rows = [
      `local-ci/ours\tpending\t${url}`, // still the pending one this run posted: closed
      `local-ci/passed-elsewhere\tsuccess\t`, // the owner's Mac passed it since: left alone
      `local-ci/failed-elsewhere\tfailure\t${url}`, // answered, even with our link: left alone
      `local-ci/newer-run\tpending\thttps://example.test/runs/4`, // a newer run's pending: left alone
      `ci/unrelated\tpending\t${url}`,
    ]
    writeFileSync(join(r.home, 'rows'), `${rows.join('\n')}\n`)
    const rec = join(r.cache, 'runs/dead-run')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    writeFileSync(join(rec, 'owner'), '999999\nlong ago\nnonce-1')
    writeFileSync(
      join(rec, 'posted'),
      `owner/repo\tci-runner\t${url}\n${['ours', 'passed-elsewhere', 'failed-elsewhere', 'newer-run', 'unlisted'].map((j) => `${sha}\t${j}`).join('\n')}\n`,
    )
    const reap = r.start(['--reap'])
    expect(await reap.done).toBe(0)
    const p = r.posted()
    expect(p).toMatch(/state=error .*context=local-ci\/ours /)
    expect(p).not.toContain('passed-elsewhere')
    expect(p).not.toContain('failed-elsewhere')
    expect(p).not.toContain('newer-run')
    // GitHub shows nothing for a job we posted: it can't be told apart from a failed read, and a status left pending is worse.
    expect(p).toMatch(/state=error .*context=local-ci\/unlisted /)
    expect(existsSync(rec)).toBe(false)
  })
})

describe('colima is not the runner job', () => {
  it("starts without the runner's tracking id, so the runner's orphan cleanup at the end of the job leaves the VM up", async () => {
    const r = repo('', {
      docker: `echo "docker $*" >> "$CALLS"; case "$1" in info) [ -f "$HOME/up" ]; exit ;; build) cat > /dev/null; exit 1 ;; *) exit 0 ;; esac`,
      colima:
        't=unset; [ -n "$RUNNER_TRACKING_ID" ] && t=$RUNNER_TRACKING_ID; echo "colima $* tracking=$t" >> "$CALLS"; touch "$HOME/up"; exit 0',
    })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'], { RUNNER_TRACKING_ID: 'github_123' })
    await run.done
    expect(readFileSync(r.env.CALLS as string, 'utf8')).toContain('colima start tracking=unset')
  })
})

describe('a job that warned', () => {
  it('passes, and its result line and status say so; a quiet job says nothing', async () => {
    const r = repo(
      'job_warned() { warn_step warned "$1" "the sample step found something" false; }\njob_quiet() { warn_step quiet "$1" "never" true; }',
    )
    const run = r.start([...withStatus, '--jobs', 'warned,quiet'], repoArgs)
    expect(await run.done).toBe(0)
    expect(run.out()).toContain('! warning: the sample step found something (exit 1: false)')
    expect(r.posted()).toMatch(
      /state=success .*context=local-ci\/warned .*description=passed on .*, with warnings \(see its log\)/,
    )
    expect(r.posted()).not.toMatch(/context=local-ci\/quiet .*description=passed on .*with warnings/)
  })
})

describe('a Mac that slept warns by default, and CI_SLEEP_GUARD=1 stops it reporting a pass', () => {
  const WAKE_AFTER = (offset: number) =>
    `if [ "$2" = kern.waketime ]; then echo "{ sec = $(( $(date +%s) + (${offset}) )), usec = 7 }"; exit 0; fi; exec /usr/sbin/sysctl "$@"`
  const ok = 'job_ok() { :; }'

  it('a job that finished green after a wake during the run still passes, with a warning', async () => {
    const r = repo(ok, { sysctl: WAKE_AFTER(+60) }) // "woke" a minute after the run began
    const run = r.start([...withStatus, '--jobs', 'ok'], repoArgs)
    expect(await run.done).toBe(0)
    expect(run.out()).toContain('! warning: the Mac slept during this run')
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/ok .*with warnings/)
    expect(r.posted()).not.toContain('state=error')
  })

  it('with CI_SLEEP_GUARD=1 that job is an error, not a success; the run fails', async () => {
    const r = repo(ok, { sysctl: WAKE_AFTER(+60) })
    const run = r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' })
    expect(await run.done).toBe(1)
    const p = r.posted()
    expect(p).toMatch(/state=error .*context=local-ci\/ok .*the Mac slept during the run/)
    expect(p).not.toContain('state=success')
    expect(run.out()).toContain('FAILED: ok')
  })

  it('a wake from before the run began, or no sleep at all, changes nothing', async () => {
    const r = repo(ok, { sysctl: WAKE_AFTER(-600) })
    expect(await r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(0)
    expect(r.posted()).toContain('state=success')
    const never = repo(ok, {
      sysctl: 'if [ "$2" = kern.waketime ]; then echo "{ sec = 0, usec = 7 }"; exit 0; fi; exec /usr/sbin/sysctl "$@"',
    })
    expect(await never.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(0)
    expect(never.posted()).not.toContain('with warnings')
  })

  it('a Mac whose wake time cannot be read counts as slept: a warning by default, a failure with CI_SLEEP_GUARD=1', async () => {
    const blind = { sysctl: 'if [ "$2" = kern.waketime ]; then exit 1; fi; exec /usr/sbin/sysctl "$@"' }
    const r = repo(ok, blind)
    expect(await r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(1)
    const off = repo(ok, blind)
    expect(await off.start([...withStatus, '--jobs', 'ok'], repoArgs).done).toBe(0)
    expect(off.posted()).toContain('with warnings')
  })

  it('a skipped job does not depend on the Mac being awake', async () => {
    const r = repo('job_skip() { SKIPPED+=(skip); SKIP_WHY="no changes"; return 0; }', { sysctl: WAKE_AFTER(+60) })
    expect(await r.start([...withStatus, '--jobs', 'skip'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(0)
    expect(r.posted()).toContain('skipped (no changes)')
  })

  it('ci_slept_since: strictly after the moment asked about', () => {
    const t = (offset: number, since: number) =>
      spawnSync('bash', ['-c', `. "${script}"; ci_slept_since ${since}`], {
        env: {
          ...cleanEnv(),
          PATH: `${repo('', { sysctl: `if [ "$2" = kern.waketime ]; then echo "{ sec = ${offset}, usec = 7 }"; exit 0; fi; exec /usr/sbin/sysctl "$@"` }).T}/bin:${process.env.PATH}`,
        },
      }).status
    expect(t(1000, 999)).toBe(0) // woke after: slept
    expect(t(1000, 1000)).toBe(1) // woke at the same second: not after
    expect(t(1000, 2000)).toBe(1)
  })
})
