// The hand-off ledger on its own (docs/OPTION-C.md "Hand-offs"): the daily window, what survives a restart, and two
// processes asking for the last slot. Times are fixed, so none of this depends on the wall clock.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '@talos-app/testkit'
import { HANDOFF_DAILY_LIMIT, HandoffLedger, type HandoffRow } from '../src/worker/handoff.ts'
import { waitFor } from './helpers.ts'

const ZONE = 'Etc/GMT+5' // UTC-5 all year: local midnight is 05:00Z
const at = (iso: string) => Date.parse(iso)
let n = 0
const row = (over: Partial<HandoffRow> & { at: number }): HandoffRow => ({
  id: `h_${String(++n).padStart(4, '0')}`,
  lead: 'trip',
  dir: 'to_main',
  type: 'TASK',
  text: 'Out of my lane.',
  ...over,
})
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fileDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'hl-'))
  dirs.push(d)
  return join(d, 'h.sqlite')
}
const fill = (l: HandoffLedger, count: number, when: number) => {
  for (let i = 0; i < count; i++) expect(l.record(row({ at: when + i }), { timezone: ZONE }).ok).toBe(true)
}

describe("the daily count is a warning in the owner's timezone, never a block", () => {
  const warned = (v: ReturnType<HandoffLedger['record']>) => (v.ok ? (v.warn ?? '') : 'REFUSED')

  test('the 21st hand-off of the day is recorded with a warning; after local midnight there is none', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-04T01:00:00Z')) // 20:00 on the 3rd, local
    const over = l.record(row({ at: at('2026-11-04T04:30:00Z') }), { timezone: ZONE }) // 23:30 local
    expect(over.ok).toBe(true)
    expect(warned(over)).toContain('hand-off 21 today')
    // ten minutes past local midnight: a new day, no warning
    expect(warned(l.record(row({ at: at('2026-11-04T05:10:00Z') }), { timezone: ZONE }))).toBe('')
  })

  test('the same instant is a different day in another zone', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-04T01:00:00Z'))
    expect(warned(l.record(row({ at: at('2026-11-04T04:30:00Z') }), { timezone: 'UTC' }))).toContain('hand-off 21')
    expect(warned(l.record(row({ at: at('2026-11-04T04:31:00Z') }), { timezone: ZONE }))).toContain('hand-off 22')
  })

  test('rows dated in the future do not count and do not stretch the window', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-05T12:00:00Z'))
    expect(warned(l.record(row({ at: at('2026-11-04T12:00:00Z') }), { timezone: ZONE }))).toBe('')
  })

  test('each direction has its own count', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-04T08:00:00Z'))
    expect(warned(l.record(row({ at: at('2026-11-04T09:00:00Z') }), { timezone: ZONE }))).toContain('hand-off 21')
    expect(warned(l.record(row({ at: at('2026-11-04T09:00:00Z'), dir: 'to_lead' }), { timezone: ZONE }))).toBe('')
  })
})

