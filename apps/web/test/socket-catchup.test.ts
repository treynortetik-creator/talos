// @vitest-environment node
// Catch-up on the real socket client against FakeRelay, which pages at 200 frames like the real relay: a gap bigger
// than one page must be followed to the end, and the owner's own stored messages in a batch must come back as messages.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

async function online() {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
}

const received_at = () => new Date().toISOString()

function agentReply(seq: number, text: string): Record<string, unknown> {
  return {
    ...mkFrame('reply', {
      message: {
        id: newId('m'),
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text,
        format: 'markdown',
        attachments: [],
        via: 'app',
        created_at: received_at(),
      },
    }),
    relay: { seq, received_at: received_at() },
  }
}

/** What the relay stores for a message the owner sent from another device: the signed app frame, as sent. */
function storedOwnerMessage(seq: number, text: string): Record<string, unknown> {
  return {
    ...mkFrame('message', {
      thread_id: 'general',
      client_msg_id: newId('m'),
      text,
      attachments: [],
      device_id: 'd_aaaaaaaaaaaaaaaaaaaa',
      osig: 'A'.repeat(86),
    }),
    relay: { seq, received_at: received_at() },
  }
}

/** Gives the client a last_seq of 1, then fills the relay's buffer past it while the client is away. */
async function seedWhileAway(frames: (seq: number) => Record<string, unknown>[]) {
  await online()
  await client.sendMessage({ threadId: 'general', text: 'first' })
  await waitFor(() => client.store.getState().lastSeq === 1, 2000, 'first seq')
  relay.dropApps()
  await waitFor(() => client.store.getState().connection !== 'online', 2000, 'dropped')
  const added = frames(relay.seq + 1)
  for (const f of added) relay.stored.push(f)
  relay.seq = (added.at(-1)?.relay as { seq: number } | undefined)?.seq ?? relay.seq
}

const catchupRequests = () =>
  relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'catchup.request').map((f) => f.raw.since_seq)
const catchupBatches = () =>
  relay.frames.filter((f) => f.direction === 'to_app' && f.raw.type === 'catchup.batch').map((f) => f.raw)

describe('catch-up past one page', () => {
  it('asks for each next page until the relay says no more, and ends on the last seq', async () => {
    let lastText = ''
    await seedWhileAway((first) => {
      const out: Record<string, unknown>[] = []
      for (let i = 0; i < 450; i++) {
        lastText = `reply ${i}`
        out.push(agentReply(first + i, lastText))
      }
      return out
    })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'back')
    await waitFor(() => client.store.getState().lastSeq === relay.seq, 4000, 'whole gap fetched')

    const batches = catchupBatches()
    expect(batches).toHaveLength(3)
    // each follow-up request starts where the previous page ended
    expect(catchupRequests()).toEqual(batches.slice(0, -1).map((b) => b.to_seq))
    const texts = (client.store.getState().messages.general ?? []).map((m) => m.text)
    expect(texts).toHaveLength(451)
    expect(texts).toContain('reply 0')
    expect(texts).toContain('reply 199')
    expect(texts).toContain('reply 200')
    expect(texts).toContain(lastText)
    // replayed replies were counted in `ready.unread`; none of them is counted again
    expect(client.store.getState().unread.general ?? 0).toBe(0)
  })

  it('stops asking after a page that says more:false', async () => {
    await online()
    relay.sendToApps(
      mkFrame('catchup.batch', { from_seq: 1, to_seq: 3, frames: [agentReply(3, 'one page')], more: false }),
    )
    await waitFor(() => client.store.getState().lastSeq === 3, 2000, 'page applied')
    await new Promise((r) => setTimeout(r, 50))
    expect(catchupRequests()).toEqual([])
  })
})

describe('stored owner frames in a catch-up batch', () => {
  it('come back as owner messages with their seq, also when they sit on a later page', async () => {
    await seedWhileAway((first) => {
      const out: Record<string, unknown>[] = []
      for (let i = 0; i < 250; i++)
        out.push(i === 5 ? storedOwnerMessage(first + i, 'from my iPad') : agentReply(first + i, `reply ${i}`))
      out[240] = storedOwnerMessage(first + 240, 'from my iPad, later page')
      return out
    })
    await waitFor(() => client.store.getState().lastSeq === relay.seq, 4000, 'whole gap fetched')

    const owner = (client.store.getState().messages.general ?? []).filter(
      (m) => m.author === 'owner' && m.text?.startsWith('from my iPad'),
    )
    expect(owner.map((m) => m.text).sort()).toEqual(['from my iPad', 'from my iPad, later page'])
    for (const m of owner) {
      expect(m.receipt).toBe('sent')
      expect(m.seq).toBeGreaterThan(1)
      expect(m.via).toBe('app')
    }
  })

  it('skips a stored owner frame that does not parse, and the rest of the batch still lands', async () => {
    await online()
    const bad = { ...storedOwnerMessage(2, 'broken'), attachments: undefined }
    relay.sendToApps(
      mkFrame('catchup.batch', {
        from_seq: 2,
        to_seq: 3,
        frames: [bad, agentReply(3, 'after the broken one')],
        more: false,
      }),
    )
    await waitFor(() => client.store.getState().lastSeq === 3, 2000, 'batch applied')
    const texts = (client.store.getState().messages.general ?? []).map((m) => m.text)
    expect(texts).toEqual(['after the broken one'])
  })
})
