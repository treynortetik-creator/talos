// WP-V0 web seams: featureState, Cmd+K, v2 routes + placeholders, the ?m= switch, the fake Search/Memory clients, and
// ready.features -> ClientState.relayFeatures.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { useGlobalKeys } from '../../src/lib/useKeyboard.ts'
import { featureState } from '../../src/lib/v2Client.ts'

afterEach(cleanup)

const base = { bridge_online: false, last_seen: null, queue_depth: 0 }

describe('featureState', () => {
  it('relay features are on with the bridge offline', () => {
    expect(featureState(base, ['health/1', 'share/1'], 'health/1')).toBe('on')
    expect(featureState(base, ['health/1', 'share/1'], 'share/1')).toBe('on')
    expect(featureState(base, [], 'health/1')).toBe('off')
  })
  it('bridge features: on when online and listed', () => {
    const p = { ...base, bridge_online: true, features: ['search/1'], features_at: '2026-10-28T15:00:00.000Z' }
    expect(featureState(p, [], 'search/1')).toBe('on')
    expect(featureState(p, [], 'memory/1')).toBe('off')
  })
  it('bridge features: needs_mac when offline with a last-known list, off when never seen', () => {
    const p = { ...base, features: ['search/1'], features_at: '2026-10-28T15:00:00.000Z' }
    expect(featureState(p, [], 'search/1')).toBe('needs_mac')
    expect(featureState(p, [], 'memory/1')).toBe('off')
    expect(featureState(base, [], 'search/1')).toBe('off')
  })
})

function Keys({ onAction, mac }: { onAction: (id: string) => void; mac: boolean }) {
  useGlobalKeys({ onAction: (e) => onAction(e.id) }, { mac })
  return null
}
describe('Cmd+K', () => {
  const press = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }))
  it('Cmd+K opens the palette on a Mac and Ctrl+K elsewhere; Cmd+Shift+K still calls and does not', () => {
    const onAction = vi.fn()
    const off = render(<Keys onAction={onAction} mac />)
    press({ code: 'KeyK', key: 'k', metaKey: true })
    press({ code: 'KeyK', key: 'k', ctrlKey: true })
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['palette'])
    press({ code: 'KeyK', key: 'K', metaKey: true, shiftKey: true })
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['palette', 'call'])
    press({ code: 'KeyK', key: 'k', metaKey: true, altKey: true })
    expect(onAction).toHaveBeenCalledTimes(2)
    off.unmount()
    render(<Keys onAction={onAction} mac={false} />)
    press({ code: 'KeyK', key: 'k', ctrlKey: true })
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['palette', 'call', 'palette'])
  })
})

describe('fake SearchClient and MemoryClient', () => {
  it('finds a seeded message case- and accent-insensitively, with marks', async () => {
    const c = createFakeClient()
    await c.sendMessage({ threadId: 'general', text: 'Meet at the Café before the résumé review' })
    const filters = { thread_ids: [], from: 'any' as const, has_file: null, after: null, before: null }
    const res = await c.search?.search({ q: 'CAFE resume', filters, sort: 'newest', cursor: null, limit: 20 })
    expect(res?.hits.length).toBeGreaterThanOrEqual(1)
    const hit = res?.hits[0]
    expect(hit?.match_in).toBe('text')
    expect(hit?.marks.length).toBeGreaterThan(0)
    const none = await c.search?.search({ q: 'zzzqqq', filters, sort: 'newest', cursor: null, limit: 20 })
    expect(none?.hits).toEqual([])
  })
  it('context returns messages around an id', async () => {
    const c = createFakeClient()
    const ctx = await c.search?.context('general', { aroundId: 'm_01JBF3V7Q8K2M4N6P8R0S2T4AA' })
    expect(ctx?.messages.map((m) => m.id)).toContain('m_01JBF3V7Q8K2M4N6P8R0S2T4AA')
  })
  it('memory tree, read and search over a tiny tree; unknown paths reject', async () => {
    const c = createFakeClient()
    const roots = await c.memory?.tree(null, '', null)
    expect(roots?.roots?.map((r) => r.id)).toContain('notes')
    const top = await c.memory?.tree('notes', '', null)
    expect(top?.entries.some((e) => e.type === 'file')).toBe(true)
    const file = top?.entries.find((e) => e.type === 'file')
    const read = await c.memory?.read('notes', file?.path ?? '', 0)
    expect(read?.text.length).toBeGreaterThan(0)
    const found = await c.memory?.search('GROCERIES', [], null, 10)
    expect(found?.hits.length).toBeGreaterThan(0)
    await expect(c.memory?.read('notes', 'nope.md', 0)).rejects.toBeInstanceOf(TalosClientError)
  })
  it('presence shows search and memory on in fake mode', async () => {
    const c = createFakeClient()
    const p = c.store.getState().presence
    expect(featureState(p, c.store.getState().relayFeatures, 'search/1')).toBe('on')
    expect(featureState(p, c.store.getState().relayFeatures, 'memory/1')).toBe('on')
  })
})

describe('routes (fake mode, real App)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_FAKE', '1')
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
  })
  afterEach(() => vi.unstubAllEnvs())

  async function mount(url: string, opts: { macOffline?: boolean } = {}) {
    window.history.pushState({}, '', url)
    const { App } = await import('../../src/App.tsx')
    const { createFakeClient: mk } = await import('../../src/lib/fakeClient.ts')
    const { createMemoryStorage } = await import('../../src/lib/storage.ts')
    render(<App client={mk(opts)} storage={createMemoryStorage()} />)
  }

  it.each([
    ['/memory', 'Memory'],
    ['/memory/notes/todo.md', 'Memory'],
  ])('%s renders its placeholder', async (url, heading) => {
    await mount(url)
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeTruthy()
  })

  it('/settings/health renders the real Health screen (WP-V1), a level-2 heading under Settings', async () => {
    await mount('/settings/health')
    expect(await screen.findByRole('heading', { name: 'Health', level: 2 })).toBeTruthy()
  })

  it('/search mounts the real SearchScreen (a search box, not a placeholder)', async () => {
    await mount('/search')
    expect(await screen.findByRole('searchbox', { name: 'Search messages' })).toBeTruthy()
    expect(screen.queryByTestId('placeholder-search')).toBeNull()
  })

  it('health and share work with the Mac offline (no "Needs your Mac")', async () => {
    await mount('/share', { macOffline: true })
    // WP-V4 replaced the placeholder with the real /share page
    expect(await screen.findByRole('heading', { name: /^Share to /, level: 1 })).toBeTruthy()
    expect(screen.queryByText(/Needs your Mac/)).toBeNull()
  })

  it('search shows "Needs your Mac" when the Mac is offline', async () => {
    await mount('/search', { macOffline: true })
    expect(await screen.findByText(/Needs your Mac/)).toBeTruthy()
  })

  it('/t/general?m=<valid id> renders ContextView and Jump to latest drops ?m', async () => {
    await mount('/t/general?m=m_01JBF3V7Q8K2M4N6P8R0S2T4AA')
    expect(await screen.findByText('Showing a past conversation')).toBeTruthy()
    expect(screen.queryByTestId('thread-screen')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(await screen.findByTestId('thread-screen')).toBeTruthy()
  })

  it('/t/general without ?m renders the normal thread; a bad ?m is ignored', async () => {
    await mount('/t/general?m=garbage')
    expect(await screen.findByTestId('thread-screen')).toBeTruthy()
    expect(screen.queryByText('Showing a past conversation')).toBeNull()
  })
})
