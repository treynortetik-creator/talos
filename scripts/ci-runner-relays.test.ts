// ci-runner.sh relays: a relay that must run only six-green commits and runs one whose own statuses are not green is an ALERT (an ::error::
// line, an alert file for the lead, a non-zero exit); so is every error and warning of the check itself. A fake gh answers the deployments,
// statuses and runs APIs from files. The environment names here are neutral inventions: the real list is not in the repository.
// docs/CI-MACHINES.md, "The green branch".
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const runnerYmlPath = join(here, '..', '.github/workflows/ci-runner.yml')
const itRunnerYml = existsSync(runnerYmlPath) ? it : it.skip
const dirs: string[] = []
const kills: Array<() => void> = []
afterAll(() => {
  for (const k of kills.splice(0)) k()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const BETA = 'beta-relay-1 / production'
const OWNER = 'owner-relay / production'
const SIX = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/
const slug = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_')
const sha = (n: number) => n.toString(16).padStart(40, '0')
const A = sha(1)
const B = sha(2)
const C = sha(3)
const BOT = 'github-actions[bot]'
const AT = '@' // ssh remotes (user@host) built from parts, so the file has nothing that reads as an e-mail address

type Dep = { id: number; sha: string; state: string }

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ci-relays-'))
  dirs.push(T)
  const r = join(T, 'r')
  const cache = join(T, 'cache')
  const bin = join(T, 'bin')
  for (const d of [
    bin,
    join(T, 'dep'),
    join(T, 'depstat'),
    join(T, 'status'),
    join(T, 'runs'),
    join(r, 'scripts/ci-runner'),
  ])
    mkdirSync(d, { recursive: true })
  for (const f of ['ci-runner.sh', 'ci-runner/green.sh', 'ci-runner/gh-account.sh', 'ci-runner/relays.sh'])
    cpSync(join(here, f), join(r, 'scripts', f))
  writeFileSync(join(T, 'runs', '77'), '77\n') // this job's own run
  // GitHub as `gh api` answers it with --jq applied. dep/<environment, non-alphanumerics as _>: "id<TAB>sha" rows, newest first;
  // dep/_all: the environment of every deployment of the repository; depstat/<id>: the newest status of a deployment (empty: none yet);
  // status/<sha>: the commit's statuses (context, state, description, creator, link), newest first; runs/<id>: "path event head_sha branch".
  // fail: every call fails; fail-deployments: the deployment reads fail; status/<sha>.fail and runs/<id>.fail: that read fails.
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${T}/gh-calls"
echo "\${GH_TOKEN:-(active account)} $*" >> "${T}/gh-tokens"
if [ "$1 $2" = "auth token" ]; then
  [ "$3" = --help ] && { [ -f "${T}/old-gh" ] || echo "  -u, --user string   The account to output the token for"; i=0; while [ $i -lt 4000 ]; do echo "  more help, line $i"; i=$((i+1)); done; exit 0; }
  u=""; prev=""; for a in "$@"; do [ "$prev" = --user ] && u="$a"; prev="$a"; done
  [ -n "$u" ] && [ -f "${T}/accounts/$u" ] && { cat "${T}/accounts/$u"; exit 0; }
  echo "no oauth token found for github.com account $u" >&2; exit 1
fi
[ "$1 $2" = "api user" ] && { echo active-login; exit 0; }
[ -f "${T}/fail" ] && { echo "gh: HTTP 403 for this read" >&2; exit 1; }
path=""; env=""
for a in "$@"; do case "$a" in repos/*) path="$a" ;; environment=*) env="\${a#environment=}" ;; esac; done
case "$path" in
  */deployments/*/statuses) id="\${path#*/deployments/}"; id="\${id%%/*}"; cat "${T}/depstat/$id" 2>/dev/null ;;
  */deployments)
    [ ! -f "${T}/fail-deployments" ] || { echo "gh: HTTP 403 for deployments" >&2; exit 1; }
    if [ -n "$env" ]; then s="$(printf '%s' "$env" | tr -c 'A-Za-z0-9\\n' '_')"; cat "${T}/dep/$s" 2>/dev/null; else cat "${T}/dep/_all" 2>/dev/null; fi ;;
  */commits/*/statuses*) s="\${path#*/commits/}"; s="\${s%%/statuses*}"; [ ! -f "${T}/status/$s.fail" ] || { echo "gh: HTTP 500 for statuses" >&2; exit 1; }; cat "${T}/status/$s" 2>/dev/null ;;
  */actions/runs/*) id="\${path#*/actions/runs/}"; [ ! -f "${T}/runs/$id.fail" ] || { echo "gh: HTTP 500 for a run" >&2; exit 1; }; cat "${T}/runs/$id" 2>/dev/null ;;
