// @vitest-environment node
// What the owner already sent but nothing has delivered yet survives a session expiry and goes out after sign-in, once
// each and in typed order. Sign-out and revoke still empty everything, and a different identity never inherits the queue.
// The real client and the real session code run against FakeRelay; only the network is switched.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLocalData, useSession } from '../src/features/auth/session.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

let relay: FakeRelay
let storage: Storage
let online = false
let client: SocketClient

const make = () =>
  createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => online,
    // media uploads go to the fake relay's own HTTP side
    fetchImpl: ((url: string, init?: RequestInit) => fetch(`${relay.httpUrl}${url}`, init)) as typeof fetch,
  })

beforeEach(async () => {
  relay = await new FakeRelay().start()
  storage = createMemoryStorage()
  online = false
  useSession.setState({ status: 'authed', me: null, offline: false })
  client = make()
  await client.ensureDevice()
  await client.start({ pinned: true })
})
afterEach(async () => {
  client.close()
  vi.unstubAllGlobals()
  await relay.stop()
})

const owned = () =>
  relay.frames.filter((f) => f.direction === 'from_app' && (f.raw.type === 'message' || f.raw.type === 'voice_note'))
const sentSummary = () => owned().map((f) => (f.raw.type === 'message' ? String(f.raw.text) : 'voice'))

async function queueThree() {
  await client.sendMessage({ threadId: 'general', text: 'first' })
  await client.queueVoiceNote({
    threadId: 'general',
    blob: new Blob(['abc'], { type: 'audio/webm' }),
    name: 'v.webm',
  })
  await client.sendMessage({ threadId: 'general', text: 'third' })
  expect(client.outboxSize()).toBe(3)
}

/** The app opened with an expired cookie: /api/me says 401, and the session code stops the client first. */
async function expireSession(reason: string | null = 'expired', wipes = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'unauthorized', ...(reason ? { reason } : {}) }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
  await storage.put('cache', 'snapshot', { messages: {} }) // something the wipe must remove, to know when it has run
  expect(await useSession.getState().refresh(storage, () => client.close())).toBe('anon')
  vi.unstubAllGlobals()
  // This browser signing in over the session (`signed_in_again`) leaves the shared stores to the tab that did it.
  if (wipes) await vi.waitFor(async () => expect((await storage.all('cache')).length).toBe(0))
}

describe('a session that expires with messages waiting', () => {
  it('keeps the queue and sends each message and voice note once, in typed order, after sign-in', async () => {
    await queueThree()
    await expireSession()
    expect((await storage.all('outbox')).length).toBe(2)
    expect((await storage.all('blobs')).length).toBe(1)
    expect(owned()).toHaveLength(0)

    // sign in again: the page starts a client on the same storage, with the network back
    online = true
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => owned().length === 3, 8000, 'all three delivered')
    await waitFor(() => client.outboxSize() === 0, 8000, 'queue empty after acks')
    expect(sentSummary()).toEqual(['first', 'voice', 'third'])

    // another reconnect must not send any of them again
    const hellos = relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'hello').length
    relay.dropApps()
    await waitFor(
      () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'hello').length > hellos,
      4000,
      'reconnect',
    )
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(owned()).toHaveLength(3)
  })
})

describe('sign-out and revoke still empty everything', () => {
  it('sign-out: nothing queued survives, and a fresh client sends nothing', async () => {
    await queueThree()
    client.close()
    await clearLocalData(storage) // what "Sign out of this device" runs
    expect((await storage.all('outbox')).length).toBe(0)
    expect((await storage.all('blobs')).length).toBe(0)
    online = true
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(owned()).toHaveLength(0)
  })

  it('revoke after a 401 already kept the queue: the new key wipes it and nothing is sent', async () => {
    await queueThree()
    await expireSession()
    expect((await storage.all('outbox')).length).toBe(2)
    // the relay refuses the old key (revoked); signing in makes a new one
    await make().ensureDevice({ replace: true })
    expect((await storage.all('outbox')).length).toBe(0)
    expect((await storage.all('blobs')).length).toBe(0)
    online = true
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(owned()).toHaveLength(0)
  })
})

describe('a sign-in that proves a different identity', () => {
  it('never flushes the old queue, removes it, and tells the owner', async () => {
    await queueThree()
    await expireSession()
    // a different device key is in this storage now (the old queue was signed by the previous one)
    const other = make()
    const { deleteDeviceKey } = await import('../src/lib/deviceKey.ts')
    await deleteDeviceKey(storage)
    await other.ensureDevice()
    online = true
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(owned()).toHaveLength(0)
    expect((await storage.all('outbox')).length).toBe(0)
    expect((await storage.all('blobs')).length).toBe(0)
    const notice = Object.values(client.store.getState().messages)
      .flat()
      .find((m) => m.author === 'system')
    expect(notice?.text).toMatch(/3 messages that were waiting were removed/)
  })
})

