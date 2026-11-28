// A reply pushes to the phone's browser, with words, while a Mac window is open: the real relay (real auth, hub and routes), a
// browser subscribed over HTTP, an app socket that says it is visible, and a fake bridge that replies.
import { t, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: t(90_000) })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

describe('a reply reaches the phone while the Mac app is open', () => {
  it('a visible, active app socket does not stop the browser push, and the push has the thread name and the words', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const subscribed = await r.post(
      '/api/push/subscribe',
      { endpoint: 'https://push.example.com/send/phone', keys: { p256dh: 'p256dh-key', auth: 'auth-key' } },
      owner,
    )
    expect(subscribed.status).toBe(204)
    const mac = r.app(owner, { visible: true })
    await mac.connect()
    const bridge = r.bridge()
    await bridge.connect()
    await waitFor(() => r?.runtime.hub.anyVisible() === true, 10_000, 'the Mac window counts as visible')
    bridge.reply('general', 'The report is ready for you.')
    await mac.expectFrame('reply')
    await waitFor(() => (r?.transport.sent.length ?? 0) >= 1, 10_000, 'the push')
    expect(r.transport.sent[0]?.endpoint).toBe('https://push.example.com/send/phone')
    expect(r.transport.sent[0]?.payload.notification).toMatchObject({
      title: 'General',
      body: 'The report is ready for you.',
      navigate: '/t/general',
    })
    expect(r.transport.sent[0]?.payload.talos).toMatchObject({ kind: 'reply', thread_id: 'general' })
  })
})
