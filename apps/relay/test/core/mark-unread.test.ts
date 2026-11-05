// D36, relay part: `thread.unread` lowers the read mark (the only frame that does; `thread.read` is a max), answers every
// device including the sender, survives a reconnect, and a thread whose counting rows aged out of the 7-day buffer still
// reads as one unread (a manual flag) until the next `thread.read`.
import { fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })
const DAY = 86_400_000

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function world(opts: { clock?: ReturnType<typeof fakeClock> } = {}) {
  relay = await startTestRelay(opts.clock ? { clock: opts.clock } : {})
  const k = kit(relay)
  const a = await k.connectedApp()
  const b = await k.connectedApp()
  const bridge = await k.bridge().connect()
  return { k, a, b, bridge, r: relay }
}
const readyOf = async (k: ReturnType<typeof kit>) => (await k.connectedApp()).rec.of('ready', 'in')[0]

describe('D36 mark unread (real relay)', () => {
  it('lowers the read mark to just under the newest counting row and tells every device, the sender too', async () => {
    const { k, a, b, bridge } = await world()
    bridge.reply('general', 'one')
    bridge.reply('general', 'two')
    const second = await a.expectFrame('reply', (f) => f.message.text === 'two')
    const seq2 = second.relay?.seq as number
    a.send({ type: 'thread.read', thread_id: 'general', up_to_seq: seq2 })
    await b.expectFrame('thread.read', (f) => f.up_to_seq === seq2)
    expect((await readyOf(k))?.unread).toEqual({})

    a.send({ type: 'thread.unread', thread_id: 'general' })
    const mine = await a.expectFrame('thread.unread', (f) => f.count !== undefined)
    const theirs = await b.expectFrame('thread.unread', (f) => f.count !== undefined)
    for (const f of [mine, theirs]) expect(f).toMatchObject({ thread_id: 'general', up_to_seq: seq2 - 1, count: 1 })

    // a reconnecting device sees the same: one unread, and the mark the Timeline draws its "new" line from
    const ready = await readyOf(k)
    expect(ready?.unread).toEqual({ general: 1 })
    expect(ready?.read_upto).toEqual({ general: seq2 - 1 })

    // reading it again raises the mark; and a thread.read BELOW the mark still changes nothing (it is a max)
    b.send({ type: 'thread.read', thread_id: 'general', up_to_seq: seq2 })
    await a.expectFrame('thread.read', (f) => f.up_to_seq === seq2)
    expect((await readyOf(k))?.unread).toEqual({})
    a.send({ type: 'thread.read', thread_id: 'general', up_to_seq: 1 })
    await sleep(80)
    expect((await readyOf(k))?.read_upto).toEqual({ general: seq2 })
  })

  it('a silent reply is not the row that goes unread: the newest COUNTING row is', async () => {
    const { k, a, bridge } = await world()
    bridge.reply('general', 'counts')
    const counted = await a.expectFrame('reply', (f) => f.message.text === 'counts')
    bridge.reply('general', 'quiet', { silent: true })
    await a.expectFrame('reply', (f) => f.message.text === 'quiet')
    a.send({ type: 'thread.read', thread_id: 'general', up_to_seq: 999 })
    a.send({ type: 'thread.unread', thread_id: 'general' })
    const f = await a.expectFrame('thread.unread', (f) => f.count !== undefined)
    expect(f.up_to_seq).toBe((counted.relay?.seq as number) - 1)
    expect((await readyOf(k))?.unread).toEqual({ general: 1 })
  })

  it('counting rows that aged out of the buffer: a manual flag keeps it at one unread until the next thread.read', async () => {
    const c = fakeClock(new Date().toISOString())
    const { k, a, bridge, r } = await world({ clock: c })
    bridge.reply('general', 'old news')
    const old = await a.expectFrame('reply')
    a.send({ type: 'thread.read', thread_id: 'general', up_to_seq: old.relay?.seq as number })
    await waitFor(() => Object.keys(r.runtime.store.unreadByThread()).length === 0, 5000, 'read')
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(r.runtime.store.threadEvents('general', null, 10)).toHaveLength(0) // gone from the buffer

    a.send({ type: 'thread.unread', thread_id: 'general' })
    const f = await a.expectFrame('thread.unread', (f) => f.count !== undefined)
    expect(f.count).toBe(1)
    expect(f.up_to_seq).toBeUndefined() // nothing to put a mark under: the app keeps its own
    expect((await readyOf(k))?.unread).toEqual({ general: 1 })

    a.send({ type: 'thread.read', thread_id: 'general', up_to_seq: 5 })
    await waitFor(() => r.runtime.store.manualUnread().length === 0, 5000, 'flag cleared by thread.read')
    expect((await readyOf(k))?.unread).toEqual({})
  })
})
