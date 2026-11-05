// A failed database write must leave nothing behind: no seen id, no event, no card change. The owner's retry (or the
// agent's resend) then runs as a first attempt. Failures are injected inside SQLite with a trigger, so the real
// statements fail the way a full disk or a locked file would.
import { bindingFrom, newId, newUlid, payloadHash } from '@talos-app/protocol'
import { buildCard, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit, newConn, silentBridge } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

/** Makes every insert into `table` fail until the returned function is called. */
function failInserts(r: TestRelay, table: string, when = '1') {
  const name = `fail_${table}`
  r.runtime.store.db.exec(
    `create trigger ${name} before insert on ${table} when ${when} begin select raise(abort, 'disk full'); end`,
  )
  return () => r.runtime.store.db.exec(`drop trigger ${name}`)
}

const eventCount = (r: TestRelay) =>
  (r.runtime.store.db.prepare('select count(*) n from core_events').get() as { n: number }).n

const acksFor = (app: { rec: { frames: Array<{ frame: { type: string; ref?: string } }> } }, ref: string) =>
  app.rec.frames.filter((r) => r.frame.type === 'ack' && r.frame.ref === ref)

const bridgeAcks = (b: { received: Array<Record<string, unknown>> }, ref: string) =>
  b.received.filter((f) => f.type === 'ack' && f.ref === ref).length

describe('owner frames are acked only after the durable write', () => {
  it('a failed outbox write gives a retryable error for that frame, and the retry is not a duplicate', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const before = eventCount(relay)
    const heal = failInserts(relay, 'core_outbox')

    const sent = await app.sendMessage('general', 'please do the thing')
    const err = await app.expectFrame('error', (f) => f.ref === sent.id)
    expect(err.code).toBe('internal')
    expect(acksFor(app, sent.id)).toHaveLength(0)
    expect(relay.runtime.store.seen(`of:${sent.id}`)).toBeUndefined()
    expect(relay.runtime.store.seen(`cm:${sent.client_msg_id}`)).toBeUndefined()
    expect(eventCount(relay)).toBe(before)
    expect(app.rec.of('message.stored', 'in')).toHaveLength(0)
    await bridge.sync()
    expect(bridge.count('message', sent.id)).toBe(0)

    heal()
    app.sendRaw(app.sentBytes[app.sentBytes.length - 1] as string) // the app's retry: the same signed bytes
    await app.expectFrame('ack', (f) => f.ref === sent.id)
    await bridge.reaches('message', sent.id, 1)
    expect(bridge.count('message', sent.id)).toBe(1)
    expect(relay.runtime.store.outboxRow(sent.id)).toBeDefined()
    expect(app.rec.of('message.stored', 'in')).toHaveLength(1)
    await bridge.close()
  })

  it('a failed dedupe write leaves no event and no outbox row for a message', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    const before = eventCount(relay)
    const heal = failInserts(relay, 'core_dedup', "new.key like 'cm:%'")
    const sent = await app.sendMessage('general', 'second path')
    await app.expectFrame('error', (f) => f.ref === sent.id)
    expect(eventCount(relay)).toBe(before)
    expect(relay.runtime.store.outboxRow(sent.id)).toBeUndefined()
    heal()
  })

  it('a card.resolve whose write fails leaves the card pending, and the retry reaches the Mac once', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
      .connect()
    const card = bridge.createCard({ thread_id: 'general', title: 'Ship it' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const heal = failInserts(relay, 'core_outbox')

    const first = await app.resolveCard(card, 'primary', hash)
    const err = await app.expectFrame('error', (f) => f.ref === first.id)
    expect(err.code).toBe('internal')
    expect(relay.runtime.store.getCard(card.id)?.state).toBe('pending')
    expect(relay.runtime.store.seen(`of:${first.id}`)).toBeUndefined()
    expect(acksFor(app, first.id)).toHaveLength(0)

    heal()
    app.sendRaw(app.sentBytes[app.sentBytes.length - 1] as string)
    await app.expectFrame('ack', (f) => f.ref === first.id)
    await bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
    expect(relay.runtime.store.getCard(card.id)?.state).toBe('resolved')
    expect(bridge.rec.of('card.resolve', 'in')).toHaveLength(1)
  })
})

