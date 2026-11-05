// Hook events through the real hub and a real Mac socket: a write that fails while a hook.event is queued for the Mac
// must not stall the events behind it, and the retry must deliver the event once. Failures are injected inside SQLite
// with a trigger, so the real statements fail the way a full disk would.
import { type NormalizedEventT, newId, newUlid } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { flushDigest } from '../../src/hooks/digest.ts'
import { runtimeFor } from '../../src/hooks/index.ts'
import { deliverPending, storeEvents } from '../../src/hooks/route.ts'
import { stopTicking, tick } from '../../src/hooks/runtime.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, newConn, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const conn = newConn()
const eventFor = (title: string, thread = 'inbox'): NormalizedEventT => ({
  id: newId('e'),
  source: 'generic',
  connection: conn,
  kind: 'generic.event',
  title,
  summary: title,
  actor: {},
  ts: new Date().toISOString(),
  thread,
  work: false,
  priority: 'low',
  dedup_key: `generic:${title}`,
})

async function start() {
  relay = await startTestRelay()
  const rt = runtimeFor(relay.relay.services)
  stopTicking(relay.relay.services) // the test runs each delivery pass itself
  const bridge = await silentBridge(relay, relay.bridgeKey)
  const db = relay.runtime.store.db
  const store = (...events: NormalizedEventT[]) => {
    db.transaction(() =>
      storeEvents(
        rt,
        events.map((event) => ({ event, rawId: null })),
      ),
    )()
  }
  const row = (id: string) =>
    db.prepare('select bridge_frame_id, sent_at, delivered_at from hooks_events where event_id = ?').get(id) as {
      bridge_frame_id: string | null
      sent_at: number | null
      delivered_at: number | null
    }
  /** Fails the writes of one event's hook.event frame into the Mac's outbox until the returned function is called. */
  const failOutboxFor = (id: string) => {
    db.exec(
      `create trigger fail_outbox_${id} before insert on core_outbox when new.frame_id = (select bridge_frame_id from hooks_events where event_id = '${id}') begin select raise(abort, 'disk full'); end`,
    )
    return () => db.exec(`drop trigger fail_outbox_${id}`)
  }
  const stored = (frameId: string) =>
    (db.prepare('select count(*) n from core_events where frame_id = ?').get(frameId) as { n: number }).n
  /** Teaches the relay the default threads, so an event for 'general' keeps its thread instead of falling back to the inbox. */
  const knowThreads = async () => {
    bridge.send({ type: 'config.sync', config: { ...DEFAULT_AGENT_CONFIG, rev: 1, quiet_window: null }, rev: 1 })
    await waitFor(() => relay?.runtime.hub.agentConfig() != null, 5000, 'config stored')
  }
  const frames = (type: string) =>
    (db.prepare('select count(*) n from core_events where type = ?').get(type) as { n: number }).n
  /** Fails one column's stamp on every hooks_events row until the returned function is called. */
  const failStamp = (column: string) => {
    db.exec(
      `create trigger fail_${column} before update of ${column} on hooks_events when new.${column} is not null begin select raise(abort, 'disk full'); end`,
    )
    return () => db.exec(`drop trigger fail_${column}`)
  }
  /** The seen ids written for an event (`hi:` for its inbox item, `hm:` for its timeline line). */
  const keys = (id: string) =>
    (db.prepare('select key from core_dedup where key like ?').all(`%${id}`) as Array<{ key: string }>).map(
      (r) => r.key,
    )
  /** Fails the insert of every stored frame of one type until the returned function is called. */
  const failFrame = (type: string) => {
    db.exec(
      `create trigger fail_frame before insert on core_events when new.type = '${type}' begin select raise(abort, 'disk full'); end`,
    )
    return () => db.exec('drop trigger fail_frame')
  }
  /** Fails the insert of every seen id with this prefix until the returned function is called. */
  const failSeen = (prefix: string) => {
    db.exec(
      `create trigger fail_seen before insert on core_dedup when new.key like '${prefix}%' begin select raise(abort, 'disk full'); end`,
    )
    return () => db.exec('drop trigger fail_seen')
  }
  return {
    rt,
    bridge,
    db,
    store,
    row,
    failOutboxFor,
    stored,
    knowThreads,
    frames,
    failStamp,
    keys,
    failFrame,
    failSeen,
  }
}

