// @vitest-environment jsdom
// The real App and Gate. The relay closes the live socket with 4401 and says why; only a session that ran out of time, was
// signed in again, or a tab holding an old device key keeps what the owner had queued. Revoked, signed out everywhere, or no reason (an older relay) empties the queue, queued voice notes included.

import { FakeRelay, NodeWebSocket } from '@talos-app/testkit'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

let relay: FakeRelay
beforeEach(async () => {
  vi.resetModules()
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
  window.history.pushState({}, '', '/')
  relay = await new FakeRelay().start()
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  await relay.stop()
})

async function liveApp(opts: { meReason?: string } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      opts.meReason !== undefined && String(url).endsWith('/api/me')
        ? Response.json({ error: 'unauthorized', reason: opts.meReason }, { status: 401 })
        : Response.json({ signed_in: true, device_pinned: true }),
    ),
  )
  const { App } = await import('../src/App.tsx')
  const { createSocketClient } = await import('../src/lib/socketClient.ts')
  const { createMemoryStorage } = await import('../src/lib/storage.ts')
  const storage = createMemoryStorage()
  const client = createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
    // jsdom's own WebSocket cannot be used against the node test server; the client takes any implementation
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
  })
  await client.ensureDevice()
  // one message and one voice note are already waiting on this device
  await storage.put('outbox', '01JZ0000000000000000000001', {
    id: '01JZ0000000000000000000001',
    order: 1,
    kind: 'message',
    clientMsgId: 'm_01JZ0000000000000000000001',
    threadId: 'general',
    bytes: '{}',
  })
  await storage.put('blobs', 'm_01JZ0000000000000000000002', {
    clientMsgId: 'm_01JZ0000000000000000000002',
    threadId: 'general',
    mime: 'audio/webm',
    name: 'v.webm',
    blob: new Blob(['abc']),
    order: 2,
  })
  const close = vi.spyOn(client, 'close')
  render(<App client={client} storage={storage} />)
  if (opts.meReason === undefined)
    await waitFor(() => expect(client.store.getState().connection).toBe('online'), { timeout: 10_000 })
  return { client, storage, close }
}

const counts = async (s: { all: (n: 'outbox' | 'blobs') => Promise<unknown[]> }) => ({
  outbox: (await s.all('outbox')).length,
  blobs: (await s.all('blobs')).length,
})

describe('the Gate on a 4401 close', () => {
  it('expired: the queue stays, the cached chats go', async () => {
    const { storage } = await liveApp()
    await storage.put('cache', 'snapshot', { messages: { general: [{ text: 'cached' }] } })
    relay.closeApps(4401, 'expired')
    await waitFor(() => expect(window.location.pathname).toBe('/login'), { timeout: 10_000 })
    await waitFor(async () => expect((await storage.all('cache')).length).toBe(0))
    expect(await counts(storage)).toEqual({ outbox: 1, blobs: 1 })
  })

  // This tab held a device key the owner has since replaced, or this browser has just signed in over its session. The storage
  // it shares belongs to the tab that did that, so the chats, drafts and schedules in it are that tab's: this tab leaves
  // without touching them.
  it.each([['device_changed'], ['signed_in_again']])(
    'closed with reason %j: the queue, chats, drafts and schedules stay',
    async (reason) => {
      const { storage } = await liveApp()
      await storage.put('cache', 'snapshot', { messages: { general: [{ text: 'cached' }] } })
      await storage.put('drafts', 'general', 'half a thought')
      await storage.put('schedules', 's1', { id: 's1' })
      relay.closeApps(4401, reason)
      await waitFor(() => expect(window.location.pathname).toBe('/login'), { timeout: 10_000 })
      expect(await storage.get('cache', 'snapshot')).toBeDefined()
      expect(await storage.get('drafts', 'general')).toBe('half a thought')
      expect((await storage.all('schedules')).length).toBe(1)
      expect(await counts(storage)).toEqual({ outbox: 1, blobs: 1 })
      expect(window.localStorage.getItem('talos-app:wipe-pending')).toBeNull()
    },
  )

  it.each([['revoked'], ['logged_out_everywhere'], ['logged_out'], ['']])(
    'closed with reason %j: the queue and the voice notes are wiped too',
    async (reason) => {
      const { storage } = await liveApp()
      relay.closeApps(4401, reason)
      await waitFor(() => expect(window.location.pathname).toBe('/login'), { timeout: 10_000 })
      await waitFor(async () => expect(await counts(storage)).toEqual({ outbox: 0, blobs: 0 }), { timeout: 10_000 })
    },
  )
})

// What the client is told when it is stopped matters for a write that is in flight at that moment: an expired session
// keeps the one copy, anything else takes it back out. These pin the two places the Gate stops the client.
describe('what the Gate tells the client when it stops it', () => {
  it.each([
    ['expired', true],
    ['revoked', false],
    ['', false],
  ])('a 4401 close with reason %j: keepQueue is %s', async (reason, keep) => {
    const { close } = await liveApp()
    relay.closeApps(4401, reason)
    await waitFor(() => expect(window.location.pathname).toBe('/login'), { timeout: 10_000 })
    expect(close).toHaveBeenCalledWith({ keepQueue: keep })
    expect(close).not.toHaveBeenCalledWith({ keepQueue: !keep })
  })

  it.each([
    ['expired', true],
    ['revoked', false],
  ])('a 401 on /api/me at open, reason %j: keepQueue is %s', async (reason, keep) => {
    const { close } = await liveApp({ meReason: reason })
    await waitFor(() => expect(window.location.pathname).toBe('/login'), { timeout: 10_000 })
    expect(close).toHaveBeenCalledWith({ keepQueue: keep })
    expect(close).not.toHaveBeenCalledWith({ keepQueue: !keep })
  })
})
