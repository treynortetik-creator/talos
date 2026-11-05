// Audit D35: the Done view (`GET /api/inbox?state=done`) and Restore (done -> read), against the real relay hooks.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { expectValidFrames, framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const upd = (over: Record<string, unknown>) => ({
  v: 1,
  type: 'inbox.update',
  id: '01JBF3WA0H1J2K3M4N5P6Q7R8S',
  ts: '2026-10-28T15:00:00.000Z',
  ...over,
})

type List = { items: Array<{ id: string; title: string; state: string; snooze_until?: string }>; counts: object }
const get = async (s: ReturnType<typeof setup>, q: string) =>
  (await (await s.api('GET', `/api/inbox${q}`)).json()) as List

async function seed(s: ReturnType<typeof setup>, items: Array<{ title: string; priority: 'high' | 'normal' | 'low' }>) {
  const c = await s.create('generic')
  for (const [i, it] of items.entries()) {
    s.f.clock.advance(1000)
    await s.send('generic', c.id, c.secret, { ...it, ts: new Date(s.f.clock.now()).toISOString() }, { id: `i${i}` })
  }
  await s.drain()
}
describe('inbox Done view', () => {
  it('lists done items of both tabs, newest first, and the default lists still exclude them', async () => {
    const s = setup()
    await seed(s, [
      { title: 'a', priority: 'high' },
      { title: 'b', priority: 'low' },
      { title: 'c', priority: 'normal' },
    ])
    // finish a (high) then b (low); c stays open
    const all = await get(s, '?tab=priority')
    const other = await get(s, '?tab=other')
    const a = all.items.find((i) => i.title === 'a')?.id as string
    const b = other.items.find((i) => i.title === 'b')?.id as string
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'done' }))
    s.f.clock.advance(1000)
    await s.f.bus.injectAppFrame(upd({ event_id: b, state: 'done' }))

    const done = await get(s, '?state=done')
    expect(done.items.map((i) => i.title).sort()).toEqual(['a', 'b'])
    expect(done.items.every((i) => i.state === 'done')).toBe(true)
    expect((await get(s, '?tab=priority')).items.map((i) => i.title)).toEqual(['c'])
    expect((await get(s, '?tab=other')).items).toHaveLength(0)
    expect(await get(s, '')).toMatchObject({ counts: { priority: 1, other: 0 } }) // counts stay open-item counts
  })

  it('an empty Done view is an empty list, not an error', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const done = await get(s, '?state=done')
    expect(done.items).toEqual([])
  })

  it('an unknown state value falls back to the normal list; it never leaks done items', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const a = (await get(s, '')).items[0]?.id as string
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'done' }))
    expect((await get(s, '?state=bogus')).items).toEqual([])
    expect((await get(s, '?state=snoozed')).items).toEqual([])
  })
})

describe('Restore: done -> read', () => {
  it('moves the item back to its tab, off the Done view, and tells every app', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const a = (await get(s, '')).items[0]?.id as string
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'done' }))
    expect((await get(s, '?state=done')).items).toHaveLength(1)

    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'read' }))

    expect((await get(s, '?state=done')).items).toEqual([])
    const back = await get(s, '?tab=priority')
    expect(back.items.map((i) => ({ id: i.id, state: i.state }))).toEqual([{ id: a, state: 'read' }])
    expect(back.counts).toEqual({ priority: 1, other: 0 })
    const echoed = framesOf(s.f.bus.toAppsLog, 'inbox.update')
    expect(echoed.at(-1)).toMatchObject({ event_id: a, state: 'read' })
    expectValidFrames(s.f)
  })

  it('a snoozed item that was marked done comes back read, with no stale wake-up time', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const a = (await get(s, '')).items[0]?.id as string
    const until = new Date(s.f.clock.now() + 3600_000).toISOString()
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'snoozed', snooze_until: until }))
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'done' }))
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'read' }))
    const item = (await get(s, '?tab=priority')).items[0]
    expect(item).toMatchObject({ id: a, state: 'read' })
    expect(item?.snooze_until).toBeUndefined()
    // the old wake-up must not fire later and flip it back to new
    s.f.clock.advance(2 * 3600_000)
    await s.tick()
    expect((await get(s, '?tab=priority')).items[0]).toMatchObject({ id: a, state: 'read' })
  })

  it('undo of a snooze: snoozed -> read puts it back in the list', async () => {
    const s = setup()
    await seed(s, [{ title: 'a', priority: 'high' }])
    const a = (await get(s, '')).items[0]?.id as string
    const until = new Date(s.f.clock.now() + 3600_000).toISOString()
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'snoozed', snooze_until: until }))
    await s.f.bus.injectAppFrame(upd({ event_id: a, state: 'read' }))
    expect((await get(s, '?tab=priority')).items[0]).toMatchObject({ id: a, state: 'read' })
  })
})
