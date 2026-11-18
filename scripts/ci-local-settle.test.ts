// ci-local.sh settle: a push run of main (ci-runner.sh sets CI_SETTLE=1 for it, and for nothing else) waits, before any slot or job,
// until origin/main's head has been the same for TALOS_CI_SETTLE_S; a head that is no longer its own sha means a newer push has
// its own run, so it stands aside as report-ci/superseded ("not tested:", never red, never green); after TALOS_CI_SETTLE_MAX_S of
// waiting in all (counted across the runs that stood aside one after another) it runs on its own sha anyway.
// The same harness as ci-local-runner-status.test.ts (a bare origin, a fake gh that records what it is asked to post) with a fake
// clock: `date +%s` reads a file and `sleep` advances it, so the numbers below are the real defaults (300, 900, 30) and no test waits.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })

const dirs: string[] = []
const live: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const realDate = ['/bin/date', '/usr/bin/date'].find((p) => existsSync(p)) as string

function repo(jobs = 'job_mod() { :; }', gh = '') {
  const T = mkdtempSync(join(tmpdir(), 'cil-settle-'))
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
  copyCiLocalParts(join(clone, 'scripts'))
  for (const h of ['ci-swift-retry.sh', 'ci-flake-vitest.ts'])
    writeFileSync(join(clone, 'scripts', h), readFileSync(join(dirname(script), h), 'utf8'))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const tool = (name: string, body: string) => fakeTool(bin, name, `#!/bin/bash\n${body}\n`)
  // the statuses a read of a commit returns come from the STATUSES file ("context<TAB>state<TAB>link<TAB>description" rows)
  tool(
    'gh',
    `case "$1" in repo) exit 1 ;; api) echo "$*" >> "$GH_LOG"; case "$*" in *"/commits/"*"/statuses"*) cat "$STATUSES" 2>/dev/null ;; esac; ${gh} ;; esac`,
  )
  tool('pnpm', 'exit 0')
  tool('bun', 'exit 0')
  // The clock: a file of seconds. `date +%s` reads it; every other date call is the real one. `sleep 30` (the settle poll) adds 30 to
  // it, and every sleep returns after a real tick (a loop that sleeps stays cheap; the watchdog's `sleep 1` moves nothing). The Nth sleep of 30 s (the settle poll) runs MOVE_CMD once, when MOVE_AT
  // says N: main moves while the run sleeps.
  const clock = join(T, 'clock')
  const polls = join(T, 'polls')
  writeFileSync(clock, `${Math.floor(Date.now() / 1000)}\n`)
  tool(
    'date',
    `if [ "$*" = "+%s" ]; then awk -v c="$(cat "$CLOCK")" 'BEGIN { printf "%d\\n", c }'; else exec "${realDate}" "$@"; fi`,
  )
  tool(
    'sleep',
    `if [ "$1" = 30 ]; then
  awk -v c="$(cat "$CLOCK")" 'BEGIN { printf "%d\\n", c + 30 }' > "$CLOCK.new" && mv -f "$CLOCK.new" "$CLOCK"
  n=$(($(cat "$POLLS" 2>/dev/null || echo 0) + 1)); echo "$n" > "$POLLS"
  case " \${MOVE_AT:-} " in *" $n "*) bash "$MOVE_CMD" ;; esac
  [ -z "\${MOVE_EVERY:-}" ] || [ $((n % MOVE_EVERY)) != 0 ] || bash "$MOVE_CMD"
fi
/bin/sleep 0.01`,
  )
  // a push to main from elsewhere: one more commit on origin
  const move = join(T, 'move.sh')
  writeFileSync(
    move,
    `#!/bin/bash\ngit -C "${src}" -c user.name=t -c user.email=t@example.com commit --allow-empty -qm moved && git -C "${src}" push -q "${origin}" main\n`,
  )
  chmodSync(move, 0o755)
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
    CLOCK: clock,
    POLLS: polls,
    MOVE_CMD: move,
    STATUSES: join(T, 'statuses'),
    CI_REPO: 'owner/repo',
    CI_SETTLE: '1',
    CI_STATUS_URL: 'https://example.test/run/1',
    CI_SHA_FILE: join(T, 'ci-sha'),
  }
  const cache = join(home, '.cache/talos-ci')
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
    return { done, out: () => out }
  }
  const now = () => Number(readFileSync(clock, 'utf8').trim().split('.')[0])
  const posted = () => (existsSync(env.GH_LOG as string) ? readFileSync(env.GH_LOG as string, 'utf8') : '')
  const head = () => git(clone, 'rev-parse', 'HEAD')
  const push = () => spawnSync('bash', [move])
  const state = () =>
    existsSync(join(cache, 'settle-chain')) ? readFileSync(join(cache, 'settle-chain'), 'utf8').trim() : ''
  // the chain so far: when its first run stood aside, and when the last of them did
  const seed = (since: number, last: number) => {
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'settle-chain'), `${since} ${last}\n`)
  }
  const tick = (secs: number) => writeFileSync(clock, `${now() + secs}\n`) // time passes outside the run (a remote part working)
  const tip = () => git(origin, 'rev-parse', 'main') // main as GitHub has it
  return { T, clone, git, start, env, cache, now, posted, head, push, state, seed, tick, tip, origin }
}
const ctx = (p: string, c: string) => new RegExp(`state=\\w+ .*context=${c.replace('/', '\\/')} `).test(p)
const localCi = (p: string) => p.split('\n').filter((l) => l.includes('context=local-ci/'))
const short = (s: string) => s.slice(0, 7)