describe('a session replaced by a fresh sign-in keeps the queue', () => {
  it('another tab whose cookie was replaced by signing in again does not wipe what is waiting', async () => {
    await queueThree()
    await expireSession('signed_in_again', false)
    expect((await storage.all('outbox')).length).toBe(2)
    expect((await storage.all('blobs')).length).toBe(1)
    expect((await storage.all('cache')).length).toBe(1) // the newer sign-in's chats are not emptied either
  })
})

describe('only a session that ran out of time keeps the queue', () => {
  it.each([['revoked'], ['logged_out'], ['logged_out_everywhere'], [null]])(
    'a 401 that says %s empties the queue, and a fresh client sends nothing',
    async (reason) => {
      await queueThree()
      await expireSession(reason)
      await vi.waitFor(async () => {
        expect((await storage.all('outbox')).length).toBe(0)
        expect((await storage.all('blobs')).length).toBe(0)
      })
      online = true
      client = make()
      await client.start({ pinned: true })
      await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
      expect(owned()).toHaveLength(0)
    },
  )
})

describe('what is waiting is visible again after the cache was cleared', () => {
  it('every kept message and voice note gets its row back, shown as waiting, and delivery marks it sent', async () => {
    await queueThree()
    await expireSession()
    online = false
    client = make()
    await client.start({ pinned: true })
    const rows = (client.store.getState().messages.general ?? []).filter((m) => m.author === 'owner')
    expect(rows.map((m) => m.text ?? m.kind).sort()).toEqual(['first', 'third', 'voice_note'].sort())
    expect(client.meta.getState().queuedIds).toHaveLength(3)

    // a row exists for each, so one that fails later can be seen and retried, and delivery marks them sent
    online = true
    client.close()
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => owned().length === 3, 8000, 'delivered')
    await waitFor(() => client.outboxSize() === 0, 8000, 'acked')
    expect(
      (client.store.getState().messages.general ?? []).filter((m) => m.author === 'owner' && m.receipt === 'sent'),
    ).toHaveLength(3)
  })
})

describe('a recording that cannot be saved is not queued and leaves no row', () => {
  it('queueVoiceNote throws, shows nothing, and nothing is sent later', async () => {
    const real = storage.put.bind(storage)
    storage.put = async (store, key, value) => {
      if (store === 'blobs') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      return real(store, key, value)
    }
    await expect(
      client.queueVoiceNote({ threadId: 'general', blob: new Blob(['abc'], { type: 'audio/webm' }), name: 'v.webm' }),
    ).rejects.toThrow()
    expect(client.outboxSize()).toBe(0)
    expect(client.store.getState().messages.general ?? []).toHaveLength(0)
    storage.put = real
    online = true
    client.close()
    client = make()
    await client.start({ pinned: true })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    expect(owned()).toHaveLength(0)
  })

  it('sendVoiceNote whose save fails removes its row and queues nothing', async () => {
    const real = storage.put.bind(storage)
    storage.put = async (store, key, value) => {
      if (store === 'outbox') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      return real(store, key, value)
    }
    await expect(
      client.sendVoiceNote({
        threadId: 'general',
        attachment: {
          media_id: 'md_01JZ0000000000000000000000',
          kind: 'voice_note',
          role: 'attachment',
          mime: 'audio/webm',
          name: 'v.webm',
          size: 3,
          sha256: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow()
    expect(client.outboxSize()).toBe(0)
    expect(client.store.getState().messages.general ?? []).toHaveLength(0)
  })
})

describe('nothing writes the queue after a sign-out', () => {
  it('an upload that finishes after sign-out writes no row, and a failed wipe is not hidden', async () => {
    let finishUpload: (() => void) | undefined
    const slow = createSocketClient({
      storage,
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => online,
      fetchImpl: ((url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finishUpload = () => resolve(fetch(`${relay.httpUrl}${url}`, init))
        })) as typeof fetch,
    })
    client.close()
    client = slow
    await client.ensureDevice()
    await client.start({ pinned: true })
    await client.queueVoiceNote({
      threadId: 'general',
      blob: new Blob(['abc'], { type: 'audio/webm' }),
      name: 'v.webm',
    })
    online = true
    client.close()
    client = slow
    await client.start({ pinned: true })
    await waitFor(() => finishUpload !== undefined, 8000, 'the upload is in flight')
    client.close() // signed out while it uploads
    await clearLocalData(storage)
    finishUpload?.()
    await new Promise((r) => setTimeout(r, 300)) // let the late upload land, if it is going to
    expect((await storage.all('outbox')).length).toBe(0)
    expect((await storage.all('blobs')).length).toBe(0)
  })

  it('replacing a revoked key tells the owner what was removed, and a wipe that fails is an error, not a silence', async () => {
    await queueThree()
    client.close()
    const other = make()
    await other.ensureDevice({ replace: true })
    const notice = Object.values(other.store.getState().messages)
      .flat()
      .find((m) => m.author === 'system')
    expect(notice?.text).toMatch(/3 messages that were waiting were removed/)

    const real = storage.clear.bind(storage)
    storage.clear = async (n) => {
      if (n === 'outbox') throw new Error('disk')
      return real(n)
    }
    await expect(make().ensureDevice({ replace: true })).rejects.toThrow('disk')
  })
})
