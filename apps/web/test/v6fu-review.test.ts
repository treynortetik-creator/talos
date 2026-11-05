// @vitest-environment node
// Review of PR #100 (v6 follow-ups), the socket client against FakeRelay + FakeBridge: signed media.fetch, the clamped
// relay clock, and history pages nobody asked for.
import { type MessageT, newId, newUlid, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay | undefined
let bridge: FakeBridge | undefined
let client: SocketClient | undefined
afterEach(async () => {
  client?.close()
  await bridge?.close()
  await relay?.stop()
})

async function start(now: () => number = Date.now) {
  relay = await new FakeRelay().start()
  bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, features: ['search/1'] }).connect()
  const c = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
    now,
  })
  client = c
  await c.ensureDevice()
  await c.start({ pinned: true })
  await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
  await waitFor(() => c.store.getState().presence.bridge_online, 4000, 'bridge online')
  return c
}

const fromApp = (type: string) =>
  (relay as FakeRelay).frames.filter((f) => f.direction === 'from_app' && f.raw.type === type).map((f) => f.raw)

const msg = (thread: string, text: string): MessageT => ({
  id: newId('m'),
  thread_id: thread,
  author: 'agent',
  kind: 'text',
  text,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date().toISOString(),
  seq: 5,
})

describe('media.fetch is signed by the device key (finding 1)', () => {
  it('goes out with device_id and an osig that verifies, and the Mac refusal shows no "security check" row', async () => {
    const c = await start()
    const key = await c.deviceKey()
    if (!key) throw new Error('no key')
    const mediaId = newId('md')
    c.fetchMedia(mediaId)
    await waitFor(() => fromApp('media.fetch').length === 1, 3000, 'media.fetch')
    const raw = fromApp('media.fetch')[0] as Record<string, unknown>
    expect(raw.media_id).toBe(mediaId)
    expect(raw.device_id).toBe(key.deviceId)
    expect(await verifyOwnerFrame(raw, key.publicJwk)).toBe(true)
    // the Mac says no (an old Mac, or a clock problem): the owner sees no alarm row for it
    const before = JSON.stringify(c.store.getState().messages)
    ;(relay as FakeRelay).sendToApps(
      mkFrame('error', { ref: raw.id, code: 'sig_invalid', message: 'signature check failed' }) as never,
    )
    await sleep(200)
    expect(JSON.stringify(c.store.getState().messages)).toBe(before)
  })

  it('does nothing while the device is not pinned (nothing the Mac would accept can be signed)', async () => {
    relay = await new FakeRelay().start()
    const c = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
    })
    client = c
    await c.ensureDevice()
    await c.start({ pinned: false })
    await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
    c.fetchMedia(newId('md'))
    await sleep(300)
    expect(fromApp('media.fetch')).toHaveLength(0)
  })
})

describe('media.fetch asked before the socket is ready is sent when it is (not silently dropped)', () => {
  it('an ask made right after start(), before the ready frame, goes out once the connection is up', async () => {
    relay = await new FakeRelay().start()
    const c = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
    })
    client = c
    await c.ensureDevice()
    await c.start({ pinned: true })
    const mediaId = newId('md')
    c.fetchMedia(mediaId) // a cached chip mounted and probed before the socket finished connecting
    expect(c.store.getState().connection).not.toBe('online')
    await waitFor(() => fromApp('media.fetch').length === 1, 4000, 'media.fetch after ready')
    expect((fromApp('media.fetch')[0] as Record<string, unknown>).media_id).toBe(mediaId)
    await sleep(150)
    expect(fromApp('media.fetch')).toHaveLength(1) // sent once, not on every later frame
  })

  it('an ask made before the device is pinned is sent when it is pinned', async () => {
    relay = await new FakeRelay().start()
    const c = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
    })
    client = c
    await c.ensureDevice()
    await c.start({ pinned: false })
    await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
    const mediaId = newId('md')
    c.fetchMedia(mediaId)
    await sleep(200)
    expect(fromApp('media.fetch')).toHaveLength(0)
    c.setPinned(true)
    await waitFor(() => fromApp('media.fetch').length === 1, 4000, 'media.fetch after pin')
  })
})