describe('an inbox change from the app is acked only after the inbox row is written', () => {
  const stateOf = (r: TestRelay, id: string) =>
    (r.runtime.store.db.prepare('select state from hooks_events where event_id = ?').get(id) as { state: string }).state

  it('a failed inbox write gives a retryable error, leaves no seen id, and the retry applies once', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    relay.seedInboxItem('ev1')
    relay.runtime.store.db.exec(
      "create trigger fail_inbox before update on hooks_events begin select raise(abort, 'disk full'); end",
    )
    const sent = app.send({ type: 'inbox.update', event_id: 'ev1', state: 'done' })
    const err = await app.expectFrame('error', (f) => f.ref === sent.id)
    expect(err.code).toBe('internal')
    expect(acksFor(app, sent.id)).toHaveLength(0)
    expect(relay.runtime.store.seen(`of:${sent.id}`)).toBeUndefined()
    expect(stateOf(relay, 'ev1')).toBe('new')

    relay.runtime.store.db.exec('drop trigger fail_inbox')
    app.sendRaw(app.sentBytes[app.sentBytes.length - 1] as string)
    await app.expectFrame('ack', (f) => f.ref === sent.id)
    expect(stateOf(relay, 'ev1')).toBe('done')
  })

  it('a change to an item the relay does not have is refused for good: no ack, nothing stored, no other device told', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const sent = app.send({ type: 'inbox.update', event_id: 'e_gone', state: 'done' })
    const err = await app.expectFrame('error', (f) => f.ref === sent.id)
    expect(err.code).toBe('bad_frame') // not 'internal': a retry could never work
    expect(acksFor(app, sent.id)).toHaveLength(0)
    expect(relay.runtime.store.seen(`of:${sent.id}`)).toBeUndefined()
    other.send({ type: 'ping', nonce: 'caught-up' })
    await other.expectFrame('pong', (f) => f.nonce === 'caught-up') // frames arrive in order: a told device would have it
    expect(other.rec.of('inbox.update', 'in')).toHaveLength(0)
  })

  it('a snooze that is not in the future changes nothing and is refused, not acked', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    relay.seedInboxItem('ev2')
    const sent = app.send({
      type: 'inbox.update',
      event_id: 'ev2',
      state: 'snoozed',
      snooze_until: '2020-01-01T00:00:00.000Z',
    })
    const err = await app.expectFrame('error', (f) => f.ref === sent.id)
    expect(err.code).toBe('bad_frame')
    expect(acksFor(app, sent.id)).toHaveLength(0)
    expect(stateOf(relay, 'ev2')).toBe('new')
  })
})

describe('the dedupe contract older peers rely on', () => {
  it('a repeat of a stored message is acked again with the same seq and queued for the Mac once', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const sent = await app.sendMessage('general', 'once only')
    const first = await app.expectFrame('ack', (f) => f.ref === sent.id)
    app.sendRaw(app.sentBytes[app.sentBytes.length - 1] as string) // an older app resends the same bytes
    await waitFor(() => acksFor(app, sent.id).length === 2, 10_000, 'second ack')
    const acks = acksFor(app, sent.id).map((r) => (r.frame as unknown as { seq: number }).seq)
    expect(acks).toEqual([first.seq, first.seq])
    await bridge.reaches('message', sent.id, 1)
    expect(bridge.count('message', sent.id)).toBe(1)
    await bridge.close()
  })
})

describe('bridge durable frames are stored as one unit', () => {
  it('a card whose write fails is not acked, and the resend creates it for the app', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const card = buildCard({ thread_id: 'general', title: 'Approve deploy' })
    const frame = mkFrame('card.create', { card })
    const heal = failInserts(relay, 'core_cards')

    bridge.send(frame)
    await bridge.sync()
    expect(bridgeAcks(bridge, frame.id)).toBe(0)
    expect(relay.runtime.store.seen(`bf:${frame.id}`)).toBeUndefined()
    expect(relay.runtime.store.getCard(card.id)).toBeNull()
    expect(app.rec.of('card.create', 'in')).toHaveLength(0)

    heal()
    bridge.send(frame) // the bridge resends the frame it never saw acked
    await waitFor(() => bridgeAcks(bridge, frame.id) >= 1, 10_000, 'ack')
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    expect(relay.runtime.store.getCard(card.id)?.state).toBe('pending')
    expect(app.rec.of('card.create', 'in')).toHaveLength(1)
    await bridge.close()
  })

  it('a reply whose dedupe write fails leaves no event behind', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const before = eventCount(relay)
    const heal = failInserts(relay, 'core_dedup', "new.key like 'bf:%'")
    const frame = mkFrame('reply', {
      message: {
        id: newId('m'),
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text: 'done',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date().toISOString(),
      },
    })
    bridge.send(frame)
    await bridge.sync()
    expect(eventCount(relay)).toBe(before)
    expect(bridgeAcks(bridge, frame.id)).toBe(0)
    heal()
    bridge.send(frame)
    await app.expectFrame('reply', (f) => f.id === frame.id)
    await waitFor(() => bridgeAcks(bridge, frame.id) >= 1, 10_000, 'ack')
    expect(bridgeAcks(bridge, frame.id)).toBe(1)
    await bridge.close()
  })
})

