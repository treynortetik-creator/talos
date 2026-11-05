// @vitest-environment node
// O21 parity: the app icon's number is computed from `unread` on the phone and from the relay's own count in each push. The
// relay counts an inbox item, a share and a hook row as unread (hub.ts `countsUnread`); a connected phone must count the same
// frames live, or the icon jumps between the two numbers. Real socket client against the fake relay.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function online() {
  relay = await new FakeRelay().start()
  const client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return { client, relay }
}

const item = (id: string, thread = 'inbox') => ({
  id,
  source: 'github',
  connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
  kind: 'github.review_requested',
  title: 'Review requested',
  summary: 'octocat requested your review',
  actor: { name: 'octocat' },
  ts: new Date().toISOString(),
  thread,
  work: false,
  priority: 'low',
  state: 'new',
})
const stored = (author: 'owner' | 'hook' | 'agent', via: 'app' | 'share' | 'hook', thread: string) =>
  mkFrame('message.stored', {
    client_msg_id: newId('m'),
    message: {
      id: newId('m'),
      thread_id: thread,
      author,
      kind: author === 'hook' ? 'event' : 'text',
      text: 'x',
      format: 'plain',
      attachments: [],
      via,
      created_at: new Date().toISOString(),
    },
  })

describe('the phone counts live the frames the relay counts as unread', () => {
  it('an inbox item is one unread in its thread, and the same item again is not a second one', async () => {
    const { client, relay } = await online()
    try {
      relay.sendToApps(mkFrame('inbox.item', { item: item('e_AAAAAAAAAAAAAAAAAAAAAAAAAA') }))
      await waitFor(() => client.store.getState().unread.inbox === 1, 3000, 'one unread')
      relay.sendToApps(mkFrame('inbox.item', { item: item('e_BBBBBBBBBBBBBBBBBBBBBBBBBB', 'general') }))
      await waitFor(() => client.store.getState().unread.general === 1, 3000, 'one in general')
      relay.sendToApps(mkFrame('inbox.item', { item: item('e_AAAAAAAAAAAAAAAAAAAAAAAAAA') })) // re-delivered
      await new Promise((r) => setTimeout(r, 150))
      expect(client.store.getState().unread).toMatchObject({ inbox: 1, general: 1 })
    } finally {
      client.close()
    }
  })

  it('a hook row and a share count; the owner own stored message does not', async () => {
    const { client, relay } = await online()
    try {
      relay.sendToApps(stored('hook', 'hook', 'general'))
      relay.sendToApps(stored('owner', 'share', 'general'))
      await waitFor(() => client.store.getState().unread.general === 2, 3000, 'hook row and share')
      relay.sendToApps(stored('owner', 'app', 'general'))
      await new Promise((r) => setTimeout(r, 150))
      expect(client.store.getState().unread.general).toBe(2)
    } finally {
      client.close()
    }
  })
})
