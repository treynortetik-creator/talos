// R2: small daily fixes on Home, Search, Inbox and agent text (audit D28, D29, D20, D19, D27, D34).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { HomeScreen, loadSnoozed, saveSnoozed } from '../../src/features/home/HomeScreen.tsx'
import { SETUP_DISMISSED_KEY } from '../../src/features/home/SetupCard.tsx'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { PhoneChrome } from '../../src/features/phone/PhoneChrome.tsx'
import { usePhonePanel } from '../../src/features/phone/phoneStore.ts'
import * as nativePushMod from '../../src/features/pwa/nativePush.ts'
import { useNativePush } from '../../src/features/pwa/nativePush.ts'
import { usePushState } from '../../src/features/pwa/push.ts'
import { SearchScreen } from '../../src/features/search/SearchScreen.tsx'
import { ThreadEditor } from '../../src/features/threads/manage/ThreadEditor.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { renderMarkdown } from '../../src/lib/markdown.ts'
import { AppErrorBoundary, CHUNK_RELOAD_FLAG, pageReload, RowErrorBoundary } from '../../src/ui/ErrorBoundary.tsx'
import { makeCard, makeItem, renderWith, setup } from '../cards/helpers.tsx'
import { replayClient } from '../search/replay.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  usePhonePanel.setState({ open: null, path: '', thread: null })
  usePushState.setState({ permission: 'default', busy: false, message: null })
  useNativePush.setState({ view: { kind: 'hidden' }, busy: false, note: null })
  useComposerStore.setState({ prefill: {} })
})

const threadIds = (req: Record<string, unknown> | undefined): string[] =>
  ((req?.filters ?? {}) as { thread_ids?: string[] }).thread_ids ?? ['<no request>']

function Boom({ msg }: { msg: string }): never {
  throw new Error(msg)
}

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