describe('durable frames to the Mac are stored as one unit', () => {
  const hookFrame = (id: string) => ({
    type: 'hook.event',
    id,
    delivery: 'live',
    event: {
      id: newId('e'),
      source: 'generic',
      connection: newConn(),
      kind: 'generic.event',
      title: 'Deploy finished',
      summary: 'A deploy finished',
      actor: {},
      ts: new Date().toISOString(),
      thread: 'inbox',
      work: false,
      priority: 'normal',
      dedup_key: 'generic:1',
    },
  })
  const eventRows = (r: TestRelay, id: string) =>
    (r.runtime.store.db.prepare('select count(*) n from core_events where frame_id = ?').get(id) as { n: number }).n

  it('a failed outbox write leaves no event, and the retry with the same frame id is queued once', async () => {
    relay = await startTestRelay()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const frame = hookFrame(newUlid())
    const heal = failInserts(relay, 'core_outbox')

    await expect(relay.runtime.hub.toBridge(frame, { durable: true, resume: true })).rejects.toThrow('disk full')
    expect(eventRows(relay, frame.id)).toBe(0)
    expect(relay.runtime.store.outboxRow(frame.id)).toBeUndefined()
    await bridge.sync()
    expect(bridge.count('hook.event', frame.id)).toBe(0)

    heal()
    await relay.runtime.hub.toBridge(frame, { durable: true, resume: true }) // the hook pass retries with the frame id it saved
    await bridge.reaches('hook.event', frame.id, 1)
    expect(eventRows(relay, frame.id)).toBe(1)
    expect(relay.runtime.store.outboxRow(frame.id)).toBeDefined()
    expect(bridge.count('hook.event', frame.id)).toBe(1)
    await bridge.close()
  })

  it('a retry that finds its own stored event without an outbox row finishes the row instead of failing', async () => {
    relay = await startTestRelay()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const frame = hookFrame(newUlid())
    // What an earlier build left behind when the outbox write failed after the event had committed.
    relay.runtime.store.appendEvent({ frame, audience: 'bridge', threadId: undefined })
    expect(relay.runtime.store.outboxRow(frame.id)).toBeUndefined()

    await relay.runtime.hub.toBridge(frame, { durable: true, resume: true })
    await bridge.reaches('hook.event', frame.id, 1)
    expect(eventRows(relay, frame.id)).toBe(1)
    expect(relay.runtime.store.outboxRow(frame.id)).toBeDefined()
    expect(bridge.count('hook.event', frame.id)).toBe(1)
    await bridge.close()
  })

  it('a retry for a frame that is already queued changes nothing and sends nothing more', async () => {
    relay = await startTestRelay()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const frame = hookFrame(newUlid())
    await relay.runtime.hub.toBridge(frame, { durable: true, resume: true })
    await bridge.reaches('hook.event', frame.id, 1)
    const row = relay.runtime.store.outboxRow(frame.id)

    await relay.runtime.hub.toBridge(frame, { durable: true, resume: true })
    await bridge.sync()
    expect(eventRows(relay, frame.id)).toBe(1)
    expect(relay.runtime.store.outboxRow(frame.id)).toEqual(row)
    expect(bridge.count('hook.event', frame.id)).toBe(1)
    await bridge.close()
  })

  it('an id that belongs to a different stored frame is an error, not a retry', async () => {
    relay = await startTestRelay()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const taken = newUlid()
    relay.runtime.store.appendEvent({
      frame: { v: 1, id: taken, ts: new Date().toISOString(), type: 'inbox.item', item: { id: newId('e') } },
      audience: 'app',
    })
    const control = { type: 'session.control', id: taken, control_id: newUlid(), thread_id: 'general', action: 'stop' }

    // The id came from the app: it must not be taken for a retry, with or without the caller asking to resume.
    for (const resume of [false, true]) {
      await expect(relay.runtime.hub.toBridge(control, { durable: true, resume })).rejects.toThrow(/UNIQUE/)
    }
    await bridge.sync()
    expect(bridge.count('session.control')).toBe(0)
    expect(bridge.count('inbox.item')).toBe(0)
    expect(relay.runtime.store.outboxRow(taken)).toBeUndefined()
    await bridge.close()
  })

  it('a caller that did not ask to resume gets the unique error for a repeat of a stored frame of its own kind', async () => {
    relay = await startTestRelay()
    const bridge = await silentBridge(relay, relay.bridgeKey)
    const frame = hookFrame(newUlid())
    await relay.runtime.hub.toBridge(frame, { durable: true })
    await bridge.reaches('hook.event', frame.id, 1)

    await expect(relay.runtime.hub.toBridge(frame, { durable: true })).rejects.toThrow(/UNIQUE/)
    await bridge.sync()
    expect(bridge.count('hook.event', frame.id)).toBe(1)
    await bridge.close()
  })
})
