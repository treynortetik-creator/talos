// ci-runner.sh green: after a push run of main whose commit has all six local-ci/* statuses passed (ci_classify's green), CI
// fast-forwards refs/heads/green to that commit. Fast-forward only, never backwards, never forced; a green that is not an ancestor
// of the commit is refused loudly. Real git (a bare origin and the runner's checkout of it), a fake gh for the statuses.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const runnerYmlPath = join(here, '..', '.github/workflows/ci-runner.yml')
const itRunnerYml = existsSync(runnerYmlPath) ? it : it.skip
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Builder One',
  GIT_AUTHOR_EMAIL: 'one@example.com',
  GIT_COMMITTER_NAME: 'Builder One',
  GIT_COMMITTER_EMAIL: 'one@example.com',
}
const SIX = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ci-green-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const origin = join(T, 'origin.git')
  const w = join(T, 'w')
  git(T, 'init', '-q', '--bare', '-b', 'main', origin)
  git(T, 'clone', '-q', origin, w)
  let n = 0
  const commit = (subject: string, branch = 'main') => {
    writeFileSync(join(w, 'f'), `${subject} ${n++}\n`)
    git(w, 'add', '-A')
    git(w, 'commit', '-qm', subject)
    git(w, 'push', '-q', 'origin', `HEAD:${branch}`)
    return git(w, 'rev-parse', 'HEAD')
  }
  const remoteGreen = () => {
    const r = spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/heads/green'], {
      cwd: origin,
      env: gitEnv,
      encoding: 'utf8',
    })
    return r.status === 0 ? r.stdout.trim() : ''
  }
  const setGreen = (sha: string) => git(origin, 'update-ref', 'refs/heads/green', sha)
  // the runner's checkout, where ci-runner.sh runs (actions/checkout of the pushed commit)
  const r = join(T, 'r')
  const cache = join(T, 'cache')
  const bin = join(T, 'bin')
  mkdirSync(bin)
  mkdirSync(join(T, 'status'))
  mkdirSync(join(T, 'runs'))
  // GitHub: a commit's statuses, newest first, from the list endpoint ("context<TAB>state<TAB>description<TAB>creator<TAB>url"
  // rows), and a workflow run ("path<TAB>event<TAB>head_sha", from runs/<id>; runs/<id>.fail makes that read fail, saying what the file says). A file named
  // fail makes every read fail. Every call is written down, so a test can say gh was never asked.
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> "${T}/gh-calls"\n[ -f "${T}/fail" ] && { echo "gh: HTTP 403 for this read" >&2; exit 1; }\nall="$*"; case "$all" in *"/commits/"*"/statuses"*) s="\${all#*/commits/}"; s="\${s%%/statuses*}"; cat "${T}/status/$s" 2>/dev/null; [ ! -f "${T}/status/$s.then" ] || mv -f "${T}/status/$s.then" "${T}/status/$s" ;; *"/actions/runs/"*) id="\${all#*/actions/runs/}"; id="\${id%% *}"; [ ! -f "${T}/runs/$id.fail" ] || { cat "${T}/runs/$id.fail" >&2; exit 1; }; cat "${T}/runs/$id" 2>/dev/null ;; esac\nexit 0\n`,
    { mode: 0o755 },
  )
  const BOT = 'github-actions[bot]'
  const URL = 'https://github.com/owner/talos-app/actions/runs/100/attempts/1#lemnos'
  type Row = { job: string; state: string; creator?: string; url?: string }
  const desc = (st: string) => (st === 'success' ? 'passed on ci-runner in 9s' : `${st} on ci-runner`)
  // a workflow run as GitHub tells it: run 100 is, by default, this workflow's push run of the commit under test
  const runInfo = (id: string, path: string, event: string, head: string, branch = 'main') =>
    writeFileSync(join(T, 'runs', id), `${path}\t${event}\t${head}\t${branch}\n`)
  const statusRows = (sha: string, rows: Row[], then = false) => {
    writeFileSync(
      join(T, 'status', then ? `${sha}.then` : sha),
      rows
        .map((r) => `local-ci/${r.job}\t${r.state}\t${desc(r.state)}\t${r.creator ?? BOT}\t${r.url ?? URL}\n`)
        .join(''),
    )
    runInfo('100', '.github/workflows/ci-runner.yml', 'push', sha)
  }
  const status = (sha: string, states: Record<string, string>, then = false) =>
    statusRows(
      sha,
      Object.entries(states).map(([job, state]) => ({ job, state })),
      then,
    )
  const green = (sha: string) => status(sha, Object.fromEntries(SIX.map((j) => [j, 'success'])))
  const checkout = () => {
    if (!existsSync(r)) {
      git(T, 'clone', '-q', origin, r)
      mkdirSync(join(r, 'scripts/ci-runner'), { recursive: true })
      cpSync(join(here, 'ci-runner.sh'), join(r, 'scripts/ci-runner.sh'))
      cpSync(join(here, 'ci-runner/green.sh'), join(r, 'scripts/ci-runner/green.sh'))
    }
    return r
  }
  const run = (sha: string, extra: Record<string, string> = {}) => {
    checkout()
    git(r, 'fetch', '-q', 'origin')
    git(r, 'checkout', '-q', '--detach', sha)
    const p = spawnSync('bash', ['scripts/ci-runner.sh', 'green'], {
      cwd: r,
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha,
        CI_PLAN_SHA: sha,
        GH_TOKEN: 't',
        CI_GREEN_WAIT_S: '0',
        ...extra,
      },
      encoding: 'utf8',
    })
    return { code: p.status, out: p.stdout + p.stderr }
  }
  const tsv = () => {
    const f = join(cache, 'logs/green.tsv')
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t'))
      : []
  }
  const alerts = () =>
    existsSync(join(cache, 'alerts')) ? readdirSync(join(cache, 'alerts')).filter((f) => f.endsWith('.txt')) : []
  const ghCalls = () => (existsSync(join(T, 'gh-calls')) ? readFileSync(join(T, 'gh-calls'), 'utf8') : '')
  const statusReads = () =>
    ghCalls()
      .split('\n')
      .filter((l) => l.includes('/status')).length
  return {
    T,
    origin,
    git,
    commit,
    remoteGreen,
    setGreen,
    status,
    statusRows,
    runInfo,
    green,
    cache,
    BOT,
    URL,
    run,
    tsv,
    alerts,
    ghCalls,
    statusReads,
    checkout,
  }
}
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/

describe('ci-runner.sh green: fast-forward refs/heads/green to a six-green commit of main', () => {
  it('first creation: no green yet, a green verdict creates it at the commit, logged with no previous green', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    const r = s.run(c1)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain(`green: created at ${c1.slice(0, 7)}`)
    const rows = s.tsv()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.[0]).toMatch(ISO)
    expect(rows[0]?.slice(1)).toEqual([c1, '-', 'created'])
  })

  it('a green verdict fast-forwards green from an ancestor, logged with the previous green', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    const c3 = s.commit('three')
    s.setGreen(c1)
    s.green(c3)
    const r = s.run(c3)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c3)
    expect(r.out).toContain(`green: moved ${c1.slice(0, 7)} -> ${c3.slice(0, 7)}`)
    expect(s.tsv()[0]?.slice(1)).toEqual([c3, c1, 'moved'])
    expect(c2).not.toBe(c3)
  })

  it.each([
    ['red', { check: 'failure' }, 'red'],
    ['partial', { image: undefined }, 'partial'],
    ['pending', { browser: 'pending' }, 'pending'],
  ] as const)('a %s verdict moves nothing, and says so', (_name, change, cls) => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    const states: Record<string, string> = Object.fromEntries(SIX.map((j) => [j, 'success']))
    for (const [j, st] of Object.entries(change)) {
      if (st === undefined) delete states[j]
      else states[j] = st
    }
    s.status(c2, states)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain(`verdict is ${cls}`)
    expect(s.tsv()).toHaveLength(1)
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, `unchanged: verdict ${cls}`])
    expect(s.statusReads()).toBe(cls === 'red' ? 1 : 3) // red is final at once; not final yet is read again, 3 reads in all
  })

  it('a commit a run stood aside from (report-ci/superseded only) has no verdict: green stays where it is', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    writeFileSync(
      join(s.T, 'status', c2),
      `report-ci/superseded\tsuccess\tnot tested: superseded by 1234567; CI tests main's newest commit\t${s.BOT}\t${s.URL}\n`,
    )
    s.runInfo('100', '.github/workflows/ci-runner.yml', 'push', c2)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain('verdict is none')
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, 'unchanged: verdict none'])
    expect(s.alerts()).toEqual([]) // an unmoved green is no alert: only a refused move is
  })

  it('a status that lands a moment late: the re-read sees green and moves it', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    // the first read still says pending; the next one has the last pass (the .then file, swapped in after a read)
    s.status(c2, { ...Object.fromEntries(SIX.map((j) => [j, 'success'])), mobile: 'pending' })
    s.status(c2, Object.fromEntries(SIX.map((j) => [j, 'success'])), true)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(s.statusReads()).toBe(2)
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, 'moved'])
  })

  it('green already ahead: an older commit turning green late moves nothing, and says so', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c2)
    s.green(c1)
    const r = s.run(c1)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(r.out).toContain('older than green')
    expect(s.tsv()[0]?.slice(1)).toEqual([c1, c2, 'unchanged: older than green'])
  })

  it('green already at the commit: nothing to push', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.setGreen(c1)
    s.green(c1)
    const r = s.run(c1)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(s.tsv()[0]?.slice(1)).toEqual([c1, c1, 'unchanged: already green'])
  })

  it('green not an ancestor (moved off main): refused loudly, logged, an alert for the lead, green left alone', () => {
    const s = setup()
    const c1 = s.commit('base')
    const side = s.commit('a side branch, never on main', 'side')
    s.git(join(s.T, 'w'), 'reset', '-q', '--hard', c1)
    const c2 = s.commit('two')
    s.setGreen(side)
    s.green(c2)
    const r = s.run(c2)
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::')
    expect(r.out).toContain('not an ancestor')
    expect(s.remoteGreen()).toBe(side)
    const row = s.tsv()[0]
    expect(row?.slice(1, 3)).toEqual([c2, side])
    expect(row?.[3]).toMatch(/^refused: /)
    expect(s.alerts()).toHaveLength(1)
  })

  it('a push GitHub refuses is a loud failure, logged, never "moved"', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    // the remote refuses every update of green (as a protection rule would)
    writeFileSync(
      join(s.origin, 'hooks/pre-receive'),
      '#!/bin/sh\nwhile read o n ref; do [ "$ref" = refs/heads/green ] && { echo "green is protected" >&2; exit 1; }; done\nexit 0\n',
      { mode: 0o755 },
    )
    const r = s.run(c2)
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::')
    expect(s.remoteGreen()).toBe(c1)
    expect(s.tsv()[0]?.[3]).toMatch(/^failed: /)
    expect(s.alerts()).toHaveLength(1)
  })

  it('statuses that cannot be read are a loud error, not "not green"', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    writeFileSync(join(s.T, 'fail'), '')
    const r = s.run(c2)
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::')
    expect(s.remoteGreen()).toBe(c1)
    expect(s.tsv()[0]?.[3]).toMatch(/^error: .*HTTP 403/)
    expect(s.alerts()).toHaveLength(1)
  })

  it('a commit not on main moves nothing', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.setGreen(c1)
    const side = s.commit('side', 'side')
    s.green(side)
    const r = s.run(side)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(s.tsv()[0]?.slice(1)).toEqual([side, c1, 'unchanged: not on main'])
  })

  it("the checkout's own pre-push hook (the gate) is not run for green's push", () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    const r0 = s.checkout()
    mkdirSync(join(s.T, 'hooks'))
    writeFileSync(join(s.T, 'hooks/pre-push'), `#!/bin/sh\necho ran > "${s.T}/hook-ran"\nexit 1\n`, { mode: 0o755 })
    s.git(r0, 'config', 'core.hooksPath', join(s.T, 'hooks'))
    const r = s.run(c1)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(existsSync(join(s.T, 'hook-ran'))).toBe(false)
  })

  it('lost a race: green moved past the commit during the push, which is no failure', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    const c3 = s.commit('three')
    s.setGreen(c1)
    s.green(c2)
    // origin refuses this push and, at that moment, someone else has moved green to c3 (a newer run, or the lead by hand)
    writeFileSync(
      join(s.origin, 'hooks/pre-receive'),
      `#!/bin/sh\nenv -u GIT_QUARANTINE_PATH git update-ref refs/heads/green ${c3}\necho "stale" >&2\nexit 1\n`,
      { mode: 0o755 },
    )
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c3)
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c3, 'unchanged: older than green'])
    expect(s.alerts()).toEqual([])
  })

  it('a push that landed though git reported a failure is logged as moved, not as older', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    writeFileSync(
      join(s.origin, 'hooks/pre-receive'),
      `#!/bin/sh\nenv -u GIT_QUARANTINE_PATH git update-ref refs/heads/green ${c2}\nexit 1\n`,
      { mode: 0o755 },
    )
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, 'moved (the push reported a failure, but green is at the commit)'])
  })

  it.each([
    ['the nightly', { GITHUB_EVENT_NAME: 'schedule' }],
    ['a pull request', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['a dispatch', { GITHUB_EVENT_NAME: 'workflow_dispatch' }],
    ['a push to another branch', { GITHUB_REF: 'refs/heads/other' }],
  ])('%s moves nothing, logs nothing and asks GitHub nothing', (_name, extra) => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    const r = s.run(c2, extra)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('not a push run of main')
    expect(s.remoteGreen()).toBe(c1)
    expect(s.tsv()).toEqual([])
    expect(s.ghCalls()).toBe('')
  })

  // Trust: only a status GitHub's own token posted (github-actions[bot]) from this workflow's push run of this very commit counts.
  type Row = { job: string; state: string; creator?: string; url?: string }
  const sixOk = (over: Partial<Record<string, Partial<Row>>> = {}): Row[] =>
    SIX.map((job) => ({ job, state: 'success', ...over[job] }))

  it('a status by another creator is ignored: five trusted passes read partial, green not moved, the row named', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, sixOk({ mobile: { creator: 'someone-else' } }))
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain('verdict is partial')
    expect(r.out).toMatch(/untrusted.*local-ci\/mobile.*someone-else/)
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, 'unchanged: verdict partial'])
  })

  it('a forged success alongside a real failure does not count: the newest trusted check is the failure, red', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, [
      { job: 'check', state: 'success', creator: 'someone-else' },
      ...sixOk().filter((r) => r.job !== 'check'),
      { job: 'check', state: 'failure' },
    ])
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain('verdict is red')
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, 'unchanged: verdict red'])
  })

  it.each([
    ['another workflow', '.github/workflows/other.yml', 'push', false],
    ['a pull_request run of ci-runner.yml', '.github/workflows/ci-runner.yml', 'pull_request', false],
    ['a workflow_dispatch run of ci-runner.yml', '.github/workflows/ci-runner.yml', 'workflow_dispatch', false],
    ['a run of another commit', '.github/workflows/ci-runner.yml', 'push', true],
  ] as const)('a status from %s is ignored', (_name, path, event, otherHead) => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, sixOk({ check: { url: 'https://github.com/owner/talos-app/actions/runs/200/attempts/1#lemnos' } }))
    s.runInfo('200', path, event, otherHead ? c1 : c2)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain('verdict is partial')
    expect(r.out).toMatch(/untrusted.*local-ci\/check/)
  })

  it.each([
    'https://github.com/owner/talos-app/actions/runs/100/attempts/1#lemnos and more',
    'https://github.com/owner/talos-app/actions/runs/100/attempts/1#lemnos/x',
    'https://github.com/owner/talos-app/actions/runs/100/jobs/5',
    'https://github.com/owner/talos-app/actions/runs/100x',
    'https://github.com/owner/talos-app/actions/runs/100#',
    'https://github.com/owner/talos-app/actions/runs/100/attempts/#lemnos',
    'https://github.com/owner/talos-app/actions/runs/',
    'https://github.com/owner/talos-app.other/actions/runs/100',
    'https://github.com/other/talos-app/actions/runs/100',
    'http://github.com/owner/talos-app/actions/runs/100',
    'https://example.com/owner/talos-app/actions/runs/100',
    '',
  ])('a status whose link is not exactly a run of this repository is ignored: %j', (url) => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, sixOk({ desktop: { url } }))
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain('verdict is partial')
    expect(r.out).toMatch(/untrusted.*local-ci\/desktop/)
  })

  it.each([
    'https://github.com/owner/talos-app/actions/runs/100',
    'https://github.com/owner/talos-app/actions/runs/100/attempts/2',
    'https://github.com/owner/talos-app/actions/runs/100/attempts/1#check-titan',
    'https://github.com/owner/talos-app/actions/runs/100/attempts/1#browser_e2e.2',
  ])('every link the workflow posts is trusted: %s', (url) => {
    const s = setup()
    const c1 = s.commit('base')
    s.statusRows(c1, sixOk({ check: { url } }))
    const r = s.run(c1)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).not.toContain('untrusted')
  })

  it('a newer untrusted status does not hide an older trusted pass: the trusted six read green and move it', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, [...SIX.map((job) => ({ job, state: 'failure', creator: 'someone-else' })), ...sixOk()])
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(s.tsv()[0]?.slice(1)).toEqual([c2, c1, 'moved'])
    // the run is read once, however many statuses name it
    expect(
      s
        .ghCalls()
        .split('\n')
        .filter((l) => l.includes('/actions/runs/100')),
    ).toHaveLength(1)
  })

  it('a run that cannot be read is a loud error, never "untrusted"', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    writeFileSync(join(s.T, 'runs/100.fail'), 'gh: HTTP 403 for run 100\n')
    const r = s.run(c2)
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::')
    expect(r.out).not.toContain('untrusted')
    expect(s.remoteGreen()).toBe(c1)
    expect(s.tsv()[0]?.[3]).toMatch(/^error: .*run 100.*HTTP 403/)
    expect(s.alerts()).toHaveLength(1)
  })

  it('a link to a run that does not exist (404) is untrusted, not an error: the other six still decide', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, [
      { job: 'check', state: 'failure', url: 'https://github.com/owner/talos-app/actions/runs/404/attempts/1#lemnos' },
      ...sixOk(),
    ])
    writeFileSync(join(s.T, 'runs/404.fail'), 'gh: HTTP 404: Not Found\n')
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/untrusted.*local-ci\/check.*runs\/404/)
    expect(s.remoteGreen()).toBe(c2)
    expect(s.alerts()).toEqual([])
  })

  it('a forged success by the bot itself, linked to another run, newer than a real failure, does not count: red', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, [
      { job: 'check', state: 'success', url: 'https://github.com/owner/talos-app/actions/runs/300/attempts/1#lemnos' },
      ...sixOk().filter((r) => r.job !== 'check'),
      { job: 'check', state: 'failure' },
    ])
    s.runInfo('300', '.github/workflows/ci-runner.yml', 'pull_request', c2)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    expect(r.out).toContain('verdict is red')
  })

  it.each([
    ['a failure then a newer pass (a re-run attempt): green', ['success', 'failure'], 'moved'],
    ['a pass then a newer failure: red', ['failure', 'success'], 'unchanged: verdict red'],
  ] as const)('the newest trusted status of a context wins, %s', (_name, [newer, older], result) => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.statusRows(c2, [
      { job: 'check', state: newer, url: 'https://github.com/owner/talos-app/actions/runs/100/attempts/2#lemnos' },
      ...sixOk().filter((r) => r.job !== 'check'),
      { job: 'check', state: older },
    ])
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.tsv()[0]?.[3]).toBe(result)
    expect(s.remoteGreen()).toBe(result === 'moved' ? c2 : c1)
  })

  it("the lead's move by hand: CI_GREEN_TRUST_RUN counts a dispatch run's statuses, named in the log; never in a workflow", () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    const c3 = s.commit('three')
    s.setGreen(c1)
    const DISPATCH = 'https://github.com/owner/talos-app/actions/runs/500/attempts/1#lemnos'
    s.statusRows(
      c2,
      SIX.map((job) => ({ job, state: 'success', url: DISPATCH })),
    )
    s.runInfo('500', '.github/workflows/ci-runner.yml', 'workflow_dispatch', c3) // a dispatch runs from main's tip
    // without the override: untrusted, not moved
    expect(s.run(c2).code).toBe(0)
    expect(s.remoteGreen()).toBe(c1)
    // inside a workflow the override is refused
    const inWf = s.run(c2, { CI_GREEN_TRUST_RUN: '500', GITHUB_ACTIONS: 'true' })
    expect(inWf.code).toBe(1)
    expect(s.remoteGreen()).toBe(c1)
    // another run named: still untrusted
    s.run(c2, { CI_GREEN_TRUST_RUN: '501' })
    expect(s.remoteGreen()).toBe(c1)
    // the named dispatch ran from a branch (its own workflow and scripts): still untrusted
    s.runInfo('500', '.github/workflows/ci-runner.yml', 'workflow_dispatch', c3, 'some-branch')
    s.run(c2, { CI_GREEN_TRUST_RUN: '500' })
    expect(s.remoteGreen()).toBe(c1)
    s.runInfo('500', '.github/workflows/ci-runner.yml', 'workflow_dispatch', c3)
    // by hand, naming the dispatch: moved, and the row says so
    const r = s.run(c2, { CI_GREEN_TRUST_RUN: '500' })
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(s.tsv().at(-1)?.slice(1)).toEqual([c2, c1, 'moved (by hand, trusting run 500)'])
    // and the job's next run on this machine knows where green is: no foreign alert
    s.green(c3)
    expect(s.run(c3).code).toBe(0)
    expect(s.alerts().filter((f) => f.endsWith('-green-foreign.txt'))).toEqual([])
  })

  it("this job's own run must be readable (actions: read), or it is an error, not a quiet partial", () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    writeFileSync(join(s.T, 'runs/900.fail'), 'gh: HTTP 404: Not Found\n')
    const r = s.run(c2, { GITHUB_RUN_ID: '900' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::error::.*own run 900/)
    expect(s.remoteGreen()).toBe(c1)
    expect(s.alerts()).toHaveLength(1)
    // readable: on as usual
    rmSync(join(s.T, 'runs/900.fail'))
    writeFileSync(join(s.T, 'runs/900'), '900\n')
    const ok = s.run(c2, { GITHUB_RUN_ID: '900' })
    expect(ok.code, ok.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
  })

  it('a green.tsv that cannot be written is said as an error', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    mkdirSync(join(s.cache, 'logs/green.tsv'), { recursive: true }) // a folder where the file goes: every append fails
    const r = s.run(c1)
    expect(r.out).toMatch(/::error::.*green\.tsv could not be written/)
  })

  // A foreign move: green.tsv on this machine says where green last was; origin's green anywhere else was moved by hand.
  const seed = (s: ReturnType<typeof setup>, rows: string[][]) => {
    mkdirSync(join(s.cache, 'logs'), { recursive: true })
    writeFileSync(join(s.cache, 'logs/green.tsv'), rows.map((r) => `${r.join('\t')}\n`).join(''))
  }
  const foreignAlerts = (s: ReturnType<typeof setup>) => s.alerts().filter((f) => f.endsWith('-green-foreign.txt'))

  it('a hand move: alerted once, logged, and green then moves on as usual', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    const c3 = s.commit('three')
    seed(s, [['2026-01-01T00:00:00Z', c1, '-', 'moved']])
    s.setGreen(c2) // moved by hand, past where this machine left it
    s.green(c3)
    const r = s.run(c3)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('::warning::')
    expect(s.remoteGreen()).toBe(c3)
    const foreign = foreignAlerts(s)
    expect(foreign).toEqual([expect.stringMatching(new RegExp(`^\\d+-${c3.slice(0, 7)}-green-foreign\\.txt$`))])
    const text = readFileSync(join(s.cache, 'alerts', foreign[0] as string), 'utf8')
    expect(text).toContain(c1.slice(0, 7))
    expect(text).toContain(c2.slice(0, 7))
    expect(s.alerts()).toHaveLength(1)
    expect(
      s
        .tsv()
        .slice(1)
        .map((row) => row.slice(1)),
    ).toEqual([
      [c3, c2, `foreign move: ${c1.slice(0, 7)} -> ${c2.slice(0, 7)}`],
      [c3, c2, 'moved'],
    ])
    // the next run, with no further hand move: no second alert
    const c4 = s.commit('four')
    s.green(c4)
    const r2 = s.run(c4)
    expect(r2.code, r2.out).toBe(0)
    expect(r2.out).not.toContain('::warning::')
    expect(s.remoteGreen()).toBe(c4)
    expect(s.alerts()).toHaveLength(1)
    expect(s.tsv().at(-1)?.slice(1)).toEqual([c4, c3, 'moved'])
  })

  it('a hand move is noticed when the verdict is red too, and its own row then counts as where green is', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    const c3 = s.commit('three')
    seed(s, [['2026-01-01T00:00:00Z', c1, '-', 'created']])
    s.setGreen(c2)
    s.status(c3, { ...Object.fromEntries(SIX.map((j) => [j, 'success'])), check: 'failure' })
    const r = s.run(c3)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(foreignAlerts(s)).toHaveLength(1)
    expect(s.tsv().at(-2)?.slice(1)).toEqual([c3, c2, `foreign move: ${c1.slice(0, 7)} -> ${c2.slice(0, 7)}`])
    const r2 = s.run(c3)
    expect(r2.code, r2.out).toBe(0)
    expect(s.alerts()).toHaveLength(1)
  })

  it('green deleted by hand: alerted as deleted, then created again as usual', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    seed(s, [['2026-01-01T00:00:00Z', c1, '-', 'created']])
    s.green(c2)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(s.remoteGreen()).toBe(c2)
    expect(
      s
        .tsv()
        .slice(1)
        .map((row) => row.slice(1)),
    ).toEqual([
      [c2, '-', `foreign move: ${c1.slice(0, 7)} -> deleted`],
      [c2, '-', 'created'],
    ])
    expect(readFileSync(join(s.cache, 'alerts', foreignAlerts(s)[0] as string), 'utf8')).toContain('(deleted)')
  })

  it('no history on this machine: no foreign alert', () => {
    const s = setup()
    const c1 = s.commit('base')
    const c2 = s.commit('two')
    s.setGreen(c1)
    s.green(c2)
    const r = s.run(c2)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('::warning::')
    expect(s.alerts()).toEqual([])
    expect(s.tsv().map((row) => row.slice(1))).toEqual([[c2, c1, 'moved']])
  })

  it('never forces: no --force, no + refspec, and the pre-push hook is not the gate here', () => {
    const text = readFileSync(join(here, 'ci-runner/green.sh'), 'utf8')
    const code = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const pushes = code.split('\n').filter((l) => /\bpush\b/.test(l) && /ci_git_net|git /.test(l))
    expect(pushes).toEqual([expect.stringContaining('push origin "$sha:refs/heads/green"')])
    for (const l of pushes) expect(l).not.toMatch(/--force|\s-f\b|\s\+|"\+|--mirror|--delete/)
    expect(code).not.toMatch(/--force/)
  })
})

