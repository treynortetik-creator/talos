// @vitest-environment node
// Review finding #9: after a 4401/4403 close and a re-login the app must reconnect without a page reload. The shell
// calls `start()` again when the session is back, and "Retry" on the offline banner calls `reconnect()`.
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteDeviceKey } from '../../src/lib/deviceKey.ts'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../../src/lib/storage.ts'

let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const sockets: WebSocket[] = []
class TrackedWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url)
    sockets.push(this)
  }
}

let jar: Storage
async function authFailedClient() {
  relay = await new FakeRelay().start()
  jar = createMemoryStorage()
  const client = createSocketClient({
    storage: jar,
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: TrackedWebSocket as never,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  // The relay closes the app socket with 4401 (session expired).
  const live = sockets.at(-1)
  if (!live) throw new Error('no socket')
  live.onclose?.({ code: 4401 } as CloseEvent)
  expect(client.store.getState().connection).toBe('offline')
  expect(client.meta.getState().authFailed).toBe(true)
  return client
}

describe('reconnect after an auth close', () => {
  it('start() again (after the re-login) reconnects and clears authFailed', async () => {
    const client = await authFailedClient()
    await client.start({ pinned: true })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'back online')
    expect(client.meta.getState().authFailed).toBe(false)
    client.close()
  })

  it('close() clears the old authFailed flag, so the next sign-in is not bounced by it (audit D21 follow-up)', async () => {
    const client = await authFailedClient()
    client.close()
    expect(client.meta.getState().authFailed).toBe(false)
  })

  it('close() forgets the cached device key: a key deleted from storage is not handed back (audit D9 follow-up)', async () => {
    const client = await authFailedClient()
    expect(await client.deviceKey()).not.toBeNull()
    client.close()
    await deleteDeviceKey(jar)
    expect(await client.deviceKey()).toBeNull()
  })

  it('reconnect() (the banner Retry) works after an auth close', async () => {
    const client = await authFailedClient()
    client.reconnect()
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'back online')
    client.close()
  })
})

describe('an expired session seen only as refused upgrades', () => {
  async function refusedClient(me: number) {
    // The relay answers the upgrade with HTTP 401, so the browser only ever sees close code 1006.
    relay = await new FakeRelay({ appAuth: { header: 'x-session', value: 'good' } }).start()
    const probes: string[] = []
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 10, maxMs: 20 },
      isOnline: () => true,
      fetchImpl: (async (url: string) => {
        probes.push(String(url))
        return new Response('{}', { status: me, headers: { 'content-type': 'application/json' } })
      }) as never,
    })
    await client.ensureDevice()
    await client.start({ pinned: true })
    return { client, probes }
  }

  it('flags authFailed once /api/me answers 401, so the shell can send the owner to sign in', async () => {
    const { client, probes } = await refusedClient(401)
    await waitFor(() => client.meta.getState().authFailed, 4000, 'authFailed')
    expect(probes.some((u) => u.includes('/api/me'))).toBe(true)
    client.close()
  })

  it('keeps retrying (no authFailed) while /api/me still says signed in', async () => {
    const { client } = await refusedClient(200)
    await new Promise((r) => setTimeout(r, 400))
    expect(client.meta.getState().authFailed).toBe(false)
    expect(client.store.getState().connection).not.toBe('online')
    client.close()
  })
})
