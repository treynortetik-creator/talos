// The screenshot hotkey's web half (capture_drop -> a pending attachment in a thread's composer, answered by capture_ack).
import { AgentConfig } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { resetComposer, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { attachShell, NATIVE_FEATURES } from '../../src/features/native/attach.ts'
import {
  captureFile,
  captureThread,
  handleCaptureDrop,
  noteViewedThread,
  resetCaptureState,
} from '../../src/features/native/capture.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import type { Shell } from '../../src/lib/native/shell.ts'

const config = AgentConfig.parse(readyFixture.agent_config)
const threads = [
  ...config.threads,
  { ...(config.threads[0] as (typeof config.threads)[number]), id: 'trip', name: 'Trip' },
  { ...(config.threads[0] as (typeof config.threads)[number]), id: 'old', name: 'Old', archived: true },
]
const defaultThread = config.default_thread ?? config.threads[0]?.id ?? 'general'

// The PNG signature and an IHDR header stating the size: all the page reads (it never decodes the image itself).
const pngB64 = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  return btoa(String.fromCharCode(...b))
}
const PNG_B64 = pngB64(100, 80)
const drop = (over: Record<string, unknown> = {}) => ({
  type: 'capture_drop' as const,
  req: 'r1',
  thread_id: null,
  mime: 'image/png' as const,
  data_b64: PNG_B64,
  width: 100,
  height: 80,
  mode: 'region' as const,
  ...over,
})

function setup(pinned = true) {
  const posted: Array<Record<string, unknown>> = []
  const bridge = createShellBridge({ post: (m) => posted.push(m as Record<string, unknown>) })
  const store = createStore(() => ({ ...initialClientState(), config, devicePinned: pinned, threads }))
  const client = { store, sendMessage: vi.fn(), onFrame: () => () => {} } as unknown as TalosClient
  const shell = { kind: 'desktop', bridge, platform: {} } as unknown as Shell
  const nav = vi.fn()
  return { posted, bridge, client, shell, nav, acks: () => posted.filter((m) => m.type === 'capture_ack') }
}
const dropped = (thread: string) => useComposerStore.getState().dropped[thread] ?? []
// What the composer does when it mounts: takes the files waiting for its thread.
const composerTakes = (thread: string) => useComposerStore.getState().takeDropped(thread)

beforeEach(() => {
  useSession.setState({ status: 'authed' })
  useComposerStore.setState({ dropped: {}, dropFocus: {} })
  resetCaptureState()
})
afterEach(() => vi.useRealTimers())