describe('the workflow: a green job of its own, push runs of main only', () => {
  type Job = { if?: string; needs?: string[]; permissions?: Record<string, string>; steps: Record<string, unknown>[] }
  const jobs = (): Record<string, Job> =>
    JSON.parse(
      execFileSync(
        'bun',
        [
          '-e',
          'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text()).jobs))',
          runnerYmlPath,
        ],
        { encoding: 'utf8' },
      ),
    )
  itRunnerYml('green runs after ci on a push of main, alone holds contents: write, and close waits for it', () => {
    const j = jobs()
    const g = j.green as Job
    expect(g.needs).toEqual(['plan', 'ci'])
    expect(g.if).toContain("github.event_name == 'push'")
    expect(g.if).toContain("github.ref == 'refs/heads/main'")
    expect(g.if).toContain('!cancelled()')
    expect(g.permissions).toEqual({ contents: 'write', statuses: 'read', actions: 'read' })
    for (const [name, job] of Object.entries(j))
      if (name !== 'green') expect(job.permissions?.contents, name).not.toBe('write')
    const body = JSON.stringify(g.steps)
    expect(body).toContain('bash scripts/ci-runner.sh green')
    expect(body).not.toContain('ci-local.sh') // no code under test runs beside this token
    expect(j.close?.needs).toContain('green') // close never cancels the run under green
  })
})