esac
exit 0
`,
    { mode: 0o755 },
  )
  // ssh -G for a host alias of github.com (a Mac with two logins), and nothing else
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh
[ "$1" = -G ] || exit 1
[ "$2" = -- ] && shift
case "$2" in github-personal) echo "hostname github.com" ;; *) echo "hostname $2" ;; esac
`,
    { mode: 0o755 },
  )
  const allEnv: string[] = []
  const deploy = (env: string, deps: Dep[]) => {
    writeFileSync(join(T, 'dep', slug(env)), deps.map((d) => `${d.id}\t${d.sha}\n`).join(''))
    for (const d of deps) {
      writeFileSync(join(T, 'depstat', String(d.id)), d.state === '' ? '' : `${d.state}\n`)
      allEnv.push(env)
    }
    writeFileSync(join(T, 'dep', '_all'), allEnv.map((e) => `${e}\n`).join(''))
  }
  let run = 1000
  const desc = (st: string) => (st === 'success' ? 'passed on ci-runner in 9s' : `${st} on ci-runner`)
  // a commit's statuses, posted by a push run of ci-runner.yml of that very commit on main (what the trust rules want)
  const statuses = (s: string, rows: { job: string; state: string; creator?: string }[]) => {
    const id = ++run
    writeFileSync(
      join(T, 'status', s),
      rows
        .map(
          (x) =>
            `local-ci/${x.job}\t${x.state}\t${desc(x.state)}\t${x.creator ?? BOT}\thttps://github.com/owner/talos-app/actions/runs/${id}/attempts/1#lemnos\n`,
        )
        .join(''),
    )
    writeFileSync(join(T, 'runs', String(id)), `.github/workflows/ci-runner.yml\tpush\t${s}\tmain\n`)
    return id
  }
  const six = (s: string, over: Record<string, string> = {}) =>
    statuses(
      s,
      SIX.map((job) => ({ job, state: over[job] ?? 'success' })),
    )
  const cfg = { list: '', hand: '' }
  const lists = (relays: string, hand = '') => {
    cfg.list = relays
    cfg.hand = hand
  }
  const go = (extra: Record<string, string> = {}) => {
    const p = spawnSync('bash', ['scripts/ci-runner.sh', 'relays'], {
      cwd: r,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '77',
        GH_TOKEN: 't',
        CI_RELAY_DEPLOYS: cfg.list,
        CI_RELAY_HAND_DEPLOYS: cfg.hand,
        ...extra,
      },
      encoding: 'utf8',
    })
    return { code: p.status, out: p.stdout + p.stderr }
  }
  const tsv = () => {
    const f = join(cache, 'logs/relays.tsv')
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t'))
      : []
  }
  const alerts = () =>
    existsSync(join(cache, 'alerts')) ? readdirSync(join(cache, 'alerts')).filter((f) => f.endsWith('.txt')) : []
  const readAlert = (f: string) => readFileSync(join(cache, 'alerts', f), 'utf8')
  const ghCalls = () => (existsSync(join(T, 'gh-calls')) ? readFileSync(join(T, 'gh-calls'), 'utf8') : '')
  // "<the GH_TOKEN a call ran with> <its arguments>" lines
  const ghTokens = () => (existsSync(join(T, 'gh-tokens')) ? readFileSync(join(T, 'gh-tokens'), 'utf8') : '')
  /** gh on this machine is logged in to `user`, whose token is `token` */
  const login = (user: string, token: string) => {
    mkdirSync(join(T, 'accounts'), { recursive: true })
    writeFileSync(join(T, 'accounts', user), `${token}\n`)
  }
  const one = (env = BETA, mode = 'green') => lists(`${env}\t${mode}\n`)
  return { T, deploy, statuses, six, lists, one, run: go, tsv, alerts, readAlert, ghCalls, ghTokens, login, r, cache }
}
const ok = (id: number, s: string): Dep => ({ id, sha: s, state: 'success' })

