// The start sequence behind the session gate: finish an owed wipe, then start the socket client. If the gate's effect was
// torn down while the wipe was running (sign-out, route change, a second run), the client must not be started by the old run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startOwnerClient } from '../../src/features/auth/startClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

beforeEach(() => localStorage.setItem('talos-app:wipe-pending', 'all'))
afterEach(() => localStorage.removeItem('talos-app:wipe-pending'))

const fakeClient = (key: unknown = { deviceId: 'dev_1' }) => ({
  deviceKey: vi.fn(async () => key),
  start: vi.fn(async () => {}),
})

describe('startOwnerClient', () => {
  it('does not start the client when the gate went away while the owed wipe was running', async () => {
    const client = fakeClient()
    let gone = false
    const storage = createMemoryStorage()
    const realClear = storage.clear.bind(storage)
    storage.clear = async (name) => {
      gone = true // the effect is cleaned up mid-wipe
      return realClear(name)
    }
    const result = await startOwnerClient({ client, storage, pinned: false, isGone: () => gone })
    expect(result).toBe('gone')
    expect(client.start).not.toHaveBeenCalled()
  })

  it('starts the client after a finished wipe', async () => {
    const client = fakeClient()
    const result = await startOwnerClient({ client, storage: createMemoryStorage(), pinned: true, isGone: () => false })
    expect(result).toBe('started')
    expect(client.start).toHaveBeenCalledWith({ pinned: true })
  })

  it('reports a wipe that cannot finish, and a storage that will not open', async () => {
    const storage = createMemoryStorage()
    storage.clear = async () => {
      throw new Error('denied')
    }
    expect(await startOwnerClient({ client: fakeClient(), storage, pinned: false, isGone: () => false })).toBe('wipe')
    localStorage.removeItem('talos-app:wipe-pending')
    const broken = { deviceKey: vi.fn(async () => Promise.reject(new Error('no'))), start: vi.fn() }
    expect(
      await startOwnerClient({ client: broken, storage: createMemoryStorage(), pinned: false, isGone: () => false }),
    ).toBe('storage')
  })

  it('says there is no key so the gate can send the owner to enroll', async () => {
    expect(
      await startOwnerClient({
        client: fakeClient(null),
        storage: createMemoryStorage(),
        pinned: false,
        isGone: () => false,
      }),
    ).toBe('no-key')
  })
})
