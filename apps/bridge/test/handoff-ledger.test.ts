// The hand-off ledger on its own (docs/OPTION-C.md "Hand-offs"): the daily window, what survives a restart, and two
// processes asking for the last slot. Times are fixed, so none of this depends on the wall clock.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffLedger, type HandoffRow } from '../src/worker/handoff.ts'

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
  test('the five used before midnight are free again after it, and the refusal says when', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, 5, at('2026-11-04T01:00:00Z')) // 20:00 on the 3rd, local
    const refused = l.record(row({ at: at('2026-11-04T04:30:00Z') }), { timezone: ZONE }) // 23:30 local
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.why).toContain('resets at midnight (Etc/GMT+5), in 30 min')
    // ten minutes past local midnight: a rolling 24 hours would still be full
    expect(l.record(row({ at: at('2026-11-04T05:10:00Z') }), { timezone: ZONE }).ok).toBe(true)
  })

  test('the same instant is a different day in another zone', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, 5, at('2026-11-04T01:00:00Z'))
    // in UTC the five are today's, so at 04:30Z the day is spent
    expect(l.record(row({ at: at('2026-11-04T04:30:00Z') }), { timezone: 'UTC' }).ok).toBe(false)
  })

  test('rows dated in the future do not count and do not stretch the window', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, 5, at('2026-11-05T12:00:00Z'))
    expect(l.record(row({ at: at('2026-11-04T12:00:00Z') }), { timezone: ZONE }).ok).toBe(true)
  })

  test('each direction has its own five', () => {
    const l = new HandoffLedger(new Database(':memory:'))
    fill(l, 5, at('2026-11-04T08:00:00Z'))
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
    fill(a, 5, at('2026-11-04T09:00:00Z'))
    first.close()
    const b = new HandoffLedger(new Database(path))
    const open = b.record(row({ dir: 'to_lead', at: at('2026-11-04T10:00:00Z') }), { timezone: ZONE })
    expect(open.ok ? '' : open.why).toContain('3 open TASKs')
    const spent = b.record(row({ at: at('2026-11-04T10:00:00Z') }), { timezone: ZONE })
    expect(spent.ok ? '' : spent.why).toContain('Hand-off budget used')
  })
})

describe('two processes asking for the last slot', () => {
  test('exactly one gets it', async () => {
    const path = fileDb()
    const seed = new Database(path)
    const seeded = new HandoffLedger(seed)
    for (let i = 0; i < 4; i++) expect(seeded.record(row({ at: Date.now() }), { timezone: 'UTC' }).ok).toBe(true)
    seed.close()
    const src = join(import.meta.dir, '../src/worker/handoff.ts')
    const code = `
      import { Database } from 'bun:sqlite'
      import { HandoffLedger } from ${JSON.stringify(src)}
      const [path, id, go] = process.argv.slice(1)
      const db = new Database(path)
      db.exec('PRAGMA busy_timeout = 10000')
      const l = new HandoffLedger(db)
      while (Date.now() < Number(go)) {}
      const v = l.record({ id, lead: 'trip', dir: 'to_main', type: 'TASK', text: 'x', at: Date.now() }, { timezone: 'UTC' })
      console.log(JSON.stringify({ ok: v.ok }))`
    const go = String(Date.now() + 1500)
    const run = (id: string) =>
      new Response(Bun.spawn(['bun', '-e', code, path, id, go], { stdout: 'pipe', stderr: 'pipe' }).stdout).text()
    const out = await Promise.all([run('h_race_a'), run('h_race_b'), run('h_race_c')])
    const oks = out.map((o) => JSON.parse(o.trim().split('\n').pop() ?? '{}').ok)
    expect(oks.filter(Boolean)).toHaveLength(1)
    const check = new Database(path)
    expect((check.query('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(5)
  })
})
