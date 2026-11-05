// @vitest-environment node
// The chat family (src/lib/socket-frames-chat.ts): a frame of each kind still reaches the store the way it did when the
// handlers lived inside createSocketClient.
import { newId } from '@talos-app/protocol'
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AT, connectedRig, type Rig, STAMP } from './helpers/socket-frames.ts'

let rig: Rig
beforeEach(async () => {
  rig = await connectedRig()
})
afterEach(async () => {
  await rig.stop()
})

const agentRow = (id: string, text: string) => ({
  id,
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: AT,
})

describe('chat frames', () => {
  it('a live reply is added to its thread, moves lastSeq and counts as unread', async () => {
    const id = newId('m')
    rig.relay.sendToApps(mkFrame('reply', { message: agentRow(id, 'hello'), ...STAMP(7) }))
    await waitFor(() => rig.client.store.getState().messages.general?.length === 1, 2000, 'reply')
    const s = rig.client.store.getState()
    expect(s.messages.general?.[0]).toMatchObject({ id, text: 'hello', seq: 7 })
    expect(s.lastSeq).toBe(7)
    expect(s.unread.general).toBe(1)
  })

  it('a transcript fills in the voice note it names, and a not_delivered receipt marks the row', async () => {
    const id = newId('m')
    rig.relay.sendToApps(
      mkFrame('reply', { message: { ...agentRow(id, 'x'), author: 'owner', kind: 'voice_note' }, ...STAMP(3) }),
    )
    await waitFor(() => rig.client.store.getState().messages.general?.length === 1, 2000, 'row')
    rig.relay.sendToApps(
      mkFrame('transcript', { message_id: id, text: 'said this', engine: 'test', status: 'done', ...STAMP(4) }),
    )
    rig.relay.sendToApps(mkFrame('receipt', { message_id: id, state: 'not_delivered' }))
    await waitFor(() => rig.client.store.getState().messages.general?.[0]?.receipt === 'not_delivered', 2000, 'receipt')
    const row = rig.client.store.getState().messages.general?.[0]
    expect(row?.transcript).toEqual({ text: 'said this', engine: 'test', status: 'done' })
    expect(rig.client.store.getState().lastSeq).toBe(4)
  })

  it('message.stored keeps a not_delivered mark the receipt set earlier', async () => {
    const id = newId('m')
    rig.relay.sendToApps(mkFrame('receipt', { message_id: id, state: 'not_delivered' }))
    rig.relay.sendToApps(
      mkFrame('message.stored', { client_msg_id: id, message: { ...agentRow(id, 'mine'), author: 'owner', seq: 9 } }),
    )
    await waitFor(() => rig.client.store.getState().messages.general?.length === 1, 2000, 'stored')
    expect(rig.client.store.getState().messages.general?.[0]?.receipt).toBe('not_delivered')
    expect(rig.client.store.getState().lastSeq).toBe(9)
  })
})
