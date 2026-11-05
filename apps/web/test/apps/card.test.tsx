// @vitest-environment jsdom
// AppViewCard in the DOM (jsdom, fake client): the chrome, the frame attributes, the handshake through a real iframe
// window, the live-frame cap, fullscreen without a reload, posters, and every way a card can go away mid-work.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppViewCard } from '../../src/features/apps/AppViewCard.tsx'
import { resetSlots } from '../../src/features/apps/liveSlots.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient, type FakeClient } from '../../src/lib/fakeClient.ts'
import { getPlatform } from '../../src/lib/platform.ts'
import { makeView } from './helpers.ts'

beforeEach(() => resetSlots())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mount(views = [makeView()], client: FakeClient = createFakeClient()) {
  const ui = (vs: typeof views) => (
    <ClientProvider client={client}>
      {vs.map((v) => (
        <AppViewCard key={v.view_id} view={v} />
      ))}
    </ClientProvider>
  )
  const r = render(ui(views))
  return { client, views, ...r, rerenderViews: (vs: typeof views) => r.rerender(ui(vs)) }
}

const frames = () => Array.from(document.querySelectorAll('iframe'))
/** A view's window: what it posts to the host, and what the host posts back. */
function viewOf(iframe: HTMLIFrameElement) {
  const win = iframe.contentWindow as Window
  const inbox: Array<Record<string, unknown>> = []
  vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => void inbox.push(m as Record<string, unknown>))
  const say = (data: unknown, source: unknown = win) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }))
    })
  return { win, inbox, say, load: () => act(() => void fireEvent.load(iframe)) }
}
/** What a tap inside a cross-origin frame looks like to the host page: the window loses focus to the frame. */
async function tapInside(iframe: HTMLIFrameElement) {
  await act(async () => {
    iframe.focus()
    window.dispatchEvent(new Event('blur'))
    await new Promise((r) => setTimeout(r, 5))
  })
}
const init = (id: string | number = 'i') => ({
  jsonrpc: '2.0',
  id,
  method: 'ui/initialize',
  params: { protocolVersion: '2026-01-26', appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] } },
})
const initialized = { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }
async function handshake(iframe: HTMLIFrameElement) {
  const v = viewOf(iframe)
  v.load()
  v.say(init())
  v.say(initialized)
  await waitFor(() => expect(v.inbox.some((m) => m.method === 'ui/notifications/tool-result')).toBe(true))
  return v
}

