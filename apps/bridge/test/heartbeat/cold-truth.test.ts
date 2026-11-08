// A cold run in which no source answers has skipped nothing yet, so the cold period must outlive it. The store's `cold_since` marks
// it: set on a cold run that no source answered, cleared by the first run that one does. Cold itself is still "the heartbeat was off
// longer than its limit" (`last_run`, R1-8) or `cold_since` set. Seeding writes the ages straight into the store, so no test moves
// the clock by days (that fires thousands of timers). A row is posted after the run returns, so every "is not in the text" check
// first waits for a row of the same run that must be there.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { emptyStore, loadStore, storeFile } from '../../src/heartbeat/store.ts'
import { type Harness, startHarness, waitFor } from '../helpers.ts'
import { cmd, config, item, type Kit, kit, MON_1000_UTC, ok, printing, script, tmpDir } from './kit.ts'

const HOUR = 3600_000
const COLD_AFTER = 3 * 24 * HOUR
let h: Harness
let clock: ReturnType<typeof fakeClock>
let k: Kit
afterEach(async () => {
  await h?.stop()
})
async function start() {
  clock = fakeClock(MON_1000_UTC)
  h = await startHarness({ clock, config: (c) => ({ ...c, timezone: 'UTC', quiet_window: null }) })
  k = kit(h, clock)
}
const iso = (agoH: number) => new Date(clock.now() - agoH * HOUR).toISOString()
type Seed = { ran: number | null; sources: Record<string, number | null>; coldSince?: number }
/** A store as a heartbeat leaves it: each source answered N hours ago (null: never), the heartbeat ran `ran` hours ago (null: no record). */
function seed(s: Seed) {
  const st = emptyStore()
  for (const [id, agoH] of Object.entries(s.sources))
    st.sources[id] = { cursor: { n: 1 }, last_ok: agoH === null ? null : iso(agoH), fail_streak: 0 }
  st.last_run = s.ran === null ? null : iso(s.ran)
  if (s.coldSince !== undefined) st.cold_since = iso(s.coldSince)
  writeFileSync(storeFile(h.home, false, 'beat'), JSON.stringify(st))
}
const killed = (d: string, id = 'ss') => cmd(id, script(d, `k-${id}`, 'kill -9 $$'))
const answering = (d: string, items: unknown[], id = 'ss') => cmd(id, printing(d, `p-${id}`, ok(items, { n: 2 })))
const asked = (d: string, id = 'ss') => JSON.parse(readFileSync(join(d, `p-${id}.stdin`), 'utf8'))
const texts = () => k.rows().map((r) => r.text)
const rowWith = (s: string) => waitFor(() => texts().some((t) => t.includes(s)), 5000, `a row with "${s}"`)
const rowFor = async (s: string) => {
  await rowWith(s)
  return texts().find((t) => t.includes(s)) as string
}
const run = (sources: unknown[]) => k.run(config(sources), { coldAfterMs: COLD_AFTER })
const hop = () => clock.set(clock.now() + HOUR)
const offRows = () => texts().filter((t) => t.includes('was off for') || t.includes('started over')).length

describe('a cold run that nobody answers', () => {
  test('says it was off for 4 days AND that the check failed, in one message, and promises only what will happen', async () => {
    await start()
    seed({ ran: 96, sources: { ss: 96 } })
    const r = await run([killed(tmpDir())])
    expect(r.result.outcome).toBe('failed')
    const text = await rowFor('Heartbeat was off for 4 days.')
    expect(k.rows().length).toBe(1)
    expect(text).toContain('Heartbeat check failed: ss (')
    expect(text).toContain('The backlog will be skipped once a source answers.')
    expect(text).not.toContain('Skipped the backlog') // nothing was looked at, so nothing was skipped yet
    expect(text.indexOf('Heartbeat check failed')).toBeLessThan(text.indexOf('Heartbeat was off'))
  }, 20_000)

  test('the run is still a run: last_run moves, the source keeps its old last_ok, and cold_since marks when the off period began', async () => {
    await start()
    seed({ ran: 96, sources: { ss: 96 } })
    await run([killed(tmpDir())])
    const st = k.store()
    expect(st.last_run).toBe(MON_1000_UTC)
    expect(st.sources.ss.last_ok).toBe(iso(96))
    expect(st.cold_since).toBe(iso(96)) // the heartbeat last ran then
  }, 20_000)

  test('a run that fails while the heartbeat is NOT cold sets nothing and says nothing about being off', async () => {
    await start()
    seed({ ran: 2, sources: { ss: 4 * 24 } }) // one source, down for four days while the heartbeat kept running (R1-8)
    const r = await run([killed(tmpDir())])
    expect(r.result.outcome).toBe('failed')
    await rowWith('Heartbeat check failed')
    expect(texts().join('\n')).not.toContain('was off')
    expect(k.store().cold_since ?? null).toBeNull()
  }, 20_000)

  test('a store that knows no last_run says only "Heartbeat started over." and stays cold until a source answers', async () => {
    await start()
    seed({ ran: null, sources: { ss: null } })
    await run([killed(tmpDir())])
    const text = await rowFor('Heartbeat started over.')
    expect(text).not.toContain('backlog') // no promise: nothing is known of how long it was off
    expect(k.store().cold_since).toBe(MON_1000_UTC)
    hop()
    const d = tmpDir()
    await run([answering(d, [item('a')])])
    expect(asked(d)).toMatchObject({ cursor: null, since: null }) // the first answer still starts over
    await rowWith('Heartbeat started over. Skipped the backlog (1 item).')
    expect(k.store().cold_since ?? null).toBeNull()
  }, 20_000)
})

