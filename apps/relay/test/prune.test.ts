// Review #34 (relay part): rows that nothing ever pruned.
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { HelloGuard } from '../src/auth/limits.ts'
import { pruneVoiceUsage } from '../src/voice/manager.ts'
import { afterEachReset, makeHarness } from './auth/helpers.ts'
import { startTestRelay, type TestRelay } from './core/harness.ts'

const DAY = 86_400_000
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
  await afterEachReset()
})

describe('retention of leftovers (#34)', () => {
  it('the sweep deletes media rows flagged evicted for 90 days, keeps younger ones', async () => {
    const clock = fakeClock()
    relay = await startTestRelay({ clock })
    const db = relay.relay.services.db
    const ins = db.prepare(
      "insert into core_media (media_id, mime, name, size, sha256, kind, origin, evicted, created_at) values (?, 'image/png', x'00', 1, 'h', 'image', 'app', 1, ?)",
    )
    const now = clock.now()
    ins.run('md_old', now - 91 * DAY)
    ins.run('md_new', now - 10 * DAY)
    relay.runtime.hub.sweep()
    const ids = (db.prepare('select media_id from core_media').all() as Array<{ media_id: string }>).map(
      (r) => r.media_id,
    )
    expect(ids).toEqual(['md_new'])
  })

  it('expired enroll codes are purged a day after they expire', async () => {
    const h = await makeHarness()
    const now = h.fake.clock.now()
    const ins = h.state.core.db.prepare(
      'insert into auth_enroll_codes (code_id, code_auth_hash, created_at, expires_at) values (?, ?, ?, ?)',
    )
    ins.run('c-old', 'h1', now - 3 * DAY, now - 2 * DAY)
    ins.run('c-live', 'h2', now, now + 600_000)
    h.state.core.purge()
    const ids = (
      h.state.core.db.prepare('select code_id from auth_enroll_codes').all() as Array<{ code_id: string }>
    ).map((r) => r.code_id)
    expect(ids).toEqual(['c-live'])
  })

  it('HelloGuard forgets IPs once their failures and block have aged out', () => {
    let t = 1_000_000
    const g = new HelloGuard({ now: () => t } as never)
    g.fail('198.51.100.1')
    for (let i = 0; i < 5; i++) g.fail('198.51.100.2')
    expect(g.isBlocked('198.51.100.2')).toBe(true)
    t += 2 * 3600_000
    g.prune()
    const inner = g as unknown as { fails: Map<string, number[]>; blocked: Map<string, number> }
    expect(inner.fails.size).toBe(0)
    expect(inner.blocked.size).toBe(0)
  })

  it('closed voice_usage rows older than 8 days are pruned; open and recent ones stay', async () => {
    const clock = fakeClock()
    relay = await startTestRelay({ clock })
    const db = relay.relay.services.db
    const ins = db.prepare('insert into voice_usage (voice_session_id, started_at, seconds, open) values (?, ?, 5, ?)')
    const iso = (ms: number) => new Date(clock.now() - ms).toISOString()
    ins.run('v_old', iso(9 * DAY), 0)
    ins.run('v_open_old', iso(9 * DAY), 1)
    ins.run('v_recent', iso(1 * DAY), 0)
    expect(pruneVoiceUsage(relay.relay.services)).toBe(1)
    const ids = (
      db.prepare('select voice_session_id id from voice_usage order by id').all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(ids).toEqual(['v_open_old', 'v_recent'])
  })
})
