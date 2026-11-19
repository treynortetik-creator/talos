// scripts/ci-local.sh as the self-hosted runner uses it (docs/CI-LOCAL.md, "On the self-hosted runner"): what a cancelled run leaves behind
// (nothing: no held lock, no stale container, no half-started colima, no status stuck pending), what a status says and links to,
// where the scratch goes, and a Mac that slept warning by default. The same harness as ci-local-jobs.test.ts: a local
// "origin", a fake `gh` that records the statuses it is asked to post, fake `pnpm`/`docker`/`colima`/`sysctl`.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
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
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { ciLocalSource, cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })

const dirs: string[] = []
const live: ChildProcess[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const _alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
const _started = (f: string) =>
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

describe('ci_ios_sim_dest: the runner slot has its own simulator', () => {
  // A fake xcrun: it serves a device listing and a runtime listing, records every call, and answers `simctl create` with a fixed id.
  // Nothing here reaches a real simulator.
  const CREATED = 'CCCCCCCC-0000-4000-8000-000000000003'
  const runtimes = (rows: { id: string; version: string; types: string[] }[]) =>
    JSON.stringify({
      runtimes: rows.map((r) => ({
        identifier: r.id,
        version: r.version,
        isAvailable: true,
        supportedDeviceTypes: r.types.map((n) => ({ name: n, identifier: `type.${n.replace(/ /g, '-')}` })),
      })),
    })
  const IOS27 = {
    id: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
    version: '27.2',
    types: ['iPhone 17', 'iPhone 18', 'iPad Air'],
  }
  const IOS26 = {
    id: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
    version: '26.3',
    types: ['iPhone 17 Pro', 'iPhone 17'],
  }
  const row = (name: string, udid: string) => ({ name, udid, isAvailable: true })
  const run = (devices: ReturnType<typeof row>[], rts: string, env: Record<string, string> = {}) => {
    const b = mkdtempSync(join(tmpdir(), 'cis-'))
    dirs.push(b)
    const calls = join(b, 'calls')
    writeFileSync(
      join(b, 'devices'),
      JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-3': devices } }),
    )
    writeFileSync(join(b, 'runtimes'), rts)
    writeFileSync(
      join(b, 'xcrun'),
      `#!/bin/bash\necho "xcrun $*" >> "${calls}"\ncase "$1 $2 $3" in\n"simctl list -j") [ -n "$HANG" ] && exec sleep 600; [ -n "$FAIL_DEVICES" ] && { echo "boom"; exit 1; }; cat "${join(b, 'devices')}" ;;\n"simctl list runtimes") [ -n "$FAIL_RUNTIMES" ] && { echo "boom"; exit 1; }; cat "${join(b, 'runtimes')}" ;;\n"simctl create "*) [ -n "$CREATE_FAIL" ] && { echo "create refused" >&2; exit 1; }; echo "$CREATE_OUT" ;;\nesac\nexit 0\n`,
    )
    chmodSync(join(b, 'xcrun'), 0o755)
    const r = spawnSync('bash', ['-c', `. "${script}"\nCI_SLOT=${env.CI_SLOT ?? 1}\nci_ios_sim_dest`], {
      env: { ...cleanEnv(), PATH: `${b}:${process.env.PATH}`, CREATE_OUT: CREATED, ...env },
      encoding: 'utf8',
    })
    const seen = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
    return { dest: r.stdout.trim(), err: r.stderr, seen }
  }
  const ID1 = 'AAAAAAAA-0000-4000-8000-000000000001'
  const ID2 = 'BBBBBBBB-0000-4000-8000-000000000002'
  const SHARED = row('iPhone 17 Pro', 'DDDDDDDD-0000-4000-8000-000000000004')
  const only = (seen: string[], sub: string) => seen.filter((c) => c.includes(sub))
  const mutating = (seen: string[]) => seen.filter((c) => /boot|shutdown|erase|install/.test(c))

  it('uses the slot simulator that exists, by id, and touches no other device', () => {
    const r = run([SHARED, row('talos-ci-s1', ID1)], runtimes([IOS26]), { CI_SLOT: '1' })
    expect(r.dest).toBe(`platform=iOS Simulator,id=${ID1}`)
    expect(r.err).toContain('talos-ci-s1')
    expect(only(r.seen, 'create')).toEqual([])
    expect(mutating(r.seen)).toEqual([])
  })
  it('creates a missing one on the newest runtime and its newest plain iPhone type, then uses it', () => {
    const r = run([SHARED], runtimes([IOS26, IOS27]), { CI_SLOT: '2' })
    expect(r.dest).toBe(`platform=iOS Simulator,id=${CREATED}`)
    expect(only(r.seen, 'create')).toEqual([`xcrun simctl create talos-ci-s2 type.iPhone-18 ${IOS27.id}`])
    expect(r.err).toContain('talos-ci-s2')
    expect(mutating(r.seen)).toEqual([])
  })
  it('gives a different slot a different simulator', () => {
    const devices = [row('talos-ci-s1', ID1), row('talos-ci-s2', ID2)]
    expect(run(devices, runtimes([IOS26]), { CI_SLOT: '1' }).dest).toBe(`platform=iOS Simulator,id=${ID1}`)
    expect(run(devices, runtimes([IOS26]), { CI_SLOT: '2' }).dest).toBe(`platform=iOS Simulator,id=${ID2}`)
    // a name that only starts the same is not the same slot
    expect(run([row('talos-ci-s10', ID2)], runtimes([IOS26]), { CI_SLOT: '1' }).dest).toBe(
      `platform=iOS Simulator,id=${CREATED}`,
    )
  })
  it('TALOS_IOS_SIM set by hand wins and nothing is listed or created', () => {
    const r = run([row('talos-ci-s1', ID1)], runtimes([IOS26]), { CI_SLOT: '1', TALOS_IOS_SIM: 'Test Phone' })
    expect(r.dest).toBe('platform=iOS Simulator,name=Test Phone')
    expect(r.seen).toEqual([])
  })
  it('fails clearly, creating nothing, when no iOS runtime has an iPhone type', () => {
    for (const rts of [runtimes([]), runtimes([{ ...IOS26, types: ['iPad Air'] }]), '']) {
      const r = run([SHARED], rts, { CI_SLOT: '1' })
      expect(r.dest).toBe('')
      expect(r.err).toContain('no iOS runtime')
      expect(only(r.seen, 'create')).toEqual([])
    }
  })
  it('a failed or timed-out device listing makes nothing: it is not "missing"', () => {
    const failed = run([SHARED], runtimes([IOS26]), { CI_SLOT: '1', FAIL_DEVICES: '1' })
    expect(failed.dest).toBe('')
    expect(failed.err).toContain('could not list the simulators')
    expect(only(failed.seen, 'create')).toEqual([])
    const hung = run([SHARED], runtimes([IOS26]), { CI_SLOT: '1', CI_SIMCTL_LIMIT: '1', HANG: '1' })
    expect(hung.dest).toBe('')
    expect(only(hung.seen, 'create')).toEqual([])
  })
  it('a failed runtime listing says so, and is not "no iOS runtime"', () => {
    const r = run([SHARED], '', { CI_SLOT: '1', FAIL_RUNTIMES: '1' })
    expect(r.dest).toBe('')
    expect(r.err).toContain('could not list the simulator runtimes')
    expect(r.err).not.toContain('no iOS runtime')
    expect(only(r.seen, 'create')).toEqual([])
  })
  it("a create that fails or answers with anything but a UDID gives no device, and simctl's reason reaches stderr", () => {
    const failed = run([SHARED], runtimes([IOS26]), { CI_SLOT: '1', CREATE_FAIL: '1' })
    expect(failed.dest).toBe('')
    expect(failed.err).toContain('create refused')
    expect(failed.err).toContain('could not create the simulator talos-ci-s1')
    for (const junk of [
      'ci-local: stopped after 120s, the time limit',
      'not-a-udid',
      'cccccccc-0000-4000-8000-000000000003',
    ]) {
      const r = run([SHARED], runtimes([IOS26]), { CI_SLOT: '1', CREATE_OUT: junk })
      expect(r.dest, junk).toBe('')
      expect(r.err).toContain('could not create the simulator')
    }
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
      `#!/bin/bash\necho "xcrun $*" >> "${calls}"\n[ "$HANG" = "$1 $2" ] && exec sleep 600\n[ "$CANCEL" = "$1 $2" ] && { kill -TERM $PPID; exit 143; }\n[ -n "$SIGREC" ] && [ "$1 $2" = "simctl shutdown" ] && { for s in INT TERM HUP; do trap "echo got $s >> \\"$SIGREC\\"; exit 0" $s; done; kill -$SIGSEND $$; sleep 1; echo ignored $SIGSEND >> "$SIGREC"; exit 0; }\n[ "$1 $2" = "simctl list" ] && { [ -n "$SLOW_LIST" ] && sleep "$SLOW_LIST"; cat "${join(b, 'listing')}"; }\nexit 0\n`,
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
    // The same limit also caps the stub test run that follows, so it must be long enough for that stub to start and exit on a
    // loaded Mac: at 1 s it was itself stopped (rc 142) while CI ran other suites. The hang is still stopped at the limit.
    const r = rig('exit 0').run({ CI_XCODE_TEST_LIMIT: '5', HANG: 'simctl bootstatus' })
    expect(r.rc).toBe(0)
    expect(r.log).toContain('the simulator did not report booted (exit 142)')
    expect(stops(r.log)).toBe(1)
    expect(xcodeCalls(r.seen)).toBe(1)
  })
  it('a listing that runs out of time leaves the device running: nothing is shut down, so nothing is stopped', () => {
    // The mechanism behind the flake below, made certain: the device list that decides "was it already booted" is on the same limit
    // as the shutdown. A list slower than the limit says yes (booted), so the end never shuts down and never hangs.
    const r = rig('exit 0').run({ CI_SIMCTL_LIMIT: '1', HANG: 'simctl shutdown', SLOW_LIST: '2' })
    expect(r.rc).toBe(0)
    expect(shutdowns(r.seen)).toBe(0)
    expect(stops(r.log)).toBe(0) // the symptom seen in CI: no "stopped after" line, because the shutdown never ran
  })
  it('a hung shutdown is stopped, at the end and before the retry', () => {
    // The limit is 3 s, not 1: the listing before the run shares it (see the test above), and a loaded Mac (CI_SIMCTL_LIMIT=1 failed
    // once in CI on 389143df: stops 0) can take over a second to start the stub and answer.
    const end = rig('exit 0').run({ CI_SIMCTL_LIMIT: '3', HANG: 'simctl shutdown' })
    expect(end.rc).toBe(0)
    expect(stops(end.log)).toBe(1)
    const retry = rig(`if [ "$n" = 1 ]; then printf '${BUSY}\\n'; exit 65; fi\nexit 0`).run({
      CI_SIMCTL_LIMIT: '3',
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
  it('a simulator step that hangs everywhere still ends before a run waiting for the desktop mutex gives up', () => {
    // The mobile job holds the machine-wide desktop mutex through these calls. A waiter gives up after CI_LOCK_TIMEOUT, so the
    // worst case must be under it. Per ci_ios_test: the device listing, the runtime listing and the create of ci_ios_sim_dest, the listing that checks it, two shutdowns
    // (before the Busy retry, at the end) = 6 calls on CI_SIMCTL_LIMIT; a boot wait and a test run, each done twice (the
    // retry) = 4 on CI_XCODE_TEST_LIMIT. The call sites are counted too, so a new limited call cannot be added unnoticed: the three calls in ci_ios_sim_dest,
    // the check listing and the one shutdown function that the retry, the end and a cancel all call (a cancel is not a wait for the mutex).
    const text = ciLocalSource() // ci-local.sh and the parts it sources
    expect(text.match(/ci_with_limit "\$CI_SIMCTL_LIMIT"/g)).toHaveLength(5)
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
    expect(6 * simctl + 4 * xcode).toBeLessThan(lock)
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
