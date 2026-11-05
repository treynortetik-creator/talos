// Third round of push regression tests, web side. Each test pins a bug that was found and fixed, unless its name says
// "control". The real App, routes
// and Gate. i5-review-2 seeds the card before mount, so it never meets the case that matters most: a push fires because the
// app is not open, so the card is NOT on the phone yet when the tap lands.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeCard } from '../cards/helpers.tsx'

vi.setConfig({ testTimeout: 30_000 })

const long = { timeout: 10_000 }
const settle = (ms = 100) => act(() => new Promise<void>((r) => setTimeout(r, ms)))

beforeEach(() => {
  vi.resetModules()
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {} // jsdom has none; Timeline scrolls to the highlighted card
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

type Card = ReturnType<typeof makeCard>

/** A decided card stays in the saved snapshot (socketClient `pickSnapshot`, and `ready` keeps every non-pending card). */
const decided = () => makeCard({ state: 'resolved' })

/** The app as socketClient.ts:1178 leaves it after a restart: the saved snapshot on screen, the socket not ready yet. */
async function coldStart(url: string, snapshot: Card[], arm?: string) {
  vi.stubEnv('VITE_FAKE', '1')
  window.history.pushState({}, '', url)
  const { App } = await import('../../src/App.tsx')
  const { createFakeClient } = await import('../../src/lib/fakeClient.ts')
  const { createMemoryStorage } = await import('../../src/lib/storage.ts')
  const client = createFakeClient()
  client.store.setState((s) => ({ ...s, cards: snapshot, connection: 'connecting' }))
  const stepup = vi.spyOn(client, 'stepup')
  // Since the decision to keep the arm out of URLs, the native shell arms the card in memory (onNativePushAction).
  if (arm) (await import('../../src/features/cards/arm.tsx')).armCard(arm)
  render(<App client={client} storage={createMemoryStorage()} />)
  /** `ready` lands: the connection state first, then the cards, as socketClient.ts:859-860 does it. */
  const ready = (cards: Card[]) =>
    act(async () => {
      client.store.setState((s) => ({ ...s, connection: 'online' }))
      client.store.setState((s) => ({ ...s, cards }))
    })
  return { ready, stepup }
}

describe('I5-R14 a tap on a card the phone has not received yet', () => {
  it('R14 Open waits for the connection and opens the card, with an older card in the snapshot', async () => {
    const older = decided()
    const fresh = makeCard()
    const { ready } = await coldStart(`/card/${fresh.id}`, [older])
    await settle()
    expect(window.location.pathname).toBe(`/card/${fresh.id}`)
    await ready([older, fresh])
    await screen.findByRole('button', { name: /Send/ }, long)
    expect(window.location.pathname).toBe(`/card/${fresh.id}`)
  })

  it('control: with an empty snapshot Open waits and opens the card', async () => {
    const fresh = makeCard()
    const { ready } = await coldStart(`/card/${fresh.id}`, [])
    await settle()
    await ready([fresh])
    await screen.findByRole('button', { name: /Send/ }, long)
    expect(window.location.pathname).toBe(`/card/${fresh.id}`)
  })

  it('control: Approve on a card that arrives late starts Face ID exactly once', async () => {
    const older = decided()
    const fresh = makeCard({ risk: 'high' })
    const { ready, stepup } = await coldStart(`/card/${fresh.id}`, [older], fresh.id)
    await settle()
    await ready([older, fresh])
    await waitFor(() => expect(stepup).toHaveBeenCalledWith(`card:${fresh.id}`), long)
    await settle(600)
    expect(stepup).toHaveBeenCalledTimes(1)
  })
})

describe('I5-R15 Approve on a card that never arrives', () => {
  it('R15 the card was decided elsewhere: the owner lands on the start page, not a blank page', async () => {
    const older = decided()
    const gone = makeCard({ risk: 'high' })
    const { ready, stepup } = await coldStart(`/card/${gone.id}`, [older], gone.id)
    await settle()
    await ready([older])
    await waitFor(() => expect(window.location.pathname).toBe('/'), long)
    expect(window.location.search).toBe('')
    await waitFor(() => expect(document.querySelector('main')?.childElementCount).toBeGreaterThan(0), long)
    await settle(600)
    expect(stepup).not.toHaveBeenCalled()
  })
})

describe('I5-R16 moving around the app', () => {
  const TOKEN = 'ab'.repeat(32)

  /** The real Gate (no VITE_FAKE), a fake iPhone shell, a fake relay that holds this phone's token. */
  async function signedInOnAPhone() {
    vi.stubEnv('VITE_FAKE', '0')
    vi.stubGlobal('top', globalThis) // jsdom's window.top is not vitest's global; isNativeShell asks for the top frame
    const asked = { register: 0 }
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        TalosPush: {
          getStatus: async () => ({ permission: 'granted' }),
          register: async () => {
            asked.register += 1
            return { token: TOKEN, env: 'sandbox' }
          },
          unregister: async () => {},
          addListener: async () => ({ remove() {} }),
        },
      },
    })
    const posted: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'https://relay.example.com').pathname
        if (path === '/api/me') return Response.json({ device_pinned: true })
        if (path === '/api/push/apns') {
          if (init?.method === 'POST') {
            posted.push(String(init.body))
            return new Response(null, { status: 204 })
          }
          return Response.json({ configured: true, registered: true })
        }
        return Response.json({ error: 'not_found' }, { status: 404 })
      }),
    )
    window.history.pushState({}, '', '/')
    const { App } = await import('../../src/App.tsx')
    const { createFakeClient } = await import('../../src/lib/fakeClient.ts')
    const { createMemoryStorage } = await import('../../src/lib/storage.ts')
    const { createMetaStore } = await import('../../src/lib/connectionMeta.ts')
    const client = Object.assign(createFakeClient(), {
      meta: createMetaStore(),
      ensureDevice: async () => ({}),
      deviceKey: async () => ({}),
      start: async () => {},
    })
    render(<App client={client} storage={createMemoryStorage()} />)
    return { posted, asked }
  }

  const go = (path: string) =>
    act(async () => {
      window.history.pushState({}, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

  it('R16 five route changes post no further token registration', async () => {
    const { posted, asked } = await signedInOnAPhone()
    // The open itself registers once, so a pass below cannot mean the refresh never ran.
    await waitFor(() => expect(posted).toHaveLength(1), long)
    for (const path of ['/threads', '/t/general', '/schedules', '/t/inbox', '/']) {
      await go(path)
      await settle(50)
    }
    await settle(200)
    expect(posted).toHaveLength(1)
    expect(asked.register).toBe(1)
  })
})