describe('numbered jobs', () => {
  const T0 = at('2026-11-04T08:00:00Z')
  const task = (l: HandoffLedger, when: number) => l.record(row({ dir: 'to_lead', at: when }), { timezone: ZONE })
  const answer = (l: HandoffLedger, when: number, num?: number) =>
    l.record(row({ dir: 'to_main', type: 'RESULT', at: when, ...(num === undefined ? {} : { num }) }), {
      timezone: ZONE,
    })
  const openNums = (db: Database) =>
    (db.query('SELECT num FROM handoffs WHERE open = 1 ORDER BY num').all() as Array<{ num: number }>).map((r) => r.num)

  test('each TASK for a lead gets the next number; another lead counts on its own', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    const nums = [task(l, T0), task(l, T0 + 1)].map((v) => (v.ok ? v.row.num : -1))
    expect(nums).toEqual([1, 2])
    const other = l.record(row({ dir: 'to_lead', lead: 'garden', at: T0 + 2 }), { timezone: ZONE })
    expect(other.ok && other.row.num).toBe(1)
  })

  test('an answer with a number closes that job only; without one it closes the oldest', () => {
    const db = new Database(':memory:')
    const l = new HandoffLedger(db)
    for (let i = 0; i < 3; i++) task(l, T0 + i)
    expect(answer(l, T0 + 10, 2).ok).toBe(true)
    expect(openNums(db)).toEqual([1, 3])
    expect(answer(l, T0 + 11).ok).toBe(true) // no number: the oldest still open, job 1
    expect(openNums(db)).toEqual([3])
    const twice = answer(l, T0 + 12, 2)
    expect(twice.ok ? '' : twice.why).toContain('Job 2 is not open')
    expect(openNums(db)).toEqual([3])
  })

  test('a late answer is always taken, however old the job is', () => {
    const db = new Database(':memory:')
    const l = new HandoffLedger(db)
    task(l, T0)
    const later = T0 + 40 * 24 * 3600_000 // forty days on
    expect(answer(l, later, 1).ok).toBe(true)
    expect(openNums(db)).toEqual([])
    // and without a number, after another new TASK was handed over two days later (it used to close the first one for good)
    const l2 = new HandoffLedger(new Database(':memory:'))
    task(l2, T0)
    task(l2, T0 + 2 * 24 * 3600_000)
    expect(answer(l2, T0 + 2 * 24 * 3600_000 + 1).ok).toBe(true)
  })

  test('an answer with no number takes the oldest job under a day first; a number always wins', () => {
    const db = new Database(':memory:')
    const l = new HandoffLedger(db)
    task(l, T0) // job 1, abandoned
    const day2 = T0 + 30 * 3600_000
    task(l, day2) // job 2
    task(l, day2 + 1) // job 3
    expect(answer(l, day2 + 10).ok).toBe(true) // no number: job 2, not the abandoned job 1
    expect(openNums(db)).toEqual([1, 3])
    expect(answer(l, day2 + 11, 1).ok).toBe(true) // a number names the old one and wins
    expect(openNums(db)).toEqual([3])
    expect(answer(l, day2 + 12).ok).toBe(true)
    expect(openNums(db)).toEqual([])
  })

  test('with only jobs over a day old, an answer with no number still takes the oldest', () => {
    const db = new Database(':memory:')
    const l = new HandoffLedger(db)
    task(l, T0)
    task(l, T0 + 1)
    expect(answer(l, T0 + 3 * 24 * 3600_000).ok).toBe(true)
    expect(openNums(db)).toEqual([2])
  })

  test('a TASK older than a day does not count against the open limit but can still be answered', () => {
    const db = new Database(':memory:')
    const l = new HandoffLedger(db)
    for (let i = 0; i < 3; i++) task(l, T0 + i)
    const day2 = T0 + 25 * 3600_000
    expect(task(l, day2).ok).toBe(true)
    expect(answer(l, day2 + 1, 1).ok).toBe(true)
  })

  test('a TASK right after a RESULT is not refused', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    task(l, T0)
    answer(l, T0 + 1000)
    expect(task(l, T0 + 2000).ok).toBe(true)
  })

  test('a file from before numbers loads; its open TASK is answered without one', () => {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE handoffs (id TEXT PRIMARY KEY, lead TEXT NOT NULL, dir TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, open INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER, posted_at INTEGER)',
    )
    db.query(
      "INSERT INTO handoffs(id, lead, dir, type, text, at, open) VALUES ('h_old', 'trip', 'to_lead', 'TASK', 'x', ?, 1)",
    ).run(T0)
    const l = new HandoffLedger(db)
    expect(answer(l, T0 + 5, 1).ok).toBe(false) // it has no number
    const v = answer(l, T0 + 6)
    expect(v.ok && v.row.num).toBeUndefined()
    expect(openNums(db)).toEqual([])
    expect(task(l, T0 + 7).ok).toBe(true)
  })
})

describe('the ledger lives in the file', () => {
  test('after a restart the spent budget and the open TASKs are still spent', () => {
    const path = fileDb()
    const first = new Database(path)
    const a = new HandoffLedger(first)
    for (let i = 0; i < 3; i++)
      expect(a.record(row({ dir: 'to_lead', at: at('2026-11-04T08:00:00Z') + i }), { timezone: ZONE }).ok).toBe(true)
    fill(a, HANDOFF_DAILY_LIMIT, at('2026-11-04T09:00:00Z'))
    first.close()
    const b = new HandoffLedger(new Database(path))
    const open = b.record(row({ dir: 'to_lead', at: at('2026-11-04T10:00:00Z') }), { timezone: ZONE })
    expect(open.ok ? '' : open.why).toContain('3 open TASKs')
    const spent = b.record(row({ at: at('2026-11-04T10:00:00Z') }), { timezone: ZONE })
    expect(spent.ok && spent.warn).toContain('hand-off 21 today')
  })
})

