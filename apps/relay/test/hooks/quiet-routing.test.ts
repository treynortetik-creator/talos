import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { expectValidFrames, framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const quiet = (c: { quiet_window: { start: string; end: string } | null; timezone: string }) => {
  c.quiet_window = { start: '22:00', end: '07:00' }
  c.timezone = 'UTC'
}

describe('quiet window', () => {
  it('collects during the window: stored and visible, but no bridge event and no push; one digest at the end', async () => {
    const s = setup({ config: quiet })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T23:30:00Z'))
    for (let i = 0; i < 3; i++)
      await s.send('generic', c.id, c.secret, { title: `n${i}`, priority: 'high' }, { id: `q${i}` })
    await s.drain()
    expect(s.events()).toHaveLength(3)
    expect(framesOf(s.f.bus.toAppsLog, 'inbox.item')).toHaveLength(3) // the app can still show them
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
    expect(s.f.push.intents).toEqual([])

    s.f.clock.set(Date.parse('2026-10-29T03:00:00Z'))
    await s.tick() // still quiet
    expect(s.f.bus.toBridgeLog).toHaveLength(0)

    s.f.clock.set(Date.parse('2026-10-29T07:00:00Z'))
    await s.tick()
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')
    expect(digest).toHaveLength(1)
    expect(digest[0]?.events.map((e: { title: string }) => e.title)).toEqual(['n0', 'n1', 'n2'])
    expect(digest[0]?.threads).toEqual([{ thread_id: 'inbox', counts: { generic: 3 } }])
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(0)
    expect(s.f.push.intents).toEqual([{ template: 'overnight', count: 3 }])
    expectValidFrames(s.f)

    await s.tick() // nothing more to send
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.digest')).toHaveLength(1)
    expect(s.f.push.intents).toHaveLength(1)
  })

  it('no digest and no push when nothing arrived overnight', async () => {
    const s = setup({ config: quiet })
    s.f.clock.set(Date.parse('2026-10-29T08:00:00Z'))
    await s.tick()
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
    expect(s.f.push.intents).toEqual([])
  })

  it('dedup still runs while collecting', async () => {
    const s = setup({ config: quiet })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T23:30:00Z'))
    await s.send('generic', c.id, c.secret, { title: 'a' }, { id: 'same' })
    await s.send('generic', c.id, c.secret, { title: 'a' }, { id: 'same' })
    await s.drain()
    expect(s.events()).toHaveLength(1)
  })

  it('outside the window events flow live: bridge event and push', async () => {
    const s = setup({ config: quiet })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T12:00:00Z'))
    await s.send('generic', c.id, c.secret, { title: 'daytime', priority: 'high' })
    await s.drain()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1)
    expect(s.f.push.intents).toHaveLength(1)
  })

  it('removing the quiet window flushes what was collected', async () => {
    const s = setup({ config: quiet })
    const c = await s.create('generic')
    s.f.clock.set(Date.parse('2026-10-28T23:30:00Z'))
    await s.send('generic', c.id, c.secret, { title: 'late' })
    await s.drain()
    s.config((cfg) => {
      cfg.quiet_window = null
    })
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.digest')).toHaveLength(1)
  })

  it('GET /bridge/digest returns the same list on demand', async () => {
    const s = setup()
    const c = await s.create('generic')
    await s.send('generic', c.id, c.secret, { title: 'one' }, { id: 'd1' })
    s.f.clock.advance(60_000)
    await s.send('generic', c.id, c.secret, { title: 'two' }, { id: 'd2' })
    await s.drain()
    const since = new Date(s.f.clock.now() - 30_000).toISOString()
    const res = await s.app.request(
      `${s.f.services.env.PUBLIC_ORIGIN}/bridge/digest?since=${encodeURIComponent(since)}`,
      { headers: { 'x-test-bridge': 'k' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { type: string; events: Array<{ title: string }>; window: { start: string } }
    expect(body.type).toBe('hook.digest')
    expect(body.events.map((e) => e.title)).toEqual(['two'])
    expect(body.window.start).toBe(since)
    const bad = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/digest?since=yesterday`, {
      headers: { 'x-test-bridge': 'k' },
    })
    expect(bad.status).toBe(400)
    const noAuth = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/digest`)
    expect(noAuth.status).toBe(401)
  })
})

describe('routing to threads', () => {
  it('an event for a non-inbox thread also becomes a timeline message, emitted as message.stored', async () => {
    const s = setup()
    const c = await s.create('generic', { thread: 'general' })
    await s.send('generic', c.id, c.secret, { title: 'for general' })
    await s.drain()
    const stored = framesOf(s.f.bus.toAppsLog, 'message.stored')
    expect(stored).toHaveLength(1)
    const m = stored[0]?.message
    expect(m).toMatchObject({ thread_id: 'general', author: 'hook', kind: 'event', text: 'for general', via: 'hook' })
    expect(m.event_id).toBe(s.events()[0]?.event_id)
    expect(s.f.bus.toAppsLog.find((l) => l.frame.type === 'message.stored')?.opts).toMatchObject({ durable: true })
    expect(framesOf(s.f.bus.toAppsLog, 'inbox.item')).toHaveLength(1) // the Inbox lists everything regardless
    expectValidFrames(s.f)
  })

  it('an event for the inbox thread has no timeline message', async () => {
    const s = setup()
    const c = await s.create('generic')
    await s.send('generic', c.id, c.secret, { title: 'inbox only' })
    await s.drain()
    expect(framesOf(s.f.bus.toAppsLog, 'message.stored')).toHaveLength(0)
  })

  it('creating a connection that points at a missing thread is rejected', async () => {
    const s = setup()
    const res = await s.api('POST', '/api/connections', { integration: 'generic', name: 'x', thread: 'nope' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown_thread' })
    expect(s.count('hooks_connections')).toBe(0)
    const patch = await (await s.create('generic')).id
    expect((await s.api('PATCH', `/api/connections/${patch}`, { thread: 'nope' })).status).toBe(400)
  })

  it('a thread that vanished from the config since the connection was made falls back to the inbox', async () => {
    const s = setup()
    const c = await s.create('generic', { thread: 'general' })
    s.config((cfg) => {
      cfg.threads = cfg.threads.filter((t) => t.id !== 'general')
      cfg.default_thread = 'inbox'
    })
    await s.send('generic', c.id, c.secret, { title: 'orphan' })
    await s.drain()
    expect(s.events()[0]?.thread).toBe('inbox')
    expect(framesOf(s.f.bus.toAppsLog, 'message.stored')).toHaveLength(0)
  })
})
