import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { newId, newUlid } from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(100_000))

let h: Harness
afterEach(async () => h?.stop())

type Store = { kvSet: (k: string, v: string) => void; markSeen: (id: string, at: number, outcome?: string) => void }
const store = () => h.bridge.ctx.store as unknown as Store & { hasSeen(id: string): boolean }
const copies = (text: string) => h.notes.filter((n) => n.content.includes(text))

/** The next `n` calls of store.markSeen throw, as a locked or full database does. */
const failMarkSeen = (n: number) => {
  const s = store()
  const real = s.markSeen.bind(s)
  let left = n
  s.markSeen = (id, at, outcome) => {
    if (left > 0) {
      left--
      throw new Error('database is locked')
    }
    return real(id, at, outcome)
  }
  return () => n - left
}

describe('after the hand-over to the agent', () => {
  test('a throw while keeping the last-word time does not skip the delivered receipt, the unseen record or the seen mark', async () => {
    h = await startHarness()
    const s = store()
    const real = s.kvSet.bind(s)
    s.kvSet = (k, v) => {
      if (k === 'last_owner_ts') throw new Error('database is locked')
      return real(k, v)
    }
    const sent = await h.app.sendMessage('general', 'receipt please')
    await h.relay.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'delivered', {
      direction: 'from_bridge',
    })
    await h.relay.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'consumed', { direction: 'from_bridge' })
    expect(s.hasSeen(sent.client_msg_id)).toBe(true)
    expect(s.hasSeen(sent.id)).toBe(true)
    expect(h.bridge.ctx.seen.unseenIds()).toContain(sent.client_msg_id)
    // item 4: once the store has the ids, nothing is kept in the in-memory note
    expect(h.bridge.inbound?.handedOverCount).toBe(0)
  })

  test('a replay found in the in-memory note marks the frame id and the message id seen, and clears the note', async () => {
    h = await startHarness()
    const thrown = failMarkSeen(1)
    const sent = await h.app.sendMessage('general', 'both ids')
    await waitFor(() => thrown() === 1, 4000, 'the failed mark')
    expect(copies('both ids')).toHaveLength(1)
    expect(h.bridge.inbound?.handedOverCount).toBeGreaterThan(0)
    h.relay.dropBridge()
    await h.relay.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'consumed', { direction: 'from_bridge' })
    await sleep(t(300))
    expect(copies('both ids')).toHaveLength(1)
    expect(store().hasSeen(sent.id)).toBe(true)
    expect(store().hasSeen(sent.client_msg_id)).toBe(true)
    expect(h.bridge.inbound?.handedOverCount).toBe(0)
  })

  test('a message handed over, then re-signed under a new frame id inside a stale burst, is not handed over again', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ startBridge: false, clock })
    const old = new Date(clock.now() - 20 * 60_000).toISOString()
    // handed over in this process, its store write failed: only the in-memory note knows
    const handed = await h.app.buildMessage('general', 'already handed over')
    h.bridge.inbound?.noteHandedOver([String(handed.id), handed.client_msg_id])
    const again = await h.app.buildMessage('general', 'already handed over', { client_msg_id: handed.client_msg_id })
    const other = await h.app.buildMessage('general', 'a different stale one')
    const sentAgain = h.relay.sendToBridge({ ...again, relay: { seq: 1, received_at: old } })
    const sentOther = h.relay.sendToBridge({ ...other, relay: { seq: 2, received_at: old } })
    h.bridge.start()
    for (const id of [sentAgain.id, sentOther.id])
      await h.relay.expectFrame('ack', (a) => a.ref === id && a.stage === 'delivered', { direction: 'from_bridge' })
    clock.advance(1000)
    await h.bridge.inbound?.idle()
    await h.waitNotes(1)
    expect(copies('a different stale one')).toHaveLength(1)
    expect(copies('already handed over')).toHaveLength(0)
  })

  test('a share handed over, whose store write then fails, is not handed over again on the replay', async () => {
    h = await startHarness()
    const thrown = failMarkSeen(1)
    const share = {
      type: 'share.item',
      share_id: newUlid(),
      token_id: `sh_${newUlid()}`,
      token_label: 'iPhone',
      message: {
        id: newId('m'),
        thread_id: 'inbox',
        author: 'owner',
        kind: 'text',
        text: 'save this once',
        format: 'plain',
        attachments: [],
        via: 'share',
        created_at: new Date().toISOString(),
        share_content: { url: 'https://example.com/a', title: 'A page', text: 'shared body' },
      },
    }
    const sent = h.relay.sendToBridge(share)
    await waitFor(() => thrown() === 1, 4000, 'the failed mark')
    expect(copies('example.com/a')).toHaveLength(1)
    h.relay.dropBridge()
    await waitFor(
      () => h.relay.frames.filter((r) => r.direction === 'to_bridge' && r.raw.id === sent.id).length >= 2,
      4000,
      'the replay',
    )
    await h.bridge.inbound?.idle()
    await sleep(t(300))
    expect(copies('example.com/a')).toHaveLength(1)
  })
})
