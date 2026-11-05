import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { FrameRejected } from '../../src/core/hub.ts'
import { expectValidFrames, framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const ID = '01JBF3WA0H1J2K3M4N5P6Q7R8S'
const upd = (over: Record<string, unknown>) => ({
  v: 1,
  type: 'inbox.update',
  id: ID,
  ts: '2026-10-28T15:00:00.000Z',
  ...over,
})

/** An app change that applies to nothing is refused (the hub turns this into an error frame), never acked as done. */
const refused = (s: ReturnType<typeof setup>, frame: Record<string, unknown>) =>
  expect(s.f.bus.injectAppFrame(frame)).rejects.toBeInstanceOf(FrameRejected)

async function seed(s: ReturnType<typeof setup>, items: Array<{ title: string; priority: 'high' | 'normal' | 'low' }>) {
  const c = await s.create('generic')
  for (const [i, it] of items.entries()) {
    s.f.clock.advance(1000)
    await s.send('generic', c.id, c.secret, { ...it, ts: new Date(s.f.clock.now()).toISOString() }, { id: `i${i}` })
  }
  await s.drain()
  return c
}

describe('inbox', () => {
  it('Priority is high + normal, Other is low, newest first, with counts', async () => {
    const s = setup()
    await seed(s, [
      { title: 'a', priority: 'high' },
      { title: 'b', priority: 'low' },
      { title: 'c', priority: 'normal' },
    ])
    const prio = (await (await s.api('GET', '/api/inbox?tab=priority')).json()) as {
      items: Array<{ title: string; state: string }>
      counts: object
    }
    expect(prio.items.map((i) => i.title)).toEqual(['c', 'a'])
    expect(prio.counts).toEqual({ priority: 2, other: 1 })
    expect(prio.items.every((i) => i.state === 'new')).toBe(true)
    const other = (await (await s.api('GET', '/api/inbox?tab=other')).json()) as { items: Array<{ title: string }> }
    expect(other.items.map((i) => i.title)).toEqual(['b'])
    const dflt = (await (await s.api('GET', '/api/inbox')).json()) as { items: unknown[] }
    expect(dflt.items).toHaveLength(2)
  })

  it('items carry no relay internals', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const body = JSON.stringify(await (await s.api('GET', '/api/inbox')).json())
    expect(body).not.toContain('dedup_key')
    expect(body).not.toContain('raw_ref')
  })

  it('the app can mark done; done items leave the lists but stay in the digest source', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const eventId = s.events()[0]?.event_id
    await s.f.bus.injectAppFrame(upd({ event_id: eventId, state: 'done' }))
    expect(((await (await s.api('GET', '/api/inbox')).json()) as { items: unknown[] }).items).toHaveLength(0)
    const echoed = framesOf(s.f.bus.toAppsLog, 'inbox.update')
    expect(echoed[0]).toMatchObject({ event_id: eventId, state: 'done' })
    expectValidFrames(s.f)
  })

  it('snooze needs a future time, hides nothing, and wakes up on its own', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const eventId = s.events()[0]?.event_id
    await refused(s, upd({ event_id: eventId, state: 'snoozed' })) // no time
    await refused(s, upd({ event_id: eventId, state: 'snoozed', snooze_until: '2026-10-28T14:00:00.000Z' })) // past
    expect(s.events()[0]?.state).toBe('new')
    const until = new Date(s.f.clock.now() + 3600_000).toISOString()
    await s.f.bus.injectAppFrame(upd({ event_id: eventId, state: 'snoozed', snooze_until: until }))
    expect(s.events()[0]).toMatchObject({ state: 'snoozed', snooze_until: until })
    const before = framesOf(s.f.bus.toAppsLog, 'inbox.update').length
    s.f.clock.advance(1800_000)
    await s.tick()
    expect(s.events()[0]?.state).toBe('snoozed')
    s.f.clock.advance(1801_000)
    await s.tick()
    expect(s.events()[0]).toMatchObject({ state: 'new', snooze_until: null })
    const woke = framesOf(s.f.bus.toAppsLog, 'inbox.update').slice(before).at(-1)
    expect(woke).toMatchObject({ event_id: eventId, state: 'new' })
    expectValidFrames(s.f)
  })

  it('the agent can add a summary and a card; the app cannot', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const eventId = s.events()[0]?.event_id
    const card = 'c_01JBF3WB0H1J2K3M4N5P6Q7R8S'
    await refused(s, upd({ event_id: eventId, agent_summary: 'forged', card_id: card }))
    expect(s.events()[0]).toMatchObject({ agent_summary: null, card_id: null })
    await s.f.bus.injectBridgeFrame(
      upd({ event_id: eventId, agent_summary: 'Invoice due Friday', card_id: card, priority: 'low' }),
    )
    expect(s.events()[0]).toMatchObject({ agent_summary: 'Invoice due Friday', card_id: card, priority: 'low' })
    const item = (
      (await (await s.api('GET', '/api/inbox?tab=other')).json()) as { items: Array<Record<string, unknown>> }
    ).items[0]
    expect(item).toMatchObject({ agent_summary: 'Invoice due Friday', card_id: card, priority: 'low' })
  })

  it('updates for unknown events are refused and tell no one', async () => {
    const s = setup()
    await refused(s, upd({ event_id: 'e_01JBF3WA0H1J2K3M4N5P6Q7R8S', state: 'done' }))
    expect(s.f.bus.toAppsLog).toHaveLength(0)
  })
})

describe('bridge routes', () => {
  const hdr = { 'x-test-bridge': 'k' }

  it('serves the decrypted raw payload to the bridge only', async () => {
    const s = setup()
    const c = await s.create('generic')
    const body = JSON.stringify({ title: 'raw-marker', extra: { nested: [1, 2, 3] } })
    await s.send('generic', c.id, c.secret, body)
    await s.drain()
    const eventId = s.events()[0]?.event_id
    const url = `${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/${eventId}`
    expect((await s.app.request(url)).status).toBe(401)
    const ok = await s.app.request(url, { headers: hdr })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe(body)
    expect(ok.headers.get('content-type')).toBe('application/octet-stream')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(
      (
        await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/e_01JBF3WA0H1J2K3M4N5P6Q7R8S`, {
          headers: hdr,
        })
      ).status,
    ).toBe(404)
    expect(
      (await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/nonsense`, { headers: hdr })).status,
    ).toBe(400)
  })

  it('the session cookie is not enough for bridge routes', async () => {
    const s = setup()
    const res = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/digest`, {
      headers: { 'x-test-session': 'none' },
    })
    expect(res.status).toBe(401)
  })
})
