// @vitest-environment node
// The delivery family (src/lib/socket-frames-delivery.ts): the device pin, acks and errors still act on the client.
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
})
