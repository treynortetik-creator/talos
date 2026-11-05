// @vitest-environment node
// D18: the jump banner against the REAL socket client. It stores a live reply in two writes (the message, then the
// unread bump), which a hand-written store update does not do.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { type Banner, watchForBanner } from '../../src/features/threads/bannerWatch.ts'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const reply = (thread_id: string, text: string, over: Record<string, unknown> = {}, silent = false) =>
  mkFrame('reply', {
    ...(silent ? { silent: true } : {}),
    message: {
      id: newId('m'),
      thread_id,
      author: 'agent',
      kind: 'text',
      text,
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: new Date().toISOString(),
      ...over,
    },
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

describe('jump banner on the real socket client', () => {
  it('a live reply in another thread fires the banner; the one on screen does not', async () => {
    const { client, relay } = await online()
    try {
      const shown: Banner[] = []
      const off = watchForBanner(
        client.store,
        () => 'general',
        (b) => shown.push(b),
      )
      // the first thread that is not the one on screen
      const other = client.store.getState().threads.find((t) => t.id !== 'general' && !t.archived)
      if (!other) throw new Error('the fake relay config has no second thread')
      relay.sendToApps(reply('general', 'on screen'))
      relay.sendToApps(reply(other.id, 'news for you'))
      await waitFor(() => (client.store.getState().unread[other.id] ?? 0) === 1, 3000, 'unread')
      await waitFor(() => shown.length > 0, 1000, 'banner')
      expect(shown.map((b) => b.snippet)).toEqual(['news for you'])
      expect(shown[0]?.threadId).toBe(other.id)
      off()
    } finally {
      client.close()
    }
  })

  it('a silent reply (no unread bump) and an old one do not fire it', async () => {
    const { client, relay } = await online()
    try {
      const shown: Banner[] = []
      const off = watchForBanner(
        client.store,
        () => 'general',
        (b) => shown.push(b),
      )
      const other = client.store.getState().threads.find((t) => t.id !== 'general' && !t.archived)
      if (!other) throw new Error('no second thread')
      relay.sendToApps(reply(other.id, 'silent', {}, true))
      await waitFor(() => (client.store.getState().messages[other.id]?.length ?? 0) === 1, 3000, 'stored')
      await new Promise((r) => setTimeout(r, 50))
      expect(client.store.getState().unread[other.id] ?? 0).toBe(0)
      relay.sendToApps(reply(other.id, 'old', { created_at: '2020-01-01T00:00:00.000Z' }))
      await waitFor(() => (client.store.getState().unread[other.id] ?? 0) === 1, 3000, 'unread')
      await new Promise((r) => setTimeout(r, 50))
      expect(shown).toEqual([])
      off()
    } finally {
      client.close()
    }
  })
})