describe('ci-runner.sh relays: a green-only relay must run a commit whose own six statuses are green', () => {
  it('a beta relay on a six-green commit is ok, and nothing is alerted', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`${BETA} runs ${A.slice(0, 7)}`)
    expect(r.out).toContain('its own six statuses read green: ok')
    expect(r.out).not.toContain('::error::')
    expect(s.alerts()).toEqual([])
    expect(s.ghCalls()).not.toContain('git/ref') // no branch is read: green's tip does not matter
  })

  it('a six-green commit that is neither the tip of anything nor newest on main is ok too', () => {
    const s = setup()
    s.six(A)
    s.statuses(B, [{ job: 'check', state: 'failure' }]) // a newer commit, red, not deployed
    s.deploy(BETA, [ok(11, A)])
    s.one()
    expect(s.run().code).toBe(0)
  })

  it('a commit whose statuses are red is an ALERT: ::error::, an alert file naming everything, exit non-zero', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.deploy(BETA, [ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain(`::error::ci-runner: relays: ${BETA} runs ${A.slice(0, 7)}`)
    const files = s.alerts()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(new RegExp(`^\\d+-${A.slice(0, 7)}-relay-not-green\\.txt$`))
    const text = s.readAlert(files[0] as string)
    for (const want of [BETA, A, 'red', 'roll back', 'hand-deploy list']) expect(text, want).toContain(want)
    expect(s.tsv()).toHaveLength(1)
    expect(s.tsv()[0]?.slice(1, 4)).toEqual([BETA, A, 'red'])
    expect(s.tsv()[0]?.[4]).toMatch(/^ALERT/)
  })

  it.each([
    ['pending', { check: 'pending' }],
    ['skipped', { check: 'success', mod: 'error' }],
  ])('statuses that read %s are never ok', (_n, over) => {
    const s = setup()
    s.six(A, over)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('::error::')
    expect(s.alerts()).toHaveLength(1)
  })

  it('statuses for only some of the six (partial), or none at all, are never ok', () => {
    const s = setup()
    s.statuses(A, [{ job: 'check', state: 'success' }])
    s.deploy(BETA, [ok(11, A)])
    s.one()
    expect(s.run().code).not.toBe(0)
    const s2 = setup()
    s2.deploy(BETA, [ok(11, B)])
    s2.one()
    expect(s2.run().code).not.toBe(0)
    expect(s2.alerts()).toHaveLength(1)
  })

  it('six greens not posted by the workflow bot are untrusted: not ok, and the line says they were ignored', () => {
    const s = setup()
    s.statuses(
      A,
      SIX.map((job) => ({ job, state: 'success', creator: 'someone-else' })),
    )
    s.deploy(BETA, [ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('relays: ignored an untrusted status')
    expect(s.alerts()).toHaveLength(1)
  })

  it('statuses that cannot be read are an ERROR (an alert of its own kind), never ok and never "not green"', () => {
    const s = setup()
    s.six(A)
    writeFileSync(join(s.T, 'status', `${A}.fail`), '')
    s.deploy(BETA, [ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(
      `::error::ci-runner: relays: ${BETA} runs ${A.slice(0, 7)} and its statuses cannot be judged`,
    )
    expect(r.out).toContain('HTTP 500')
    expect(r.out).not.toMatch(/: ok/)
    expect(s.tsv()[0]?.[4]).toMatch(/^error/)
    const files = s.alerts()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-relay-error\.txt$/)
  })

  it('a run behind a status that cannot be read is an error too', () => {
    const s = setup()
    const id = s.six(A)
    writeFileSync(join(s.T, 'runs', `${id}.fail`), '')
    s.deploy(BETA, [ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('::error::')
    expect(s.alerts()).toHaveLength(1)
  })

  it('said once per relay and commit until the next ok: a second run still fails loudly but writes no second alert', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.deploy(BETA, [ok(11, A)])
    s.one()
    expect(s.run().code).not.toBe(0)
    const again = s.run()
    expect(again.code).not.toBe(0)
    expect(again.out).toContain('::error::')
    expect(s.alerts()).toHaveLength(1)
    s.six(A) // its statuses turn green: ok, and the memory of the alert goes
    expect(s.run().code).toBe(0)
    s.six(A, { mod: 'failure' })
    expect(s.run().code).not.toBe(0)
    expect(s.alerts()).toHaveLength(2) // the same commit off green again is said again
  })

  it('a commit on the hand-deploy list for that environment is ok, and the line says so', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.deploy(BETA, [ok(11, A)])
    s.lists(`${BETA}\tgreen\n`, `${A}\t${BETA}\t2026-11-18\tsecurity fix, before CI finished\n`)
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('allowlisted')
    expect(r.out).toContain('security fix, before CI finished')
    expect(s.alerts()).toEqual([])
    expect(s.tsv()[0]?.[4]).toMatch(/^ok.*allowlisted/)
  })

  it('a hand-deploy line for another environment or another commit does not excuse this one', () => {
    const s = setup()
    s.six(B, { mod: 'failure' })
    s.deploy(BETA, [ok(11, B)])
    s.lists(
      `${BETA}\tgreen\n`,
      `${B}\t${OWNER}\t2026-11-18\twrong environment\n${A}\t${BETA}\t2026-11-18\twrong commit\n`,
    )
    expect(s.run().code).not.toBe(0)
    expect(s.alerts()).toHaveLength(1)
  })

  it('a main-tracking relay on a red commit: one info line saying what its statuses read, never an alert, exit 0', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.deploy(OWNER, [ok(21, A)])
    s.one(OWNER, 'main')
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`info: ${OWNER} (tracks main) runs ${A.slice(0, 7)}; its six statuses read red`)
    expect(r.out).not.toContain('::error::')
    expect(s.alerts()).toEqual([])
    expect(s.tsv()[0]?.slice(1, 4)).toEqual([OWNER, A, 'red'])
    expect(s.tsv()[0]?.[4]).toMatch(/^info/)
  })

  it('a newer deployment that failed or is still in progress does not count: the older successful one is judged', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [{ id: 13, sha: C, state: 'in_progress' }, { id: 12, sha: B, state: 'failure' }, ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`runs ${A.slice(0, 7)}`)
    expect(s.tsv()[0]?.[2]).toBe(A)
    // and the other way: the successful one that is not six-green is what is judged, whatever came after it
    s.deploy(BETA, [
      { id: 13, sha: A, state: 'failure' },
      { id: 12, sha: C, state: 'success' },
    ])
    const bad = s.run()
    expect(bad.code).not.toBe(0)
    expect(bad.out).toContain(C.slice(0, 7))
  })

  it('a deployment with no status yet, or an inactive one, is not running', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [{ id: 13, sha: B, state: '' }, { id: 12, sha: B, state: 'inactive' }, ok(11, A)])
    s.one()
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`runs ${A.slice(0, 7)}`)
  })

  it('deployments but no successful one: a warning, a tsv row and an alert file, never a silent ok (exit 0)', () => {
    const s = setup()
    s.deploy(BETA, [{ id: 11, sha: A, state: 'failure' }])
    s.one()
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`::warning::ci-runner: relays: ${BETA} has no successful deployment`)
    expect(s.tsv()[0]?.[4]).toMatch(/^warning/)
    const files = s.alerts()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-relay-warning\.txt$/)
  })

  it('a listed environment with NO deployment at all (a typo?) is an error and an alert, not a warning', () => {
    const s = setup()
    s.six(A)
    s.deploy(OWNER, [ok(21, A)])
    s.lists(`${OWNER}\tmain\nbeta-relay-typo / production\tgreen\n`)
    const r = s.run()
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays: beta-relay-typo / production has no deployment at all')
    expect(s.alerts()).toHaveLength(1)
    expect(s.alerts()[0]).toMatch(/-relay-nodeploy\.txt$/)
  })

  it('an environment with deployments that is not in the list is an error and an alert (a rename, a new relay)', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.deploy('beta-relay-2 / production', [ok(31, A)])
    s.one()
    const r = s.run()
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays: unlisted relay environment: beta-relay-2 / production')
    expect(s.alerts()).toHaveLength(1)
    expect(s.alerts()[0]).toMatch(/-relay-unlisted\.txt$/)
    expect(s.readAlert(s.alerts()[0] as string)).toContain('beta-relay-2 / production')
    s.run()
    expect(s.alerts()).toHaveLength(1) // said once
    s.lists(`${BETA}\tgreen\nbeta-relay-2 / production\tgreen\n`) // listed now: ok, and it is forgotten
    expect(s.run().code).toBe(0)
  })

  it('gh failing at all is a loud error, never ok: an alert file, said once, cleared by the next ok, said again later', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    writeFileSync(join(s.T, 'fail'), '')
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays:')
    expect(r.out).toContain('HTTP 403')
    expect(r.out).not.toMatch(/: ok/)
    expect(s.tsv()[0]?.[4]).toMatch(/^error/)
    expect(s.alerts()).toHaveLength(1)
    expect(s.run().code).not.toBe(0)
    expect(s.alerts()).toHaveLength(1) // a second identical failure: no second file
    rmSync(join(s.T, 'fail'))
    expect(s.run().code).toBe(0)
    expect(s.alerts()).toHaveLength(1)
    writeFileSync(join(s.T, 'fail'), '')
    expect(s.run().code).not.toBe(0)
    expect(s.alerts()).toHaveLength(2) // cleared by the ok, so said again
  })

  it('the deployments of one relay unreadable (a lost deployments: read) is an error and an alert for it', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    writeFileSync(join(s.T, 'fail-deployments'), '')
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`::error::ci-runner: relays: ${BETA}: the deployments could not be read`)
    expect(s.alerts().length).toBeGreaterThanOrEqual(1)
    expect(s.tsv().some((row) => row[1] === BETA && /^error/.test(row[4] ?? ''))).toBe(true)
  })

  it('this job\'s own run unreadable (no actions: read) is an error, so statuses are never silently "untrusted"', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    writeFileSync(join(s.T, 'runs', '77.fail'), '')
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("this job's own run 77 could not be read")
    expect(s.alerts()).toHaveLength(1)
  })

  it('the lists: a missing or empty relay list is an error and an alert, never "nothing to check"', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.lists('')
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays: no relay list')
    expect(s.alerts()).toHaveLength(1)
    expect(s.ghCalls()).toBe('')
    s.lists('# only a comment\n\n')
    const e = s.run()
    expect(e.code).not.toBe(0)
    expect(e.out).toContain('lists no relay')
    expect(s.alerts()).toHaveLength(1) // the same kind: said once
  })

  it('the relay list can come from a file outside the repository: ~/.config/talos-ci/relay-deploys.txt', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    mkdirSync(join(s.T, '.config/talos-ci'), { recursive: true })
    writeFileSync(join(s.T, '.config/talos-ci/relay-deploys.txt'), `# mine\n${BETA}\tgreen\n`)
    s.lists('')
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('ok')
  })

  it('a one-line variable survives: a literal \\t and \\n are a tab and a newline (and a CR is ignored)', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.deploy(BETA, [ok(11, A)])
    s.deploy(OWNER, [ok(21, A)])
    s.lists(`${BETA}\\tgreen\r\\n${OWNER}\\tmain`, `${A}\\t${OWNER}\\t2026-11-18\\treason here`)
    const r = s.run()
    expect(r.code).not.toBe(0) // the beta relay is red
    expect(s.tsv().map((x) => x[1])).toEqual([BETA, OWNER])
    expect(r.out).toContain(`info: ${OWNER}`)
  })

  it('the hand-deploy list can come from a file outside the repository too; absent means empty', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.deploy(BETA, [ok(11, A)])
    s.one()
    expect(s.run().code).not.toBe(0)
    mkdirSync(join(s.T, '.config/talos-ci'), { recursive: true })
    writeFileSync(join(s.T, '.config/talos-ci/relay-hand-deploys.txt'), `${A}\t${BETA}\t2026-11-18\tby hand\n`)
    expect(s.run().code).toBe(0)
  })

  it.each([
    ['a line with no mode', `${BETA}\n`],
    ['a mode that is neither green nor main', `${BETA}\tstaging\n`],
    ['an extra column', `${BETA}\tgreen\textra\n`],
    ['a space-separated line', `${BETA} green\n`],
    ['an environment listed twice', `${BETA}\tgreen\n${BETA}\tmain\n`],
  ])(
    'a malformed relay list (%s): an error, an alert and exit non-zero, before anything is read from GitHub',
    (_n, body) => {
      const s = setup()
      s.six(A)
      s.deploy(BETA, [ok(11, A)])
      s.lists(body)
      const r = s.run()
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('::error::ci-runner: relays: the relay list line')
      expect(s.ghCalls()).toBe('')
      expect(s.alerts()).toHaveLength(1)
    },
  )

  it('a name that is only part of another listed name is not a duplicate (exact first field)', () => {
    const s = setup()
    s.six(A)
    s.deploy('beta-relay / production', [ok(11, A)])
    s.deploy('relay / production', [ok(12, A)])
    s.lists('beta-relay / production\tgreen\nrelay / production\tgreen\n')
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(s.tsv()).toHaveLength(2)
  })

  it.each([
    ['a short sha', `abc123\t${BETA}\t2026-11-18\treason\n`],
    ['a missing reason', `${'a'.repeat(40)}\t${BETA}\t2026-11-18\n`],
    ['a date that is not a date', `${'a'.repeat(40)}\t${BETA}\tyesterday\treason\n`],
    ['an upper-case sha', `${'A'.repeat(40)}\t${BETA}\t2026-11-18\treason\n`],
    ['an empty reason', `${'a'.repeat(40)}\t${BETA}\t2026-11-18\t\n`],
  ])('a malformed hand-deploy line (%s): an error, an alert and exit non-zero', (_n, body) => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.lists(`${BETA}\tgreen\n`, body)
    const r = s.run()
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays: the hand-deploy list line')
    expect(s.ghCalls()).toBe('')
    expect(s.alerts()).toHaveLength(1)
  })

  it('every environment gets a tsv row (UTC time, environment, commit, verdict, result); one bad relay fails the run but the rest are checked', () => {
    const s = setup()
    s.six(A, { mod: 'failure' })
    s.six(B)
    s.deploy(BETA, [ok(11, A)])
    s.deploy(OWNER, [ok(21, B)])
    s.lists(`${BETA}\tgreen\n${OWNER}\tmain\n`)
    expect(s.run().code).not.toBe(0)
    const rows = s.tsv()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.[0]).toMatch(ISO)
    expect(rows[0]?.slice(1, 4)).toEqual([BETA, A, 'red'])
    expect(rows[0]?.[4]).toMatch(/^ALERT/)
    expect(rows[1]?.slice(1, 4)).toEqual([OWNER, B, 'green'])
    expect(rows[1]?.[4]).toMatch(/^info/)
    s.run()
    expect(s.tsv()).toHaveLength(4)
  })

  it('the repository comes from GITHUB_REPOSITORY, else CI_REPO', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    s.run({ GITHUB_REPOSITORY: '', CI_REPO: 'someone/else', GITHUB_RUN_ID: '' }) // its statuses are of another repository: not asserted
    expect(s.ghCalls()).toContain('repos/someone/else/deployments')
  })

  it("with no GH_TOKEN every call runs with the repository owner's token, asked for by name, never the active account", () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    s.login('owner', 'tok-owner')
    s.login('work-account', 'tok-work') // another login on the same Mac: never used
    const r = s.run({ GH_TOKEN: '' })
    expect(r.code, r.out).toBe(0)
    expect(s.ghCalls()).toContain('auth token --hostname github.com --user owner')
    const calls = s
      .ghTokens()
      .split('\n')
      .filter((l) => l.includes(' api '))
    expect(calls.length).toBeGreaterThan(2)
    for (const c of calls) expect(c.startsWith('tok-owner '), c).toBe(true)
  })

  it('CI_GH_USER names another account', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    s.login('ci-bot', 'tok-bot')
    const r = s.run({ GH_TOKEN: '', CI_GH_USER: 'ci-bot' })
    expect(r.code, r.out).toBe(0)
    for (const c of s
      .ghTokens()
      .split('\n')
      .filter((l) => l.includes(' api ')))
      expect(c.startsWith('tok-bot '), c).toBe(true)
  })

  it('a GH_TOKEN that is set is used as it is, and no account is asked for', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    expect(s.run().code).toBe(0)
    expect(s.ghCalls()).not.toContain('auth token')
  })

  it("the owner's account not logged in is an error and an alert naming the account and the fix; nothing is read as the active account", () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    s.login('work-account', 'tok-work')
    const r = s.run({ GH_TOKEN: '' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays: gh on this machine has no login for owner')
    expect(r.out).toContain("gh's active account is never used")
    expect(s.ghCalls()).not.toContain('api user') // the active account is not even asked who it is
    expect(r.out).toContain('gh auth login')
    expect(s.alerts()).toHaveLength(1)
    expect(s.readAlert(s.alerts()[0] as string)).toContain('no login for owner')
    expect(s.ghCalls()).not.toContain('repos/') // not one repository read went out
  })

  it("with no GITHUB_REPOSITORY or CI_REPO the repository is this checkout's github.com origin (https or ssh)", () => {
    for (const url of [
      'https://github.com/someone/else.git',
      'https://github.com/someone/else/',
      `git${AT}github.com:someone/else.git`,
      `ssh://git${AT}github.com/someone/else.git`,
      `git${AT}github-personal:someone/else.git`, // an ssh alias whose hostname is github.com
      'https://github.com/someone_x/else_y.git', // _ is allowed in names
    ]) {
      const s = setup()
      s.six(A)
      s.deploy(BETA, [ok(11, A)])
      s.one()
      const [owner, name] = url.includes('someone_x') ? ['someone_x', 'else_y'] : ['someone', 'else']
      s.login(owner, 'tok-someone')
      spawnSync('git', ['init', '-q'], { cwd: s.r })
      spawnSync('git', ['remote', 'add', 'origin', url], { cwd: s.r })
      s.run({ GITHUB_REPOSITORY: '', CI_REPO: '', GITHUB_RUN_ID: '', GH_TOKEN: '' })
      expect(s.ghCalls(), url).toContain(`repos/${owner}/${name}/deployments`)
      expect(s.ghCalls(), url).not.toContain('repo view')
      expect(s.ghCalls(), url).toContain(`--user ${owner}`)
    }
  })

  it('an origin that is not github.com (or an alias of it) is not used as the repository', () => {
    for (const url of ['https://gitlab.com/someone/else.git', 'git@elsewhere:someone/else.git']) {
      const s = setup()
      s.one()
      spawnSync('git', ['init', '-q'], { cwd: s.r })
      spawnSync('git', ['remote', 'add', 'origin', url], { cwd: s.r })
      s.run({ GITHUB_REPOSITORY: '', CI_REPO: '', GITHUB_RUN_ID: '', GH_TOKEN: '' })
      expect(s.ghCalls(), url).toContain('repo view')
      expect(s.ghCalls(), url).not.toContain('someone/else')
    }
  })

  it('a token that comes back empty is the not-logged-in error too', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    s.login('owner', '')
    const r = s.run({ GH_TOKEN: '' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no login for owner')
    expect(s.ghCalls()).not.toContain('repos/')
  })

  it("in Actions an empty GH_TOKEN is an error, and the runner's own login is never asked for", () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    s.login('owner', 'tok-owner')
    const r = s.run({ GH_TOKEN: '', GITHUB_ACTIONS: 'true' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('::error::ci-runner: relays: GH_TOKEN is empty in this Actions job')
    expect(s.ghCalls()).not.toContain('auth token')
    expect(s.ghCalls()).not.toContain('repos/')
    expect(s.alerts()).toHaveLength(1)
  })

  it('a gh with no --user for auth token says so, instead of "not logged in"', () => {
    const s = setup()
    s.one()
    s.login('owner', 'tok-owner')
    writeFileSync(join(s.T, 'old-gh'), '')
    const r = s.run({ GH_TOKEN: '' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('gh 2.40 or newer')
    expect(r.out).not.toContain('no login for')
  })

  it('the account error is kept quiet apart from the other check errors: a new cause after "no repository" is still said', () => {
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.one()
    writeFileSync(join(s.T, 'fail'), '') // gh repo view fails: "no repository"
    s.run({ GITHUB_REPOSITORY: '', CI_REPO: '', GITHUB_RUN_ID: '' })
    expect(s.alerts()).toHaveLength(1)
    const r = s.run({ GH_TOKEN: '' }) // the repository is known now, the owner's login is missing
    expect(r.out).toContain('no login for owner')
    expect(s.alerts()).toHaveLength(2)
  })

  it('the shipped examples parse, and run: neutral names, one green relay and one main relay', () => {
    const list = readFileSync(join(here, 'relay-deploys.example.txt'), 'utf8')
    const lines = list.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(lines).toEqual([`${BETA}\tgreen`, `${OWNER}\tmain`])
    const hand = readFileSync(join(here, 'relay-hand-deploys.example.txt'), 'utf8')
    const handLines = hand.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(handLines).toHaveLength(1)
    const s = setup()
    s.six(A)
    s.deploy(BETA, [ok(11, A)])
    s.deploy(OWNER, [ok(21, A)])
    s.lists(list, hand)
    const r = s.run()
    expect(r.code, r.out).toBe(0)
    expect(s.alerts()).toEqual([])
  })
})

describe('where the check runs', () => {
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
  itRunnerYml(
    'a relays job after green on every push run of main: read-only token, the lists from repository variables, green untouched',
    () => {
      const j = jobs()
      const rel = j.relays as Job
      expect(rel.needs).toEqual(['green']) // after the move, never before it
      expect(rel.if).toContain("github.event_name == 'push'")
      expect(rel.if).toContain("github.ref == 'refs/heads/main'")
      expect(rel.if).toContain('!cancelled()') // it runs when green failed or stood aside: a hand deploy is checked regardless
      expect(rel.permissions).toEqual({ contents: 'read', deployments: 'read', statuses: 'read', actions: 'read' })
      for (const p of Object.values(rel.permissions ?? {})) expect(p).toBe('read')
      expect(j.green?.permissions).toEqual({ contents: 'write', statuses: 'read', actions: 'read' }) // not widened
      const runs = rel.steps.filter((s) => s.run).map((s) => s.run)
      expect(runs).toEqual(['bash scripts/ci-runner.sh relays'])
      const body = JSON.stringify(rel.steps)
      expect(body).toContain('vars.CI_RELAY_DEPLOYS')
      expect(body).toContain('vars.CI_RELAY_HAND_DEPLOYS')
      expect(body).not.toContain('ci-local.sh')
      expect(JSON.stringify(rel)).not.toContain('continue-on-error') // a failing check is a failed step, visible
      expect(j.green?.needs).toEqual(['plan', 'ci']) // green waits for nothing of relays: it can never block the move
      expect(j.close?.needs).toContain('relays')
    },
  )
})

describe('ci-alerts.sh watch checks the relays between pushes', () => {
  const watch = (runnerStub: string, env: Record<string, string> = {}) => {
    const T = mkdtempSync(join(tmpdir(), 'ci-relays-watch-'))
    dirs.push(T)
    const scripts = join(T, 'scripts')
    const cache = join(T, 'cache')
    mkdirSync(scripts)
    mkdirSync(join(cache, 'alerts'), { recursive: true })
    cpSync(join(here, 'ci-alerts.sh'), join(scripts, 'ci-alerts.sh'))
    writeFileSync(join(scripts, 'ci-runner.sh'), runnerStub.replaceAll('@T@', T))
    writeFileSync(join(scripts, 'lead-inbox.sh'), '#!/bin/sh\nexit 0\n')
    const p = spawn('bash', [join(scripts, 'ci-alerts.sh'), 'watch'], {
      env: { PATH: process.env.PATH ?? '', HOME: T, TALOS_CI_CACHE: cache, TALOS_CI_ALERTS_EVERY: '0.05', ...env },
      detached: true,
      stdio: 'ignore',
    })
    kills.push(() => {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL')
      } catch {} // already gone
    })
    return { T, cache }
  }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 25))
  }

  it('runs ci-runner.sh relays in the background with the 10-minute untested check', async () => {
    const { T } = watch(`#!/bin/sh\necho "$1" >> '@T@/calls'\n`)
    const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').split('\n') : [])
    await until(() => calls().includes('untested') && calls().includes('relays'))
    expect(calls()).toContain('untested')
    expect(calls()).toContain('relays')
  }, 20_000)

  it('a check that outlives its group time limit is stopped, and says so in an alert (never silence), once', async () => {
    const { cache } = watch(`#!/bin/sh\n[ "$1" = untested ] && sleep 60\nexit 0\n`, { TALOS_CI_CHECK_LIMIT: '1' })
    const files = () =>
      existsSync(join(cache, 'alerts'))
        ? readdirSync(join(cache, 'alerts')).filter((f) => f.endsWith('-check-timeout.txt'))
        : []
    await until(() => files().length > 0)
    expect(files()).toHaveLength(1)
    expect(readFileSync(join(cache, 'alerts', files()[0] as string), 'utf8')).toContain('did not finish within 1 s')
  }, 30_000)
})
