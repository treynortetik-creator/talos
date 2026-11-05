// A tab that ends as `device_changed` (it holds an old device key) or `signed_in_again` (this browser just signed in over
// it) shares its storage with the tab that now owns it. That tab's chats, drafts, schedules and queue stay; this tab lets
// go only of what it holds in memory itself. Every other end empties the stores.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentDraftState, resetAgentDraft, setAgentDraft } from '../../src/features/agent-config/draftStore.ts'
import { clearAfterSessionEnd, pendingWipe } from '../../src/features/auth/session.ts'
import { createMemoryStorage, type Storage } from '../../src/lib/storage.ts'

afterEach(() => {
  resetAgentDraft()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function fill(): Promise<Storage> {
  const storage = createMemoryStorage()
  await storage.put('cache', 'snapshot', { messages: {} })
  await storage.put('drafts', 'general', 'half a thought')
  await storage.put('schedules', 's1', { id: 's1' })
  await storage.put('outbox', 'o1', { id: 'o1', kind: 'message', bytes: '{}' })
  return storage
}
const rows = async (s: Storage) => ({
  cache: (await s.all('cache')).length,
  drafts: (await s.all('drafts')).length,
  schedules: (await s.all('schedules')).length,
  outbox: (await s.all('outbox')).length,
})
const draft = () => setAgentDraft({ model: 'x' } as never, null)

describe('clearAfterSessionEnd', () => {
  it.each([['device_changed'], ['signed_in_again']])(
    'reason %s keeps the shared stores, sets no wipe marker, and resets this tab only',
    async (reason) => {
      const storage = await fill()
      draft()
      await clearAfterSessionEnd(storage, reason)
      expect(await rows(storage)).toEqual({ cache: 1, drafts: 1, schedules: 1, outbox: 1 })
      expect(pendingWipe()).toBeNull()
      expect(getAgentDraftState().draft).toBeNull() // this tab's own memory is still reset
    },
  )

  it.each([['expired'], ['revoked'], ['logged_out'], [null]])('reason %j still empties the stores', async (reason) => {
    const storage = await fill()
    await clearAfterSessionEnd(storage, reason)
    const r = await rows(storage)
    expect([r.cache, r.drafts, r.schedules]).toEqual([0, 0, 0])
  })
})

describe('a 401 on /api/me at open', () => {
  it.each([['device_changed'], ['signed_in_again']])('reason %s keeps the shared stores', async (reason) => {
    const { useSession } = await import('../../src/features/auth/session.ts')
    const storage = await fill()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'unauthorized', reason }, { status: 401 })),
    )
    expect(await useSession.getState().refresh(storage)).toBe('anon')
    expect(pendingWipe()).toBeNull() // a wipe would have marked itself before it started
    expect(await rows(storage)).toEqual({ cache: 1, drafts: 1, schedules: 1, outbox: 1 })
  })
})
