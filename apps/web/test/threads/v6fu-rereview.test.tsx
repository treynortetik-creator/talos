// Re-review of PR #100 at 3565373: the real socket client and the real attachment components against FakeRelay.
//
// docs/SECURITY.md row "Signed history reads" says a taken-over relay "cannot pull files off the Mac by naming their ids".
// A `reply` row carries no Mac signature and the client merges it unchecked. So a relay can put any media id in a row,
// answer GET /media/<id> with 410, and the app signs a valid `media.fetch` for that id as soon as the row renders. The
// owner opens the thread and taps nothing.
//
// The app does this today, and docs/SECURITY.md lists it under "What this does not protect against".
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { type AttachmentRefT, type MessageT, newId, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentView } from '../../src/features/threads/Attachments.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

// Node's built-in WebSocket throws on jsdom's Event, so this test borrows the testkit's `ws`.
const { WebSocket: NodeWebSocket } = createRequire(
  resolve(import.meta.dirname, '../../../../packages/testkit/package.json'),
)('ws') as { WebSocket: typeof WebSocket }

let relay: FakeRelay | undefined
let bridge: FakeBridge | undefined
let client: SocketClient | undefined
afterEach(async () => {
  cleanup()
  client?.close()
  await bridge?.close()
  await relay?.stop()
})

describe('re-review at 3565373: the relay cannot pull files by naming ids', () => {
  it('the app signs media.fetch for the id of a row the Mac never signed, once its player fails', async () => {
    relay = await new FakeRelay().start()
    bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, features: ['search/1'] }).connect()
    const c = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
      isOnline: () => true,
      WebSocketImpl: NodeWebSocket,
    })
    client = c
    await c.ensureDevice()
    await c.start({ pinned: true })
    await waitFor(() => c.store.getState().connection === 'online', 4000, 'online')
    const key = await c.deviceKey()
    if (!key) throw new Error('no key')

    // The relay invents a row. Nothing about it came from the Mac: no signature, and the id is the one the relay wants.
    const wanted = newId('md')
    const injected: MessageT = {
      id: newId('m'),
      thread_id: 'general',
      author: 'agent',
      kind: 'file',
      text: '',
      format: 'plain',
      attachments: [
        {
          media_id: wanted,
          kind: 'audio',
          role: 'attachment',
          mime: 'audio/mpeg',
          name: 'a.mp3',
          size: 3,
          sha256: 'a'.repeat(64),
        },
      ],
      via: 'app',
      created_at: new Date().toISOString(),
      seq: 5,
    }
    relay.sendToApps(mkFrame('reply', { message: injected }) as never)
    const stored = () => c.store.getState().messages.general?.find((m) => m.id === injected.id)
    await waitFor(() => stored() !== undefined, 3000, 'the row is merged unchecked')
    const row = stored() as MessageT
    const att = row.attachments[0] as AttachmentRefT

    // Opening the thread mounts the player. The relay answers GET /media/<id> with 410, which the element reports as an
    // error. jsdom loads no media, so the error is fired by hand. No tap on anything.
    const r = render(
      <ClientProvider client={c}>
        <AttachmentView att={att} message={row} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    fireEvent.error(r.container.querySelector('audio') as HTMLAudioElement)

    const sent = () =>
      (relay as FakeRelay).frames
        .filter((f) => f.direction === 'from_app' && f.raw.type === 'media.fetch')
        .map((f) => f.raw as Record<string, unknown>)
    // Pinned on purpose: today the app signs for any id a row names, even one only the relay vouched for. Docs list this as a
    // limit (scripts/apps-doc.test.ts). If the app stops signing for such ids, change this test and the doc together.
    await waitFor(() => sent().length === 1, 2000, 'media.fetch')
    const raw = sent()[0] as Record<string, unknown>
    expect(raw.media_id).toBe(wanted)
    expect(await verifyOwnerFrame(raw, key.publicJwk)).toBe(true) // the bridge test shows the Mac uploads for such a frame
  })
})
