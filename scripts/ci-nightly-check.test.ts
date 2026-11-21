// ci-runner.sh nightly-check: the 07:00 check that tonight's nightly and hostile dispatches (scripts/ci-nightly.sh, one line each in
// logs/ci-nightly.log) did report a result. A dispatch that went out and posted nothing is ONE message for the lead per kind and
// morning, in alerts/ (ci-alerts.sh watch passes it on). A fake gh and a fake clock (CI_NIGHTLY_CHECK_NOW); never the real GitHub.
import { spawnSync } from 'node:child_process'
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
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-runner.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const URL = (id: number | string) => `https://github.com/owner/talos-app/actions/runs/${id}`

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'nightly-check-'))
  dirs.push(T)
  const cache = join(T, 'cache')
  const bin = join(T, 'bin')
  for (const d of [join(cache, 'logs'), bin, join(T, 'runs'), join(T, 'statuses')]) mkdirSync(d, { recursive: true })
  // gh: a run's "head<TAB>status<TAB>conclusion" from runs/<id>, a commit's "context<TAB>state<TAB>link" rows from statuses/<sha>;
  // every call is written to calls; GH_FAIL=1 is GitHub unreadable
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/bash
echo "$*" >> "${T}/calls"
[ -z "$GH_FAIL" ] || { echo "HTTP 502" >&2; exit 1; }
case "$*" in
  *"/statuses"*) sha=$(echo "$*" | sed -n 's|.*commits/\\([0-9a-f]*\\)/statuses.*|\\1|p'); cat "${T}/statuses/$sha" 2>/dev/null; exit 0 ;;
  *actions/runs/[0-9]*) id=$(echo "$*" | sed -n 's|.*actions/runs/\\([0-9]*\\).*|\\1|p'); cat "${T}/runs/$id" 2>/dev/null || { echo "HTTP 404: Not Found" >&2; exit 1; } ;;
