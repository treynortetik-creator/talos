// Work content (a hook event's title, summary and sender) must not stay on the relay once the Mac has pushed it into
// Claude, and must not outlive its own hour when the Mac never takes it. Real hub, real store, real Mac socket; the
// stored frame is counted in core_events itself, because that table is the replay buffer the product words speak of.
import { newId } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, newConn, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

const HOUR = 3_600_000
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function start() {
  const clock = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock })
  const db = relay.relay.services.db
  const event = () => ({
    id: newId('e'),
    source: 'generic',
    connection: newConn(),
    kind: 'generic.event',
    title: 'SECRET TITLE',
    summary: 'SECRET SUMMARY',
    actor: { name: 'Sender' },
    ts: new Date(clock.now()).toISOString(),
    thread: 'inbox',
    work: true,
    priority: 'normal',
    dedup_key: `generic:${Math.random()}`,
  })
  const frameBody = (type: string) =>
    type === 'hook.event'
      ? { type, event: event(), delivery: 'live' }
      : {
          type,
          window: { start: new Date(clock.now()).toISOString(), end: new Date(clock.now()).toISOString() },
          threads: [],
          events: [event()],
        }
  const send = (type: string) =>
    relay!.relay.services.bus.toBridge(frameBody(type) as never, { durable: true, ttl_s: 3600 })
  const stored = (type: string) =>
    (db.prepare('select count(*) n from core_events where type = ?').get(type) as { n: number }).n
  const queued = (type: string) =>
    (db.prepare('select count(*) n from core_outbox where type = ?').get(type) as { n: number }).n
  return { clock, send, stored, queued }
}

describe.each(['hook.event', 'hook.digest'])('%s frame on the relay', (type) => {
  it('is dropped when the Mac reports it consumed, not before', async () => {
    const t = await start()
    const b = await silentBridge(relay!, relay!.bridgeKey)
    await t.send(type)
    await b.reaches(type, undefined, 1)
    const got = b.received.find((f) => f.type === type)!
    b.ack(got.id as string, 'delivered')
    await b.sync()
    expect(t.stored(type)).toBe(1) // taken but not yet in Claude: still replayable
    expect(t.queued(type)).toBe(1)
    b.ack(got.id as string, 'consumed')
    await b.sync()
    expect(t.stored(type)).toBe(0)
    expect(t.queued(type)).toBe(0)
    await b.close()
  })

  it('is replayed after the Mac crashes between delivered and consumed', async () => {
    const t = await start()
    const b1 = await silentBridge(relay!, relay!.bridgeKey)
    await t.send(type)
    await b1.reaches(type, undefined, 1)
    const first = b1.received.find((f) => f.type === type)!
    b1.ack(first.id as string, 'delivered')
    await b1.sync()
    await b1.close() // dies before pushing it into Claude
    const b2 = await silentBridge(relay!, relay!.bridgeKey)
    await b2.reaches(type, first.id as string, 1)
    const again = b2.received.find((f) => f.type === type && f.id === first.id)!
    expect(JSON.stringify(again)).toContain('SECRET TITLE') // original bytes, content intact
    b2.ack(first.id as string, 'delivered')
    b2.ack(first.id as string, 'consumed')
    await b2.sync()
    expect(t.stored(type)).toBe(0)
    await b2.close()
  })

  it('is dropped with its outbox row when the Mac never takes it within the hour', async () => {
    const t = await start()
    await t.send(type)
    expect(t.stored(type)).toBe(1)
    await advance(t.clock, 2 * HOUR, 600_000)
    relay!.runtime.hub.sweep()
    expect(t.queued(type)).toBe(0)
    expect(t.stored(type)).toBe(0)
  })
})