describe('capture_drop', () => {
  it('the page lists capture-drop in its ready, so the Mac app sends only to a page that can take it', () => {
    expect(NATIVE_FEATURES).toContain('capture-drop')
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    expect(t.posted[0]?.features).toContain('capture-drop')
  })

  it('goes into the composer of the thread last on screen, asks for focus, opens that thread, and acks once it is taken', async () => {
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    noteViewedThread('trip')
    const answer = t.bridge.receive(drop())
    expect(dropped('trip')).toHaveLength(1)
    expect(dropped('trip')[0]?.type).toBe('image/png')
    expect(dropped('trip')[0]?.name).toMatch(/^Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/)
    expect(useComposerStore.getState().dropFocus.trip).toBe(true)
    expect(t.nav).toHaveBeenCalledWith('/t/trip')
    expect(t.acks()).toEqual([]) // not yet: the composer has not taken it
    composerTakes('trip')
    expect(await answer).toBe(true)
    expect(t.acks()).toEqual([{ type: 'capture_ack', req: 'r1', ok: true }])
    expect(t.client.sendMessage).not.toHaveBeenCalled() // nothing is sent until the owner sends
  })

  it('a thread pinned in the Mac app wins; an unknown or archived one falls back; nothing on screen means the default thread', () => {
    const t = setup()
    expect(captureThread(t.client, null)).toBe(defaultThread)
    noteViewedThread('trip')
    expect(captureThread(t.client, defaultThread)).toBe(defaultThread)
    expect(captureThread(t.client, 'nope')).toBe('trip')
    expect(captureThread(t.client, 'old')).toBe('trip')
    noteViewedThread(null) // leaving a thread for the inbox keeps the last one
    expect(captureThread(t.client, null)).toBe('trip')
  })

  it('not signed in: answered not_signed_in, nothing in any composer', async () => {
    useSession.setState({ status: 'anon' })
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    await t.bridge.receive(drop())
    expect(t.acks()).toEqual([{ type: 'capture_ack', req: 'r1', ok: false, reason: 'not_signed_in' }])
    expect(useComposerStore.getState().dropped).toEqual({})
    expect(t.nav).not.toHaveBeenCalled()
  })

  it('bytes that are not a PNG: answered bad_image', async () => {
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    await t.bridge.receive(drop({ data_b64: btoa('GIF89a..') }))
    expect(t.acks()).toEqual([{ type: 'capture_ack', req: 'r1', ok: false, reason: 'bad_image' }])
    expect(captureFile({ data_b64: '', width: 1, height: 1 })).toBeNull()
  })

  it('a PNG whose header states another size than the message, or no header at all: answered bad_image', async () => {
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    await t.bridge.receive(drop({ req: 'a1', data_b64: pngB64(20_000, 20_000) }))
    await t.bridge.receive(
      drop({ req: 'b2', data_b64: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) }),
    )
    expect(t.acks().map((m) => m.reason)).toEqual(['bad_image', 'bad_image'])
    expect(captureFile({ data_b64: PNG_B64, width: 100, height: 80 })).not.toBeNull()
  })

  it('a sign-out while it waits wipes it: answered not_signed_in, never ok', async () => {
    const t = setup()
    noteViewedThread('trip')
    const sent: unknown[] = []
    const done = handleCaptureDrop(drop(), {
      client: t.client,
      signedIn: () => true,
      nav: t.nav,
      send: (a) => sent.push(a),
    })
    expect(dropped('trip')).toHaveLength(1)
    resetComposer() // what a sign-out does
    await done
    expect(sent).toEqual([{ type: 'capture_ack', req: 'r1', ok: false, reason: 'not_signed_in' }])
  })

  it('already on that thread: no extra history entry', async () => {
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    noteViewedThread('trip')
    history.replaceState(null, '', '/t/trip')
    const answer = t.bridge.receive(drop())
    composerTakes('trip')
    await answer
    expect(t.nav).not.toHaveBeenCalled()
    history.replaceState(null, '', '/')
  })

  it('a message that is not valid (too big, a window title) is refused by the bridge before any handler runs', () => {
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    expect(t.bridge.receive(drop({ window_title: 'Mail' }))).toBe(false)
    expect(t.bridge.receive(drop({ mime: 'image/jpeg' }))).toBe(false)
    expect(useComposerStore.getState().dropped).toEqual({})
  })

  it('a composer that never takes it in time: answered no_thread, and the image is taken back', async () => {
    vi.useFakeTimers()
    const t = setup()
    noteViewedThread('trip')
    const sent: unknown[] = []
    const done = handleCaptureDrop(drop(), {
      client: t.client,
      signedIn: () => true,
      nav: t.nav,
      send: (a) => sent.push(a),
      takeMs: 1000,
    })
    expect(dropped('trip')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(sent).toEqual([{ type: 'capture_ack', req: 'r1', ok: false, reason: 'no_thread' }])
    expect(dropped('trip')).toHaveLength(0)
    // the focus request went with it: a later ordinary drop does not take the focus
    expect(useComposerStore.getState().takeDropFocus('trip')).toBe(false)
  })

  it('a second capture while the first waits: each is answered for its own req', async () => {
    const t = setup()
    attachShell(t.shell, t.client, { nav: t.nav })
    noteViewedThread('trip')
    const a = t.bridge.receive(drop({ req: 'a1' }))
    const b = t.bridge.receive(drop({ req: 'b2' }))
    expect(dropped('trip')).toHaveLength(2)
    composerTakes('trip')
    await Promise.all([a, b])
    expect(t.acks().map((m) => m.req)).toEqual(['a1', 'b2'])
    expect(t.acks().every((m) => m.ok === true)).toBe(true)
  })
})
