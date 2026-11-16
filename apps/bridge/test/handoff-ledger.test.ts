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

describe("the daily budget is a calendar day in the owner's timezone", () => {
  test("the day's budget, used before midnight, is free again after it, and the refusal says when", () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-04T01:00:00Z')) // 20:00 on the 3rd, local
    const refused = l.record(row({ at: at('2026-11-04T04:30:00Z') }), { timezone: ZONE }) // 23:30 local
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.why).toContain('resets at midnight (Etc/GMT+5), in 30 min')
    // ten minutes past local midnight: a rolling 24 hours would still be full
    expect(l.record(row({ at: at('2026-11-04T05:10:00Z') }), { timezone: ZONE }).ok).toBe(true)
  })

  test('the same instant is a different day in another zone', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-04T01:00:00Z'))
    // in UTC they are today's, so at 04:30Z the day is spent
    expect(l.record(row({ at: at('2026-11-04T04:30:00Z') }), { timezone: 'UTC' }).ok).toBe(false)
  })

  test('rows dated in the future do not count and do not stretch the window', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-05T12:00:00Z'))
    expect(l.record(row({ at: at('2026-11-04T12:00:00Z') }), { timezone: ZONE }).ok).toBe(true)
  })

  test('each direction has its own budget', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, HANDOFF_DAILY_LIMIT, at('2026-11-04T08:00:00Z'))
    expect(l.record(row({ at: at('2026-11-04T09:00:00Z') }), { timezone: ZONE }).ok).toBe(false)
    expect(l.record(row({ at: at('2026-11-04T09:00:00Z'), dir: 'to_lead' }), { timezone: ZONE }).ok).toBe(true)
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
    expect(spent.ok ? '' : spent.why).toContain('Hand-off budget used')
  })
})

describe('two processes asking for the last slot', () => {
  test(
    'exactly one gets it',
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
      console.log(JSON.stringify({ ok: v.ok }))`
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
          last: expect.stringMatching(/^\{"ok":(true|false)\}$/),
        })
      const oks = out.map(([stdout]) => JSON.parse(stdout.trim().split('\n').pop() ?? '{}').ok)
      expect(oks.filter(Boolean)).toHaveLength(1)
      const check = new Database(path)
      expect((check.query('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(HANDOFF_DAILY_LIMIT)
    },
    t(30_000),
  ) // a hang cap: three processes start, then race (longer on a slow machine: TALOS_TEST_TIME_FACTOR)
})
