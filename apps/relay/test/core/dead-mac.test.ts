// D38: a message sent to a Mac that never came back. The audit's probe (fake clock, 8 days: outbox 0, bridge received 0,
// receipt still `sent`) now ends with a `not_delivered` receipt that survives a reconnect, a plain system row for a settings
// change, and ONE push at day 6 per episode (the flag lives in the store, so a relay restart repeats nothing).
import { bindingFrom, payloadHash } from '@talos-app/protocol'
import { fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
const DAY = 86_400_000
const SUB = { endpoint: 'https://push.example.com/send/dead-mac', keys: { p256dh: 'a', auth: 'b' } }

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const warnings = (r: TestRelay) =>
  r.transport.sent.map((s) => s.payload.notification.body).filter((b) => b.includes('Your messages have not reached'))

async function world() {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  const r = relay
  r.runtime.store.putSub(SUB)
  const k = kit(r)
  const app = await k.connectedApp({ visible: false })
  return { c, r, k, app }
}

describe('D38 a message to a dead Mac', () => {
  it('8 days, no bridge: the outbox empties, the bridge never saw it, and the app is told it was not delivered', async () => {
    const { c, r, k, app } = await world()
    const sent = await app.sendMessage('general', 'are you there')
    await app.expectFrame('ack', (f) => f.ref === sent.id)
    const store = r.runtime.store

    c.set(c.now() + 6 * DAY)
    r.runtime.hub.sweep()
    // under 7 days nothing is reported: the Mac may still come back
    expect(store.getMeta(String(sent.client_msg_id)).receipt).toBeUndefined()
    expect(store.outboxDepth()).toBe(1)

    c.set(c.now() + 2 * DAY)
    r.runtime.hub.sweep()
    expect(store.outboxDepth()).toBe(0) // the probe's finding, unchanged: it is gone
    const got = await app.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id, { direction: 'in' })
    expect(got.state).toBe('not_delivered')
    expect(store.getMeta(String(sent.client_msg_id)).receipt).toBe('not_delivered')

    // a device that was away learns on its next ready, and a second sweep says nothing more
    const back = await k.connectedApp()
    expect(back.rec.of('ready', 'in')[0]?.not_delivered).toEqual([sent.client_msg_id])
    r.runtime.hub.sweep()
    expect(app.rec.of('receipt', 'in').filter((f) => f.state === 'not_delivered')).toHaveLength(1)
  })

  it('a message the Mac pushed into Claude is never reported', async () => {
    const { c, r, k, app } = await world()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    const sent = await app.sendMessage('general', 'hello')
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    await waitFor(() => r.runtime.store.outboxRow(String(sent.id)) === undefined, 5000, 'consumed')
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(app.rec.of('receipt', 'in').filter((f) => f.state === 'not_delivered')).toHaveLength(0)
    expect(r.runtime.store.getMeta(String(sent.client_msg_id)).receipt).not.toBe('not_delivered')
  })

  it('a message the Mac took but never pushed into Claude warns at day 6 and ends with a not_delivered receipt', async () => {
    const { c, r, k, app } = await world()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
      .connect()
    // the Mac has pushed an earlier message, which is how the relay learns it acks in two stages
    const earlier = await app.sendMessage('general', 'pushed through')
    await bridge.expectFrame('message', (f) => f.id === earlier.id, { direction: 'in' })
    expect(bridge.consume(String(earlier.id))).toBe(true)
    await waitFor(() => r.runtime.store.outboxRow(String(earlier.id)) === undefined, 5000, 'earlier consumed')

    const start = c.now()
    const stuck = await app.sendMessage('general', 'taken but stuck')
    await bridge.expectFrame('message', (f) => f.id === stuck.id, { direction: 'in' })
    await waitFor(() => r.runtime.store.outboxRow(String(stuck.id))?.delivered === 1, 5000, 'delivered, not consumed')
    await bridge.close() // the Mac dies holding it
    await waitFor(() => !r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')

    c.set(start + 5 * DAY + 23 * 3_600_000)
    r.runtime.hub.sweep()
    expect(warnings(r)).toHaveLength(0)
    c.set(start + 6 * DAY + 3_600_000)
    r.runtime.hub.sweep()
    await waitFor(() => warnings(r).length === 1, 5000, 'the day-6 push')

    c.set(start + 8 * DAY)
    r.runtime.hub.sweep()
    expect(r.runtime.store.outboxDepth()).toBe(0)
    const got = await app.expectFrame('receipt', (f) => f.message_id === stuck.client_msg_id, { direction: 'in' })
    expect(got.state).toBe('not_delivered')
    expect(r.runtime.store.getMeta(String(stuck.client_msg_id)).receipt).toBe('not_delivered')
    expect(r.runtime.store.getMeta(String(earlier.client_msg_id)).receipt).not.toBe('not_delivered')
    r.runtime.hub.sweep() // once per frame
    expect(app.rec.of('receipt', 'in').filter((f) => f.state === 'not_delivered')).toHaveLength(1)
  })

  it('a bridge that has never pushed a frame (an older one that only says delivered) is not reported or warned about', async () => {
    const { c, r, k, app } = await world()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
      .connect()
    const start = c.now()
    const sent = await app.sendMessage('general', 'taken by an older bridge')
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    await waitFor(() => r.runtime.store.outboxRow(String(sent.id))?.delivered === 1, 5000, 'delivered')
    await bridge.close()
    await waitFor(() => !r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')

    c.set(start + 6 * DAY + 3_600_000)
    r.runtime.hub.sweep()
    c.set(start + 8 * DAY)
    r.runtime.hub.sweep()
    expect(r.runtime.store.outboxDepth()).toBe(0)
    expect(warnings(r)).toHaveLength(0)
    await sleep(150)
    expect(app.rec.of('receipt', 'in').filter((f) => f.state === 'not_delivered')).toHaveLength(0)
    expect(r.runtime.store.getMeta(String(sent.client_msg_id)).receipt).not.toBe('not_delivered')
  })

  it('short-lived frames (a device notice, a hook) are dropped without a word', async () => {
    const { c, r, app } = await world()
    await r.runtime.hub.toBridge({ type: 'device.revoked', device_id: 'dev_gone' }, { durable: true, ttl_s: 300 })
    expect(r.runtime.store.outboxDepth()).toBe(1)
    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    expect(r.runtime.store.outboxDepth()).toBe(0)
    await sleep(150) // a frame the relay did send would have reached the app by now
    expect(app.rec.of('receipt', 'in')).toHaveLength(0)
    expect(app.rec.of('message.stored', 'in')).toHaveLength(0)
    expect(warnings(r)).toHaveLength(0)
  })

  it('a settings change and a card decision get a plain system row, not a receipt', async () => {
    const { c, r, k, app } = await world()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
      .connect()
    const card = bridge.createCard({ thread_id: 'general', title: 'Ship it?' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    await bridge.close() // the Mac goes away before either owner frame
    await waitFor(() => !r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')
    await app.sendConfigPatch(0, { quiet_window: null })
    await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    await waitFor(() => r.runtime.store.outboxDepth() === 2, 5000, 'both queued')

    c.set(c.now() + 8 * DAY)
    r.runtime.hub.sweep()
    const system = () => app.rec.of('message.stored', 'in').filter((f) => f.message.author === 'system')
    await waitFor(() => system().length === 2, 5000, 'two system rows')
    const rows = system()
    expect(rows.map((f) => f.message.text).sort()).toEqual([
      expect.stringContaining('A settings change never reached your Mac'),
      expect.stringContaining('Your decision on a card never reached your Mac'),
    ])
    expect(rows.find((f) => f.message.text?.includes('card'))?.message.thread_id).toBe('general')
    expect(app.rec.of('receipt', 'in')).toHaveLength(0)
    r.runtime.hub.sweep() // once per frame
    await sleep(100)
    expect(app.rec.of('message.stored', 'in').filter((f) => f.message.author === 'system')).toHaveLength(2)
  })
})

describe('D38 the day-6 warning', () => {
  it('one push per episode, none before day 6, none again after a relay restart, a new one for a new episode', async () => {
    const { c, r, k, app } = await world()
    const dir = r.dir
    const start = c.now()
    await app.sendMessage('general', 'first')
    await waitFor(() => r.runtime.store.outboxDepth() === 1, 5000, 'queued')

    c.set(start + 5 * DAY + 23 * 3_600_000)
    r.runtime.hub.sweep()
    expect(warnings(r)).toHaveLength(0)

    c.set(start + 6 * DAY + 3_600_000)
    r.runtime.hub.sweep()
    await waitFor(() => warnings(r).length === 1, 5000, 'the day-6 push')
    r.runtime.hub.sweep()
    c.set(start + 6 * DAY + 5 * 3_600_000)
    r.runtime.hub.sweep()
    expect(warnings(r)).toHaveLength(1)

    // a restart keeps the "already warned" state (it is in the store, not in memory)
    const first = r.transport.sent.length
    await r.stopKeepData()
    relay = await startTestRelay({ clock: c, dir })
    relay.runtime.store.putSub(SUB)
    relay.runtime.hub.sweep()
    expect(relay.transport.sent.length).toBe(0)
    expect(first).toBe(1)

    // the Mac comes back and takes the message: the episode is over, and the next one warns afresh
    const k2 = kit(relay)
    const app2 = await k2.connectedApp({ visible: false })
    const bridge = await k2
      .bridge({ pinnedDevices: { [app2.device.deviceId]: app2.device.publicJwk }, autoReply: false })
      .connect()
    await bridge.expectFrame('message', (f) => f.text === 'first', { direction: 'in' })
    await waitFor(() => relay?.runtime.store.oldestUndeliveredOwner() === null, 5000, 'delivered')
    relay.runtime.hub.sweep()
    await bridge.close()
    await waitFor(() => !relay?.runtime.hub.bridgeOnline(), 5000, 'gone again')
    const t2 = c.now()
    await app2.sendMessage('general', 'second')
    await waitFor(() => relay?.runtime.store.oldestUndeliveredOwner() !== null, 5000, 'second queued')
    c.set(t2 + 6 * DAY + 3_600_000)
    relay.runtime.hub.sweep()
    await waitFor(() => (relay ? warnings(relay).length === 1 : false), 5000, 'the second episode push')
    void k
  })
})

describe('D38 review findings', () => {
  it('a share queued for a dead Mac warns at day 6 and ends with a not_delivered receipt on its row', async () => {
    const { c, r, k, app } = await world()
    const start = c.now()
    const message = {
      id: 'm_share_1',
      thread_id: 'general',
      author: 'owner' as const,
      kind: 'text' as const,
      text: 'look at this',
      format: 'plain' as const,
      attachments: [],
      via: 'share' as const,
      created_at: new Date(start).toISOString(),
    }
    await r.runtime.hub.toApps(
      { type: 'message.stored', id: 'st_share_1', client_msg_id: message.id, message },
      { durable: true },
    )
    await r.runtime.hub.toBridge({ type: 'share.item', share_id: 'sh_1', message }, { durable: true })
    expect(r.runtime.store.oldestUndeliveredOwner()).not.toBeNull()

    c.set(start + 6 * DAY + 1_800_000)
    r.runtime.hub.sweep()
    await waitFor(() => warnings(r).length === 1, 5000, 'the day-6 push for a share')

    c.set(start + 8 * DAY)
    r.runtime.hub.sweep()
    expect(r.runtime.store.getMeta(message.id).receipt).toBe('not_delivered')
    // the first socket sat through a 6-day clock jump; a fresh device learns from its ready
    const back = await k.connectedApp()
    expect(back.rec.of('ready', 'in')[0]?.not_delivered).toEqual([message.id])
    void app
  })

  it('one row that no longer decrypts does not stop retention or the other reports', async () => {
    const { c, r, app } = await world()
    const bad = await app.sendMessage('general', 'will be unreadable')
    const good = await app.sendMessage('general', 'still reportable')
    await waitFor(() => r.runtime.store.outboxDepth() === 2, 5000, 'queued')
    const row = r.runtime.store.db
      .prepare('select e.seq from core_events e join core_outbox o on o.seq = e.seq where o.frame_id = ?')
      .get(String(bad.id)) as { seq: number }
    r.runtime.store.db
      .prepare("update core_events set body = x'0102030405060708090a0b0c0d0e0f1011121314' where seq = ?")
      .run(row.seq)

    c.set(c.now() + 8 * DAY)
    expect(() => r.runtime.hub.sweep()).not.toThrow()
    expect(r.runtime.store.outboxDepth()).toBe(0)
    expect(r.runtime.store.db.prepare('select count(*) n from core_events where seq = ?').get(row.seq)).toEqual({
      n: 0,
    })
    const got = await app.expectFrame('receipt', (f) => f.message_id === good.client_msg_id, { direction: 'in' })
    expect(got.state).toBe('not_delivered')
  })
})

describe('a card decision the Mac took but never confirmed passing to the agent', () => {
  const HOUR = 3_600_000
  /**
   * A relay that knows the Mac confirms in two steps, and a card decision the Mac holds with its confirmation lost. The
   * card is decided two hours after it was made, and the relay then sweeps every hour, as it does in service.
   */
  async function takenDecision(
    decided: boolean,
    opts: { corrupt?: boolean; queueAfter?: boolean; days?: number; consume?: boolean } = {},
  ) {
    const { c, r, k, app } = await world()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
      .connect()
    const earlier = await app.sendMessage('general', 'pushed through')
    await bridge.expectFrame('message', (f) => f.id === earlier.id, { direction: 'in' })
    expect(bridge.consume(String(earlier.id))).toBe(true)
    await waitFor(() => r.runtime.store.outboxRow(String(earlier.id)) === undefined, 5000, 'earlier consumed')

    const card = bridge.createCard({ thread_id: 'general', title: 'Ship it?' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    c.set(c.now() + 2 * HOUR)
    const hash = payloadHash(bindingFrom(card))
    const sent = await app.resolveCard(card, 'primary', hash)
    await bridge.expectFrame('card.resolve', (f) => f.id === sent.id, { direction: 'in' })
    await waitFor(() => r.runtime.store.outboxRow(String(sent.id))?.delivered === 1, 5000, 'delivered, not consumed')
    if (decided) {
      bridge.send({
        type: 'card.update',
        card_id: card.id,
        state: 'resolved',
        resolution: { action: 'primary', at: new Date(c.now()).toISOString(), edited: false, payload_hash: hash },
      })
      await waitFor(() => r.runtime.store.getCard(card.id)?.resolution !== undefined, 5000, 'decided')
    }
    if (opts.consume) {
      expect(bridge.consume(String(sent.id))).toBe(true)
      await waitFor(() => r.runtime.store.outboxRow(String(sent.id)) === undefined, 5000, 'consumed')
    }
    await bridge.close() // the consumed confirmation never arrives, unless the test asked for it
    await waitFor(() => !r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')
    if (opts.corrupt)
      r.runtime.store.db
        .prepare("update core_cards set card = x'0102030405060708090a0b0c0d0e0f1011121314' where card_id = ?")
        .run(card.id)
    const later = opts.queueAfter ? await app.sendMessage('general', 'queued after the decision') : null
    if (later) await app.expectFrame('ack', (f) => f.ref === later.id) // queued for the Mac, which is gone
    const end = c.now() + (opts.days ?? 8) * DAY
    while (c.now() < end) {
      c.set(c.now() + HOUR)
      r.runtime.hub.sweep()
    }
    return { app, r, later, card }
  }
  const systemRows = (app: { rec: { of: (t: 'message.stored', d: 'in') => Array<{ message: { author: string } }> } }) =>
    app.rec.of('message.stored', 'in').filter((f) => f.message.author === 'system')

  it('is not called lost when the Mac did decide the card, however long after it was made', async () => {
    const { app, r } = await takenDecision(true)
    expect(r.runtime.store.outboxDepth()).toBe(0)
    app.send({ type: 'ping', nonce: 'caught-up' })
    await app.expectFrame('pong', (f) => f.nonce === 'caught-up') // frames arrive in order: a note would be here by now
    expect(systemRows(app)).toHaveLength(0)
  })

  it('a decided card is still swept after 7 days once its decision has been confirmed', async () => {
    const { r, card } = await takenDecision(true, { consume: true })
    expect(r.runtime.store.getCard(card.id)).toBeNull()
  })

  it('is called lost when the card was never decided', async () => {
    const { app } = await takenDecision(false)
    await waitFor(() => systemRows(app).length === 1, 5000, 'the note')
    expect((systemRows(app)[0] as unknown as { message: { text: string } }).message.text).toContain(
      'reached your Mac but never got to your agent',
    )
  })

  it('a card row that no longer opens counts as undecided and does not stop the reports after it', async () => {
    const { app, r, later } = await takenDecision(true, { corrupt: true, queueAfter: true })
    expect(r.runtime.store.outboxDepth()).toBe(0)
    const got = await app.expectFrame('receipt', (f) => f.message_id === later?.client_msg_id, { direction: 'in' })
    expect(got.state).toBe('not_delivered')
    await waitFor(() => systemRows(app).length === 1, 5000, 'the note for the card')
  })

  it('sends no day-6 warning for a card the Mac did decide, and one for a card it did not', async () => {
    const decided = await takenDecision(true, { days: 6 })
    expect(warnings(decided.r)).toHaveLength(0)
    await relay?.stop()
    relay = null
    const undecided = await takenDecision(false, { days: 6 })
    await waitFor(() => warnings(undecided.r).length === 1, 5000, 'the day-6 push')
  })
})

describe('the sweep and the day-6 warning read queued frames', () => {
  const HOUR = 3_600_000
  const BAD = "x'0102030405060708090a0b0c0d0e0f1011121314'"
  const corruptFrame = (r: TestRelay, frameId: string) =>
    r.runtime.store.db
      .prepare(`update core_events set body = ${BAD} where seq = (select seq from core_outbox where frame_id = ?)`)
      .run(frameId)

  /** Two cards with a long expiry, each decided three hours after it was made, with the Mac gone. */
  async function twoDecisions() {
    const { c, r, k, app } = await world()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
      .connect()
    const expires_at = new Date(c.now() + 30 * DAY).toISOString()
    const cards = [1, 2].map((n) => bridge.createCard({ thread_id: 'general', title: `Card ${n}`, expires_at }))
    for (const card of cards) await app.expectFrame('card.create', (f) => f.card.id === card.id)
    await bridge.close()
    await waitFor(() => !r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')
    c.set(c.now() + 3 * HOUR)
    const frames: string[] = []
    for (const card of cards) {
      const sent = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
      await app.expectFrame('ack', (f) => f.ref === sent.id)
      frames.push(String(sent.id))
    }
    return { c, r, app, cards, frames }
  }

  it('a queued decision that no longer opens does not stop the sweep from keeping the next card', async () => {
    const { c, r, cards, frames } = await twoDecisions()
    corruptFrame(r, frames[0] as string)
    c.set(c.now() + 7 * DAY - 2 * HOUR) // the cards are past 7 days old, the decisions (made 3 hours later) are not
    expect(() => r.runtime.hub.sweep()).not.toThrow()
    expect(r.runtime.store.getCard((cards[1] as { id: string }).id)).not.toBeNull()
  })

  it('the sweep opens only frames that decide a card', async () => {
    const { c, r, app } = await world()
    await app.sendMessage('general', 'a message waits too')
    await waitFor(() => r.runtime.store.outboxDepth() === 1, 5000, 'queued')
    const seen: string[] = []
    r.runtime.store.sweep({
      bufferMs: 7 * DAY,
      dedupMs: 8 * DAY,
      decisionCard: (type) => void seen.push(type) as undefined,
    })
    expect(seen).toEqual([])
    void c
  })

  it('a waiting frame that no longer opens still starts the day-6 warning, and the oldest one sets its time', async () => {
    const { c, r, app } = await world()
    const first = await app.sendMessage('general', 'first')
    await app.expectFrame('ack', (f) => f.ref === first.id)
    c.set(c.now() + HOUR)
    const second = await app.sendMessage('general', 'second')
    await app.expectFrame('ack', (f) => f.ref === second.id)
    const store = r.runtime.store
    const oldest = store.oldestUndeliveredOwner()
    // the oldest is the one with the earliest time, whichever row the database reads first
    store.db
      .prepare('update core_outbox set created_at = created_at + ? where frame_id = ?')
      .run(5 * HOUR, String(first.id))
    const later = (
      store.db.prepare('select created_at from core_outbox where frame_id = ?').get(String(second.id)) as {
        created_at: number
      }
    ).created_at
    expect(store.oldestUndeliveredOwner()).toBe(later)
    expect(store.oldestUndeliveredOwner(false, (_t, body) => (body as { text?: string }).text === 'second')).toBe(
      later + 4 * HOUR,
    )
    expect(oldest).toBeLessThan(later)
    // a row that does not open is not skipped
    corruptFrame(r, String(second.id))
    expect(store.oldestUndeliveredOwner(false, () => true)).toBe(later)
  })
})

describe('the dead-Mac report is made once per frame', () => {
  const sent = async (app: Awaited<ReturnType<typeof world>>['app'], text: string) => {
    const m = await app.sendMessage('general', text)
    await app.expectFrame('ack', (f) => f.ref === m.id)
    return m
  }
  const queuedRows = (r: TestRelay) =>
    (r.runtime.store.db.prepare('select count(*) n from core_outbox').get() as { n: number }).n

  it('a sweep that stops after the report leaves the frame queued, and the next sweep does not report it again', async () => {
    const { c, r, app } = await world()
    const m = await sent(app, 'are you there')
    c.set(c.now() + 8 * DAY)
    // The retention step is where a crash would land: the report has been made, the frame has not been deleted.
    vi.spyOn(r.runtime.store, 'sweep').mockImplementationOnce(() => {
      throw new Error('stopped between the report and the cleanup')
    })
    expect(() => r.runtime.hub.sweep()).toThrow('stopped between')
    expect(queuedRows(r)).toBe(1)
    await app.expectFrame('receipt', (f) => f.message_id === m.client_msg_id, { direction: 'in' })
    r.runtime.hub.sweep() // for real this time: the frame goes, and the mark keeps the report from repeating
    expect(queuedRows(r)).toBe(0)
    await sent(app, 'a later frame, so everything sent before it has arrived')
    expect(app.rec.of('receipt', 'in').filter((f) => f.state === 'not_delivered')).toHaveLength(1)
  })
})