describe('chrome and frame', () => {
  it('draws the label, server and tool, the badge, and a sandbox with fixed attributes', () => {
    const { views } = mount()
    expect(screen.getByTestId('app-label').textContent).toBe('Notes')
    expect(screen.getByTestId('app-source').textContent).toBe('probe-notes · show_note')
    expect(screen.getByTestId('app-badge').textContent).toBe('Third-party app')
    const f = frames()
    expect(f).toHaveLength(1)
    const el = f[0] as HTMLIFrameElement
    expect(el.getAttribute('sandbox')).toBe('allow-scripts')
    expect(el.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(el.hasAttribute('allow')).toBe(false)
    expect(el.getAttribute('src')).toBe(`/media/${views[0]?.page.media_id}/app`)
    expect(el.getAttribute('src')).not.toContain('/page')
  })

  it('a hostile label or server is text, never markup', () => {
    mount([makeView({ label: '<img src=x onerror=alert(1)>', server: '<b>evil</b>' })])
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(screen.getByTestId('app-label').textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('has no "Open in new tab", in the card or in fullscreen', async () => {
    mount()
    expect(screen.queryByText(/open in new tab/i)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(screen.queryByText(/open in new tab/i)).toBeNull()
    expect(document.querySelector('a[href]')).toBeNull()
  })

  it('shows loading until the view is ready, then not', async () => {
    mount()
    expect(screen.getByTestId('app-loading')).toBeTruthy()
    expect(screen.getByTestId('app-view').dataset.state).toBe('loading')
    await handshake(frames()[0] as HTMLIFrameElement)
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull())
    expect(screen.getByTestId('app-view').dataset.state).toBe('ready')
  })

  it('a view that never starts shows a failed state with Try again, which reloads a fresh frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    mount()
    const first = frames()[0] as HTMLIFrameElement
    act(() => void fireEvent.load(first))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(screen.getByTestId('app-failed').textContent).toMatch(/didn't start/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const next = frames()[0] as HTMLIFrameElement
    expect(next).not.toBe(first)
    expect(next.getAttribute('src')).toMatch(/\?r=1$/)
    expect(screen.queryByTestId('app-failed')).toBeNull()
  })
})

describe('the handshake through a real iframe window', () => {
  it('replies to ui/initialize and sends the input and result only after initialized', async () => {
    mount()
    const v = viewOf(frames()[0] as HTMLIFrameElement)
    v.load()
    v.say(init())
    expect(v.inbox.map((m) => m.id)).toEqual(['i'])
    expect(v.inbox[0]?.result).toMatchObject({ hostInfo: { name: 'talos-app' } })
    v.say(initialized)
    expect(v.inbox.map((m) => m.method).filter(Boolean)).toEqual([
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ])
  })

  it('ignores messages from any other window', async () => {
    mount()
    const v = viewOf(frames()[0] as HTMLIFrameElement)
    v.say(init(), window)
    v.say(init(), null)
    v.say(init(), window.parent)
    expect(v.inbox).toEqual([])
  })

  it('carries the live theme in the context and resends it when the theme changes', async () => {
    document.documentElement.dataset.theme = 'dark'
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    expect(v.inbox[0]?.result).toMatchObject({ hostContext: { theme: 'dark' } })
    document.documentElement.dataset.theme = 'light'
    await waitFor(() => expect(v.inbox.some((m) => m.method === 'ui/notifications/host-context-changed')).toBe(true))
    expect(v.inbox.at(-1)?.params).toMatchObject({ theme: 'light' })
    delete document.documentElement.dataset.theme
  })
})

describe('requests', () => {
  it('a tools/call becomes a signed app.request; status reads Waiting, then the answer lands', async () => {
    const { client, views } = mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_note', arguments: { id: 'n1' } } })
    await waitFor(() => expect(client.sent).toHaveLength(1))
    expect(client.sent[0]).toMatchObject({ type: 'app.request', tool_name: 'read_note', view_id: views[0]?.view_id })
    expect(client.sent[0]?.osig).toBeTruthy()
    expect(screen.getByTestId('app-status').textContent).toBe('Waiting for Talos…')
    const rid = String(client.sent[0]?.request_id)
    act(() =>
      client.emit('app.response', {
        view_id: views[0]?.view_id as string,
        request_id: rid,
        state: 'pending_card',
        card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T43X',
      }),
    )
    await waitFor(() => expect(screen.getByTestId('app-status').textContent).toBe('Waiting for your approval'))
    act(() =>
      client.emit('app.response', {
        view_id: views[0]?.view_id as string,
        request_id: rid,
        state: 'done',
        result: { content: [{ type: 'text', text: 'ok' }] },
      }),
    )
    await waitFor(() =>
      expect(v.inbox.find((m) => m.id === 5)?.result).toEqual({ content: [{ type: 'text', text: 'ok' }] }),
    )
    expect(screen.queryByTestId('app-status')).toBeNull()
  })

  it('a gestured request hands focus back to the card, so the next tap in the view is a new gesture', async () => {
    const { client } = mount()
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true })
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    await tapInside(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a' } })
    v.say({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'b' } })
    await waitFor(() => expect(client.sent).toHaveLength(2))
    expect(client.sent.map((s) => s.user_gesture).sort()).toEqual([false, true])
    expect(document.activeElement).not.toBe(frames()[0])
    await tapInside(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'c' } })
    await waitFor(() => expect(client.sent).toHaveLength(3))
    expect(client.sent[2]?.user_gesture).toBe(true)
    // @ts-expect-error cleanup of the stub
    delete navigator.userActivation
  })

  it('a relay refusal fails the call once with a Talos code', async () => {
    const { client } = mount()
    client.failNextAppRequestWith('rate_limited')
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'a' } })
    await waitFor(() => expect(v.inbox.find((m) => m.id === 5)).toBeTruthy())
    expect(v.inbox.filter((m) => m.id === 5)).toHaveLength(1)
    expect(v.inbox.find((m) => m.id === 5)?.error).toMatchObject({ code: -32000, data: { talos: 'rate_limited' } })
  })

  it('two cards at once: each answer reaches only the view that asked', async () => {
    const a = makeView({ label: 'A' })
    const b = makeView({ label: 'B' })
    const { client } = mount([a, b])
    const [fa, fb] = frames() as [HTMLIFrameElement, HTMLIFrameElement]
    const va = await handshake(fa)
    const vb = await handshake(fb)
    va.say({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })
    vb.say({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })
    await waitFor(() => expect(client.sent).toHaveLength(2))
    const ra = client.sent.find((s) => s.view_id === a.view_id)
    const rb = client.sent.find((s) => s.view_id === b.view_id)
    act(() =>
      client.emit('app.response', {
        view_id: b.view_id,
        request_id: String(rb?.request_id),
        state: 'done',
        result: { content: [{ type: 'text', text: 'for B' }] },
      }),
    )
    await waitFor(() => expect(vb.inbox.find((m) => m.id === 1)).toBeTruthy())
    expect(va.inbox.find((m) => m.id === 1)).toBeUndefined()
    // a response naming A's request id under B's view id is nobody's
    act(() =>
      client.emit('app.response', {
        view_id: b.view_id,
        request_id: String(ra?.request_id),
        state: 'done',
        result: { content: [] },
      }),
    )
    expect(va.inbox.find((m) => m.id === 1)).toBeUndefined()
  })

  it('open-link shows the whole URL, Cancel opens nothing, Open opens once', async () => {
    const open = vi.spyOn(getPlatform(), 'openExternal').mockReturnValue(true)
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    v.say({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/open-link',
      params: { url: 'https://example.com/a/very/long/path?q=1' },
    })
    const dialog = await screen.findByRole('dialog', { name: /Open a link from Notes\?/ })
    expect(within(dialog).getByTestId('open-link-url').textContent).toBe('https://example.com/a/very/long/path?q=1')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(v.inbox.find((m) => m.id === 1)).toMatchObject({ result: { isError: true } }))
    expect(open).not.toHaveBeenCalled()
    v.say({ jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'https://example.com/ok' } })
    const openBtn = await screen.findByRole('button', { name: 'Open' })
    await waitFor(() => expect((openBtn as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(openBtn)
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com/ok'))
    expect(open).toHaveBeenCalledTimes(1)
    expect(v.inbox.find((m) => m.id === 2)?.result).toEqual({})
  })

  it('[Open] is dead for 400 ms after the sheet appears: a tap meant for the view cannot land on it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const open = vi.spyOn(getPlatform(), 'openExternal').mockReturnValue(true)
    mount()
    const v = viewOf(frames()[0] as HTMLIFrameElement)
    v.say(init())
    v.say(initialized)
    v.say({ jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url: 'https://example.com/phish' } })
    await act(() => vi.advanceTimersByTimeAsync(0))
    const btn = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    await act(() => vi.advanceTimersByTimeAsync(399))
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(open).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(btn.disabled).toBe(false)
    expect(document.activeElement).not.toBe(btn)
  })

  it('size-changed grows the inline frame within bounds', async () => {
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 9999 } })
    const box = frames()[0]?.parentElement as HTMLElement
    await waitFor(() => expect(Number.parseInt(box.style.height, 10)).toBeLessThanOrEqual(640))
    v.say({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 100 } })
    await waitFor(() => expect(box.style.height).toBe('100px'))
  })

  it('the App log lists what the view logged, as text', async () => {
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'warning', data: '<script>x</script>' } })
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'App log' }))
    const log = await screen.findByTestId('app-log')
    expect(log.textContent).toContain('<script>x</script>')
    expect(log.querySelector('script')).toBeNull()
  })

  it('Details shows what was approved', async () => {
    const { views } = mount()
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Details' }))
    const d = await screen.findByTestId('app-details')
    expect(d.textContent).toContain('https://api.example.com')
    expect(d.textContent).toContain(views[0]?.approval_key.slice(0, 12))
    expect(d.textContent).not.toContain(views[0]?.approval_key as string)
  })
})

