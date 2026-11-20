// Two bridges used one key. While the older one has not rejoined, the app says "bridge superseded" instead of a plain
// "offline", and while two bridges share the key it says another bridge connected. Driven through the real components.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bannerFor, macMessage, presenceMacState } from '../../src/features/health/rows.ts'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { onPresence } from '../../src/lib/socket-frames-threads.ts'
import { statusOf } from './status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NOW = Date.parse('2026-10-29T20:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('the words for a superseded bridge', () => {
  it('say "superseded", name what to do, and differ from every other offline state', () => {
    const m = macMessage('superseded', { lastSeen: iso(60_000), nowMs: NOW })
    expect(m.cause).toMatch(/took your (Mac|PC|computer)'s place/i)
    expect(m.next).toMatch(/rotate/)
    for (const k of ['dropped', 'asleep', 'key_refused', 'mod_quiet'] as const)
      expect(macMessage(k, { lastSeen: iso(60_000), nowMs: NOW }).cause).not.toBe(m.cause)
  })
  it('an offline Mac that was superseded is "superseded", however recently or long ago it was seen', () => {
    expect(presenceMacState(false, iso(60_000), NOW, true)).toBe('superseded')
    expect(presenceMacState(false, iso(3600_000), NOW, true)).toBe('superseded')
    expect(presenceMacState(true, iso(0), NOW, true)).toBeNull() // online: the notice below, not an offline state
    expect(presenceMacState(false, iso(60_000), NOW)).toBe('dropped') // unchanged without the flag
  })
  it('the health banner says superseded too, once the Mac has been gone long enough to alert', () => {
    const s = statusOf({
      mac_problems: ['bridge_offline'],
      bridge: { online: false, last_seen: iso(3600_000), down_since: iso(3600_000), superseded: true },
    })
    const b = bannerFor(s, false, NOW)
    expect(b?.kind).toBe('bridge_offline')
    expect(b?.text).toMatch(/took your (Mac|PC|computer)'s place/i)
  })
})

describe('the presence frame', () => {
  it('keeps the superseded mark', () => {
    let state: { presence?: unknown } = {}
    const ctx = {
      set: (fn: (s: typeof state) => typeof state) => {
        state = { ...state, ...fn(state) }
      },
    }
    onPresence(
      ctx as never,
      {
        bridge_online: false,
        last_seen: iso(1000),
        queue_depth: 0,
        superseded: true,
      } as never,
    )
    expect(state.presence).toMatchObject({ bridge_online: false, superseded: true })
  })
})

function mount(presence: { online: boolean; lastSeen: string | null; superseded?: boolean }) {
  const client = createFakeClient()
  client.store.setState({
    connection: 'online',
    presence: {
      ...client.store.getState().presence,
      bridge_online: presence.online,
      last_seen: presence.lastSeen,
      ...(presence.superseded ? { superseded: true } : {}),
    },
  })
  return render(
    <MemoryRouter>
      <ClientProvider client={client}>
        <Banners />
      </ClientProvider>
    </MemoryRouter>,
  )
}

describe('Banners', () => {
  it('offline and superseded: one banner that says superseded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    mount({ online: false, lastSeen: new Date(Date.now() - 30_000).toISOString(), superseded: true })
    await waitFor(() => expect(screen.getByTestId('mac-banner').getAttribute('data-kind')).toBe('superseded'))
    expect(screen.getByText(/took your (Mac|PC|computer)'s place/i)).toBeTruthy()
  })
  it('online while two bridges share the key: a notice that another bridge connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    mount({ online: true, lastSeen: new Date().toISOString(), superseded: true })
    await waitFor(() => expect(screen.getByTestId('bridge-notice')).toBeTruthy())
    expect(screen.getByTestId('bridge-notice').textContent).toMatch(/took your (Mac|PC|computer)'s place/i)
    expect(screen.queryByTestId('mac-banner')).toBeNull()
  })
  it('online and not superseded: no notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    mount({ online: true, lastSeen: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('bridge-notice')).toBeNull()
  })
})
