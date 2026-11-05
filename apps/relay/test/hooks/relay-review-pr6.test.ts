// Hook route regression tests: each test pins one bug that was found and fixed.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { fakeWork, framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

describe('PR6 review', () => {
  it('F1: a Bearer secret is never stored in plaintext (hooks_inbound.headers)', async () => {
    const s = setup()
    const c = await s.create('generic')
    const res = await s.post('generic', c.id, JSON.stringify({ title: 'hello' }), {
      'content-type': 'application/json',
      authorization: `Bearer ${c.secret}`,
    })
    expect(res.status).toBe(200)
    const rows = s.f.db.prepare('select headers from hooks_inbound').all() as Array<{ headers: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]?.headers).not.toContain(c.secret)
  })

  it('F2: unauthenticated junk cannot use up the hourly budget and get real events dropped', async () => {
    const s = setup()
    const c = await s.create('generic')
    for (let i = 0; i < 600; i++)
      await s.post('generic', c.id, '{}', { 'content-type': 'application/json', authorization: 'Bearer wrong' })
    await s.send('generic', c.id, c.secret, { title: 'real event', priority: 'high' }, { id: 'real-1' })
    await s.drain()
    expect(s.eventBodies().map((e) => e.title)).toEqual(['real event'])
  })

  it('F3: a failed durable write does not burn the delivery id (the retry is stored)', async () => {
    const s = setup()
    const c = await s.create('generic')
    const crypto = s.f.services.crypto
    const real = crypto.encrypt.bind(crypto)
    let fail = true
    crypto.encrypt = (plain, aad) => {
      if (fail && aad.startsWith('hooks_inbound:')) {
        fail = false
        throw new Error('disk full')
      }
      return real(plain, aad)
    }
    const first = await s.send('generic', c.id, c.secret, { title: 'once' }, { id: 'retry-me' }).catch(() => null)
    expect(first?.status ?? 500).not.toBe(200) // the sender sees a failure and retries
    await s.send('generic', c.id, c.secret, { title: 'once' }, { id: 'retry-me' })
    await s.drain()
    expect(s.events()).toHaveLength(1)
  })

  it('F4: a worker crash after per-event dedup does not lose the bridge delivery on retry', async () => {
    const s = setup()
    const c = await s.create('generic')
    const bus = s.f.bus as unknown as { toBridge: (...a: unknown[]) => Promise<{ queued: boolean }> }
    const real = bus.toBridge.bind(bus)
    let fail = true
    bus.toBridge = async (...a: unknown[]) => {
      if (fail) {
        fail = false
        throw new Error('socket hiccup')
      }
      return real(...a)
    }
    await s.send('generic', c.id, c.secret, { title: 'must arrive' }, { id: 'w1' })
    await s.drain()
    await s.tick() // retry pass
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1)
  })

  it('F5: an overnight flood of low-priority items cannot push a high-priority item out of the digest', async () => {
    const s = setup({
      config: (cfg) => {
        cfg.quiet_window = { start: '22:00', end: '07:00' }
        cfg.timezone = 'UTC'
      },
    })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T23:00:00Z'))
    await s.send('generic', c.id, c.secret, { title: 'IMPORTANT', priority: 'high' }, { id: 'imp' })
    await s.drain()
    for (let i = 0; i < 210; i++) {
      s.f.clock.advance(1000)
      await s.send('generic', c.id, c.secret, { title: `noise ${i}`, priority: 'low' }, { id: `n${i}` })
    }
    await s.drain()
    s.f.clock.set(Date.parse('2026-10-29T07:00:00Z'))
    await s.tick()
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')
    expect(digest).toHaveLength(1)
    expect(digest[0]?.events.map((e: { title: string }) => e.title)).toContain('IMPORTANT')
  })

  it('F6: deliveries polled in one batch are processed in the order the poller returned them', async () => {
    const calls: string[] = []
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: String(i + 1),
      unread: true,
      reason: 'mention',
      updated_at: '2026-10-28T14:55:00Z',
      subject: { title: `t${i + 1}`, url: 'https://api.github.com/repos/o/r/pulls/1', type: 'PullRequest' },
      repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
    }))
    const replies = [{ body: '[]' }, { body: JSON.stringify(items) }]
    const fetchFake = (async (url: string | URL | Request) => {
      calls.push(String(url))
      const r = replies.shift() ?? { body: '[]' }
      return new Response(r.body, { status: 200, headers: { 'x-poll-interval': '60' } })
    }) as typeof fetch
    const s = setup({ fetch: fetchFake, random: () => 0 })
    const c = await s.create('github')
    await s.api('POST', `/api/connections/${c.id}/credentials`, {
      fields: { token: 'ghp_exampletoken0000000000000000000000' },
    })
    s.f.clock.advance(61_000)
    await s.tick()
    const sent = framesOf(s.f.bus.toBridgeLog, 'hook.event').map((f) => f.event.title)
    expect(sent).toEqual(items.map((i) => i.subject.title))
  })

  it('F9: a passthrough work event that lands in the quiet window reaches the Mac in the digest, not the shredder', async () => {
    const s = setup({
      modules: { slack: fakeWork('slack') },
      config: (c) => {
        c.quiet_window = { start: '22:00', end: '07:00' }
        c.timezone = 'UTC'
        c.work.enabled = ['slack']
        c.work.retention = 'passthrough'
      },
    })
    const c = await s.create('slack')
    s.f.clock.set(Date.parse('2026-10-28T23:00:00Z'))
    await s.send('slack', c.id, c.secret, { title: 'overnight DM', id: 'dm1' }, { id: 'dm1' })
    await s.drain()
    for (let h = 0; h < 8; h++) {
      s.f.clock.advance(3_600_000)
      await s.tick()
    }
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')
    const titles = digest.flatMap((d) => d.events.map((e: { title: string }) => e.title))
    expect(titles).toContain('overnight DM')
  })
})