describe('ci-local.sh settle: a main push run waits for a head that has been quiet', () => {
  it('a head that stays put runs after TALOS_CI_SETTLE_S (300 s), and says how long it was quiet', async () => {
    const r = repo()
    const t0 = r.now()
    const sha = r.head()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toMatch(/settle: .*quiet.* 300 ?s/)
    expect(r.now() - t0).toBeGreaterThanOrEqual(300)
    expect(r.now() - t0).toBeLessThan(900) // the cap is the other number, not this one
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
    expect(ctx(r.posted(), 'report-ci/superseded')).toBe(false)
    expect(r.state()).toBe('') // nothing left for the next run to count
  })
})

describe('ci-local.sh settle: a head that moved means a newer push has its own run', () => {
  it('stands aside: report-ci/superseded (success, "not tested:") and nothing under local-ci/, neither red nor green', async () => {
    const r = repo()
    const sha = r.head()
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { MOVE_AT: '3' })
    expect(await run.done, run.out()).toBe(0)
    const newer = r.git(r.origin, 'rev-parse', 'main')
    expect(newer).not.toBe(sha)
    expect(run.out()).toContain(`superseded by ${short(newer)}; that run tests it`)
    // the old sha now says so, with the words every other superseded commit has
    expect(r.posted()).toMatch(
      new RegExp(
        `statuses/${sha} -f state=success -f context=report-ci/superseded -f description=not tested: superseded by ${short(newer)}; CI tests main's newest commit`,
      ),
    )
    expect(localCi(r.posted())).toEqual([]) // no pending, no failure, no pass under the six
    expect(r.now() - t0).toBeLessThan(300) // it did not wait out the quiet time
    // it never got as far as a slot, a worktree or a commit file: the sweep after it has nothing to close
    expect(existsSync(join(r.cache, 'locks', 'slot-1'))).toBe(false)
    expect(existsSync(r.env.CI_SHA_FILE as string)).toBe(false)
    // and the workflow's later steps are told (ci-runner.sh settled)
    expect(readFileSync(`${r.env.CI_SHA_FILE}.superseded`, 'utf8').trim()).toBe(newer)
  })

  it('a head that had already moved when the run began stands aside at once', async () => {
    const r = repo()
    const sha = r.head()
    r.push()
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('superseded by')
    expect(r.now() - t0).toBe(0)
    expect(localCi(r.posted())).toEqual([])
  })

  it('a mark GitHub would not take means it runs: unmarked, a skip would look like "untested and fine"', async () => {
    const r = repo('job_mod() { :; }', 'case "$*" in *report-ci/superseded*) exit 1 ;; esac')
    const sha = r.head()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { MOVE_AT: '2' })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('could not be marked superseded')
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
    expect(existsSync(`${r.env.CI_SHA_FILE}.superseded`)).toBe(false)
  })

  it('a run that posts nothing (--no-status) stands aside without posting', async () => {
    const r = repo()
    const sha = r.head()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod', '--no-status'], { MOVE_AT: '1' })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('superseded by')
    expect(r.posted()).toBe('')
  })
})

