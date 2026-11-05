// Talos Help as the real components render it: the search, the Ask button, the About build lines in each state, the Settings
// row that opens it, and the Mac shell's navigate message landing on it. The fake client is the app's own in-memory client.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { LoginPage } from '../../src/features/auth/LoginPage.tsx'
import { useSession } from '../../src/features/auth/session.ts'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { POLL_MS } from '../../src/features/health/useHealthStatus.ts'
import { HELP_PATH } from '../../src/features/help/content.ts'
import { buildRows } from '../../src/features/help/HelpAbout.tsx'
import { HelpScreen, SEARCH_MAX } from '../../src/features/help/HelpScreen.tsx'
import { attachShell } from '../../src/features/native/attach.ts'
import { SettingsScreen } from '../../src/features/settings/SettingsScreen.tsx'
import { ClientProvider, initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import type { Shell } from '../../src/lib/native/shell.ts'
import { LocationProbe, setup } from '../cards/helpers.tsx'
import { statusOf } from '../health/status.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubStatus(answer: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/status')) return answer()
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function open(path = HELP_PATH) {
  const client = setup()
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={HELP_PATH} element={<HelpScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/t/:thread" element={<p>a thread</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </ClientProvider>,
  )
  return client
}

beforeEach(() => {
  localStorage.clear()
  useComposerStore.setState({ prefill: {} })
  useSession.setState({ status: 'authed' })
  Element.prototype.scrollIntoView = vi.fn()
  stubStatus(async () => json(statusOf()))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Help page', () => {
  it('shows every section, a contents list that moves focus to the heading, and no search count at rest', async () => {
    open()
    expect(await screen.findByRole('heading', { level: 1, name: 'Talos Help' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: 'Help contents' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Which settings is which',
      'Where do I change…',
      'First setup, in order',
      'Fix it',
      'Keyboard shortcuts',
      'What cannot be done',
      'About',
    ])
    expect(screen.getByTestId('help-count').textContent).toBe('')
    await userEvent.click(within(nav).getByRole('link', { name: 'Fix it' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Fix it' }))
  })

  it('search keeps only the rows that match, says how many, and opens the matching fix', async () => {
    open()
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search Help' }), 'quiet hours')
    const rows = screen.getAllByTestId('help-where-row')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.textContent?.toLowerCase()).toContain('quiet hours')
    expect(screen.getByTestId('help-count').textContent).toMatch(/^\d+ matching parts?\.$/)
    expect(screen.queryByRole('heading', { name: 'Keyboard shortcuts' })).toBeNull()
    expect(screen.getByTestId('help-fix-no-notifications').hasAttribute('open')).toBe(true)
    expect(screen.queryByRole('navigation', { name: 'Help contents' })).toBeNull()
  })

  it('a search whose words sit in different rows reports no match and draws no empty heading', async () => {
    open()
    // 'revoke' is in one row of the Where list and 'compose' in another, never in the same row
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search Help' }), 'revoke compose')
    expect(screen.getByTestId('help-count').textContent).toBe('Nothing matches.')
    expect(screen.getByTestId('help-empty')).toBeTruthy()
    expect(screen.queryAllByTestId('help-where-row')).toHaveLength(0)
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      expect.stringMatching(/^Ask /),
    ])
  })

  it('whatever is typed, the count is the parts drawn and no section heading stands alone', async () => {
    open()
    const box = await screen.findByRole('searchbox', { name: 'Search Help' })
    for (const q of ['quiet', 'revoke compose', 'stop pushes', 'mac offline', 'key terminal', 'iphone relay', 'zzz']) {
      fireEvent.change(box, { target: { value: q } })
      const sections = [...document.querySelectorAll('main section[aria-labelledby^="help-"]')].filter(
        (el) => el.getAttribute('aria-labelledby') !== 'help-ask',
      )
      for (const sec of sections) expect(sec.children.length, `"${q}": an empty section`).toBeGreaterThan(1)
      const count = Number(/^(\d+) /.exec(screen.getByTestId('help-count').textContent ?? '')?.[1] ?? 0)
      const parts = sections.reduce((n, sec) => n + sec.children.length - 1, 0)
      expect(count, q).toBe(parts)
    }
  })

  it('"iphone relay address" finds the limit about the iPhone app\'s relay address', async () => {
    open()
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search Help' }), 'iphone relay address')
    expect(screen.getByTestId('help-count').textContent).toMatch(/^\d+ matching parts?\.$/)
    expect(screen.getByText(/fixed when the iPhone app is built/)).toBeTruthy()
  })

  it('a search with no match says so and Ask still carries the words into a message', async () => {
    const client = open()
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search Help' }), 'zebra crossing')
    expect(screen.getByTestId('help-empty').textContent).toMatch(/Nothing in Help matches/)
    expect(screen.getByTestId('help-count').textContent).toBe('Nothing matches.')
    await userEvent.click(screen.getByTestId('help-ask'))
    const thread = client.store.getState().config?.default_thread ?? 'general'
    expect(useComposerStore.getState().prefill[thread]).toEqual({
      text: 'I need help with Talos. zebra crossing',
      mode: 'append',
    })
    expect(screen.getByTestId('location').textContent).toBe(`/t/${thread}`)
  })

  it('Ask only prefills the box: nothing is sent', async () => {
    const client = open()
    const send = vi.spyOn(client, 'sendMessage')
    await userEvent.click(await screen.findByTestId('help-ask'))
    expect(send).not.toHaveBeenCalled()
  })

  it('before the app has its config (signed out, or still connecting) the page works and Ask says why it cannot yet', async () => {
    const client = open()
    act(() => client.store.setState((s) => ({ ...s, config: null })))
    expect(await screen.findByRole('heading', { level: 1, name: 'Talos Help' })).toBeTruthy()
    expect(screen.queryByTestId('help-ask')).toBeNull()
    expect(screen.getByTestId('help-ask-waiting').textContent).toMatch(/once this device is signed in and connected/)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Help' }), 'quiet')
    expect(screen.getAllByTestId('help-where-row').length).toBeGreaterThan(0)
    act(() => client.store.setState((s) => ({ ...s, config: setup().store.getState().config })))
    expect(await screen.findByTestId('help-ask')).toBeTruthy()
  })
})

describe('About: the build lines in each state', () => {
  it('says it is reading while the server has not answered', async () => {
    stubStatus(() => new Promise<Response>(() => {}))
    open()
    expect(await screen.findByTestId('help-build-loading')).toBeTruthy()
    expect(screen.getByTestId('help-build').textContent).toContain('App build')
    expect(screen.queryByTestId('help-build-failed')).toBeNull()
  })

  it('says it failed, offers Try again, and then shows the version when the retry works', async () => {
    let up = false
    const fetchMock = stubStatus(async () => (up ? json(statusOf()) : json({ error: 'boom' }, 500)))
    open()
    expect((await screen.findByTestId('help-build-failed')).textContent).toMatch(/Couldn.t read the server.s version/)
    up = true
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('help-build').textContent).toContain('0.4.1'))
    expect(screen.queryByTestId('help-build-failed')).toBeNull()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('a garbled answer is a failure, never an empty version', async () => {
    stubStatus(async () => json({ nonsense: true }))
    open()
    expect(await screen.findByTestId('help-build-failed')).toBeTruthy()
    expect(screen.getByTestId('help-build').textContent).not.toContain('Server')
  })

  it('reads the Mac app, the iPhone app and an old frame without breaking the others', () => {
    const base = { app: 'v1-2-gabc', relay: '0.4.1' as string | null }
    const mac = buildRows({ ...base, running: 'Mac app', userAgent: 'Mozilla/5.0 TalosDesktop/1.2.3' })
    expect(mac).toContainEqual({ label: 'Mac app version', value: '1.2.3' })
    const phone = buildRows({ ...base, running: 'iPhone app', userAgent: 'Mozilla/5.0 TalosIOS/1.0+12' })
    expect(phone).toContainEqual({ label: 'iPhone app', value: '1.0 (build 12)' })
    const old = buildRows({ ...base, running: 'iPhone app', userAgent: 'Mozilla/5.0 AppleWebKit' })
    expect(old).toContainEqual({ label: 'iPhone app', value: 'not reported (an older build?)' })
    const odd = buildRows({ ...base, running: 'Mac app', userAgent: 'Mozilla/5.0 TalosDesktop/<script>' })
    expect(odd).toContainEqual({ label: 'Mac app version', value: 'not reported (an older Mac app?)' })
    expect(buildRows({ ...base, running: 'Browser', userAgent: undefined }).map((r) => r.label)).toEqual([
      'App build',
      'Running in',
      'Protocol',
      'Server',
    ])
    expect(
      buildRows({ ...base, relay: null, running: 'Browser', userAgent: undefined }).map((r) => r.label),
    ).not.toContain('Server')
  })
})

describe('the doors that open Help', () => {
  it('Settings lists Help as its last row and the row opens the page', async () => {
    open('/settings')
    const list = await screen.findByRole('navigation', { name: 'Settings sections' })
    const links = within(list).getAllByRole('link')
    const last = links.at(-1)
    expect(last?.textContent).toBe('Help')
    expect(last?.getAttribute('href')).toBe(HELP_PATH)
    await userEvent.click(last as HTMLElement)
    expect(await screen.findByRole('heading', { level: 1, name: 'Talos Help' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe(HELP_PATH)
  })

  it('the sign-in screen links to Help, for someone locked out', () => {
    render(
      <ClientProvider client={setup()}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(screen.getByRole('link', { name: 'Help' }).getAttribute('href')).toBe(HELP_PATH)
  })

  it('the Mac app and the iPhone shell can send the page there with a navigate message', () => {
    const posted: unknown[] = []
    const bridge = createShellBridge({ post: (m) => posted.push(m) })
    const store = createStore(() => ({ ...initialClientState() }))
    const client = { store, sendMessage: vi.fn(), onFrame: () => () => {} } as unknown as TalosClient
    const nav = vi.fn()
    attachShell({ kind: 'desktop', bridge, platform: {} } as unknown as Shell, client, { nav })
    expect(bridge.receive({ type: 'navigate', path: HELP_PATH })).toBe(true)
    expect(nav).toHaveBeenCalledWith(HELP_PATH)
  })
})

describe('keyboard', () => {
  it('Tab reaches the search box, then the contents links, in that order', async () => {
    open()
    const box = await screen.findByRole('searchbox', { name: 'Search Help' })
    const back = screen.getByRole('link', { name: 'Back to settings' })
    act(() => back.focus())
    // the scroll region takes focus before the box; keep tabbing until the box, which must come before any contents link
    let guard = 0
    while (document.activeElement !== box && guard++ < 5) await userEvent.tab()
    expect(document.activeElement).toBe(box)
    await userEvent.tab()
    expect(document.activeElement?.textContent).toBe('Which settings is which')
  })
})

describe('hostile and oversized input', () => {
  it('a search that looks like markup is shown as text and builds no elements', async () => {
    open()
    const evil = '<img src=x onerror=alert(1)><script>boom()</script>'
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search Help' }), { target: { value: evil } })
    const empty = screen.getByTestId('help-empty')
    expect(empty.textContent).toContain(evil)
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  it('the search box is capped, so Ask can never carry an essay into the message box', async () => {
    open()
    const box = await screen.findByRole('searchbox', { name: 'Search Help' })
    expect(box.getAttribute('maxlength')).toBe(String(SEARCH_MAX))
  })
})

describe('signed out', () => {
  it('shows plain text for the server version, no red alert, and never asks the server', async () => {
    useSession.setState({ status: 'anon' })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const fetchMock = stubStatus(async () => json({ error: 'unauthorized' }, 401))
      open()
      expect((await screen.findByTestId('help-build-signedout')).textContent).toMatch(/Sign in to see the server/)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByTestId('help-build-failed')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
      act(() => vi.advanceTimersByTime(POLL_MS * 4))
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/status'))).toHaveLength(0)
      expect(screen.getByTestId('help-build').textContent).not.toContain('Server')
    } finally {
      vi.useRealTimers()
    }
  })

  it('signing in while the page is open starts the version lookup, and signing out stops it', async () => {
    useSession.setState({ status: 'anon' })
    const fetchMock = stubStatus(async () => json(statusOf()))
    open()
    await screen.findByTestId('help-build-signedout')
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => useSession.setState({ status: 'authed' }))
    await waitFor(() => expect(screen.getByTestId('help-build').textContent).toContain('0.4.1'))
    act(() => useSession.setState({ status: 'anon' }))
    expect(await screen.findByTestId('help-build-signedout')).toBeTruthy()
    expect(screen.getByTestId('help-build').textContent).not.toContain('0.4.1')
  })
})

describe('leaving the page', () => {
  it('stops asking the server for its version once the reader has left', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const fetchMock = stubStatus(async () => json(statusOf()))
      open()
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0))
      // Ask leaves for a plain stub page that polls nothing, so any later request can only come from Help itself
      await userEvent.click(screen.getByTestId('help-ask'), { delay: null })
      await screen.findByText('a thread')
      const before = fetchMock.mock.calls.length
      act(() => vi.advanceTimersByTime(POLL_MS * 4))
      expect(fetchMock.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
