// The GitHub account the scripts that run on a person's Mac read and write the repository as (scripts/ci-runner/gh-account.sh):
// the repository owner's login, chosen by name for each command, never gh's active account (a work login there made the 04:43
// hostile dispatch fail on 2026-11-19, "HTTP 404: workflow ci-runner.yml not found"). Against a fake gh that logs the token
// each call ran with: ci-runner.sh untested (and the Linux report), lead-inbox.sh, and scripts/ci-nightly.sh.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const SHA = 'a'.repeat(40)

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ci-gh-account-'))
  dirs.push(T)
  const r = join(T, 'r')
  const bin = join(T, 'bin')
  const cache = join(T, 'cache')
  for (const d of [bin, join(T, 'accounts'), join(r, 'scripts/ci-runner')]) mkdirSync(d, { recursive: true })
  for (const f of ['ci-runner.sh', 'ci-runner/alert.sh', 'ci-runner/gh-account.sh', 'lead-inbox.sh', 'ci-nightly.sh'])
    cpSync(join(here, f), join(r, 'scripts', f))
  // gh: logs "<GH_TOKEN or (active account)> <args>"; accounts/<user> is a login; fail-reads makes every api read fail;
  // fail-dispatch makes workflow run fail; old-gh: auth token has no --user
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "\${GH_TOKEN:-(active account)} $*" >> "${T}/gh-calls"
if [ "$1 $2" = "auth token" ]; then
  if [ "$3" = --help ]; then [ -f "${T}/old-gh" ] || echo "  -u, --user string   The account"; i=0; while [ $i -lt 3000 ]; do echo "help line $i"; i=$((i+1)); done; exit 0; fi
  u=""; prev=""; for a in "$@"; do [ "$prev" = --user ] && u="$a"; prev="$a"; done
  [ -f "${T}/accounts/$u" ] && { cat "${T}/accounts/$u"; exit 0; }
  echo "no oauth token found for github.com account $u" >&2; exit 1
fi
[ "$1 $2" = "api user" ] && { echo work-login; exit 0; }
if [ "$1 $2" = "run list" ]; then [ -f "${T}/listed" ] && echo 1 || echo 0; exit 0; fi
if [ "$1 $2" = "workflow run" ]; then
  [ -f "${T}/hang" ] && sleep 30
  [ -f "${T}/fail-dispatch" ] && { echo "HTTP 404: workflow ci-runner.yml not found" >&2; exit 1; }
  echo "Created workflow_dispatch event for ci-runner.yml at main"; exit 0
fi
[ -f "${T}/fail-reads" ] && { [ -f "${T}/bin/gh-err" ] && echo "gh: HTTP 503: Unavailable" >&2 || echo "gh: HTTP 502: Bad Gateway" >&2; exit 1; }
case "$*" in
  *"commits?sha=main"*) printf '%s\\t2026-11-19T00:00:00Z\\n' "${SHA}" ;;
  *"/commits/"*"/status"*) printf 'local-ci/check\\tsuccess\\tpassed on ci-runner in 9s\\t2026-11-19T00:00:00Z\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  )
  const login = (user: string, token: string) => writeFileSync(join(T, 'accounts', user), `${token}\n`)
  const flag = (name: string, on = true) =>
    on ? writeFileSync(join(T, name), '') : rmSync(join(T, name), { force: true })
  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = spawnSync('bash', args, {
      cwd: r,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        CI_REPO: 'owner/talos-app',
        CI_NIGHTLY_PAUSE_S: '0',
        ...env,
      },
      encoding: 'utf8',
    })
    return { code: p.status, out: p.stdout + p.stderr }
  }
  const calls = () => (existsSync(join(T, 'gh-calls')) ? readFileSync(join(T, 'gh-calls'), 'utf8') : '')
  const apiCalls = () =>
    calls()
      .split('\n')
      .filter((l) => / (api|workflow) /.test(l) && !l.includes(' api user'))
  const alerts = () =>
    existsSync(join(cache, 'alerts')) ? readdirSync(join(cache, 'alerts')).filter((f) => f.endsWith('.txt')) : []
  const alertText = () => alerts().map((f) => readFileSync(join(cache, 'alerts', f), 'utf8'))
  return { T, r, cache, login, flag, run, calls, apiCalls, alerts, alertText }
}