describe('ci-local.sh settle: the cap, so a main that never pauses is still tested', () => {
  it('900 s (TALOS_CI_SETTLE_MAX_S) after its chain began, it runs on its own sha although main moved', async () => {
    const r = repo()
    const sha = r.head()
    r.push() // main has moved on
    // the chain began 900 s ago: the runs since stood aside one after another
    r.seed(r.now() - 900, r.now() - 5)
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toMatch(/settle: .*waited 900 ?s .*testing /)
    expect(run.out()).toContain(short(sha))
    expect(r.posted()).toMatch(new RegExp(`statuses/${sha} .*context=local-ci/mod `))
    expect(ctx(r.posted(), 'report-ci/superseded')).toBe(false)
    expect(r.state()).toBe('') // the chain is over: the next run starts a new one
  })

  it('the cap is reached while it waits: main moves at the last poll and the run goes on regardless', async () => {
    const r = repo()
    const sha = r.head()
    r.seed(r.now() - 870, r.now() - 5) // 30 s short of the cap: one poll left
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { MOVE_AT: '1' })
    expect(await run.done, run.out()).toBe(0)
    expect(r.git(r.origin, 'rev-parse', 'main')).not.toBe(sha)
    expect(run.out()).toMatch(/waited 9\d\d ?s/)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
    expect(ctx(r.posted(), 'report-ci/superseded')).toBe(false)
  })

  it("runs that stand aside one after another are one chain: the second keeps the first one's start", async () => {
    const r = repo()
    const a = r.head()
    const t0 = r.now()
    const one = r.start(['--ref', a, '--sha', a, '--jobs', 'mod'], { MOVE_AT: '5' })
    expect(await one.done, one.out()).toBe(0)
    expect(r.state()).toBe(`${t0} ${t0 + 150}`) // five polls of 30 s
    const b = r.tip()
    const two = r.start(['--ref', b, '--sha', b, '--jobs', 'mod'], { MOVE_AT: '8' })
    expect(await two.done, two.out()).toBe(0)
    expect(two.out()).toContain('superseded by')
    const [since, last] = r.state().split(' ').map(Number)
    expect(since).toBe(t0) // the same chain
    expect(last).toBeGreaterThan(t0 + 150)
    expect(localCi(r.posted())).toEqual([])
  })

  it('a chain ends only when a run tests: 40 minutes of remote parts between two runs do not end it', async () => {
    const r = repo()
    const sha = r.head()
    r.seed(r.now() - 3270, r.now() - 2400) // the last run stood aside 40 min ago, and the chain is older than that
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toMatch(/waited 3270 ?s .*testing /)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
  })

  it('a chain left over from hours ago (6 h, TALOS_CI_SETTLE_STALE_S) is over: a run after it settles for the full quiet time', async () => {
    const r = repo()
    const sha = r.head()
    r.seed(r.now() - 40_000, r.now() - 30_000)
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).not.toMatch(/waited \d+ ?s .*testing/)
    expect(r.now() - t0).toBeGreaterThanOrEqual(300)
  })

  it('pushes every 2 minutes, so main has already moved whenever a run starts: main is still tested within the cap', async () => {
    const r = repo()
    const t0 = r.now()
    let testedAt = 0
    let stoodAside = 0
    for (let i = 1; i <= 20 && !testedAt; i++) {
      const sha = r.tip() // the run GitHub kept waiting
      r.push() // and a push has landed since: the head has moved when this run starts, and it stands aside at its first look
      const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
      expect(await run.done, run.out()).toBe(0)
      if (/state=success .*context=local-ci\/mod /.test(r.posted())) testedAt = i
      else {
        stoodAside++
        expect(run.out(), run.out()).toContain('superseded by')
        r.tick(120) // the next push, and the next run after it
      }
    }
    expect(testedAt, 'a run tested main').toBeGreaterThan(0)
    expect(stoodAside).toBeGreaterThanOrEqual(5) // it did stand aside while main was busy
    expect(r.now() - t0).toBeLessThanOrEqual(900 + 30 + 120) // the cap, one poll and a push's gap
  })

  it('pushes every 4 minutes, remote parts taking 40 minutes between runs: main is still tested within the cap', async () => {
    const r = repo()
    let waitedInRuns = 0
    let superseded = 0
    let testedAt = 0
    for (let i = 1; i <= 12 && !testedAt; i++) {
      const sha = r.tip() // the newest push: the run GitHub kept waiting
      const t0 = r.now()
      const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], {
        MOVE_EVERY: '8',
        CI_PUSHED_AT: String(r.now()),
      }) // a push every 8 polls = 240 s; this head was pushed as the run began
      expect(await run.done, run.out()).toBe(0)
      waitedInRuns += r.now() - t0
      if (/state=success .*context=local-ci\/mod /.test(r.posted())) testedAt = i
      else {
        superseded++
        expect(run.out(), run.out()).toContain('superseded by')
        r.tick(2400) // the run held the group while its remote parts finished
        r.push() // and main did not pause
      }
    }
    expect(testedAt, 'a run tested main').toBeGreaterThan(0)
    expect(superseded).toBeGreaterThanOrEqual(1) // it did stand aside while main was busy
    expect(waitedInRuns).toBeLessThanOrEqual(900 + 30) // the cap, plus one poll
  })
})

