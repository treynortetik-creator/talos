// @vitest-environment node
// An upload that was already going when the session ended gets its 401 later. That answer belongs to the session that
// ended: it must not mark the next session as signed out (it would wipe it, queue included).
import { describe, expect, it } from 'vitest'
import { createSocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

function setup() {
  let answer!: () => void
  const held = new Promise<void>((r) => {
    answer = r
  })
  const client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://127.0.0.1:9/ws',
    isOnline: () => false,
    fetchImpl: (async () => {
      await held
      return Response.json({ error: 'unauthorized', reason: 'logged_out' }, { status: 401 })
    }) as typeof fetch,
  })
  return { client, answer }
}
const upload = (c: ReturnType<typeof setup>['client']) =>
  c.uploadMedia(new Blob(['x'], { type: 'text/plain' }), { name: 'a.txt' }).catch((e: unknown) => e)

describe('a 401 that answers an upload', () => {
  it('marks the live session as signed out', async () => {
    const { client, answer } = setup()
    const p = upload(client)
    answer()
    await p
    expect(client.meta.getState()).toMatchObject({ authFailed: true, authReason: 'logged_out' })
    client.close()
  })

  it('does nothing when the session it belonged to was closed first', async () => {
    const { client, answer } = setup()
    const p = upload(client)
    client.close()
    answer()
    await p
    expect(client.meta.getState().authFailed).toBe(false)
  })

  it('does nothing when the upload only started after the close', async () => {
    const { client, answer } = setup()
    client.close()
    const p = upload(client)
    answer()
    await p
    expect(client.meta.getState().authFailed).toBe(false)
  })

  it('does nothing to a new session that started after the close', async () => {
    const { client, answer } = setup()
    const p = upload(client)
    client.close()
    await client.ensureDevice()
    await client.start({ pinned: true }).catch(() => {})
    answer()
    await p
    expect(client.meta.getState().authFailed).toBe(false)
    client.close()
  })
})