// ---- D28 ----
describe('D28: Home snooze survives leaving the screen', () => {
  const card = () => makeCard({ title: 'Reply to venue' })

  it('a snoozed row is still snoozed after the screen is left and opened again', async () => {
    const client = setup({ cards: [card()] })
    const first = renderWith(<HomeScreen />, client)
    expect(screen.getByRole('tab', { name: 'Needs you (1)' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /More actions for Reply to venue/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    expect(screen.getByRole('tab', { name: 'Needs you (0)' })).toBeTruthy()
    first.unmount()
    renderWith(<HomeScreen />, client)
    expect(screen.getByRole('tab', { name: 'Needs you (0)' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Up next (1)' })).toBeTruthy()
  })

  it('drops entries that have run out, and survives a broken store', () => {
    const now = Date.parse('2026-10-28T16:00:00.000Z')
    localStorage.setItem('talos.home.snoozed', JSON.stringify({ old: now - 1, live: now + 1000, bad: 'x' }))
    expect([...loadSnoozed(now)]).toEqual([['live', now + 1000]])
    saveSnoozed(
      new Map([
        ['old', now - 1],
        ['live', now + 1000],
      ]),
      now,
    )
    expect(JSON.parse(localStorage.getItem('talos.home.snoozed') ?? '{}')).toEqual({ live: now + 1000 })
    localStorage.setItem('talos.home.snoozed', '{not json')
    expect(loadSnoozed(now).size).toBe(0)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadSnoozed(now).size).toBe(0)
    expect(() => saveSnoozed(new Map([['a', now + 5]]), now)).not.toThrow()
  })

  it('Home still renders and snoozes when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderWith(<HomeScreen />, setup({ cards: [card()] }))
    await userEvent.click(screen.getByRole('button', { name: /More actions for Reply to venue/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    expect(screen.getByRole('tab', { name: 'Up next (1)' })).toBeTruthy()
  })
})

// ---- D29 ----
describe('D29: Search is easy to reach', () => {
  it('Home says when nothing matches and offers Search all messages with the query', async () => {
    renderWith(<HomeScreen />, setup({ cards: [makeCard({ title: 'Reply to venue' })] }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzzz')
    expect(screen.getByTestId('home-no-match').textContent).toMatch(/Nothing here matches “zzzz”/)
    await userEvent.click(screen.getByRole('link', { name: 'Search all messages' }))
    expect(screen.getByTestId('location').textContent).toBe('/search')
  })

  it('the Search all messages link carries ?q= (encoded)', async () => {
    renderWith(<HomeScreen />, setup({ cards: [makeCard({ title: 'Reply to venue' })] }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'a&b zz')
    expect(screen.getByRole('link', { name: 'Search all messages' }).getAttribute('href')).toBe('/search?q=a%26b%20zz')
  })

  it('a query that matches does not show the no-match line', async () => {
    renderWith(<HomeScreen />, setup({ cards: [makeCard({ title: 'Reply to venue' })] }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'venue')
    expect(screen.queryByTestId('home-no-match')).toBeNull()
    expect(screen.getByText('Reply to venue')).toBeTruthy()
  })

  function mountSearch(url: string) {
    const replay = replayClient()
    const client = Object.assign(createFakeClient(), { search: replay })
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="search" element={<SearchScreen />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ClientProvider>,
    )
    return replay
  }

  it('/search?q=release runs that search on arrival', async () => {
    const replay = mountSearch('/search?q=release')
    expect(((await screen.findByRole('searchbox', { name: 'Search messages' })) as HTMLInputElement).value).toBe(
      'release',
    )
    await waitFor(() => expect(replay.asked[0]?.q).toBe('release'), { timeout: 3000 })
  })

  it('/search?q=release&thread=general searches that thread only', async () => {
    const replay = mountSearch('/search?q=release&thread=general')
    await waitFor(() => expect(replay.asked.length).toBeGreaterThan(0), { timeout: 3000 })
    expect(threadIds(replay.asked[0])).toEqual(['general'])
    expect((screen.getByRole('combobox', { name: 'Thread' }) as HTMLSelectElement).value).toBe('general')
  })

  it('a second link into /search while it is open replaces the box and the thread', async () => {
    const replay = replayClient()
    const client = Object.assign(createFakeClient(), { search: replay })
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/search?q=zzzz&thread=general']}>
          <Routes>
            <Route path="search" element={<SearchScreen />} />
          </Routes>
          <Link to="/search?q=release">again</Link>
        </MemoryRouter>
      </ClientProvider>,
    )
    const box = (await screen.findByRole('searchbox', { name: 'Search messages' })) as HTMLInputElement
    expect(box.value).toBe('zzzz')
    await userEvent.click(screen.getByRole('link', { name: 'again' }))
    await waitFor(() => expect(box.value).toBe('release'))
    expect((screen.getByRole('combobox', { name: 'Thread' }) as HTMLSelectElement).value).toBe('')
  })

  it('an unknown thread id is dropped instead of silently filtering', async () => {
    const replay = mountSearch('/search?q=release&thread=nope')
    await waitFor(() => expect(replay.asked.length).toBeGreaterThan(0), { timeout: 3000 })
    expect(threadIds(replay.asked.at(-1))).toEqual([])
  })

  it('the phone menu has no thread card: search is the magnifier in the list row, and there is no "Search this thread" link', async () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('max-width: 767px'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    usePhonePanel.setState({ open: 'menu', path: '/t/general', thread: 'general' })
    renderWith(<PhoneChrome />, setup(), '/t/general', '/t/:thread')
    const menu = await screen.findByTestId('phone-menu')
    expect(within(menu).queryByTestId('phone-menu-current')).toBeNull()
    expect(within(menu).queryByText('Search this thread')).toBeNull()
    expect(within(menu).queryByRole('link', { name: /^Search/ })).toBeNull()
    expect(within(menu).getByRole('button', { name: 'Search threads' })).toBeTruthy()
    // the thread on screen is an ordinary row now, with its own settings button
    expect(within(menu).getByRole('link', { name: /^General/ })).toBeTruthy()
  })

  it('the thread settings menu has Search this thread, which opens /search?thread=', async () => {
    const client = setup()
    const thread = client.store.getState().threads.find((t) => t.id === 'general')
    if (!thread) throw new Error('no general thread')
    const view = render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/t/general']}>
          <ThreadEditor open onOpenChange={() => {}} thread={thread} />
          <Where />
        </MemoryRouter>
      </ClientProvider>,
    )
    await userEvent.click(await view.findByRole('button', { name: 'Search this thread' }))
    expect(screen.getByTestId('where').textContent).toBe('/search?thread=general')
  })
})

// ---- D20 ----
describe('D20: Inbox Ask Talos keeps the item', () => {
  it('prefills the default thread composer and goes there', async () => {
    const client = setup({ inbox: [makeItem({ title: 'Invoice question' })] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('Invoice question'))
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Talos' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/t/general'))
    expect(useComposerStore.getState().prefill.general).toEqual({ text: 're: Invoice question', mode: 'replace' })
  })
})

// ---- D19 ----
describe('D19: the setup card', () => {
  // The card now reads the real permission on mount; give the browser one that can still be asked.
  beforeEach(async () => {
    const platform = await import('../../src/lib/platform.ts')
    vi.spyOn(platform, 'getPlatform').mockReturnValue({
      push: { permission: () => 'default', subscribe: async () => null, resubscribe: async () => null },
    } as never)
  })

  it('shows when notifications are off, enables only on the tap, and links to Settings', async () => {
    renderWith(<HomeScreen />, setup())
    const card = screen.getByTestId('setup-card')
    expect(usePushState.getState().busy).toBe(false) // nothing asked for permission by showing it
    await userEvent.click(within(card).getByRole('button', { name: 'Open Settings' }))
    expect(screen.getByTestId('location').textContent).toBe('/settings/notifications') // U13: lands on the setting itself
  })

  it('the Turn on button is the only thing that starts enabling', async () => {
    const platform = await import('../../src/lib/platform.ts')
    const subscribe = vi.fn(async () => null)
    vi.spyOn(platform, 'getPlatform').mockReturnValue({
      push: { permission: () => 'default', subscribe, resubscribe: async () => null },
    } as never)
    renderWith(<HomeScreen />, setup())
    expect(subscribe).not.toHaveBeenCalled()
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'k')
    await userEvent.click(screen.getByTestId('setup-enable'))
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  })

  it('Not now hides it and stays hidden', async () => {
    const first = renderWith(<HomeScreen />, setup())
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('setup-card')).toBeNull()
    expect(localStorage.getItem(SETUP_DISMISSED_KEY)).toBe('1')
    first.unmount()
    renderWith(<HomeScreen />, setup())
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })

  it('is absent when notifications are already on, blocked or unsupported', async () => {
    const platform = await import('../../src/lib/platform.ts')
    for (const permission of ['granted', 'denied', 'unsupported'] as const) {
      vi.spyOn(platform, 'getPlatform').mockReturnValue({
        push: { permission: () => permission, subscribe: async () => null, resubscribe: async () => null },
      } as never)
      const v = renderWith(<HomeScreen />, setup())
      expect(screen.queryByTestId('setup-card')).toBeNull()
      v.unmount()
    }
  })

  it('in the iPhone app the native state decides: shows on off, hides on on', () => {
    useNativePush.setState({ view: { kind: 'off' } })
    const v = renderWith(<HomeScreen />, setup())
    expect(screen.getByTestId('setup-card')).toBeTruthy()
    act(() => useNativePush.setState({ view: { kind: 'on' } }))
    expect(screen.queryByTestId('setup-card')).toBeNull()
    v.unmount()
    usePushState.setState({ permission: 'default' }) // the web state must not matter inside the app
    useNativePush.setState({ view: { kind: 'blocked' } })
    renderWith(<HomeScreen />, setup())
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })
})

describe('D19 review: the card reads the truth when it mounts', () => {
  it('in the iPhone app a "checking" state is refreshed on mount, and the card appears once it says off', async () => {
    const refresh = vi.spyOn(nativePushMod, 'refreshNativePush').mockImplementation(async () => {
      useNativePush.setState({ view: { kind: 'off' } })
      return { kind: 'off' }
    })
    useNativePush.setState({ view: { kind: 'checking' } })
    renderWith(<HomeScreen />, setup())
    await waitFor(() => expect(screen.getByTestId('setup-card')).toBeTruthy())
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a failed enable in the app keeps the card and says why', async () => {
    vi.spyOn(nativePushMod, 'enableNativePush').mockImplementation(async () => {
      useNativePush.setState({ view: { kind: 'error', message: "Couldn't reach your server. Try again." } })
    })
    useNativePush.setState({ view: { kind: 'off' } })
    renderWith(<HomeScreen />, setup())
    await userEvent.click(screen.getByTestId('setup-enable'))
    const card = await screen.findByTestId('setup-card')
    expect(within(card).getByRole('status').textContent).toBe("Couldn't reach your server. Try again.")
  })

  it('a browser that already allows or lacks push does not flash the card', () => {
    usePushState.setState({ permission: 'default' }) // the stale start value
    renderWith(<HomeScreen />, setup()) // jsdom reports 'unsupported' on mount
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })

  it('the share-sheet sentence shows in the app only', async () => {
    const platform = await import('../../src/lib/platform.ts')
    vi.spyOn(platform, 'getPlatform').mockReturnValue({
      push: { permission: () => 'default', subscribe: async () => null, resubscribe: async () => null },
    } as never)
    renderWith(<HomeScreen />, setup())
    expect(screen.getByTestId('setup-card').textContent).not.toMatch(/share sheet/)
    cleanup()
    useNativePush.setState({ view: { kind: 'off' } })
    renderWith(<HomeScreen />, setup())
    expect(screen.getByTestId('setup-card').textContent).toMatch(/share sheet/)
  })
})

// ---- D27 ----
describe('D27: one automatic reload on a stale chunk', () => {
  const chunk = 'Failed to fetch dynamically imported module: /assets/x.js'

  it('reloads once, then falls back to the New version screen without looping', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    render(
      <AppErrorBoundary>
        <Boom msg={chunk} />
      </AppErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
    expect(Number(sessionStorage.getItem(CHUNK_RELOAD_FLAG))).toBeGreaterThan(0)
    cleanup()
    render(
      <AppErrorBoundary>
        <Boom msg={chunk} />
      </AppErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('New version available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(2) // the manual button still works
  })

  it('a stale chunk inside a timeline row reloads too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    render(
      <RowErrorBoundary>
        <Boom msg={chunk} />
      </RowErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a later deploy in the same tab gets its own reload; a failure right after one does not', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, String(Date.now() - 10 * 60_000))
    render(
      <AppErrorBoundary>
        <Boom msg={chunk} />
      </AppErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('an ordinary crash never auto-reloads', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    render(
      <AppErrorBoundary>
        <Boom msg="bad frame" />
      </AppErrorBoundary>,
    )
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByText('Something broke')).toBeTruthy()
  })

  it('without sessionStorage it does not reload (no way to guard a loop)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(
      <AppErrorBoundary>
        <Boom msg={chunk} />
      </AppErrorBoundary>,
    )
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByText('New version available')).toBeTruthy()
  })
})

// ---- D34 ----
describe('D34: images in agent text become link chips', () => {
  const dom = (src: string) => new DOMParser().parseFromString(renderMarkdown(src), 'text/html')

  it('an http image is a tappable chip, never an img', () => {
    const d = dom('![a chart of sales](https://cdn.example.com/x.png)')
    expect(d.querySelector('img')).toBeNull()
    const a = d.querySelector('a.md-image-chip')
    expect(a?.getAttribute('href')).toBe('https://cdn.example.com/x.png')
    expect(a?.textContent).toBe('Image: a chart of sales')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a?.getAttribute('target')).toBe('_blank')
  })

  it('a tracking pixel with no alt still shows as a chip and loads nothing', () => {
    const d = dom('![](https://t.example.com/p.gif?u=1)')
    expect(d.querySelector('img')).toBeNull()
    expect(d.querySelector('a.md-image-chip')?.textContent).toBe('Image: open')
  })

  it('a hostile or non-http image source gets no href', () => {
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '/relative.png', 'file:///etc/passwd']) {
      const d = dom(`![x](${src})`)
      expect(d.querySelector('img')).toBeNull()
      const href = d.querySelector('a')?.getAttribute('href') ?? null
      expect(href === null || /^https?:/i.test(href)).toBe(true)
      expect(href ?? '').not.toMatch(/javascript|data:|file:/i)
    }
  })

  it('an image inside a link keeps the link destination (a badge)', () => {
    const d = dom('[![Build](https://ci.example/badge.svg)](https://ci.example/run/42)')
    expect(d.querySelector('img')).toBeNull()
    const links = d.querySelectorAll('a')
    expect(links.length).toBe(1)
    expect(links[0]?.getAttribute('href')).toBe('https://ci.example/run/42')
    expect(links[0]?.textContent).toBe('Image: Build')
  })

  it('a long alt is clipped', () => {
    const d = dom(`![${'x'.repeat(200)}](https://a.example/i.png)`)
    expect((d.querySelector('a.md-image-chip')?.textContent ?? '').length).toBeLessThan(80)
  })

  it('raw HTML img is still just text', () => {
    expect(dom('<img src="https://a.example/i.png" onerror="x()">').querySelector('img')).toBeNull()
  })
})
