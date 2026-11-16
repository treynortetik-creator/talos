// ci-runner.sh dispatch-wait: a workflow_dispatch run for commit S never takes a slot beside a push run of main for a newer commit
// that contains S. It waits behind that run's Lemnos job; when that run ends with a verdict, the dispatch is closed as superseded
// (report-ci/superseded on S, "not tested:", never a verdict) unless it was started with run_anyway. Delphi's pinned dispatches
// after each landing put three suites on Lemnos at once (3400-4000 s a run against 1000-2000 s).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const ymlPath = join(here, '../.github/workflows/ci-runner.yml')
const itYml = existsSync(ymlPath) ? it : it.skip
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const GREEN = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
  .map((j) => `local-ci/${j}\tsuccess\tpassed on ci-runner in 900s`)
  .join('\n')

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ci-dw-'))
  dirs.push(T)
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: T, env: gitEnv, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  mkdirSync(join(T, 'scripts'))
  cpSync(join(here, 'ci-runner.sh'), join(T, 'scripts/ci-runner.sh'))
  const commit = (n: string) => {
    writeFileSync(join(T, 'f'), `${n}\n`)
    git('add', '-A')
    git('commit', '-qm', n)
    return git('rev-parse', 'HEAD')
  }
  const bin = mkdtempSync(join(tmpdir(), 'ci-dw-bin-'))
  dirs.push(bin)
  mkdirSync(join(T, '.st'))
  // GitHub, as files: .runs (the push runs not completed, "id<TAB>head_sha", listed for the first $RUNS_POLLS looks, then none),
  // .job (the Lemnos job's status, default in_progress), .st/<sha> (statuses). Every call is written down.
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
all="$*"; echo "$all" >> "${T}/.gh.log"
[ ! -e "${T}/.broken" ] || exit 1
case "$all" in
  *"-X POST"*) [ -z "\${GH_POST_FAIL:-}" ] || exit 1; exit 0 ;;
  *"/actions/workflows/"*"/runs"*)
    n=$(cat "${T}/.polls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${T}/.polls"
    [ "$n" -gt "\${RUNS_POLLS:-1}" ] || cat "${T}/.runs" 2>/dev/null ;;
  *"/actions/runs/"*"/jobs"*) cat "${T}/.job" 2>/dev/null || echo in_progress ;;
  *"/commits/"*"/status"*) s="\${all#*/commits/}"; s="\${s%%/status*}"; cat "${T}/.st/$s" 2>/dev/null ;;
esac
exit 0
`,
    { mode: 0o755 },
  )
  const out = join(T, '.out')
  const run = (sha: string, extra: Record<string, string> = {}) => {
    rmSync(out, { force: true })
    const r = spawnSync('bash', ['scripts/ci-runner.sh', 'dispatch-wait'], {
      cwd: T,
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'o/r',
        INPUT_REF: sha,
        CI_PLAN_SHA: sha,
        GITHUB_OUTPUT: out,
        CI_DISPATCH_POLL: '0',
        ...extra,
      },
      encoding: 'utf8',
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}`, output: existsSync(out) ? readFileSync(out, 'utf8') : '' }
  }
  const ghLog = () => (existsSync(join(T, '.gh.log')) ? readFileSync(join(T, '.gh.log'), 'utf8') : '')
  const posts = () =>
    ghLog()
      .split('\n')
      .filter((l) => l.includes('-X POST'))
  const file = (name: string, text: string) => writeFileSync(join(T, name), text)
  return { T, git, commit, run, posts, ghLog, file, has: (sha: string, rows: string) => file(`.st/${sha}`, rows) }
}

