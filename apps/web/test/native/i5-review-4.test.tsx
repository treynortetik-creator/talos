// Fourth pass on PR #92 (WP-I5), web side: a stale 'online' after a warm resume, the native badge on resume, and the
// Settings note that outlives its row state.
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
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('a warm resume: the connection still reads online, but no ready has landed since the tap', () => {
  async function warm(url: string) {
    vi.stubEnv('VITE_FAKE', '1')
    window.history.pushState({}, '', url)
    const { App } = await import('../../src/App.tsx')
    const { createFakeClient } = await import('../../src/lib/fakeClient.ts')
    const { createMemoryStorage } = await import('../../src/lib/storage.ts')
    const client = createFakeClient()
    client.store.setState((s) => ({ ...s, connection: 'online', readySeq: 3 }))
    render(<App client={client} storage={createMemoryStorage()} />)
    return client
  }

  it('the card arrives with the next ready: the owner is not sent home first', async () => {
    const fresh = makeCard()
    const client = await warm(`/card/${fresh.id}`)
    await settle(600)
    expect(window.location.pathname).toBe(`/card/${fresh.id}`)
    await act(async () => {
      client.store.setState((s) => ({ ...s, readySeq: 4, cards: [fresh] }))
    })
    await screen.findByRole('button', { name: /Send/ }, long)
    expect(window.location.pathname).toBe(`/card/${fresh.id}`)
  })

  it('a warm tap from one card to another starts the wait again for the new card', async () => {
    const first = makeCard()
    const next = makeCard()
    const client = await warm(`/card/${first.id}`)
    await act(async () => {
      client.store.setState((s) => ({ ...s, readySeq: 4, cards: [first] }))
    })
    await screen.findByRole('button', { name: /Send/ }, long)
    await act(async () => {
      window.history.pushState({}, '', `/card/${next.id}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await settle(600)
    expect(window.location.pathname).toBe(`/card/${next.id}`)
  })

  it('a card that is really gone sends the owner to the start page once the wait is up', async () => {
    const gone = makeCard()
    await warm(`/card/${gone.id}`)
    await waitFor(() => expect(window.location.pathname).toBe('/'), long)
  })
})

describe('the icon badge after a suspended reopen', () => {
  it('sends the count again when the app returns to the front', async () => {
    const { startNativeBadge } = await import('../../src/features/native/badge.ts')
    const { createFakeClient } = await import('../../src/lib/fakeClient.ts')
    const calls: number[] = []
    const scope = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosPush: { setBadge: async (a: { count: number }) => calls.push(a.count) } },
      },
    }
    const client = createFakeClient()
    client.store.setState((s) => ({ ...s, cards: [] }))
    const off = startNativeBadge(client, scope)
    const before = calls.length
    document.dispatchEvent(new Event('visibilitychange'))
    expect(calls.length).toBeGreaterThan(before)
    off()
  })
})

describe('the Settings note belongs to the row state it was written under', () => {
  it('Blocked does not keep "Notifications are on." under it', async () => {
    const m = await import('../../src/features/pwa/nativePush.ts')
    const scope = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosPush: { getStatus: async () => ({ permission: 'denied' }), register: async () => ({}) } },
      },
      top: undefined as unknown,
    }
    scope.top = scope
    const http = { get: async () => ({ configured: true, registered: true }), post: async () => ({}) }
    m.useNativePush.setState({ view: { kind: 'on' }, note: 'Notifications are on.' })
    // biome-ignore lint/suspicious/noExplicitAny: a minimal http double
    const view = await m.refreshNativePush({ client: {} as any, http: http as any, scope })
    expect(view.kind).toBe('blocked')
    expect(m.useNativePush.getState().note).toBeNull()
  })
})
