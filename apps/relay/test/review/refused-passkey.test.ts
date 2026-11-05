// Bughunt B: when the Mac refuses a device, the passkey that device registered must stop working, or a stranger who saw
// one enrollment link can sign in again whenever they like.
import { sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let rr: RealRelay | null = null
afterEach(async () => {
  await rr?.stop()
  rr = null
})

describe('a device the Mac declines', () => {
  it('loses its passkey (no new sign-in) and stays unpinned; the owner is untouched', async () => {
    rr = await startRealRelay()
    const owner = await rr.owner({ credentialId: 'cred-owner' })
    const stranger = await rr.owner({ pinned: false, credentialId: 'cred-stranger' })
    const bridge = await rr.bridge().connect()
    bridge.send({ type: 'device.pinned', device_id: stranger.device.deviceId, ok: false, reason: 'declined' })
    await waitFor(() => rr?.auth.core.credential('cred-stranger') === null, 4000, 'the declined passkey removed')
    expect(rr.auth.core.credential('cred-stranger')).toBeNull()
    const me = await fetch(`${rr.httpBase}/api/me`, { headers: { Cookie: stranger.cookie } })
    expect(((await me.json()) as { device_pinned: boolean }).device_pinned).toBe(false)
    expect((await rr.post('/api/auth/logout-all', {}, stranger)).status).toBe(403)
    expect(rr.auth.core.credential('cred-owner')).not.toBeNull()
    expect((await fetch(`${rr.httpBase}/api/me`, { headers: { Cookie: owner.cookie } })).status).toBe(200)
  })

  it('a passkey that still has a pinned device is kept', async () => {
    rr = await startRealRelay()
    const a = await rr.owner({ credentialId: 'cred-shared' })
    const b = await rr.owner({ pinned: false, credentialId: 'cred-shared' })
    const bridge = await rr.bridge().connect()
    bridge.send({ type: 'device.pinned', device_id: b.device.deviceId, ok: false, reason: 'declined' })
    await sleep(300)
    expect(rr.auth.core.credential('cred-shared')).not.toBeNull()
    expect((await fetch(`${rr.httpBase}/api/me`, { headers: { Cookie: a.cookie } })).status).toBe(200)
  })

  it('a device that was pinned before and is declined on a repeat enrollment keeps the passkey', async () => {
    rr = await startRealRelay()
    const a = await rr.owner({ credentialId: 'cred-solo' })
    // the repeat enrollment resets the pin (upsertDevice), then the Mac answers N
    rr.auth.core.setPinned(a.device.deviceId, false)
    const bridge = await rr.bridge().connect()
    bridge.send({ type: 'device.pinned', device_id: a.device.deviceId, ok: false, reason: 'declined' })
    await sleep(300)
    expect(rr.auth.core.credential('cred-solo')).not.toBeNull()
  })
})
