import { newUlid } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { fakeWork, framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const withWork = (over: { enabled?: boolean; retention?: 'passthrough' | 'buffer' } = {}) =>
  setup({
    modules: { slack: fakeWork('slack') },
    config: (c) => {
      c.threads.push({
        id: 'work',
        name: 'Work',
        icon: 'briefcase',
        kind: 'fixed',
        order: 5,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: '2026-10-28T00:00:00.000Z',
      })
      c.work.thread = 'work'
      c.work.enabled = over.enabled === false ? [] : ['slack']
      c.work.retention = over.retention ?? 'passthrough'
    },
  })

/** Creates a work connection while it is enabled, then lets the caller switch it off. */
async function connected(s: ReturnType<typeof setup>) {
  const c = await s.create('slack')
  return { id: c.id as string, secret: c.secret as string, thread: c.thread as string }
}

describe('work gating', () => {
  it('creating a work connection while the system is not enabled is refused', async () => {
    const s = withWork({ enabled: false })
    const res = await s.api('POST', '/api/connections', { integration: 'slack', name: 'x' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'integration_disabled' })
    expect(s.count('hooks_connections')).toBe(0)
  })

  it('a hook for a work system that was switched off is 403 and nothing is stored', async () => {
    const s = withWork()
    const { id, secret } = await connected(s)
    s.config((c) => {
      c.work.enabled = []
    })
    const res = await s.send('slack', id, secret, { title: 'x' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'integration_disabled' })
    await s.drain()
    for (const t of ['hooks_events', 'hooks_inbound', 'hooks_dedup', 'hooks_deliveries']) expect(s.count(t), t).toBe(0)
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
  })

  it('WORK_INTEGRATIONS=off is a hard kill even when the config enables it', async () => {
    const s = setup({
      env: { WORK_INTEGRATIONS: 'off' },
      modules: { slack: fakeWork('slack') },
      config: (c) => {
        c.work.enabled = ['slack']
      },
    })
    expect((await s.api('POST', '/api/connections', { integration: 'slack', name: 'x' })).status).toBe(403)
    // and an existing connection is dead too
    const s2 = withWork()
    const { id, secret } = await connected(s2)
    s2.f.services.env.WORK_INTEGRATIONS = 'off'
    expect((await s2.send('slack', id, secret, { title: 'x' })).status).toBe(403)
    expect(s2.count('hooks_events')).toBe(0)
  })

  it('the module pre-filter rejects before anything is stored (200, no row, counted as received 1 / kept 0)', async () => {
    const s = withWork()
    const { id, secret } = await connected(s)
    const res = await s.send('slack', id, secret, { title: 'noise', skip: true })
    expect(res.status).toBe(200)
    await s.drain()
    for (const t of ['hooks_events', 'hooks_inbound', 'hooks_dedup']) expect(s.count(t), t).toBe(0)
    const c = (await (await s.api('GET', `/api/connections/${id}`)).json()) as {
      received_24h: number
      kept_24h: number
    }
    expect(c).toMatchObject({ received_24h: 1, kept_24h: 0 })
  })

  it('a passing event goes to the configured work thread, as work', async () => {
    const s = withWork()
    const { id, secret, thread } = await connected(s)
    expect(thread).toBe('work')
    await s.send('slack', id, secret, { title: 'standup moved', id: 'a' })
    await s.drain()
    const ev = framesOf(s.f.bus.toBridgeLog, 'hook.event')[0]
    expect(ev?.event).toMatchObject({ thread: 'work', work: true, source: 'slack' })
  })

  it('falls back to the inbox when no work thread is configured', async () => {
    const s = setup({
      modules: { slack: fakeWork('slack') },
      config: (c) => {
        c.work.enabled = ['slack']
      },
    })
    const made = await s.create('slack')
    expect(made.thread).toBe('inbox')
  })
})

describe('passthrough retention', () => {
  it('an event the Mac never took is dropped after an hour (and its raw payload with it)', async () => {
    const s = withWork()
    const { id, secret } = await connected(s)
    await s.send('slack', id, secret, { title: 'sensitive', id: 'p1' })
    await s.drain()
    const eventId = s.events()[0]?.event_id as string
    expect(s.f.bus.toBridgeLog[0]?.opts).toMatchObject({ durable: true, ttl_s: 3600 })
    s.f.clock.advance(59 * 60_000)
    await s.tick()
    expect(s.events()).toHaveLength(1)
    s.f.clock.advance(2 * 60_000) // 61 minutes in
    await s.tick()
    expect(s.events()).toHaveLength(0)
    const raw = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/${eventId}`, {
      headers: { 'x-test-bridge': 'k' },
    })
    expect(raw.status).toBe(404)
    const rows = s.f.db.prepare("select count(*) as n from hooks_inbound where raw_enc != x''").get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('the raw payload is wiped once the Mac has acked the event, and not before', async () => {
    const s = withWork()
    const { id, secret } = await connected(s)
    await s.send('slack', id, secret, { title: 'sensitive', id: 'w1' })
    await s.drain()
    const sent = framesOf(s.f.bus.toBridgeLog, 'hook.event')
    expect(sent).toHaveLength(1)
    const live = () =>
      s.f.db.prepare("select count(*) as n from hooks_inbound where raw_enc != x''").get() as { n: number }
    expect(live().n).toBe(1) // sent but not yet taken: the payload is still held for the Mac to fetch
    const frameId = String(sent[0]?.id)
    await s.f.bus.injectBridgeFrame({
      v: 1,
      type: 'ack',
      id: newUlid(),
      ts: new Date().toISOString(),
      ref: frameId,
      stage: 'consumed',
    })
    expect(live().n).toBe(0)
    const state = s.f.db.prepare('select state from hooks_inbound').get() as { state: string }
    expect(state.state).toBe('wiped')
  })

  it('retention "buffer" keeps work events and their raw payload', async () => {
    const s = withWork({ retention: 'buffer' })
    const { id, secret } = await connected(s)
    await s.send('slack', id, secret, { title: 'buffered', id: 'p4' })
    await s.drain()
    s.f.clock.advance(3 * 3600_000)
    await s.tick()
    expect(s.events()).toHaveLength(1)
    const eventId = s.events()[0]?.event_id as string
    const raw = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/${eventId}`, {
      headers: { 'x-test-bridge': 'k' },
    })
    expect(raw.status).toBe(200)
  })

  it('personal events are never subject to the one-hour rule', async () => {
    const s = setup()
    const c = await s.create('generic')
    await s.send('generic', c.id, c.secret, { title: 'mine' })
    await s.drain()
    s.f.clock.advance(3 * 3600_000)
    await s.tick()
    expect(s.events()).toHaveLength(1)
  })
})