describe('ci-runner.sh untested (the watcher, every 10 minutes): the owner account, and an unreadable GitHub is an alert', () => {
  it('with no GH_TOKEN every read runs as the repository owner, never the active account', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.login('work-login', 'tok-work')
    const r = s.run(['scripts/ci-runner.sh', 'untested'])
    expect(r.code, r.out).toBe(0)
    expect(s.apiCalls().length).toBeGreaterThan(1)
    for (const c of s.apiCalls()) expect(c.startsWith('tok-owner '), c).toBe(true)
    expect(s.alerts()).toEqual([])
  })

  it('no login for the owner: exit 1 and one alert that names the account and the fix; no read goes out', () => {
    const s = setup()
    s.login('work-login', 'tok-work')
    const r = s.run(['scripts/ci-runner.sh', 'untested'])
    expect(r.code).toBe(1)
    expect(s.apiCalls()).toEqual([])
    expect(s.alerts()).toHaveLength(1)
    const t = s.alertText()[0] as string
    expect(t).toContain('no login for owner')
    expect(t).toContain("gh's active account is never used")
    expect(s.calls()).not.toContain('api user')
    expect(t).toContain('gh auth login')
    s.run(['scripts/ci-runner.sh', 'untested']) // the same problem again: said once
    expect(s.alerts()).toHaveLength(1)
  })

  it('GitHub unreadable is exit 1 and an alert (never "could not be read", exit 0); said once, and again after a good run', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.flag('fail-reads')
    const now = { CI_GH_READ_ALERT_AFTER_S: '0' }
    const r = s.run(['scripts/ci-runner.sh', 'untested'], now)
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::')
    // one for untested, one for the Linux report: both read main, both are blind
    expect(
      s.alertText().some((t) => t.includes("untested: main's commits could not be read from owner/talos-app")),
    ).toBe(true)
    expect(s.alertText().some((t) => t.includes("report: main's commits could not be read"))).toBe(true)
    expect(s.alerts()).toHaveLength(2)
    s.run(['scripts/ci-runner.sh', 'untested'], now)
    expect(s.alerts()).toHaveLength(2) // the same, kept quiet
    s.flag('fail-reads', false)
    expect(s.run(['scripts/ci-runner.sh', 'untested'], now).code).toBe(0)
    s.flag('fail-reads')
    s.run(['scripts/ci-runner.sh', 'untested'], now)
    expect(s.alerts()).toHaveLength(4) // cleared by the good run, so said again
  })

  it('one failed read (a Mac waking before its Wi-Fi) is no alert; a read failing for 20 minutes is, once, whatever its error text', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.flag('fail-reads')
    expect(s.run(['scripts/ci-runner.sh', 'untested']).code).toBe(1) // still an error in the log
    expect(s.alerts()).toEqual([])
    // 21 minutes later, still failing
    for (const k of ['untested-read', 'report-read'])
      writeFileSync(join(s.cache, 'alerts/said', `gh-${k}.since`), `${Math.floor(Date.now() / 1000) - 21 * 60}\n`)
    s.run(['scripts/ci-runner.sh', 'untested'])
    expect(s.alerts()).toHaveLength(2)
    // the error text changes (a 502, then a 503): the same problem, not a new alert
    writeFileSync(join(s.T, 'bin', 'gh-err'), '')
    s.run(['scripts/ci-runner.sh', 'untested'])
    expect(s.alerts()).toHaveLength(2)
    // a good run forgets the wait too: the next failure waits again
    s.flag('fail-reads', false)
    s.run(['scripts/ci-runner.sh', 'untested'])
    s.flag('fail-reads')
    s.run(['scripts/ci-runner.sh', 'untested'])
    expect(s.alerts()).toHaveLength(2)
  })

  it('the red alert and the hostile report (once a push, once a night): unreadable statuses are an alert at once and exit 1', () => {
    for (const hostile of ['', '1']) {
      const s = setup()
      // the alert reads only commits on main: a checkout whose main is its own origin's
      const git = (...a: string[]) =>
        spawnSync('git', ['-c', 'user.name=Alex Example', '-c', 'user.email=alex@example.com', ...a], {
          cwd: s.r,
          encoding: 'utf8',
        }).stdout.trim()
      git('init', '-q', '-b', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'one')
      git('remote', 'add', 'origin', s.r)
      s.flag('fail-reads')
      const r = s.run(['scripts/ci-runner.sh', 'alert'], {
        GH_TOKEN: 'tok-job',
        GITHUB_REPOSITORY: 'owner/talos-app',
        CI_PLAN_SHA: git('rev-parse', 'HEAD'),
        CI_HOSTILE: hostile,
      })
      expect(r.code, hostile).toBe(1)
      const want = hostile ? 'so the hostile nightly has no report' : 'so whether main went red is unknown'
      expect(
        s.alertText().some((t) => t.includes(want)),
        `${hostile}: ${s.alertText().join('|')}`,
      ).toBe(true)
    }
  })

  it('the token is never written down: not in the cache, its logs, error files or alerts', () => {
    const s = setup()
    s.login('owner', 'tok-owner-SECRET')
    s.flag('fail-reads')
    s.run(['scripts/ci-runner.sh', 'untested'], { CI_GH_READ_ALERT_AFTER_S: '0' })
    s.flag('fail-dispatch')
    s.run(['scripts/ci-nightly.sh', 'nightly'])
    s.run(['scripts/lead-inbox.sh', 'flush'])
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [readFileSync(join(d, e.name), 'utf8')],
      )
    expect(walk(s.cache).length).toBeGreaterThan(3)
    expect(walk(s.cache).some((t) => t.includes('SECRET'))).toBe(false)
  })

  it('a watcher run from a checkout of another repository (a fork, the public export) says so once, as an alert', () => {
    const s = setup()
    s.login('someone', 'tok-someone')
    spawnSync('git', ['init', '-q'], { cwd: s.r })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/talos-export.git'], { cwd: s.r })
    s.run(['scripts/ci-runner.sh', 'untested'], { CI_REPO: '' })
    s.run(['scripts/ci-runner.sh', 'untested'], { CI_REPO: '' })
    const t = s.alertText().filter((x) => x.includes("this checkout's origin"))
    expect(t).toHaveLength(1)
    expect(t[0]).toContain('reads someone/talos-export')
  })

  it('a first failure from before a long gap (a Mac asleep) does not make the next failure an alert at once', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.flag('fail-reads')
    s.run(['scripts/ci-runner.sh', 'untested'])
    for (const k of ['untested-read', 'report-read'])
      writeFileSync(join(s.cache, 'alerts/said', `gh-${k}.since`), `${Math.floor(Date.now() / 1000) - 5 * 3600}\n`)
    s.run(['scripts/ci-runner.sh', 'untested'])
    expect(s.alerts()).toEqual([])
  })

  it("in Actions an empty GH_TOKEN is an error, and the runner Mac's own login is never asked for", () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    const r = s.run(['scripts/ci-runner.sh', 'untested'], { GITHUB_ACTIONS: 'true' })
    expect(r.code).toBe(1)
    expect(s.calls()).not.toContain('auth token --hostname')
    expect(s.alertText()[0]).toContain('GH_TOKEN is empty in this Actions job')
  })

  it('a GH_TOKEN that is set is used as it is', () => {
    const s = setup()
    const r = s.run(['scripts/ci-runner.sh', 'untested'], { GH_TOKEN: 'tok-job' })
    expect(r.code, r.out).toBe(0)
    expect(s.calls()).not.toContain('auth token')
    for (const c of s.apiCalls()) expect(c.startsWith('tok-job '), c).toBe(true)
  })
})