describe('fullscreen', () => {
  it('is a CSS state of the same iframe: no reload, a dialog, the bar stays, Escape closes', async () => {
    mount()
    const el = frames()[0] as HTMLIFrameElement
    const marker = Symbol('same iframe')
    ;(el as unknown as Record<symbol, unknown>)[marker] = true
    const win = el.contentWindow
    const before = document.body.style.overflow
    await userEvent.click(screen.getByRole('button', { name: /expand notes/i }))
    const dialog = screen.getByRole('dialog', { name: /Notes/ })
    expect(dialog.className).toContain('fixed')
    expect(frames()).toHaveLength(1)
    expect(frames()[0]).toBe(el)
    expect(frames()[0]?.contentWindow).toBe(win)
    expect((frames()[0] as unknown as Record<symbol, unknown>)[marker]).toBe(true)
    expect(screen.getByTestId('app-badge')).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /close notes full screen/i }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(frames()[0]).toBe(el)
    expect(document.body.style.overflow).toBe(before)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /expand notes/i }))
  })

  it('Tab stays inside the bar while fullscreen', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: /expand notes/i }))
    const close = screen.getByRole('button', { name: /close notes full screen/i })
    const more = screen.getByRole('button', { name: 'More' })
    close.focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(more)
    await userEvent.tab()
    expect(document.activeElement).toBe(close)
    await userEvent.tab({ shift: true })
    expect(document.activeElement).toBe(more)
  })

  it('a view-requested fullscreen waits for the chip: a self-focus makes a gesture but not a yes; [Allow] reports the new dimensions', async () => {
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    // the view focuses itself while the browser's activation is live: the old gesture path would have said yes
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true })
    await tapInside(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', id: 2, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } })
    const chip = await screen.findByTestId('app-fullscreen-chip')
    expect(chip.textContent).toContain('Notes wants to go full screen')
    expect(screen.getByTestId('app-view').getAttribute('data-mode')).toBe('inline') // the sheet is a dialog; the card is not fullscreen
    expect(v.inbox.find((m) => m.id === 2)).toBeUndefined()
    const allow = screen.getByTestId('app-fullscreen-allow')
    await waitFor(() => expect(allow.getAttribute('data-armed')).toBe('true'))
    await userEvent.click(allow)
    await waitFor(() => expect(v.inbox.find((m) => m.id === 2)).toBeTruthy())
    expect(v.inbox.find((m) => m.id === 2)?.result).toEqual({ mode: 'fullscreen' })
    expect(screen.queryByTestId('app-fullscreen-chip')).toBeNull()
    await waitFor(() =>
      expect(
        v.inbox.some(
          (m) =>
            m.method === 'ui/notifications/host-context-changed' &&
            (m.params as { displayMode?: string }).displayMode === 'fullscreen',
        ),
      ).toBe(true),
    )
    const ctx = v.inbox.findLast((m) => m.method === 'ui/notifications/host-context-changed')
    expect(ctx?.params).toMatchObject({ containerDimensions: { height: expect.any(Number) } })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(v.inbox.findLast((m) => m.method === 'ui/notifications/host-context-changed')?.params).toMatchObject({
        displayMode: 'inline',
      }),
    )
    // @ts-expect-error cleanup of the stub
    delete navigator.userActivation
  })
})