describe('ci-local.sh settle: a head that has been quiet for a while goes at once', () => {
  it("the push's own time (CI_PUSHED_AT) counts: a head pushed 6 minutes ago is not made to wait 5 more", async () => {
    const r = repo()
    const sha = r.head()
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_PUSHED_AT: String(t0 - 360) })
    expect(await run.done, run.out()).toBe(0)
    expect(r.now() - t0).toBe(0)
    expect(run.out()).toMatch(/settle: .*quiet/)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
  })

  it('a head pushed 100 s ago waits for the 200 s it still lacks, not 300', async () => {
    const r = repo()
    const sha = r.head()
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_PUSHED_AT: String(t0 - 100) })
    expect(await run.done, run.out()).toBe(0)
    expect(r.now() - t0).toBeGreaterThanOrEqual(200)
    expect(r.now() - t0).toBeLessThan(240)
  })

  it('without the push time, the commit date: a commit made 6 minutes ago goes at once', async () => {
    const r = repo()
    const sha = r.head()
    r.tick(360) // the commit is 6 minutes old by the clock the run reads
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'])
    expect(await run.done, run.out()).toBe(0)
    expect(r.now() - t0).toBe(0)
  })

  it('a push time in the future (a clock that is off) counts as now: it waits the full quiet time', async () => {
    const r = repo()
    const sha = r.head()
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_PUSHED_AT: String(t0 + 5000) })
    expect(await run.done, run.out()).toBe(0)
    expect(r.now() - t0).toBeGreaterThanOrEqual(300)
  })

  it('a push time that is not a number is ignored (the commit date decides)', async () => {
    const r = repo()
    const sha = r.head()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_PUSHED_AT: 'yesterday' })
    expect(await run.done, run.out()).toBe(0)
  })
})

describe('ci-local.sh settle: a run that stood aside grades nothing, on any machine', () => {
  const ATTEMPT = 'https://github.com/owner/repo/actions/runs/77/attempts/1#'
  const mark = (link: string) =>
    `report-ci/superseded\tsuccess\t${link}\tnot tested: superseded by 1234567; CI tests main's newest commit\n`
  /** A part machine's run (Titan's image, say): the attempt's own links, no settle of its own. */
  const part = { CI_SETTLE: '', CI_ATTEMPT_URL: ATTEMPT, CI_STATUS_URL: `${ATTEMPT}titan`, CI_RUN_ID: '77' }

  it('a part that starts after its attempt stood aside tests nothing and posts nothing', async () => {
    const r = repo()
    const sha = r.head()
    writeFileSync(r.env.STATUSES as string, mark(`${ATTEMPT}lemnos`))
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], part)
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toMatch(/stood aside/)
    expect(localCi(r.posted())).toEqual([])
  })

  it("another attempt's mark, or none, is no reason to stand aside", async () => {
    for (const rows of [mark('https://github.com/owner/repo/actions/runs/77/attempts/2#lemnos'), '']) {
      const r = repo()
      const sha = r.head()
      writeFileSync(r.env.STATUSES as string, rows)
      const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], part)
      expect(await run.done, run.out()).toBe(0)
      expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
    }
  })

  it("a part whose attempt stands aside while its job runs posts no pass and no failure: an error that says 'not tested:'", async () => {
    for (const rc of [0, 1]) {
      const r = repo(`job_mod() { printf '%s' "$MARK" > "$STATUSES"; return ${rc}; }`)
      const sha = r.head()
      const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { ...part, MARK: mark(`${ATTEMPT}lemnos`) })
      await run.done
      const p = r.posted()
      expect(p, `rc ${rc}`).not.toMatch(/state=(success|failure) .*context=local-ci\/mod /)
      expect(p, `rc ${rc}`).toMatch(/state=error .*context=local-ci\/mod .*description=not tested: superseded/)
    }
  })

  it('what such a part posted is neither red nor green for ci_classify', async () => {
    const r = repo('job_mod() { printf \'%s\' "$MARK" > "$STATUSES"; return 1; }')
    const sha = r.head()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { ...part, MARK: mark(`${ATTEMPT}lemnos`) })
    await run.done
    // the newest post of each context, as the verdict reads a commit
    const rows: string[] = []
    for (const m of r
      .posted()
      .matchAll(/-f state=(\w+) -f context=(\S+) -f description=([^\n]*?)( -f target_url=\S+)?$/gm))
      rows.unshift(`${m[2]}\t${m[1]}\t${m[3]}`)
    expect(rows.some((l) => l.startsWith('local-ci/mod\terror'))).toBe(true)
    const cls = spawnSync('bash', ['-c', `. "${join(here, 'ci-runner.sh')}"; ci_classify`], {
      input: `${rows.join('\n')}\n`,
      encoding: 'utf8',
    }).stdout.split('\t')[0]
    expect(['red', 'green']).not.toContain(cls)
  })

  it('a run that is not part of an attempt (a hand run, no CI_ATTEMPT_URL) never reads for a mark', async () => {
    const r = repo()
    const sha = r.head()
    writeFileSync(r.env.STATUSES as string, mark(`${ATTEMPT}lemnos`))
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_SETTLE: '' })
    expect(await run.done, run.out()).toBe(0)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
    expect(r.posted()).not.toContain('/statuses?')
  })
})

