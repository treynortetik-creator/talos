// @vitest-environment node
// The delivery family (src/lib/socket-frames-delivery.ts): the device pin, acks and errors still act on the client.
import { refusedMessageNote, refusedMessageNoteId } from '@talos-app/protocol'
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectedRig, type Rig } from './helpers/socket-frames.ts'

let rig: Rig
beforeEach(async () => {
  rig = await connectedRig()
})
afterEach(async () => {
  await rig.stop()
})

describe('delivery frames', () => {
  it('device.pinned for this device sets the pin, and one for another device is ignored', async () => {
    const mine = rig.client.store.getState().deviceId as string
    expect(rig.client.store.getState().devicePinned).toBe(true)
    rig.relay.sendToApps(mkFrame('device.pinned', { device_id: 'd_aaaaaaaaaaaaaaaaaaaa', ok: false }))
    rig.relay.sendToApps(mkFrame('device.pinned', { device_id: mine, ok: false }))
    await waitFor(() => rig.client.store.getState().devicePinned === false, 2000, 'unpinned')
    rig.relay.sendToApps(mkFrame('device.pinned', { device_id: mine, ok: true }))
    await waitFor(() => rig.client.store.getState().devicePinned === true, 2000, 'pinned')
  })

  it('an error with no ref and device_not_pinned clears the pin; sig_invalid adds a system row', async () => {
    rig.relay.sendToApps(mkFrame('error', { code: 'sig_invalid', message: 'bad' }))
    await waitFor(() => Object.values(rig.client.store.getState().messages).flat().length === 1, 2000, 'row')
    expect(Object.values(rig.client.store.getState().messages).flat()[0]).toMatchObject({
      author: 'system',
      text: 'A message failed its security check and was dropped.',
    })
    rig.relay.sendToApps(mkFrame('error', { code: 'device_not_pinned', message: 'wait' }))
    await waitFor(() => rig.client.store.getState().devicePinned === false, 2000, 'unpinned')
  })

  it('an ack for an unknown ref is harmless, and an error the client asked about reaches its listener', async () => {
    const heard: unknown[] = []
    rig.client.onFrame('error', (f) => heard.push(f))
    rig.relay.sendToApps(mkFrame('ack', { ref: '01J00000000000000000000000', seq: 5 }))
    rig.relay.sendToApps(mkFrame('error', { code: 'rate_limited', message: 'slow down' }))
    await waitFor(() => heard.length === 1, 2000, 'dispatch emits the error')
    expect(rig.client.store.getState().lastSeq).toBe(0) // an ack never moves lastSeq
  })

  describe('a message the Mac refuses after the relay acked it', () => {
    const rows = () => rig.client.store.getState().messages.general ?? []
    const systemRows = () => rows().filter((m) => m.author === 'system')

    /** Sends one message and waits until the relay has acked it, so the app no longer holds its signed frame. */
    async function ackedMessage() {
      await rig.client.sendMessage({ threadId: 'general', text: 'Draft the release notes' })
      await waitFor(() => rows().some((m) => m.author === 'owner' && m.receipt === 'sent'), 2000, 'sent')
      await waitFor(() => rig.client.meta.getState().queuedIds.length === 0, 2000, 'acked and out of the queue')
      const frame = rig.relay.frames.find((f) => f.direction === 'from_app' && f.raw.type === 'message')?.raw
      return { frameId: String(frame?.id), msgId: String(frame?.client_msg_id) }
    }

    it('from a relay that only passes the error on: the row is marked not delivered and the reason is in the thread', async () => {
      const { frameId, msgId } = await ackedMessage()
      const error = mkFrame('error', { ref: frameId, code: 'bad_frame', message: 'unknown thread general' })
      rig.relay.sendToApps(error)
      await waitFor(() => rows().find((m) => m.id === msgId)?.receipt === 'not_delivered', 2000, 'row marked')
      expect(systemRows().map((m) => m.text)).toEqual([refusedMessageNote('bad_frame', 'unknown thread general')])
      expect(systemRows()[0]?.id).toBe(refusedMessageNoteId(String(error.id)))
      // a late "delivered" for it (an old receipt in a catch-up) must not turn the row back
      rig.relay.sendToApps(
        mkFrame('message.stored', { client_msg_id: msgId, message: rows().find((m) => m.id === msgId) }),
      )
      await new Promise((r) => setTimeout(r, 30))
      expect(rows().find((m) => m.id === msgId)?.receipt).toBe('not_delivered')
    })

    it('from a relay that also stores the refusal: still one note, whichever of the two arrives first', async () => {
      const { frameId, msgId } = await ackedMessage()
      const error = mkFrame('error', { ref: frameId, code: 'stale', message: 'Your phone clock is off.' })
      const note = {
        id: refusedMessageNoteId(String(error.id)),
        thread_id: 'general',
        author: 'system',
        kind: 'text',
        text: refusedMessageNote('stale', 'Your phone clock is off.'),
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date().toISOString(),
      }
      rig.relay.sendToApps(mkFrame('receipt', { message_id: msgId, state: 'not_delivered' }))
      rig.relay.sendToApps({
        ...mkFrame('message.stored', { client_msg_id: note.id, message: note }),
        relay: { seq: 9, received_at: note.created_at },
      })
      rig.relay.sendToApps(error)
      await waitFor(() => rows().find((m) => m.id === msgId)?.receipt === 'not_delivered', 2000, 'row marked')
      await new Promise((r) => setTimeout(r, 30))
      expect(systemRows()).toHaveLength(1)
    })

    it('an error for a frame this device never sent as a message changes no row', async () => {
      const { msgId } = await ackedMessage()
      rig.relay.sendToApps(mkFrame('error', { ref: '01J00000000000000000000000', code: 'bad_frame', message: 'nope' }))
      await new Promise((r) => setTimeout(r, 30))
      expect(rows().find((m) => m.id === msgId)?.receipt).toBe('sent')
      expect(systemRows()).toHaveLength(0)
    })
  })
})