describe('the relay clock moves our signatures by at most an hour (finding 4)', () => {
  it('a phone 30 days behind the relay signs within an hour of its own clock, not 30 days ahead of it', async () => {
    const skew = -30 * 86_400_000
    const phoneNow = () => Date.now() + skew
    const c = await start(phoneNow)
    void c.loadHistory('general', 5).catch(() => {})
    await waitFor(() => fromApp('history.request').length === 1, 3000, 'history.request')
    const raw = fromApp('history.request')[0] as Record<string, unknown>
    expect(Math.abs(Date.parse(String(raw.ts)) - phoneNow())).toBeLessThanOrEqual(3600_000 + 10_000)
  })

  it('a small honest skew (6 minutes) is still fully corrected', async () => {
    const c = await start(() => Date.now() - 6 * 60_000)
    void c.loadHistory('general', 5).catch(() => {})
    await waitFor(() => fromApp('history.request').length === 1, 3000, 'history.request')
    const raw = fromApp('history.request')[0] as Record<string, unknown>
    expect(Math.abs(Date.parse(String(raw.ts)) - Date.now())).toBeLessThan(10_000)
  })
})

describe('a history.page nobody asked for is dropped (finding 6)', () => {
  it('an unsolicited page does not rewrite a cached row or add an owner row', async () => {
    const c = await start()
    const real = msg('general', 'what the agent really said')
    ;(relay as FakeRelay).sendToApps(mkFrame('reply', { message: real }) as never)
    await waitFor(() => (c.store.getState().messages.general ?? []).some((m) => m.id === real.id), 3000, 'cached')
    const forged = [
      { ...real, text: 'REWRITTEN BY RELAY' },
      { ...msg('general', 'I approve wiring the money'), author: 'owner' as const },
    ]
    ;(relay as FakeRelay).sendToApps(
      mkFrame('history.page', {
        request_id: newUlid(),
        thread_id: 'general',
        messages: forged,
        has_more: false,
      }) as never,
    )
    await sleep(300)
    const text = JSON.stringify(c.store.getState().messages.general)
    expect(text).toContain('what the agent really said')
    expect(text).not.toContain('REWRITTEN')
    expect(text).not.toContain('wiring the money')
  })

  it('an answer to our request is merged, but only its own thread rows', async () => {
    const c = await start()
    const p = c.loadHistory('general', 5)
    const req = await (bridge as FakeBridge).expectFrame('history.request', () => true, { direction: 'in' })
    const mine = msg('general', 'legit older row')
    const stray = msg('work', 'row from another thread')
    ;(bridge as FakeBridge).send(
      mkFrame('history.page', {
        request_id: req.request_id,
        thread_id: 'general',
        messages: [mine, stray],
        has_more: false,
      }) as never,
    )
    await p
    expect(JSON.stringify(c.store.getState().messages.general)).toContain('legit older row')
    expect(JSON.stringify(c.store.getState().messages.work ?? [])).not.toContain('another thread')
  })

  it('a page for our request id but another thread is dropped whole', async () => {
    const c = await start()
    const p = c.loadHistory('general', 5).catch((e: Error) => e)
    const req = await (bridge as FakeBridge).expectFrame('history.request', () => true, { direction: 'in' })
    ;(bridge as FakeBridge).send(
      mkFrame('history.page', {
        request_id: req.request_id,
        thread_id: 'work',
        messages: [msg('work', 'wrong thread page')],
        has_more: false,
      }) as never,
    )
    await sleep(300)
    expect(JSON.stringify(c.store.getState().messages.work ?? [])).not.toContain('wrong thread page')
    // the right page still completes the wait
    ;(bridge as FakeBridge).send(
      mkFrame('history.page', {
        request_id: req.request_id,
        thread_id: 'general',
        messages: [],
        has_more: false,
      }) as never,
    )
    expect(await p).toEqual({ hasMore: false })
  })
})