describe('lead-inbox.sh: the owner account, never the active one', () => {
  it('no login for the owner: flush posts nothing, exit 1, an alert; unread says "cannot read", exit 2', () => {
    const s = setup()
    const f = s.run(['scripts/lead-inbox.sh', 'flush'])
    expect(f.code).toBe(1)
    expect(s.apiCalls()).toEqual([])
    expect(
      s.alertText().some((t) => t.startsWith('lead-inbox: nothing posted: gh on this machine has no login for owner')),
    ).toBe(true)
    const u = s.run(['scripts/lead-inbox.sh', 'unread'])
    expect(u.code).toBe(2)
    expect(u.out).toContain('lead-inbox: cannot read: gh on this machine has no login for owner')
  })

  it('with the owner logged in, its calls carry the owner token (unread and flush)', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.run(['scripts/lead-inbox.sh', 'unread'])
    s.run(['scripts/lead-inbox.sh', 'flush'])
    expect(s.calls()).toContain('tok-owner repo view')
    expect(s.apiCalls().length).toBeGreaterThan(0)
    for (const c of s.apiCalls()) expect(c.startsWith('tok-owner '), c).toBe(true)
  })
})

describe('scripts/ci-nightly.sh: the nightly and hostile dispatch, as launchd runs it', () => {
  const logOf = (s: ReturnType<typeof setup>) => readFileSync(join(s.cache, 'logs/ci-nightly.log'), 'utf8')

  it('usage: only nightly or hostile, exit 64, nothing dispatched', () => {
    const s = setup()
    for (const a of [[], ['weekly']]) expect(s.run(['scripts/ci-nightly.sh', ...a]).code).toBe(64)
    expect(s.calls()).not.toContain('workflow run')
  })

  it('dispatches as the owner (not the active account), to the repository of CI_REPO, and logs one line', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.login('work-login', 'tok-work')
    const r = s.run(['scripts/ci-nightly.sh', 'hostile'])
    expect(r.code, r.out).toBe(0)
    const d = s
      .calls()
      .split('\n')
      .filter((l) => l.includes('workflow run'))
    expect(d).toEqual(['tok-owner workflow run ci-runner.yml --repo owner/talos-app --ref main -f nightly=hostile'])
    expect(logOf(s)).toMatch(/hostile: exit 0: Created workflow_dispatch event/)
    expect(s.alerts()).toEqual([])
  })

  it("the repository is this checkout's github.com origin when CI_REPO is not set", () => {
    const s = setup()
    s.login('someone', 'tok-someone')
    spawnSync('git', ['init', '-q'], { cwd: s.r })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/talos-app.git'], { cwd: s.r })
    const r = s.run(['scripts/ci-nightly.sh', 'nightly'], { CI_REPO: '' })
    expect(r.code, r.out).toBe(0)
    expect(s.calls()).toContain('tok-someone workflow run ci-runner.yml --repo someone/talos-app')
  })

  it('no login for the owner: nothing dispatched, never as the active account; exit 1, a log line and an alert', () => {
    const s = setup()
    s.login('work-login', 'tok-work')
    const r = s.run(['scripts/ci-nightly.sh', 'nightly'])
    expect(r.code).toBe(1)
    expect(s.calls()).not.toContain('workflow run')
    expect(logOf(s)).toMatch(/nightly: exit 1: gh on this machine has no login for owner/)
    expect(s.alertText()[0]).toContain('the nightly dispatch of ci-runner.yml did not run')
  })

  it('a failed dispatch is exit 1, a log line and an alert; a later good one clears it', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.flag('fail-dispatch')
    expect(s.run(['scripts/ci-nightly.sh', 'hostile']).code).toBe(1)
    expect(
      s
        .calls()
        .split('\n')
        .filter((l) => l.includes('workflow run')),
    ).toHaveLength(3) // tried three times
    expect(logOf(s)).toContain('hostile: exit 1: try 1 of 3 failed')
    expect(logOf(s)).toContain(
      'hostile: exit 1: gh workflow run failed 3 times: HTTP 404: workflow ci-runner.yml not found',
    )
    expect(s.alerts()).toHaveLength(1)
    const today = new Date()
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(s.alertText()[0]).toContain(`did not run on ${d}`) // one alert per night: a second failed night is said too
    s.flag('fail-dispatch', false)
    expect(s.run(['scripts/ci-nightly.sh', 'hostile']).code).toBe(0)
    s.flag('fail-dispatch')
    s.run(['scripts/ci-nightly.sh', 'hostile'])
    expect(s.alerts()).toHaveLength(2)
  })

  it('a gh that hangs is stopped at the time limit: exit 1, said as no answer, never a job stuck until the next night', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.flag('hang')
    const t0 = Date.now()
    const r = s.run(['scripts/ci-nightly.sh', 'nightly'], { CI_NIGHTLY_LIMIT_S: '1', CI_NIGHTLY_TRIES: '1' })
    expect(r.code).toBe(1)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(logOf(s)).toContain('no answer from GitHub within 1 s')
  }, 30_000)

  it('a try that timed out but reached GitHub is not dispatched again: the run list is asked first', () => {
    const s = setup()
    s.login('owner', 'tok-owner')
    s.flag('hang')
    s.flag('listed')
    const r = s.run(['scripts/ci-nightly.sh', 'hostile'], { CI_NIGHTLY_LIMIT_S: '1' })
    expect(r.code, r.out).toBe(0)
    expect(
      s
        .calls()
        .split('\n')
        .filter((l) => l.includes('workflow run')),
    ).toHaveLength(1)
    expect(s.calls()).toContain(
      'tok-owner run list --repo owner/talos-app --workflow ci-runner.yml --event workflow_dispatch',
    )
    expect(logOf(s)).toContain('hostile: exit 0: dispatched (the answer timed out, but GitHub lists the run)')
  }, 30_000)

  it('no repository at all: exit 1, an alert saying to set CI_REPO', () => {
    const s = setup()
    const r = s.run(['scripts/ci-nightly.sh', 'nightly'], { CI_REPO: '' })
    expect(r.code).toBe(1)
    expect(s.alertText()[0]).toContain('set CI_REPO')
  })
})
