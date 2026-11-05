// @vitest-environment node
// A 401 on /api/me wipes the cache (but keeps queued messages and voice notes, which go out after sign-in). The socket client must be stopped first, or its save timer and its pagehide flush
// write the chats straight back into the cache that was just emptied.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../src/features/auth/session.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

beforeEach(() => useSession.setState({ status: 'authed', me: null, offline: false }))
afterEach(() => vi.unstubAllGlobals())

const unauthorized = (body: Record<string, unknown>) =>
  vi.fn(
    async () => new Response(JSON.stringify(body), { status: 401, headers: { 'content-type': 'application/json' } }),
  )

describe('useSession.refresh on a 401', () => {
  it('a revoke, a sign-out and a 401 that says nothing all empty every store, the queue included', async () => {
    for (const body of [{ reason: 'revoked' }, { reason: 'logged_out_everywhere' }, { reason: 'who knows' }, {}]) {
      vi.stubGlobal('fetch', unauthorized({ error: 'unauthorized', ...body }))
      const storage = createMemoryStorage()
      const cleared: string[] = []
      const realClear = storage.clear.bind(storage)
      storage.clear = async (n) => {
        cleared.push(n)
        return realClear(n)
      }
      useSession.setState({ status: 'authed', me: null, offline: false })
      const stopped: Array<{ keepQueue: boolean }> = []
      expect(await useSession.getState().refresh(storage, (opts) => stopped.push(opts))).toBe('anon')
      await vi.waitFor(
        () => expect(cleared.sort()).toEqual(['blobs', 'cache', 'drafts', 'outbox', 'problems', 'schedules']),
        {
          timeout: 5000,
        },
      )
      expect(stopped).toEqual([{ keepQueue: false }]) // the client is told to drop its queue too, not only the stores
    }
  })

  it('stops the client before it clears the stores, and before status turns anon (an expired session keeps the queue)', async () => {
    vi.stubGlobal('fetch', unauthorized({ error: 'unauthorized', reason: 'expired' }))
    const storage = createMemoryStorage()
    await storage.put('cache', 'snapshot', { messages: {} })
    const order: string[] = []
    const realClear = storage.clear.bind(storage)
    storage.clear = async (n) => {
      order.push(`clear:${n}`)
      return realClear(n)
    }
    const status = await useSession
      .getState()
      .refresh(storage, (opts) =>
        order.push(`stop(status=${useSession.getState().status},keepQueue=${opts.keepQueue})`),
      )
    expect(status).toBe('anon')
    await vi.waitFor(() =>
      expect(order.filter((o) => o.startsWith('clear')).sort()).toEqual([
        'clear:cache',
        'clear:drafts',
        'clear:schedules',
      ]),
    )
    expect(order[0]).toBe('stop(status=authed,keepQueue=true)') // an expired session tells the client to keep its queue
  })

  it('does not stop the client when the network is merely down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    )
    const stop = vi.fn()
    await useSession.getState().refresh(createMemoryStorage(), stop)
    expect(stop).not.toHaveBeenCalled()
  })
})
