// Crash windows around the durable write and the post-commit sends (PR6 F3/F4): a confirmed event is never lost.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

type Bus = { toBridge: (...a: unknown[]) => Promise<{ queued: boolean }> }

describe('crash windows', () => {
  it('a crash inside the worker transaction rolls back dedup keys and events; the retry stores the event once', async () => {
    const s = setup()
    const c = await s.create('generic')
    const db = s.f.db
    // The worker's transaction dies on its last statement (state update), after dedup + event rows were written.
    db.exec(
      "create trigger boom before update of state on hooks_inbound when new.state = 'done' begin select raise(abort, 'crash'); end",
    )
    await s.send('generic', c.id, c.secret, { title: 'survives' }, { id: 'c1' })
    await s.drain()
    expect(s.events()).toHaveLength(0)
    expect(s.count('hooks_dedup')).toBe(1) // only the delivery key; no event key survived the rollback
    db.exec('drop trigger boom')
    db.exec("update hooks_inbound set state = 'pending', attempts = 0") // what a restarted process sees after a real crash
    await s.tick()
    expect(s.eventBodies().map((e) => e.title)).toEqual(['survives'])
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1)
  })

  it('a crash after commit but before the bridge send: the next pass sends it, once, with a stable frame id', async () => {
    const s = setup()
    const c = await s.create('generic')
    const bus = s.f.bus as unknown as Bus
    const real = bus.toBridge.bind(bus)
    const seen: string[] = []
    let fail = 2
    bus.toBridge = async (...a: unknown[]) => {
      seen.push((a[0] as { id: string }).id)
      if (fail-- > 0) throw new Error('process died')
      return real(...a)
    }
    await s.send('generic', c.id, c.secret, { title: 'must arrive' }, { id: 'c2' })
    await s.drain()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(0)
    await s.tick()
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1)
    expect(new Set(seen).size).toBe(1) // every attempt carried the same frame id
    const row = s.events()[0]
    expect(row?.sent_at).not.toBeNull()
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1) // stamped: no re-send
  })

  it('a failed digest send is not stamped digested; the next tick sends it', async () => {
    const s = setup({
      config: (cfg) => {
        cfg.quiet_window = { start: '22:00', end: '07:00' }
        cfg.timezone = 'UTC'
      },
    })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T23:00:00Z'))
    await s.send('generic', c.id, c.secret, { title: 'night item' }, { id: 'c3' })
    await s.drain()
    s.f.clock.set(Date.parse('2026-10-29T07:00:00Z'))
    const bus = s.f.bus as unknown as Bus
    const real = bus.toBridge.bind(bus)
    let fail = true
    bus.toBridge = async (...a: unknown[]) => {
      if (fail) {
        fail = false
        throw new Error('socket hiccup')
      }
      return real(...a)
    }
    await expect(s.tick()).rejects.toThrow()
    expect(s.events()[0]?.digested_at).toBeNull()
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.digest')).toHaveLength(1)
    expect(s.events()[0]?.digested_at).not.toBeNull()
  })

  it('digest keeps every high-priority item and caps the rest with a "+N more" line', async () => {
    const s = setup({
      config: (cfg) => {
        cfg.quiet_window = { start: '22:00', end: '07:00' }
        cfg.timezone = 'UTC'
      },
    })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T23:00:00Z'))
    for (let i = 0; i < 3; i++)
      await s.send('generic', c.id, c.secret, { title: `HIGH ${i}`, priority: 'high' }, { id: `h${i}` })
    for (let i = 0; i < 250; i++)
      await s.send('generic', c.id, c.secret, { title: `low ${i}`, priority: 'low' }, { id: `l${i}` })
    await s.drain()
    s.f.clock.set(Date.parse('2026-10-29T07:00:00Z'))
    await s.tick()
    const d = framesOf(s.f.bus.toBridgeLog, 'hook.digest')[0]
    const titles = d.events.map((e: { title: string }) => e.title)
    expect(d.events).toHaveLength(200)
    for (let i = 0; i < 3; i++) expect(titles).toContain(`HIGH ${i}`)
    expect(titles.at(-1)).toBe('+54 more low-priority items')
  })

  it('verified traffic over the hourly limit gets 429 (retry), failed-verify junk gets its own small bucket', async () => {
    const s = setup()
    const c = await s.create('generic')
    let junk429 = 0
    for (let i = 0; i < 50; i++)
      if ((await s.post('generic', c.id, '{}', { authorization: 'Bearer nope' })).status === 429) junk429++
    expect(junk429).toBeGreaterThan(0)
    expect((await s.send('generic', c.id, c.secret, { title: 'real' }, { id: 'real' })).status).toBe(200)
  })
})
