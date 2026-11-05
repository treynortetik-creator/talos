// D40: "Your Mac is offline" used to be one line with no cause and no next step, a refused key was invisible, and Home
// could show two banners for one problem. One shared function (rows.ts macMessage) words every state; Banners (presence)
// and HealthBanner (status) share it, so each state shows exactly one banner. Driven through the real components.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bannerFor, MAC_GONE_MS, macMessage, presenceMacState } from '../../src/features/health/rows.ts'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { statusOf } from './status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NOW = Date.parse('2026-10-29T20:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('macMessage / presenceMacState', () => {
  it('every state names a cause and a next step, and no two states share a cause', () => {
    const kinds = ['dropped', 'asleep', 'key_refused', 'mod_quiet'] as const
    const msgs = kinds.map((k) => macMessage(k, { lastSeen: iso(60_000), nowMs: NOW }))
    for (const m of msgs) {
      expect(m.cause.length).toBeGreaterThan(10)
      expect(m.next.length).toBeGreaterThan(10)
    }
    expect(new Set(msgs.map((m) => m.cause)).size).toBe(4)
    expect(macMessage('asleep', { lastSeen: iso(3600_000), nowMs: NOW }).cause).toContain('last seen 1 h ago')
    expect(macMessage('key_refused').cause).toMatch(/key/)
    expect(macMessage('key_refused').next).toMatch(/talos-app doctor/)
    // for a non-engineer: no markdown backticks and no variable name; the command prints the line itself
    expect(macMessage('key_refused').next).not.toMatch(/`|BRIDGE_PUBKEY/)
  })
  it('just dropped turns into asleep after five minutes; online is nothing', () => {
    expect(presenceMacState(true, iso(10 * 60_000), NOW)).toBeNull()
    expect(presenceMacState(false, iso(60_000), NOW)).toBe('dropped')
    expect(presenceMacState(false, iso(MAC_GONE_MS + 1000), NOW)).toBe('asleep')
    expect(presenceMacState(false, null, NOW)).toBe('asleep')
  })
  it('bannerFor: a refused key shows even in the quiet window, only while offline', () => {
    const refused = statusOf({
      bridge: { online: false, last_seen: iso(3600_000), down_since: null, auth_refused_at: iso(5000) },
    })
    expect(bannerFor(refused, true)?.kind).toBe('key_refused')
    const online = statusOf({
      bridge: { online: true, last_seen: iso(0), down_since: null, auth_refused_at: iso(5000) },
    })
    expect(bannerFor(online, false)).toBeNull()
  })
})

function stubStatus(body: unknown | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      body === null ? new Response('nope', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 }),
    ),
  )
}

function mount(presence: { online: boolean; lastSeen: string | null }) {
  const client = createFakeClient()
  client.store.setState({
    connection: 'online',
    presence: { ...client.store.getState().presence, bridge_online: presence.online, last_seen: presence.lastSeen },
  })
  return render(
    <MemoryRouter>
      <ClientProvider client={client}>
        <Banners />
      </ClientProvider>
    </MemoryRouter>,
  )
}
const statuses = () => screen.queryAllByRole('status').filter((n) => n.getAttribute('data-kind') !== null)

describe('Banners + HealthBanner: one banner per state', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('just dropped: one presence banner with cause and next step', async () => {
    stubStatus(
      statusOf({
        bridge: { online: false, last_seen: new Date().toISOString(), down_since: new Date().toISOString() },
      }),
    )
    mount({ online: false, lastSeen: new Date(Date.now() - 30_000).toISOString() })
    await waitFor(() => expect(screen.getByTestId('mac-banner')).toBeTruthy())
    expect(screen.getByTestId('mac-banner').getAttribute('data-kind')).toBe('dropped')
    expect(screen.getByText(/just dropped/)).toBeTruthy()
    expect(screen.getByText(/comes back on its own/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(statuses()).toHaveLength(1)
  })

  it('asleep or session stopped: the health banner owns it and the presence banner steps aside', async () => {
    const long = new Date(Date.now() - 3600_000).toISOString()
    stubStatus(
      statusOf({
        at: new Date().toISOString(),
        mac_problems: ['bridge_offline'],
        bridge: { online: false, last_seen: long, down_since: long },
      }),
    )
    mount({ online: false, lastSeen: long })
    await waitFor(() => expect(screen.getByTestId('health-banner')).toBeTruthy())
    expect(screen.getByTestId('health-banner').getAttribute('data-kind')).toBe('bridge_offline')
    expect(screen.getByText(/probably asleep/)).toBeTruthy()
    expect(screen.queryByTestId('mac-banner')).toBeNull()
    expect(statuses()).toHaveLength(1)
  })

  it('key refused: says so, once, with the next step', async () => {
    const long = new Date(Date.now() - 3600_000).toISOString()
    stubStatus(
      statusOf({
        at: new Date().toISOString(),
        bridge: { online: false, last_seen: long, down_since: long, auth_refused_at: new Date().toISOString() },
      }),
    )
    mount({ online: false, lastSeen: new Date(Date.now() - 20_000).toISOString() })
    await waitFor(() => expect(screen.getByTestId('health-banner').getAttribute('data-kind')).toBe('key_refused'))
    expect(screen.getByText(/turned away its key/)).toBeTruthy()
    expect(screen.getByText(/talos-app doctor/)).toBeTruthy()
    expect(screen.queryByTestId('mac-banner')).toBeNull()
    expect(statuses()).toHaveLength(1)
  })

  it('a refusal on file while the Mac is online shows nothing', async () => {
    stubStatus(statusOf({ at: new Date().toISOString() }))
    mount({ online: true, lastSeen: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 100))
    expect(statuses()).toHaveLength(0)
  })

  it('mod quiet: its own banner', async () => {
    stubStatus(statusOf({ at: new Date().toISOString(), mac_problems: ['mod_quiet'] }))
    mount({ online: true, lastSeen: new Date().toISOString() })
    await waitFor(() => expect(screen.getByTestId('health-banner').getAttribute('data-kind')).toBe('mod_quiet'))
    expect(screen.getByText('Your mod stopped reporting.')).toBeTruthy()
    expect(screen.getByText(/Talos mod loaded/)).toBeTruthy()
  })

  it('the status call failing leaves the presence banner (nothing silent)', async () => {
    stubStatus(null)
    mount({ online: false, lastSeen: new Date(Date.now() - 3600_000).toISOString() })
    await waitFor(() => expect(screen.getByTestId('mac-banner').getAttribute('data-kind')).toBe('asleep'))
    expect(screen.queryByTestId('health-banner')).toBeNull()
  })
})