describe("ci-local.sh settle: only the runner's main push run settles", () => {
  it('without CI_SETTLE (a hand run, a PR, a dispatch, the nightly, a part machine) it never waits and never stands aside', async () => {
    const r = repo()
    const sha = r.head()
    r.push() // main has moved: a settling run would stand aside
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_SETTLE: '' })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).not.toContain('ci-local: settle:')
    expect(r.now() - t0).toBeLessThan(30)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/mod /)
    expect(ctx(r.posted(), 'report-ci/superseded')).toBe(false)
  })

  it('the nightly skips it even when CI_SETTLE reaches it', async () => {
    const r = repo()
    const sha = r.head()
    r.push()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { CI_NIGHTLY: '1' })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).not.toContain('ci-local: settle:')
    expect(r.posted()).toMatch(/state=success .*context=nightly-ci\/mod /)
  })

  it('one number each, whole seconds: a bad one is refused at once, before anything is read or posted', async () => {
    for (const bad of [
      'TALOS_CI_SETTLE_S',
      'TALOS_CI_SETTLE_MAX_S',
      'TALOS_CI_SETTLE_POLL_S',
      'TALOS_CI_SETTLE_STALE_S',
    ]) {
      const r = repo()
      const sha = r.head()
      const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], { [bad]: 'soon' })
      expect(await run.done, bad).toBe(64)
      expect(run.out()).toContain(bad)
      expect(r.posted()).toBe('')
    }
  })

  it('the numbers can be changed: a shorter quiet time and a shorter cap, from the environment', async () => {
    const r = repo()
    const sha = r.head()
    const t0 = r.now()
    const run = r.start(['--ref', sha, '--sha', sha, '--jobs', 'mod'], {
      TALOS_CI_SETTLE_S: '60',
      TALOS_CI_SETTLE_MAX_S: '120',
      TALOS_CI_SETTLE_POLL_S: '30',
    })
    expect(await run.done, run.out()).toBe(0)
    expect(r.now() - t0).toBeGreaterThanOrEqual(60)
    expect(r.now() - t0).toBeLessThan(120)
  })
})

// keep the helper types honest: the fake `sleep` above must see a settle poll of exactly 30 by default
describe('the defaults are the documented ones', () => {
  it('300 s quiet, 900 s cap, 30 s poll, each set in one place', () => {
    const text = readFileSync(join(here, 'ci-local', 'settle.sh'), 'utf8')
    for (const [name, n] of [
      ['TALOS_CI_SETTLE_S', 300],
      ['TALOS_CI_SETTLE_MAX_S', 900],
      ['TALOS_CI_SETTLE_POLL_S', 30],
      ['TALOS_CI_SETTLE_STALE_S', 21600],
    ] as const) {
      const sets = text.split('\n').filter((l) => !l.trimStart().startsWith('#') && new RegExp(`${name}:-\\d+`).test(l))
      expect(sets, name).toHaveLength(1)
      expect(sets[0]).toContain(`${name}:-${n}`)
    }
  })
})