describe('ci-runner.sh dispatch-wait: a dispatch waits behind a newer push run of main that contains it', () => {
  it('waits while that run is going; when it ends with a verdict, the dispatch is closed as superseded, not tested', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer on main')
    s.file('.runs', `77\t${H}\n`)
    s.has(H, GREEN)
    const r = s.run(S, { RUNS_POLLS: '3' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`waiting behind the push run of ${H.slice(0, 7)}`)
    expect(readFileSync(join(s.T, '.polls'), 'utf8').trim()).toBe('4') // three looks while it ran, one that found it done
    expect(r.output).toContain('superseded=true')
    const p = s.posts()
    expect(p).toHaveLength(1)
    expect(p[0]).toContain(`statuses/${S}`)
    expect(p[0]).toMatch(
      new RegExp(
        `state=success .*context=report-ci/superseded .*description=not tested: superseded by ${H.slice(0, 7)}`,
      ),
    )
  })

  it('a red verdict is a verdict too', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer')
    s.file('.runs', `77\t${H}\n`)
    s.has(H, GREEN.replace('local-ci/mod\tsuccess\tpassed on ci-runner in 900s', 'local-ci/mod\tfailure\tfailed'))
    expect(s.run(S).output).toContain('superseded=true')
  })

  it('run_anyway (a deploy): it still waits its turn, then runs', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer')
    s.file('.runs', `77\t${H}\n`)
    s.has(H, GREEN)
    const r = s.run(S, { RUNS_POLLS: '2', INPUT_RUN_ANYWAY: 'true' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('waiting behind')
    expect(r.out).toContain('run_anyway')
    expect(r.output).toContain('superseded=false')
    expect(s.posts()).toEqual([])
  })

  it('the newer run ended with no verdict (cancelled, interrupted, partial): the dispatch runs', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer')
    s.file('.runs', `77\t${H}\n`)
    s.has(H, 'local-ci/check\terror\tnot tested: run cancelled before this job reported (on ci-runner); re-run\n')
    const r = s.run(S)
    expect(r.output).toContain('superseded=false')
    expect(s.posts()).toEqual([])
  })

  it('a push run that does not contain S (S is on a branch), or is the run of S itself: no wait', () => {
    const s = setup()
    const base = s.commit('base')
    s.git('checkout', '-q', '-b', 'side')
    const S = s.commit('on a branch')
    s.git('checkout', '-q', 'main')
    const H = s.commit('main moved')
    s.file('.runs', `77\t${H}\n78\t${S}\n`)
    s.has(H, GREEN)
    const r = s.run(S, { RUNS_POLLS: '5' })
    expect(r.out).not.toContain('waiting behind')
    expect(readFileSync(join(s.T, '.polls'), 'utf8').trim()).toBe('1')
    expect(r.output).toContain('superseded=false')
    expect(base).not.toBe(S)
  })

  it('a newer push run whose Lemnos job has no runner yet is not waited on (the wait would hold the runner it needs)', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer')
    s.file('.runs', `77\t${H}\n`)
    s.file('.job', 'queued\n')
    s.has(H, GREEN)
    const r = s.run(S, { RUNS_POLLS: '5' })
    expect(r.out).toContain('not started on a runner yet')
    expect(r.output).toContain('superseded=false')
  })

  it('GitHub cannot be read: the dispatch runs, and says why', () => {
    const s = setup()
    const S = s.commit('dispatched')
    s.file('.broken', '')
    const r = s.run(S)
    expect(r.code).toBe(0)
    expect(r.out).toContain('could not list the push runs')
    expect(r.output).toContain('superseded=false')
  })

  it('a push, a PR or the nightly: nothing to do', () => {
    const s = setup()
    const S = s.commit('x')
    for (const e of ['push', 'pull_request', 'schedule']) {
      const r = s.run(S, { GITHUB_EVENT_NAME: e })
      expect(r.code, e).toBe(0)
      expect(r.output, e).toContain('superseded=false')
    }
    expect(s.ghLog()).toBe('')
  })

  it('the superseded mark cannot be posted: the dispatch runs (a skip must never look untested and fine)', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer')
    s.file('.runs', `77\t${H}\n`)
    s.has(H, GREEN)
    const r = s.run(S, { GH_POST_FAIL: '1' })
    expect(r.out).toContain('could not be marked superseded')
    expect(r.output).toContain('superseded=false')
    expect(r.output).not.toContain('superseded=true')
  })

  it('a push run of an older commit (S contains it) is not waited on; a bad CI_DISPATCH_MAX_WAIT is the default', () => {
    const s = setup()
    const H = s.commit('older on main')
    const S = s.commit('dispatched')
    s.file('.runs', `77\t${H}\n`)
    const r = s.run(S, { RUNS_POLLS: '5', CI_DISPATCH_MAX_WAIT: 'soon' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('waiting behind')
    expect(r.output).toContain('superseded=false')
  })

  it('waits at most CI_DISPATCH_MAX_WAIT, then runs, saying so', () => {
    const s = setup()
    const S = s.commit('dispatched')
    const H = s.commit('newer')
    s.file('.runs', `77\t${H}\n`)
    const r = s.run(S, { RUNS_POLLS: '1000', CI_DISPATCH_MAX_WAIT: '1', CI_DISPATCH_POLL: '0.3' })
    expect(r.out).toContain('waited the most it may')
    expect(r.output).toContain('superseded=false')
  })
})

describe('ci-runner.yml: the dispatch guard is wired in', () => {
  const yml = existsSync(ymlPath) ? readFileSync(ymlPath, 'utf8') : ''
  itYml('a run_anyway boolean input, passed to the Lemnos job', () => {
    expect(yml).toMatch(/ {6}run_anyway:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: false/)
    expect(yml).toContain('INPUT_RUN_ANYWAY: ${{ inputs.run_anyway }}')
  })
  itYml('a step before the run waits, and a superseded dispatch runs neither ci-local nor the fallback', () => {
    const job = yml.slice(yml.indexOf('\n  ci:\n'), yml.indexOf('\n  delphi:\n'))
    const wait = job.indexOf('run: bash scripts/ci-runner.sh dispatch-wait')
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThan(job.indexOf('run: exec bash scripts/ci-runner.sh run'))
    expect(job).toMatch(/- id: dispatch\n/)
    const runStep = job.slice(
      job.indexOf('- name: Run scripts/ci-local.sh'),
      job.indexOf('run: exec bash scripts/ci-runner.sh run'),
    )
    expect(runStep).toContain("if: ${{ success() && steps.dispatch.outputs.superseded != 'true' }}")
    expect(job).toContain("needs.plan.outputs.fallback != '' && steps.dispatch.outputs.superseded != 'true'")
  })
})