describe('hook delivery to the Mac', () => {
  it('one event whose queue write fails does not hold back the events behind it, and it is delivered once after', async () => {
    const t = await start()
    const [a, b, c] = [eventFor('first'), eventFor('second'), eventFor('third')]
    t.store(a, b, c)
    const heal = t.failOutboxFor(a.id)

    await deliverPending(t.rt)
    const aFrame = t.row(a.id).bridge_frame_id as string
    const bFrame = t.row(b.id).bridge_frame_id as string
    const cFrame = t.row(c.id).bridge_frame_id as string
    expect(t.row(b.id).sent_at).not.toBeNull() // checked first: a stalled pass never gave them a frame to wait for
    expect(t.row(c.id).sent_at).not.toBeNull()
    await t.bridge.reaches('hook.event', bFrame, 1)
    await t.bridge.reaches('hook.event', cFrame, 1)
    expect(t.row(a.id).sent_at).toBeNull()
    expect(t.bridge.count('hook.event', aFrame)).toBe(0)
    expect(t.stored(aFrame)).toBe(0) // the failed write left no half-stored event to collide with

    heal()
    await deliverPending(t.rt)
    await t.bridge.reaches('hook.event', aFrame, 1)
    expect(t.row(a.id).sent_at).not.toBeNull()
    expect(t.row(a.id).bridge_frame_id).toBe(aFrame) // the retry kept its frame id
    for (const f of [aFrame, bFrame, cFrame]) {
      t.bridge.ack(f)
      expect(t.bridge.count('hook.event', f)).toBe(1)
    }
    await t.bridge.sync()
    expect([a, b, c].map((e) => t.row(e.id).delivered_at !== null)).toEqual([true, true, true])

    await deliverPending(t.rt) // a later pass finds nothing left to send
    await t.bridge.sync()
    for (const f of [aFrame, bFrame, cFrame]) expect(t.bridge.count('hook.event', f)).toBe(1)
    await t.bridge.close()
  })

  it('an event the old code stored without its queue row is finished by the next pass, once', async () => {
    const t = await start()
    const [a, b] = [eventFor('stranded'), eventFor('behind it')]
    t.store(a, b)
    // What the old code left behind: the frame is stored, the queue row is missing, and the event row has its frame id.
    const frameId = newUlid()
    t.db.prepare('update hooks_events set bridge_frame_id = ?, apps_sent_at = 1 where event_id = ?').run(frameId, a.id)
    relay?.runtime.store.appendEvent({
      frame: { v: 1, id: frameId, ts: new Date().toISOString(), type: 'hook.event', event: a, delivery: 'live' },
      audience: 'bridge',
    })

    await deliverPending(t.rt)
    const bFrame = t.row(b.id).bridge_frame_id as string
    await t.bridge.reaches('hook.event', frameId, 1)
    await t.bridge.reaches('hook.event', bFrame, 1)
    expect(t.row(a.id).sent_at).not.toBeNull()
    expect(t.stored(frameId)).toBe(1)
    await deliverPending(t.rt)
    await t.bridge.sync()
    expect(t.bridge.count('hook.event', frameId)).toBe(1)
    await t.bridge.close()
  })

  it('a failure after the queue write is retried without a second copy, and without a second one after the Mac acked', async () => {
    const t = await start()
    const [a, b] = [eventFor('stamp fails'), eventFor('acked first')]
    t.store(a, b)
    t.db.exec(
      "create trigger fail_stamp before update of sent_at on hooks_events when new.sent_at is not null begin select raise(abort, 'disk full'); end",
    )
    await deliverPending(t.rt) // both frames are queued and sent; neither row could be stamped
    const aFrame = t.row(a.id).bridge_frame_id as string
    const bFrame = t.row(b.id).bridge_frame_id as string
    expect(bFrame).not.toBeNull() // the failed stamp on the first row did not stall the second
    await t.bridge.reaches('hook.event', aFrame, 1)
    await t.bridge.reaches('hook.event', bFrame, 1)
    expect(t.row(a.id).sent_at).toBeNull()
    t.bridge.ack(bFrame, 'consumed') // the Mac took the second one, and its queue row is gone, before the retry
    await t.bridge.sync()
    expect(t.row(b.id).delivered_at).not.toBeNull()

    t.db.exec('drop trigger fail_stamp')
    await deliverPending(t.rt)
    await t.bridge.sync()
    expect(t.row(a.id).sent_at).not.toBeNull()
    expect(t.row(b.id).sent_at).not.toBeNull()
    expect(t.bridge.count('hook.event', aFrame)).toBe(1) // already queued: not sent again
    expect(t.bridge.count('hook.event', bFrame)).toBe(1) // already acked: not queued again
    expect(t.db.prepare('select 1 from core_outbox where frame_id = ?').get(bFrame)).toBeUndefined()
    await t.bridge.close()
  })

  it('the apps get one inbox item and one timeline line per event however often the sent stamp fails', async () => {
    const t = await start()
    await t.knowThreads()
    const app = await kit(relay as TestRelay).connectedApp()
    const [a, b] = [eventFor('in a thread', 'general'), eventFor('in the inbox')]
    t.store(a, b)
    const heal = t.failStamp('apps_sent_at')

    for (let i = 0; i < 4; i++) await deliverPending(t.rt) // the frames commit each time; the stamp never does
    expect(t.frames('inbox.item')).toBe(2)
    expect(t.frames('message.stored')).toBe(1)

    heal()
    await deliverPending(t.rt)
    await deliverPending(t.rt)
    expect(t.frames('inbox.item')).toBe(2)
    expect(t.frames('message.stored')).toBe(1)
    await app.expectFrame('inbox.item', (f) => f.item.title === 'in a thread')
    await t.bridge.sync()
    expect(app.rec.of('inbox.item', 'in')).toHaveLength(2)
    expect(app.rec.of('message.stored', 'in')).toHaveLength(1)
    expect(t.db.prepare('select count(*) n from hooks_events where apps_sent_at is not null').get()).toEqual({ n: 2 })
    // The Mac still got each event once: the apps step failing did not skip it, and it was not repeated after.
    for (const e of [a, b]) await t.bridge.reaches('hook.event', t.row(e.id).bridge_frame_id as string, 1)
    expect(t.bridge.count('hook.event')).toBe(2)
    await t.bridge.close()
  })

  it('a digest whose stamp failed is sent again as the same frame, not as a second digest', async () => {
    const t = await start()
    const [a, b] = [eventFor('overnight one'), eventFor('overnight two')]
    t.store(a, b)
    // As the quiet window leaves them: collected for the digest, nothing sent yet.
    t.db.exec('update hooks_events set collected = 1, apps_sent_at = 1')
    const heal = t.failStamp('digested_at')

    await expect(flushDigest(t.rt)).rejects.toThrow('disk full')
    await expect(flushDigest(t.rt)).rejects.toThrow('disk full')
    const id = t.row(a.id).bridge_frame_id as string
    expect(t.row(b.id).bridge_frame_id).toBe(id)
    await t.bridge.reaches('hook.digest', id, 1)
    expect(t.bridge.count('hook.digest')).toBe(1)

    heal()
    expect(await flushDigest(t.rt)).toBe(2)
    await t.bridge.sync()
    expect(t.bridge.count('hook.digest')).toBe(1)
    expect(t.db.prepare('select count(*) n from hooks_events where digested_at is not null').get()).toEqual({ n: 2 })
    expect(await flushDigest(t.rt)).toBe(0)
    await t.bridge.close()
  })

  it('a digest the Mac already acked is not queued again when only its stamp was lost', async () => {
    const t = await start()
    const a = eventFor('acked overnight')
    t.store(a)
    t.db.exec('update hooks_events set collected = 1, apps_sent_at = 1')
    const heal = t.failStamp('digested_at')
    await expect(flushDigest(t.rt)).rejects.toThrow('disk full')
    const id = t.row(a.id).bridge_frame_id as string
    await t.bridge.reaches('hook.digest', id, 1)
    t.bridge.ack(id, 'consumed') // the Mac took it and the relay dropped its queue row
    await t.bridge.sync()
    expect(t.row(a.id).delivered_at).not.toBeNull()

    heal()
    expect(await flushDigest(t.rt)).toBe(1)
    await t.bridge.sync()
    expect(t.bridge.count('hook.digest')).toBe(1)
    expect(t.db.prepare('select 1 from core_outbox where frame_id = ?').get(id)).toBeUndefined()
    await t.bridge.close()
  })

  it('rows collected after a failed digest go out as their own digest, and the first keeps its frame id', async () => {
    const t = await start()
    const [a, b] = [eventFor('first batch'), eventFor('second batch')]
    t.store(a)
    t.db.exec('update hooks_events set collected = 1, apps_sent_at = 1')
    const heal = t.failStamp('digested_at')
    await expect(flushDigest(t.rt)).rejects.toThrow('disk full')
    const first = t.row(a.id).bridge_frame_id as string
    heal()
    t.store(b)
    t.db.prepare('update hooks_events set collected = 1, apps_sent_at = 1 where event_id = ?').run(b.id)

    expect(await flushDigest(t.rt)).toBe(2)
    const second = t.row(b.id).bridge_frame_id as string
    expect(second).not.toBe(first)
    await t.bridge.reaches('hook.digest', first, 1)
    await t.bridge.reaches('hook.digest', second, 1)
    expect(t.bridge.count('hook.digest')).toBe(2)
    await t.bridge.close()
  })

  it('a digest batch that fails does not stop the batch behind it, and the failure still surfaces', async () => {
    const t = await start()
    const [a, b] = [eventFor('stuck batch'), eventFor('next batch')]
    t.store(a)
    t.db.exec('update hooks_events set collected = 1, apps_sent_at = 1')
    const heal = t.failStamp('digested_at')
    await expect(flushDigest(t.rt)).rejects.toThrow('disk full') // a is tagged with its frame id
    heal()
    t.store(b)
    t.db.prepare('update hooks_events set collected = 1, apps_sent_at = 1 where event_id = ?').run(b.id)
    t.db.exec(
      `create trigger fail_a before update of digested_at on hooks_events when new.event_id = '${a.id}' and new.digested_at is not null begin select raise(abort, 'disk full'); end`,
    )

    await expect(flushDigest(t.rt)).rejects.toThrow('disk full')
    expect(t.db.prepare('select digested_at from hooks_events where event_id = ?').get(b.id)).not.toEqual({
      digested_at: null,
    })
    await t.bridge.close()
  })

  it('a digest that throws does not skip the purge at the end of the tick', async () => {
    const t = await start()
    const a = eventFor('tick digest')
    t.store(a)
    t.db.exec('update hooks_events set collected = 1, apps_sent_at = 1')
    t.failStamp('digested_at')
    t.db.prepare('insert into hooks_dedup (key, seen_at, expires_at) values (?, 1, 1)').run('old-key')

    await expect(tick(t.rt)).rejects.toThrow('disk full')
    expect(t.db.prepare('select 1 from hooks_dedup where key = ?').get('old-key')).toBeUndefined()
    await t.bridge.close()
  })

  it('an inbox item whose frame write fails leaves no seen id, and the retry delivers it', async () => {
    const t = await start()
    const app = await kit(relay as TestRelay).connectedApp()
    const a = eventFor('frame fails')
    t.store(a)
    const heal = t.failFrame('inbox.item')

    await deliverPending(t.rt)
    expect(t.keys(a.id)).toEqual([]) // a seen id left behind would make the retry skip a frame that was never stored
    expect(t.frames('inbox.item')).toBe(0)
    expect(t.row(a.id).sent_at).toBeNull()

    heal()
    await deliverPending(t.rt)
    expect(t.keys(a.id)).toEqual([`hi:${a.id}`])
    expect(t.frames('inbox.item')).toBe(1)
    await app.expectFrame('inbox.item', (f) => f.item.title === 'frame fails')
    expect(app.rec.of('inbox.item', 'in')).toHaveLength(1)
    await t.bridge.close()
  })

  it('an inbox item whose seen id cannot be written is rolled back with it, goes to no app, and the retry delivers once', async () => {
    const t = await start()
    const app = await kit(relay as TestRelay).connectedApp()
    const a = eventFor('seen id fails')
    t.store(a)
    const heal = t.failSeen('hi:')

    await deliverPending(t.rt)
    expect(t.frames('inbox.item')).toBe(0) // the frame and its seen id are one transaction
    expect(t.row(a.id).sent_at).toBeNull()
    await t.bridge.sync()
    expect(app.rec.of('inbox.item', 'in')).toHaveLength(0)

    heal()
    await deliverPending(t.rt)
    await app.expectFrame('inbox.item', (f) => f.item.title === 'seen id fails')
    await t.bridge.sync()
    expect(t.frames('inbox.item')).toBe(1)
    expect(app.rec.of('inbox.item', 'in')).toHaveLength(1)
    await t.bridge.close()
  })
})
