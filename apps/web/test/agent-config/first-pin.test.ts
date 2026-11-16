// @vitest-environment node
// The client hands the bridge's device.pinned `first` on (lib/firstPin.ts), whatever page is up, so
// first run happens even when the enroll page finished on /api/me and is gone. Only for this device, and only a yes.
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { onFirstPin } from '../../src/lib/firstPin.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { scriptedSockets } from '../helpers/scripted-socket.ts'

let c: SocketClient | null = null
let heard = 0
onFirstPin(() => {
  heard++
})
afterEach(() => {
  c?.close()
  c = null
  heard = 0
})

async function start() {
  const rig = scriptedSockets({})
  c = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://scripted.invalid/ws',
    WebSocketImpl: rig.Impl,
    isOnline: () => true,
  })
  const key = await c.ensureDevice()
  await c.start({ pinned: false })
  await waitFor(() => c?.store.getState().connection === 'online', 4000, 'online')
  return { rig, key, client: c }
}

describe('device.pinned first', () => {
  it('set by a pin of this device that says first', async () => {
    const { rig, key, client } = await start()
    rig.push(mkFrame('device.pinned', { device_id: key.deviceId, ok: true, first: true }))
    await waitFor(() => heard === 1, 2000, 'first handed on')
    expect(client.store.getState().devicePinned).toBe(true)
  })
  it('not by a pin without first, a refusal, or another device', async () => {
    const { rig, key, client } = await start()
    rig.push(mkFrame('device.pinned', { device_id: 'd_aaaaaaaaaaaaaaaaaaaa', ok: true, first: true }))
    rig.push(mkFrame('device.pinned', { device_id: key.deviceId, ok: false, reason: 'declined', first: true }))
    rig.push(mkFrame('device.pinned', { device_id: key.deviceId, ok: true }))
    await waitFor(() => client.store.getState().devicePinned, 2000, 'pinned')
    expect(heard).toBe(0)
  })
})
