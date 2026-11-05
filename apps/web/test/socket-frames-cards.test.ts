// @vitest-environment node
// The cards family (src/lib/socket-frames-cards.ts): cards, MCP app views and the inbox still reach the store as before.
import { newId } from '@talos-app/protocol'
import { buildCard, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AT, connectedRig, type Rig, STAMP } from './helpers/socket-frames.ts'

let rig: Rig
beforeEach(async () => {
  rig = await connectedRig()
})
afterEach(async () => {
  await rig.stop()
})

const inboxItem = (id: string) => ({
  id,
  source: 'generic',
  connection: 'cn_aaaaaaaaaaaaaaaaaaaaaa',
  kind: 'generic.note',
  title: 'A note',
  summary: 'Something happened',
  actor: {},
  ts: AT,
  thread: 'general',
  work: false,
  priority: 'normal',
  state: 'new',
})

describe('cards frames', () => {
  it('card.create adds the card and card.update changes its state and moves lastSeq', async () => {
    const card = buildCard({ thread_id: 'general' })
    rig.relay.sendToApps(mkFrame('card.create', { card, ...STAMP(5) }))
    await waitFor(() => rig.client.store.getState().cards.length === 1, 2000, 'card')
    rig.relay.sendToApps(mkFrame('card.update', { card_id: card.id, state: 'done', ...STAMP(6) }))
    await waitFor(() => rig.client.store.getState().cards[0]?.state === 'done', 2000, 'done')
    expect(rig.client.store.getState().lastSeq).toBe(6)
  })

  it('a live inbox.item is listed and counted unread once, and inbox.update changes it', async () => {
    const id = newId('e')
    rig.relay.sendToApps(mkFrame('inbox.item', { item: inboxItem(id), ...STAMP(2) }))
    await waitFor(() => rig.client.store.getState().inbox.length === 1, 2000, 'item')
    expect(rig.client.store.getState().unread.general).toBe(1)
    rig.relay.sendToApps(mkFrame('inbox.item', { item: inboxItem(id), ...STAMP(3) })) // the same item again: not new
    rig.relay.sendToApps(mkFrame('inbox.update', { event_id: id, state: 'done', priority: 'high', ...STAMP(4) }))
    await waitFor(() => rig.client.store.getState().inbox[0]?.state === 'done', 2000, 'updated')
    const s = rig.client.store.getState()
    expect(s.inbox).toHaveLength(1)
    expect(s.inbox[0]?.priority).toBe('high')
    expect(s.unread.general).toBe(1)
  })

  it('app.update records the state of a view', async () => {
    const view = `av_${'0'.repeat(26)}`
    rig.relay.sendToApps(
      mkFrame('app.update', { view_id: view, thread_id: 'general', state: 'closed', reason: 'done here', ...STAMP(8) }),
    )
    await waitFor(() => rig.client.store.getState().appStates[view] !== undefined, 2000, 'view state')
    expect(rig.client.store.getState().appStates[view]).toEqual({ state: 'closed', reason: 'done here' })
    expect(rig.client.store.getState().lastSeq).toBe(8)
  })
})