describe('a fold that moves the card without a window resize', () => {
  it('tells the view its new width when the card box resizes', async () => {
    const callbacks: Array<(e: unknown[]) => void> = []
    let observed: Element | null = null
    class RO {
      constructor(private cb: (e: unknown[]) => void) {}
      observe(t: Element) {
        observed = t
        callbacks.push(this.cb)
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO)
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    const box = screen.getByRole('group', { name: /third-party app/i })
    const widthsSent = () =>
      v.inbox
        .filter((m) => m.method === 'ui/notifications/host-context-changed')
        .map((m) => (m.params as { containerDimensions?: { width?: number } }).containerDimensions?.width)
        .filter((w): w is number => w !== undefined)
    expect(observed).toBe(box) // the card's own box is watched, not the window
    const fire = (w: number) => {
      Object.defineProperty(box, 'clientWidth', { value: w, configurable: true })
      for (const cb of callbacks) cb([{ contentRect: { width: w } }])
    }
    fire(660) // the starting width: nothing to tell
    const before = widthsSent().length
    fire(760) // the sidebar folded
    await waitFor(() => expect(widthsSent().at(-1)).toBe(760))
    expect(widthsSent().length).toBe(before + 1)
    vi.unstubAllGlobals()
  })
})

describe('a view that goes away while fullscreen', () => {
  async function goFullscreen() {
    const m = mount()
    await userEvent.click(screen.getByRole('button', { name: /expand notes/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    return m
  }
  it('app.update leaves a normal card, scroll unlocked, with a way to read it', async () => {
    const { client, views } = await goFullscreen()
    act(() =>
      client.emit('app.update', { view_id: views[0]?.view_id as string, thread_id: 'general', state: 'revoked' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('app-view').dataset.mode).toBe('inline')
    expect(document.body.style.overflow).not.toBe('hidden')
    expect((await screen.findByTestId('app-poster')).textContent).toContain('Removed from your approved apps')
  })
  it('the view stopped for navigating itself leaves a normal card', async () => {
    await goFullscreen()
    act(() => void fireEvent.load(frames()[0] as HTMLIFrameElement))
    act(() => void fireEvent.load(frames()[0] as HTMLIFrameElement))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.style.overflow).not.toBe('hidden')
    expect((await screen.findByTestId('app-poster')).textContent).toContain('tried to leave')
  })
  it('its own request-teardown does too', async () => {
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    await userEvent.click(screen.getByRole('button', { name: /expand notes/i }))
    v.say({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown', params: {} })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 2000 })
    expect(document.body.style.overflow).not.toBe('hidden')
    expect((await screen.findByTestId('app-poster')).textContent).toContain('closed itself')
  })
})

describe('the cap of three live frames', () => {
  it('the newest three are live; the oldest is a poster with Load app, which swaps the oldest live', async () => {
    const vs = [1, 2, 3, 4].map((n) => makeView({ label: `V${n}` }))
    mount(vs)
    await waitFor(() => expect(frames()).toHaveLength(3))
    const cards = screen.getAllByTestId('app-view')
    expect(cards[0]?.dataset.state).toBe('poster')
    expect(within(cards[0] as HTMLElement).getByTestId('app-poster').textContent).toMatch(/V1 is not loaded/)
    expect(frames().map((f) => f.title)).toEqual(['V2 (app)', 'V3 (app)', 'V4 (app)'])
    await userEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Load app' }))
    await waitFor(() =>
      expect(
        frames()
          .map((f) => f.title)
          .sort(),
      ).toEqual(['V1 (app)', 'V3 (app)', 'V4 (app)']),
    )
    expect(frames()).toHaveLength(3)
    expect(screen.getAllByTestId('app-view')[1]?.dataset.state).toBe('poster')
  })

  it('a card that goes away frees its slot', async () => {
    const vs = [1, 2, 3, 4].map((n) => makeView({ label: `V${n}` }))
    const m = mount(vs)
    await waitFor(() => expect(frames()).toHaveLength(3))
    m.rerenderViews(vs.slice(1))
    expect(frames()).toHaveLength(3)
    m.rerenderViews(vs.slice(2))
    expect(frames()).toHaveLength(2)
  })
})

describe('posters and navigation', () => {
  it.each([
    ['superseded', 'Replaced by a newer view'],
    ['closed', 'Closed: too many requests'],
    ['revoked', 'Removed from your approved apps'],
  ] as const)('app.update %s -> a poster, live, without a reload', async (state, text) => {
    const { client, views } = mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    act(() => client.emit('app.update', { view_id: views[0]?.view_id as string, thread_id: 'general', state }))
    await waitFor(() => expect(screen.getByTestId('app-poster').textContent).toContain(text))
    expect(frames()).toHaveLength(0)
    expect(v.inbox.some((m) => m.method === 'ui/resource-teardown')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Load app' })).toBeNull()
  })

  it('a stored app.update shows the poster on first paint (reload, replay)', () => {
    const client = createFakeClient()
    const view = makeView()
    client.store.setState((s) => ({ ...s, appStates: { [view.view_id]: { state: 'superseded' } } }))
    mount([view], client)
    expect(frames()).toHaveLength(0)
    expect(screen.getByTestId('app-poster').textContent).toContain('Replaced by a newer view')
  })

  it('a second load tears the view down with a plain notice', async () => {
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    act(() => void fireEvent.load(frames()[0] as HTMLIFrameElement))
    await waitFor(() => expect(screen.getByTestId('app-poster').textContent).toContain('tried to leave its frame'))
    expect(frames()).toHaveLength(0)
    expect(v.inbox.length).toBeGreaterThan(0)
  })

  it('request-teardown from the view leaves a poster', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount()
    const v = viewOf(frames()[0] as HTMLIFrameElement)
    v.say(init())
    v.say(initialized)
    v.say({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown', params: {} })
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(screen.getByTestId('app-poster').textContent).toContain('closed itself')
  })

  it('shows the 24 hour banner once calls_until has passed', async () => {
    mount([makeView({ calls_until: '2026-10-28T15:59:00.000Z' })])
    expect(await screen.findByTestId('app-expired')).toBeTruthy()
    expect(screen.getByTestId('app-expired').textContent).toBe(
      'Buttons that need Talos stopped working after 24 hours.',
    )
    cleanup()
    mount([makeView({ calls_until: '2026-10-29T15:59:00.000Z' })])
    expect(screen.queryByTestId('app-expired')).toBeNull()
  })
})

describe('going away mid-work', () => {
  it('unmounting with a call open leaves no throw and no late reply', async () => {
    const err = vi.spyOn(console, 'error')
    const { client, unmount, views } = mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    v.say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'a', _meta: { progressToken: 1 } } })
    await waitFor(() => expect(client.sent).toHaveLength(1))
    const posted = v.inbox.length
    unmount()
    act(() =>
      client.emit('app.response', {
        view_id: views[0]?.view_id as string,
        request_id: String(client.sent[0]?.request_id),
        state: 'done',
        result: { content: [] },
      }),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(v.inbox.length).toBe(posted)
    expect(err).not.toHaveBeenCalled()
  })

  it('the Mac going offline mid-call: the relay refusal reaches the view, nothing hangs', async () => {
    const { client } = mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    client.setMacOnline(false)
    client.failNextAppRequestWith('mac_offline')
    v.say({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'a' } })
    await waitFor(() => expect(v.inbox.find((m) => m.id === 9)).toBeTruthy())
    expect(v.inbox.find((m) => m.id === 9)?.error).toMatchObject({ data: { talos: 'mac_offline' } })
    expect(screen.queryByTestId('app-status')).toBeNull()
  })

  it('pagehide tells the view it is going', async () => {
    mount()
    const v = await handshake(frames()[0] as HTMLIFrameElement)
    act(() => void window.dispatchEvent(new Event('pagehide')))
    expect(v.inbox.some((m) => m.method === 'ui/resource-teardown')).toBe(true)
  })
})
