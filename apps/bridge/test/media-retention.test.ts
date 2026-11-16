// Bug hunt core #19: downloaded attachments are kept only as long as the owner chose (media_keep_days; keep forever is the
// default). A file still in use is never removed, nothing is removed in the hour after a change, the owner is told what a
// change will remove, a removed file answers "removed after N days", and every sweep that removes something logs it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { paths } from '../src/config.ts'
import { MEDIA_HOLD_MS, MediaRetention, mediaByAge } from '../src/media-retention.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const DAY = 86_400_000
const SWEEP_HOUR = 3_600_000
const id = (c: string) => `md_${c.repeat(26)}`

async function world() {
  const clock = fakeClock('2026-11-10T12:00:00.000Z')
  h = await startHarness({ clock, startBridge: false })
  const ctx = h.bridge.ctx
  const dir = paths(h.home).media
  mkdirSync(dir, { recursive: true })
  const file = (c: string, ageDays: number, bytes = 1000) => {
    const full = join(dir, `${id(c)}.jpg`)
    writeFileSync(full, Buffer.alloc(bytes))
    writeFileSync(join(dir, `${id(c)}.json`), JSON.stringify({ path: full, ref: { media_id: id(c) } }))
    const t = (clock.now() - ageDays * DAY) / 1000
    utimesSync(full, t, t)
    return full
  }
  const old = file('A', 100) // nothing needs it
  const queued = file('B', 100) // a send not yet taken
  const carded = file('C', 100) // an open card's attachment
  const fresh = file('D', 5)
  ctx.store.outboxAdd(
    'f_1',
    'reply',
    JSON.stringify({ message: { attachments: [{ media_id: id('B') }] } }),
    clock.now(),
  )
  ctx.store.db
    .query(
      'INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'c_1',
      'general',
      JSON.stringify({ attachments: [{ media_id: id('C') }] }),
      'h',
      'pending',
      'chat',
      'low',
      'x',
      'x',
      'agent',
    )
  const retention = new MediaRetention(ctx, dir)
  const keep = (days: number | null) => ctx.config.update((c) => ({ ...c, media_keep_days: days }))
  return { clock, ctx, dir, retention, keep, old, queued, carded, fresh }
}

describe('media retention', () => {
  test('keep forever (the default) removes nothing, however old', async () => {
    const w = await world()
    expect(w.ctx.config.config.media_keep_days).toBeNull()
    w.retention.tick()
    w.clock.advance(400 * DAY)
    w.retention.tick()
    expect(existsSync(w.old)).toBe(true)
  })

  test('a change waits an hour, then only old files nothing needs go, and each is marked removed', async () => {
    const w = await world()
    w.retention.tick() // first look: keep forever
    w.keep(30)
    w.retention.tick() // the change: the hour starts
    w.clock.advance(MEDIA_HOLD_MS - 60_000)
    w.retention.tick()
    expect(existsSync(w.old)).toBe(true) // inside the hour: nothing yet
    w.clock.advance(120_000)
    w.retention.tick()
    expect(existsSync(w.old)).toBe(false)
    for (const kept of [w.queued, w.carded, w.fresh]) expect(existsSync(kept), kept).toBe(true)
    expect(w.ctx.media.removedInfo(id('A'))).toEqual({ at: w.clock.now(), after_days: 30 })
    expect(w.ctx.media.removedInfo(id('B'))).toBeUndefined()
    expect(JSON.parse(readFileSync(join(w.dir, `${id('A')}.json`), 'utf8')).path).toBe(w.old) // the sidecar stays
  })

  test('the change is told with what it will remove, before anything goes', async () => {
    const w = await world()
    w.retention.tick()
    w.keep(30)
    w.retention.tick()
    await new Promise((r) => setTimeout(r, 50))
    const rows = w.ctx.store.db
      .query("SELECT json FROM messages WHERE json LIKE '%kept on this Mac for 30 days%'")
      .all()
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows)).toContain('about 1 file')
    expect(existsSync(w.old)).toBe(true)
  })

  test('a mis-tap put back within the hour removes nothing', async () => {
    const w = await world()
    w.retention.tick()
    w.keep(30)
    w.retention.tick()
    w.clock.advance(10 * 60_000)
    w.keep(null)
    w.retention.tick()
    w.clock.advance(2 * MEDIA_HOLD_MS)
    w.retention.tick()
    expect(existsSync(w.old)).toBe(true)
  })

  test('the health beat carries what each choice would remove now, files in use left out', async () => {
    const w = await world()
    w.retention.tick()
    w.clock.advance(11 * 60_000)
    w.retention.tick()
    const byAge = mediaByAge(w.ctx)
    expect(byAge?.find((s) => s.days === 30)).toEqual({ days: 30, files: 1, bytes: 1000 })
    expect(byAge?.find((s) => s.days === 365)).toEqual({ days: 365, files: 0, bytes: 0 })
  })

  test('a value already set on the first look is told, and still waits the hour', async () => {
    const w = await world()
    w.keep(30) // set before this bridge ever looked (an edit while it was down, or before this build)
    w.retention.tick()
    await new Promise((r) => setTimeout(r, 50))
    const told = w.ctx.store.db
      .query("SELECT json FROM messages WHERE json LIKE '%kept on this Mac for 30 days%'")
      .all()
    expect(told.length).toBe(1)
    w.clock.advance(MEDIA_HOLD_MS - 60_000)
    w.retention.tick()
    expect(existsSync(w.old)).toBe(true)
  })

  test('after the first sweep, one that would remove far more at once (a clock that jumped) is held and told', async () => {
    const w = await world()
    w.retention.tick()
    w.keep(30)
    w.retention.tick()
    w.clock.advance(MEDIA_HOLD_MS + 60_000)
    w.retention.tick() // the first sweep: the one the owner was told about
    // 150 more downloads, all a few days old; then the clock jumps a year ahead
    for (let i = 0; i < 150; i++) {
      const n = `md_${String(i).padStart(4, '0')}${'E'.repeat(22)}.jpg`
      writeFileSync(join(w.dir, n), 'x')
      const t = (w.clock.now() - 5 * DAY) / 1000
      utimesSync(join(w.dir, n), t, t)
    }
    w.clock.advance(365 * DAY)
    w.retention.tick()
    expect(readdirSync(w.dir).filter((n) => n.endsWith('.jpg') && n.includes('EEEE')).length).toBe(150)
  })

  test('once the hold is over it sweeps at most hourly, not on every poll', async () => {
    const w = await world()
    w.retention.tick()
    w.keep(30)
    w.retention.tick()
    w.clock.advance(MEDIA_HOLD_MS + 60_000)
    w.retention.tick() // sweeps
    const late = join(w.dir, `md_${'F'.repeat(26)}.jpg`)
    writeFileSync(late, 'x')
    const t = (w.clock.now() - 100 * DAY) / 1000
    utimesSync(late, t, t)
    w.clock.advance(10_000)
    w.retention.tick() // ten seconds on: no sweep yet
    expect(existsSync(late)).toBe(true)
    w.clock.advance(SWEEP_HOUR)
    w.retention.tick()
    expect(existsSync(late)).toBe(false)
  })
})
