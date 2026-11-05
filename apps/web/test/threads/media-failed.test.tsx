// media.failed leftover from D4, and the ImageViewer failed line from #110/#111: when the Mac refuses a signed media.fetch
// ("not on this Mac", or the relay's mac_offline), the app used to drop the error and wait out the timeout (20 s + 2 s per
// MB). Now the refusal reaches the file's chip at once. The REAL socket client and the REAL components against FakeRelay;
// the Mac's answer is an `error{ref}` for the signed frame's id, exactly what the relay forwards to the asker.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { type AttachmentRefT, newId } from '@talos-app/protocol'
import { FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentView } from '../../src/features/threads/Attachments.tsx'
import { ImageViewer } from '../../src/features/threads/ImageViewer.tsx'
import { fetchTimeoutFor } from '../../src/features/threads/media.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

const { WebSocket: NodeWebSocket } = createRequire(
  resolve(import.meta.dirname, '../../../../packages/testkit/package.json'),
)('ws') as { WebSocket: typeof WebSocket }

let relay: FakeRelay | undefined
let client: SocketClient | undefined
let bridge: FakeBridge | undefined
const realFetch = globalThis.fetch

beforeEach(() => {
  // the relay no longer holds any media: HEAD and GET answer 410, which is what makes the app ask the Mac
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) =>
    String(url).includes('/media/') ? new Response(null, { status: 410 }) : realFetch(url as string, init),
  )
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  client?.close()
  await bridge?.close()
  bridge = undefined
  await relay?.stop()
})

async function start() {
  relay = await new FakeRelay().start()
  // the Mac is up (the relay answers mac_offline itself otherwise), so the fetch reaches it and its refusal is staged below
  bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey }).connect()
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
  return c
}

const fetchFrames = () =>
  (relay as FakeRelay).frames
    .filter((f) => f.direction === 'from_app' && f.raw.type === 'media.fetch')
    .map((f) => f.raw)

const att = (kind: AttachmentRefT['kind'], mime: string, name: string): AttachmentRefT => ({
  media_id: newId('md'),
  kind,
  role: 'attachment',
  mime,
  name,
  size: 2048,
  sha256: 'a'.repeat(64),
})

/** What the relay forwards when the Mac says "not on this Mac" (bridge/inbound.ts) or is offline (mac_offline). */
const refuse = (ref: unknown, code = 'bad_frame', message = 'That file is no longer on your Mac.') =>
  (relay as FakeRelay).sendToApps(mkFrame('error', { ref: ref as string, code, message }) as never)

const TIMEOUT = fetchTimeoutFor(2048)

/**
 * Keeps the chip's own timeout from ever being scheduled: the timer is requested (counted, so the test can tell it was
 * armed) but nothing is set, so it can not fire. A chip that fails after this can only have failed because of the refusal.
 * No stopwatch and no clock: whether the timeout "would have been slower" is not what is asserted.
 */
function withholdChipTimeout() {
  const realSetTimeout = globalThis.setTimeout
  const armed = { count: 0 }
  vi.stubGlobal('setTimeout', (fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (ms === TIMEOUT) {
      armed.count++
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return (realSetTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(fn, ms, ...rest)
  })
  return armed
}

describe('a refused media.fetch fails the chip at once', () => {
  it('a file chip: fetching, then failed the moment the Mac says no (the timeout never has to run), and Retry asks again', async () => {
    const c = await start()
    const armed = withholdChipTimeout()
    const a = att('file', 'text/csv', 'sheet.csv')
    render(
      <ClientProvider client={c}>
        <AttachmentView att={a} message={{ id: newId('m'), thread_id: 'general' } as never} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    await waitFor(() => fetchFrames().length === 1, 4000, 'media.fetch sent')
    expect(await screen.findByTestId('media-fetching')).toBeTruthy()
    expect(armed.count).toBeGreaterThan(0) // control: the 22 s timeout was armed, and is held back
    refuse(fetchFrames()[0]?.id)
    const failed = await screen.findByTestId('media-failed')
    expect(failed.textContent).toContain("Couldn't load sheet.csv")
    expect(screen.queryByTestId('media-fetching')).toBeNull()
    // no message row, no alarm: the refusal belongs to the chip alone
    expect(c.store.getState().messages).toEqual({})

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => fetchFrames().length === 2, 4000, 'asked again')
  })

  it('an image: same, through useMediaSrc', async () => {
    const c = await start()
    const a = att('image', 'image/png', 'photo.png')
    render(
      <ClientProvider client={c}>
        <AttachmentView att={a} message={{ id: newId('m'), thread_id: 'general' } as never} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    fireEvent.error(await screen.findByAltText('photo.png')) // the <img> got a 410
    await waitFor(() => fetchFrames().length === 1, 4000, 'media.fetch sent')
    refuse(fetchFrames()[0]?.id, 'mac_offline', 'your Mac is offline')
    expect(await screen.findByTestId('media-failed')).toBeTruthy()
  })

  it('an error for some other request is not mistaken for a refusal', async () => {
    const c = await start()
    const a = att('file', 'text/csv', 'sheet.csv')
    render(
      <ClientProvider client={c}>
        <AttachmentView att={a} message={{ id: newId('m'), thread_id: 'general' } as never} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    await waitFor(() => fetchFrames().length === 1, 4000, 'media.fetch sent')
    refuse(newId('m'))
    await new Promise((r) => setTimeout(r, 200))
    expect(screen.queryByTestId('media-failed')).toBeNull()
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
  })
})

describe('ImageViewer failed state (#110/#111)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    )
  })

  it('shows what happened with a Retry button instead of a blank stage, and Retry asks again', async () => {
    const c = await start()
    const a = att('image', 'image/png', 'photo.png')
    render(
      <ClientProvider client={c}>
        <ImageViewer att={a} onClose={() => {}} />
      </ClientProvider>,
    )
    fireEvent.error(screen.getByAltText('photo.png'))
    expect(await screen.findByTestId('viewer-fetching')).toBeTruthy()
    await waitFor(() => fetchFrames().length === 1, 4000, 'media.fetch sent')
    refuse(fetchFrames()[0]?.id)
    const failed = await screen.findByTestId('viewer-failed')
    expect(failed.textContent).toContain("Couldn't load this image")
    expect(screen.queryByTestId('viewer-fetching')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.queryByTestId('viewer-failed')).toBeNull()
    fireEvent.error(screen.getByAltText('photo.png'))
    await waitFor(() => fetchFrames().length === 2, 4000, 'asked again')
  })
})
