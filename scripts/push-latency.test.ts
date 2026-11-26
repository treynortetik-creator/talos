// scripts/push-latency.ts: a push's lock wait, gate run and re-gates, three numbers kept apart, from lock-waits.tsv and the reflog.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { latencies, main, type Push, parseWaits, readPushes, table } from './push-latency.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const P = 'd'.repeat(40)
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000', '')
const T0 = 1_800_000_000
/** A gate's own lock row, as scripts/ci-local/locks.sh ci_wait_log writes it. */
const gateRow = (at: number, base: string, waited: number, label = 'lbl') =>
  `${iso(at)}\tsuites\tgate (${label}): bash scripts/gate.sh --in-heavy-lock --base ${base} --fast\t${waited}\tgot\tpush`
const pushedRow = (at: number, sha: string, requeues: number, bases: string[], gateS: number) =>
  `${iso(at)}\tpush\tpushed ${sha} requeues=${requeues} races=0 gate=lbl bases=${bases.join(',')}\t${gateS}\tgot\tpushed`
/** The numbers of one push alone. */
const latencyOf = (p: Push, rows: ReturnType<typeof parseWaits>) => latencies([p], rows, 5)[0]
const push = (over: Partial<Push> = {}): Push => ({ sha: P, at: T0 + 3000, ancestors: [A], ...over })

