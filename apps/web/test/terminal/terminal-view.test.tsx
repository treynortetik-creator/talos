// The Terminal item and screen exist only inside the Mac app, and the only thing that leaves the page is the
// `terminal_view` message to the shell: no request to the relay, no socket frame.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalScreen } from '../../src/features/terminal/TerminalScreen.tsx'
import { BottomBar, Sidebar } from '../../src/features/threads/Nav.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { DESKTOP_UA_MARK } from '../../src/lib/native/detect.ts'
import { getShell, installShell } from '../../src/lib/native/shell.ts'
import { LocationProbe, setup } from '../cards/helpers.tsx'

afterEach(cleanup)

type Rect = { x: number; y: number; width: number; height: number }
let box: Rect = { x: 240, y: 0, width: 880, height: 780 }
let notify: () => void = () => {}
const watched: Element[] = []
/** What the page posted to the shell's message handler. */
const posted: unknown[] = []

beforeEach(() => {
  box = { x: 240, y: 0, width: 880, height: 780 }
  watched.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        notify = cb
      }
      observe(el: Element) {
        watched.push(el)
      }
      disconnect() {
        watched.length = 0
      }
    },
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        right: box.x + box.width,
        bottom: box.y + box.height,
        x: box.x,
        y: box.y,
      }) as DOMRect,
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(route: string, ui: React.ReactElement = <Sidebar />) {
  return render(
    <ClientProvider client={setup()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/terminal" element={<TerminalScreen />} />
          <Route path="*" element={ui} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </ClientProvider>,
  )
}

describe('in a browser or on a phone (no Mac app)', () => {
  it('has no Terminal item in the sidebar or the bottom bar', () => {
    expect(getShell()).toBeNull()
    mount('/')
    expect(screen.queryByRole('link', { name: /Terminal/ })).toBeNull()
    cleanup()
    mount('/', <BottomBar />)
    expect(screen.queryByRole('link', { name: /Terminal/ })).toBeNull()
  })

  it('sends /terminal back to Home and shows nothing', () => {
    mount('/terminal', <p>home</p>)
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(screen.queryByTestId('terminal-space')).toBeNull()
  })
})

describe('in the Mac app', () => {
  const fetchSpy = vi.fn()
  const socketSpy = vi.fn()

  beforeEach(() => {
    posted.length = 0
    fetchSpy.mockClear()
    socketSpy.mockClear()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', socketSpy)
    // Installed once for the file (the shell is a page-wide singleton), after the browser tests above have run.
    if (!getShell()) {
      const scope: Record<string, unknown> = {
        webkit: { messageHandlers: { talos: { postMessage: (m: unknown) => posted.push(m) } } },
        navigator: { userAgent: `Mozilla/5.0${DESKTOP_UA_MARK}1.0` },
      }
      scope.top = scope
      expect(installShell(scope)).not.toBeNull()
    }
  })

  it('lists Terminal in the sidebar, between Search and Settings, as a link to /terminal', () => {
    mount('/')
    const link = screen.getByRole('link', { name: /Terminal/ })
    expect(link.getAttribute('href')).toBe('/terminal')
    const names = screen.getAllByRole('link').map((a) => a.textContent)
    expect(names.indexOf('Terminal')).toBeGreaterThan(names.indexOf('Search'))
    expect(names.indexOf('Terminal')).toBeLessThan(names.indexOf('Settings'))
  })

  it('never puts Terminal in the phone bottom bar', () => {
    mount('/', <BottomBar />)
    expect(screen.queryByRole('link', { name: /Terminal/ })).toBeNull()
  })

  it('tells the shell where the room is, again when it moves or resizes, and null on leaving', () => {
    const view = mount('/terminal')
    // the page's own words say what the room has to hold, not only to update the app
    expect(screen.getByTestId('terminal-space').textContent).toMatch(/80 columns and 24 rows/)
    expect(watched).toEqual([screen.getByTestId('terminal-space')]) // the size is watched, not read once
    expect(posted).toEqual([{ type: 'terminal_view', rect: box }])
    box = { x: 68, y: 0, width: 1052, height: 780 } // the sidebar folded
    notify()
    expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: box })
    notify() // nothing moved: no repeat
    expect(posted).toHaveLength(2)
    view.unmount()
    expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: null })
    expect(watched).toEqual([]) // and the watch ends with the screen
  })

  it('asks for no terminal while the room has no size', () => {
    box = { x: 240, y: 0, width: 0, height: 780 }
    mount('/terminal')
    expect(posted).toEqual([{ type: 'terminal_view', rect: null }])
  })

  it('sends whole pixels, never negative', () => {
    box = { x: -0.4, y: 10.6, width: 880.4, height: 779.5 }
    mount('/terminal')
    expect(posted).toEqual([{ type: 'terminal_view', rect: { x: 0, y: 11, width: 880, height: 780 } }])
  })

  it('closes the view while a sheet or dialog is open, because the terminal would sit over it', async () => {
    mount('/terminal')
    expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: box })
    const sheet = document.createElement('div')
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('data-state', 'open')
    document.body.appendChild(sheet)
    await waitFor(() => expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: null }))
    sheet.remove()
    await waitFor(() => expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: box }))
    const alert = document.createElement('div')
    alert.setAttribute('role', 'alertdialog')
    alert.setAttribute('data-state', 'open')
    document.body.appendChild(alert)
    await waitFor(() => expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: null }))
    alert.remove()
    await waitFor(() => expect(posted.at(-1)).toEqual({ type: 'terminal_view', rect: box }))
  })

  it('reaches no relay: no request, no socket, and it needs no client', () => {
    render(
      <MemoryRouter initialEntries={['/terminal']}>
        <TerminalScreen />
      </MemoryRouter>,
    )
    expect(posted).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(socketSpy).not.toHaveBeenCalled()
  })
})