describe('a hand-off stamped before it waited for the lock', () => {
  // Two processes stamp `at` with their own clocks, then wait for the write lock. The one stamped a millisecond earlier can
  // write second: it must still see the row already written that day, even though that row's time is later than its own.
  test('a row written first with a later time still counts', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    const T = at('2026-11-04T12:00:00Z')
    fill(l, HANDOFF_DAILY_LIMIT - 1, T - 60_000)
    const first = l.record(row({ at: T + 1 }), { timezone: ZONE })
    expect(first.ok ? (first.warn ?? '') : 'REFUSED').toBe('')
    const second = l.record(row({ at: T }), { timezone: ZONE })
    expect(second.ok ? (second.warn ?? 'no warning') : 'REFUSED').toContain(`hand-off ${HANDOFF_DAILY_LIMIT + 1} today`)
  })

  test('a row of the next local day still does not count', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-05T05:00:00Z')) // local midnight of the 5th exactly
    const v = l.record(row({ at: at('2026-11-05T04:59:59Z') }), { timezone: ZONE }) // a second before it, still the 4th
    expect(v.ok ? (v.warn ?? '') : 'REFUSED').toBe('')
  })
})

describe('two processes asking for the last slot', () => {
  // timing-ok: the waits are the old test's own (three processes start, then race); only its name and what it asserts changed
  test(
    'all three are recorded, and the count they see is one after another',
    async () => {
      const path = fileDb()
      const seed = new Database(path)
      const seeded = new HandoffLedger(seed)
      for (let i = 0; i < HANDOFF_DAILY_LIMIT - 1; i++)
        expect(seeded.record(row({ at: Date.now() }), { timezone: 'UTC' }).ok).toBe(true)
      seed.close()
      const src = join(import.meta.dir, '../src/worker/handoff.ts')
      // A barrier, not a start time: each process says it is ready (its database open), then all three go together. A fixed
      // "go at now + 1.5 s" was a guess at how fast three processes start, and a loaded machine starts them slower.
      const code = `
      import { Database } from 'bun:sqlite'
      import { existsSync, readFileSync, writeFileSync } from 'node:fs'
      import { HandoffLedger } from ${JSON.stringify(src)}
      const [path, id] = process.argv.slice(1)
      const db = new Database(path)
      db.exec('PRAGMA busy_timeout = 10000')
      const l = new HandoffLedger(db)
      writeFileSync(path + '.ready-' + id, '')
      // a deadline, not a spin: sleep until the go file is there (three spinning processes starve a two-core machine), then
      // wait for the start time it holds, so the three records still begin within a fraction of a millisecond
      while (!existsSync(path + '.go')) await Bun.sleep(5)
      const at = Number(readFileSync(path + '.go', 'utf8'))
      while (Date.now() < at - 2) await Bun.sleep(1)
      while (Date.now() < at) {}
      const v = l.record({ id, lead: 'trip', dir: 'to_main', type: 'TASK', text: 'x', at: Date.now() }, { timezone: 'UTC' })
      console.log(JSON.stringify({ ok: v.ok, warn: v.ok ? (v.warn ?? '') : '' }))`
      const ids = ['h_race_a', 'h_race_b', 'h_race_c']
      const runs = ids.map((id) => {
        const p = Bun.spawn(['bun', '-e', code, path, id], { stdout: 'pipe', stderr: 'pipe' })
        return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      })
      await waitFor(
        () => ids.every((id) => existsSync(`${path}.ready-${id}`)),
        t(25_000),
        'the three processes to be ready',
      )
      // all three start at this instant; written then renamed, so no child can see the file before it holds the time
      writeFileSync(`${path}.go.tmp`, String(Date.now() + t(100)))
      renameSync(`${path}.go.tmp`, `${path}.go`)
      const out = await Promise.all(runs)
      // every process answered: a crash is a failure with its own words, never counted as "did not get the slot"
      for (const [stdout, stderr, code] of out)
        expect({ code, last: stdout.trim().split('\n').pop(), stderr }).toMatchObject({
          code: 0,
          last: expect.stringMatching(/^\{"ok":(true|false),/),
        })
      const done = out.map(
        ([stdout]) => JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { ok: boolean; warn: string },
      )
      expect(done.every((d) => d.ok)).toBe(true)
      // the transaction is taken one at a time: 19 rows seen (no warning), then 20 (hand-off 21), then 21 (hand-off 22)
      expect(done.map((d) => d.warn.match(/hand-off (\d+) today/)?.[1] ?? '').sort()).toEqual(['', '21', '22'])
      const check = new Database(path)
      expect((check.query('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(HANDOFF_DAILY_LIMIT + 2)
    },
    t(30_000),
  ) // a hang cap: three processes start, then race (longer on a slow machine: TALOS_TEST_TIME_FACTOR)
})