esac
`,
    { mode: 0o755 },
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const at = new Date()
  at.setHours(8, 0, 0, 0) // this morning, 08:00 local
  const morning = at
  const at7 = (h: number, m: number, s = 0) => {
    const d = new Date(morning)
    d.setHours(h, m, s, 0)
    return d
  }
  const yesterday = (h: number, m: number) => {
    const d = at7(h, m)
    d.setDate(d.getDate() - 1)
    return d
  }
  const log = (...lines: string[]) => writeFileSync(join(cache, 'logs/ci-nightly.log'), `${lines.join('\n')}\n`)
  const runRow = (id: number, head: string, status: string, conclusion = 'success') =>
    writeFileSync(join(T, 'runs', String(id)), `${head}\t${status}\t${conclusion}\n`)
  const statuses = (head: string, rows: string[][]) =>
    writeFileSync(join(T, 'statuses', head), `${rows.map((r) => r.join('\t')).join('\n')}\n`)
  const check = (now: Date = morning, extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [script, 'nightly-check'], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GITHUB_REPOSITORY: 'owner/talos-app',
        GH_TOKEN: 't',
        CI_NIGHTLY_CHECK_NOW: String(Math.floor(now.getTime() / 1000)),
        ...extra,
      },
      encoding: 'utf8',
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const alerts = () => {
    const d = join(cache, 'alerts')
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('-unreported.txt')) : []
  }
  const alertText = (f: string) => readFileSync(join(cache, 'alerts', f), 'utf8')
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8') : '')
  return { T, cache, log, runRow, statuses, check, alerts, alertText, calls, at7, yesterday }
}
const HEAD = 'c'.repeat(40)

describe('ci-runner.sh nightly-check', () => {
  it('a dispatch that posted no result by 07:00 is ONE message naming the kind, the dispatch time and the run id', () => {
    const s = setup()
    s.log(
      `${stamp(s.at7(2, 17, 9))} nightly: exit 0: ${URL(11)}`,
      `${stamp(s.at7(4, 43, 7))} hostile: exit 0: ${URL(22)}`,
    )
    s.runRow(11, HEAD, 'completed', 'success') // it skipped itself: finished, posted nothing
    s.runRow(22, HEAD, 'completed', 'success')
    s.statuses(HEAD, [['hostile-ci/check', 'success', `${URL(22)}/attempts/1#lemnos`]])
    const r = s.check()
    expect(r.code, r.err).toBe(0)
    const files = s.alerts()
    expect(files).toHaveLength(1) // the hostile run reported; only the nightly did not
    const text = s.alertText(files[0])
    expect(text).toContain('the nightly run dispatched at')
    expect(text).toContain(stamp(s.at7(2, 17, 9)).slice(0, 16)) // date and HH:MM
    expect(text).toContain('run 11')
    expect(text).toContain(URL(11))
    expect(text).toContain('completed/success')
    expect(text.trim().split('\n')).toHaveLength(1) // one line: the watcher prints the first
  })

  it('says it once per kind and morning: a second check writes nothing more', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'queued', 'none')
    s.check()
    s.check(s.at7(7, 40))
    s.check(s.at7(9, 0))
    expect(s.alerts()).toHaveLength(1)
    expect(s.alertText(s.alerts()[0])).toContain('queued/none')
  })

  it('a final nightly-ci/ status linked to the run is a result: no message, and it is not looked up again', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'completed')
    s.statuses(HEAD, [['nightly-ci/check', 'failure', `${URL(11)}/attempts/1#lemnos`]]) // red is a result too
    expect(s.check().code).toBe(0)
    expect(s.alerts()).toEqual([])
    const n = s.calls().split('\n').length
    s.check()
    expect(s.calls().split('\n').length).toBe(n) // done for this morning
  })

  it('a pending status is no result, another run’s status is none of this run’s, and the other kind’s context is not either', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'completed', 'success')
    s.statuses(HEAD, [
      ['nightly-ci/check', 'pending', `${URL(11)}/attempts/1#lemnos`],
      ['nightly-ci/mod', 'success', `${URL(99)}/attempts/1#lemnos`],
      ['nightly-ci/mobile', 'success', `${URL(110)}/attempts/1#lemnos`], // another run whose id starts with this one's
      ['hostile-ci/mod', 'success', `${URL(11)}/attempts/1#lemnos`],
      ['local-ci/check', 'success', `${URL(11)}/attempts/1#lemnos`],
    ])
    s.check()
    expect(s.alerts()).toHaveLength(1)
    expect(s.alertText(s.alerts()[0])).toContain('completed/success')
  })

  it('only Lemnos’s own statuses are the run’s result: another machine posts its part under the same prefix even when Lemnos skipped', () => {
    const s = setup()
    s.log(`${stamp(s.at7(4, 43))} hostile: exit 0: ${URL(22)}`)
    s.runRow(22, HEAD, 'completed', 'success') // Lemnos skipped it; Titan's parts still posted
    s.statuses(HEAD, [
      ['hostile-ci/report-browser-e2e', 'success', `${URL(22)}/attempts/1#browser-e2e`],
      ['hostile-ci/report-check', 'error', `${URL(22)}/attempts/1#check-titan`],
      ['hostile-ci/image', 'success', `${URL(22)}/attempts/1#titan`],
      ['hostile-ci/report-linux', 'success', `${URL(22)}/attempts/1#hestia`],
    ])
    s.check()
    expect(s.alerts()).toHaveLength(1)
    expect(s.alertText(s.alerts()[0])).toContain('the hostile run dispatched at')
  })

  it('Lemnos’s own link may be the bare run url, or with the attempt, or with #lemnos: each is a result', () => {
    for (const link of [URL(11), `${URL(11)}/attempts/1`, `${URL(11)}/attempts/2#lemnos`]) {
      const s = setup()
      s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
      s.runRow(11, HEAD, 'completed')
      s.statuses(HEAD, [['nightly-ci/check', 'success', link]])
      s.check()
      expect(s.alerts(), link).toEqual([])
    }
  })

  it('a run still going at 07:00 is looked at again, not alarmed about: until 10:00, then it is said; a queued one at once', () => {
    const s = setup()
    s.log(`${stamp(s.at7(4, 43))} hostile: exit 0: ${URL(22)}`)
    s.runRow(22, HEAD, 'in_progress', 'none')
    s.statuses(HEAD, [['hostile-ci/check', 'pending', `${URL(22)}/attempts/1#lemnos`]])
    expect(s.check(s.at7(7, 0)).out).toContain('still going')
    s.check(s.at7(9, 59))
    expect(s.alerts()).toEqual([])
    s.runRow(22, HEAD, 'completed', 'success') // it finishes, with a result: nothing to say, ever
    s.statuses(HEAD, [['hostile-ci/check', 'success', `${URL(22)}/attempts/1#lemnos`]])
    s.check(s.at7(10, 10))
    expect(s.alerts()).toEqual([])
    const t = setup()
    t.log(`${stamp(t.at7(4, 43))} hostile: exit 0: ${URL(22)}`)
    t.runRow(22, HEAD, 'in_progress', 'none')
    t.check(t.at7(10, 0))
    expect(t.alerts()).toHaveLength(1) // still going, and no result, 3 h past the deadline
    expect(t.alertText(t.alerts()[0])).toContain('in_progress/none')
  })

  it('a run that is no longer there (404) is said, and the other kind is still checked', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`, `${stamp(s.at7(4, 43))} hostile: exit 0: ${URL(22)}`)
    // run 11 does not exist; run 22 reported
    s.runRow(22, HEAD, 'completed')
    s.statuses(HEAD, [['hostile-ci/check', 'success', `${URL(22)}/attempts/1#lemnos`]])
    const r = s.check()
    expect(r.code, r.err).toBe(0)
    expect(s.alerts()).toHaveLength(1)
    expect(s.alertText(s.alerts()[0])).toContain('the nightly run dispatched at')
    expect(s.alertText(s.alerts()[0])).toContain('gone/none')
  })

  it('nothing before 07:00, and no GitHub call', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'queued', 'none')
    const r = s.check(s.at7(6, 59, 59))
    expect(r.code).toBe(0)
    expect(s.alerts()).toEqual([])
    expect(s.calls()).toBe('')
    s.check(s.at7(7, 0, 0))
    expect(s.alerts()).toHaveLength(1)
  })

  it('only tonight’s dispatches count: the night before, or one after 07:00, or one that failed, is left alone', () => {
    const s = setup()
    s.log(
      `${stamp(s.yesterday(12, 0))} nightly: exit 0: ${URL(1)}`,
      `${stamp(s.at7(2, 20))} nightly: exit 1: HTTP 404: workflow ci-runner.yml not found`,
      `${stamp(s.at7(7, 30))} hostile: exit 0: ${URL(3)}`,
    )
    s.runRow(1, HEAD, 'queued', 'none')
    s.runRow(3, HEAD, 'queued', 'none')
    s.check(s.at7(8, 0))
    expect(s.alerts()).toEqual([])
    expect(s.calls()).toBe('')
  })

  it('several dispatches in a night: one that reported is enough; with none, the message names the last', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`, `${stamp(s.at7(3, 26))} nightly: exit 0: ${URL(12)}`)
    s.runRow(11, HEAD, 'completed')
    s.runRow(12, 'd'.repeat(40), 'completed')
    s.statuses(HEAD, [['nightly-ci/check', 'success', `${URL(11)}/attempts/1#lemnos`]])
    s.check()
    expect(s.alerts()).toEqual([])
    const t = setup()
    t.log(`${stamp(t.at7(2, 17))} nightly: exit 0: ${URL(11)}`, `${stamp(t.at7(3, 26))} nightly: exit 0: ${URL(12)}`)
    t.runRow(11, HEAD, 'completed')
    t.runRow(12, HEAD, 'completed')
    t.check()
    expect(t.alerts()).toHaveLength(1)
    expect(t.alertText(t.alerts()[0])).toContain('run 12')
  })

  it('a run that skipped itself says why (logs/schedule-skips.tsv)', () => {
    const s = setup()
    const d = s.at7(2, 17)
    s.log(`${stamp(d)} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'completed')
    const epoch = Math.floor(d.getTime() / 1000)
    writeFileSync(
      join(s.cache, 'logs/schedule-skips.tsv'),
      `${epoch + 5}\tnightly\tskipped\tthis scheduled run's commit is not main's head\n${epoch - 99999}\tnightly\tskipped\tan older one\n`,
    )
    s.check()
    const text = s.alertText(s.alerts()[0])
    expect(text).toContain("it skipped itself: this scheduled run's commit is not main's head")
    expect(text).not.toContain('an older one')
  })

  it('the next morning is checked again', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'queued', 'none')
    s.check()
    const next = new Date(s.at7(8, 0).getTime() + 86_400_000)
    s.log(
      `${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`,
      `${stamp(new Date(s.at7(2, 17).getTime() + 86_400_000))} nightly: exit 0: ${URL(13)}`,
    )
    s.runRow(13, HEAD, 'queued', 'none')
    s.check(next)
    expect(s.alerts()).toHaveLength(2)
  })

  it('GitHub unreadable: exit 1, no message and no mark, so the next check looks again', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: ${URL(11)}`)
    s.runRow(11, HEAD, 'queued', 'none')
    const r = s.check(s.at7(8, 0), { GH_FAIL: '1' })
    expect(r.code).toBe(1)
    expect(s.alerts()).toEqual([])
    expect(existsSync(join(s.cache, 'nightly-check'))).toBe(false)
    expect(s.check().code).toBe(0)
    expect(s.alerts()).toHaveLength(1)
  })

  it('a dispatch line without a run url cannot be looked up: said, no message', () => {
    const s = setup()
    s.log(`${stamp(s.at7(2, 17))} nightly: exit 0: Created workflow_dispatch event for ci-runner.yml at main`)
    const r = s.check()
    expect(r.out).toContain('no run url in the log; not checked')
    expect(s.alerts()).toEqual([])
  })

  it('no log at all is nothing to check', () => {
    const s = setup()
    rmSync(join(s.cache, 'logs/ci-nightly.log'), { force: true })
    expect(s.check().code).toBe(0)
    expect(s.alerts()).toEqual([])
  })

  it('is part of the watcher’s 10-minute check, with untested and relays (no new launchd job)', () => {
    const w = readFileSync(join(here, 'ci-alerts.sh'), 'utf8')
    expect(w).toContain(
      'bash "$1/ci-runner.sh" untested; bash "$1/ci-runner.sh" relays; bash "$1/ci-runner.sh" nightly-check',
    )
  })
})