describe('the first answer ends it', () => {
  test('the next run, with the source back and holding a backlog, skips it once, counts from the start of the off period, and clears cold_since', async () => {
    await start()
    seed({ ran: 96, sources: { ss: 96 } })
    await run([killed(tmpDir())])
    hop()
    const d = tmpDir()
    const r = await run([answering(d, [item('old1'), item('old2')])])
    expect(r.result.outcome).toBe('fyi')
    expect(asked(d)).toMatchObject({ cursor: null, since: null }) // every source starts over
    expect(k.store().items['ss|old1'].state).toBe('surfaced')
    expect(k.store().cold_since ?? null).toBeNull()
    await rowWith('Heartbeat was off for 4 days. Skipped the backlog (2 items).') // 97 hours since the heartbeat last ran
    expect(texts().some((t) => t.includes('Item old1'))).toBe(false) // same row: the digest is one message
    // and the run after is a normal one
    hop()
    await run([answering(d, [item('old1'), item('old2'), item('fresh')])])
    expect(asked(d)).toMatchObject({ cursor: { n: 2 }, since: iso(1) })
    await rowWith('Item fresh')
    expect(offRows()).toBe(2) // the failed run's line and the skipping run's; none after
  }, 20_000)

  test('a cold_since that is still waiting keeps the true length across several failed runs', async () => {
    await start()
    seed({ ran: 96, sources: { ss: 96 } })
    await run([killed(tmpDir())])
    clock.set(clock.now() + 30 * HOUR)
    await run([killed(tmpDir())])
    await waitFor(() => offRows() === 2, 5000, 'the second line')
    expect(texts()[1]).toContain('Heartbeat was off for 5 days.') // 126 hours
    expect(k.store().cold_since).toBe(iso(126))
  }, 20_000)

  test('one source dies and one answers on a cold run: the usual note, and the answer ends the cold period', async () => {
    await start()
    seed({ ran: 96, sources: { aa: 96, bb: 96 } })
    const d = tmpDir()
    const r = await run([killed(tmpDir(), 'aa'), answering(d, [item('old')], 'bb')])
    expect(r.result.outcome).toBe('partial')
    await rowWith('Heartbeat was off for 4 days. Skipped the backlog (1 item).')
    expect(k.store().cold_since ?? null).toBeNull()
    hop()
    await run([killed(tmpDir(), 'aa'), answering(d, [item('old'), item('new1')], 'bb')])
    expect(asked(d, 'bb')).toMatchObject({ cursor: { n: 2 } }) // not cold any more
    await rowWith('Item new1')
    expect(offRows()).toBe(1)
  }, 20_000)
})

describe('stores', () => {
  test('a store from before cold_since (sources, last_run, no field) loads with it unset and behaves as before', async () => {
    await start()
    seed({ ran: 2, sources: { ss: 2 } })
    const raw = JSON.parse(readFileSync(storeFile(h.home, false, 'beat'), 'utf8'))
    expect('cold_since' in raw).toBe(true) // emptyStore writes it; strip it to be a store an older version wrote
    delete raw.cold_since
    writeFileSync(storeFile(h.home, false, 'beat'), JSON.stringify(raw))
    expect(loadStore(storeFile(h.home, false, 'beat')).store.cold_since).toBeNull()
    const d = tmpDir()
    await run([answering(d, [item('x')])])
    expect(asked(d)).toMatchObject({ cursor: { n: 1 } }) // not cold
    await rowWith('Item x')
    expect(texts().join('\n')).not.toContain('was off')
  }, 20_000)

  test('a cold_since that cannot be read is ignored, one that can be read makes the heartbeat cold even right after a run', async () => {
    await start()
    seed({ ran: 2, sources: { ss: 2 } })
    const path = storeFile(h.home, false, 'beat')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    for (const bad of ['yesterday', 7, {}, '']) {
      writeFileSync(path, JSON.stringify({ ...raw, cold_since: bad }))
      expect(loadStore(path).store.cold_since).toBeNull()
    }
    writeFileSync(path, JSON.stringify({ ...raw, cold_since: iso(100) }))
    const d = tmpDir()
    await run([answering(d, [item('x')])])
    expect(asked(d)).toMatchObject({ cursor: null, since: null })
    await rowWith('Heartbeat was off for 4 days. Skipped the backlog (1 item).')
  }, 20_000)
})