describe('parseWaits', () => {
  it('reads the six columns and drops a short or garbled line', () => {
    const rows = parseWaits(`${gateRow(T0, A, 90)}\nnot a row\n${iso(T0)}\tsuites\tx\tNaN\tgot\tci\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ at: T0, lock: 'suites', seconds: 90, kind: 'push' })
  })
})

describe('a recorded push', () => {
  it('splits the lock wait from the gate run, and reports the re-gates', () => {
    // two gates (one requeue): waits 100 s and 20 s of the 1,000 s they took in all
    const rows = parseWaits(
      [gateRow(T0 + 100, A, 100), gateRow(T0 + 700, B, 20), pushedRow(T0 + 1000, P, 1, [A, B], 1000)].join('\n'),
    )
    expect(latencyOf(push({ at: T0 + 1000 }), rows)).toEqual({
      sha: P,
      at: T0 + 1000,
      waitS: 120,
      gateS: 880,
      regates: 1,
      source: 'recorded',
    })
  })

  it("another builder's gate on the same base, inside the same minutes or long before, is not counted", () => {
    const rows = parseWaits(
      [
        gateRow(T0 - 9000, A, 555),
        gateRow(T0 + 100, A, 100),
        gateRow(T0 + 150, A, 777, 'other-worktree'),
        pushedRow(T0 + 1000, P, 0, [A], 1000),
      ].join('\n'),
    )
    expect(latencyOf(push({ at: T0 + 1000 }), rows)).toMatchObject({ waitS: 100, gateS: 900 })
  })

  it('a wait under a second is not a row: no wait, the whole time is the gate', () => {
    expect(latencyOf(push({ at: T0 + 500 }), parseWaits(pushedRow(T0 + 500, P, 0, [A], 500)))).toMatchObject({
      waitS: 0,
      gateS: 500,
      regates: 0,
    })
  })
})

describe('a push from before the row existed', () => {
  it('takes the latest gate row on an ancestor, and says regates are not recorded', () => {
    const rows = parseWaits([gateRow(T0 + 100, C, 5), gateRow(T0 + 1000, A, 300)].join('\n'))
    expect(latencyOf(push({ at: T0 + 2500, ancestors: [A, B] }), rows)).toEqual({
      sha: P,
      at: T0 + 2500,
      waitS: 300,
      gateS: 1500,
      regates: null,
      source: 'inferred',
    })
  })

  it('no gate row on any ancestor, or one from hours before: no data', () => {
    expect(latencyOf(push(), parseWaits(gateRow(T0, C, 5)))).toBeUndefined()
    expect(latencyOf(push({ at: T0 + 5 * 3600 }), parseWaits(gateRow(T0, A, 5)))).toBeUndefined()
  })

  it('a gate row belongs to one push: the next push on the same base does not take it again', () => {
    const rows = parseWaits(gateRow(T0, A, 300))
    const first = push({ sha: '1'.repeat(40), at: T0 + 1000, ancestors: [A] })
    const second = push({ sha: '2'.repeat(40), at: T0 + 2000, ancestors: [first.sha, A] })
    expect(latencies([first, second], rows, 5).map((l) => l.sha[0])).toEqual(['1'])
  })

  it('ignores a CI run, a turn, and a gate row of a later time', () => {
    const rows = parseWaits(
      [
        `${iso(T0)}\tsuites\tci: ${A}\t50\tgot\tci`,
        `${iso(T0)}\tturn\tgate --base ${A}\t50\tgot\tturn`,
        gateRow(T0 + 9000, A, 50),
      ].join('\n'),
    )
    expect(latencyOf(push(), rows)).toBeUndefined()
  })
})

describe('latencies and table', () => {
  it('keeps the newest N pushes that have data, newest first', () => {
    const rows = parseWaits([gateRow(T0, A, 10), gateRow(T0 + 5000, B, 20)].join('\n'))
    const pushes = [
      push({ sha: '1'.repeat(40), at: T0 + 1000, ancestors: [A] }),
      push({ sha: '2'.repeat(40), at: T0 + 2000, ancestors: [C] }), // no data
      push({ sha: '3'.repeat(40), at: T0 + 6000, ancestors: [B] }),
    ]
    expect(latencies(pushes, rows, 5).map((l) => l.sha[0])).toEqual(['3', '1'])
    expect(latencies(pushes, rows, 1).map((l) => l.sha[0])).toEqual(['3'])
  })

  it('prints the three numbers apart, an upper bound for an inferred gate, n/r for unrecorded re-gates', () => {
    const t = table([
      { sha: P, at: T0, waitS: 125, gateS: 880, regates: 1, source: 'recorded' },
      { sha: A, at: T0, waitS: 0, gateS: 61, regates: null, source: 'inferred' },
    ])
    const lines = t.split('\n')
    expect(lines[0]).toMatch(/^push\s+pushed \(UTC\)\s+lock wait\s+gate run\s+re-gates\s+data$/)
    expect(lines[1]).toMatch(/^ddddddd\s+2027-01-15 08:00\s+2m05s\s+14m40s\s+1\s+recorded$/)
    expect(lines[2]).toMatch(/^aaaaaaa\s+2027-01-15 08:00\s+0s\s+<=1m01s\s+n\/r\s+inferred$/)
  })
})

describe('against a real repo and its reflog', () => {
  it('reads "update by push" entries only, with the push time and the commits below', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    dirs.push(dir)
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    }
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim()
    const origin = join(dir, 'origin.git')
    const clone = join(dir, 'clone')
    mkdirSync(clone)
    g(clone, 'init', '-q', '-b', 'main')
    writeFileSync(join(clone, 'f'), '1\n')
    g(clone, 'add', '-A')
    g(clone, 'commit', '-qm', 'one')
    g(dir, 'clone', '-q', '--bare', clone, origin)
    g(clone, 'remote', 'add', 'origin', origin)
    g(clone, 'fetch', '-q', 'origin')
    writeFileSync(join(clone, 'f'), '2\n')
    g(clone, 'commit', '-qam', 'two')
    g(clone, 'push', '-q', 'origin', 'HEAD:main') // "update by push"
    const two = g(clone, 'rev-parse', 'HEAD')
    const one = g(clone, 'rev-parse', 'HEAD~1')
    const pushes = readPushes(clone, 'origin/main')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ sha: two, ancestors: [one] })
    expect(Math.abs((pushes[0] as Push).at - Date.now() / 1000)).toBeLessThan(600)
  })
})

describe('main', () => {
  it('says so when there is no log, and refuses a bad argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    dirs.push(dir)
    expect(main(['--logs', dir])).toBe(1)
    expect(main(['--last', '0'])).toBe(2)
    expect(main(['--nope'])).toBe(2)
  })
})
