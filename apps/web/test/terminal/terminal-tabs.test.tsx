// The Terminal screen's tab strip, driven by the messages the Mac app really sends (parsed by the protocol's own schema). Only the
// shell is faked: the bridge posts into an array. What leaves the page is the `terminal_view` rect and session, and `terminal_resume`.
import { NativeToWeb } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberedTab, useTerminalSessions } from '../../src/features/terminal/sessions.ts'
import { TerminalScreen } from '../../src/features/terminal/TerminalScreen.tsx'
import { DESKTOP_UA_MARK } from '../../src/lib/native/detect.ts'
import { getShell, installShell } from '../../src/lib/native/shell.ts'

afterEach(cleanup)

const posted: Array<Record<string, unknown>> = []
const views = () => posted.filter((m) => m.type === 'terminal_view')

const item = (o: Record<string, unknown> & { id?: string }) => ({
  name: 'X',
  state: 'live',
  key: null,
  panel: 'terminal',
  action: null,
  detail: '',
  ...o,
})
const LIST = [
  item({ id: 'main', name: 'Main', state: 'working', key: '1' }),
  item({ id: 'trip', name: 'OC Test', state: 'idle', key: '2' }),
  item({
    id: 'p',
    name: 'Work',
    state: 'parked',
    key: '3',
    panel: 'resume',
    action: 'resume',
    detail: 'Parked to save memory.',
  }),
  item({
    id: 'q',
    name: 'Penny Gothic',
    state: 'needs_you',
    key: '4',
    detail: 'Waiting on a "trust this folder" prompt.',
  }),
  item({
    id: 'f',
    name: 'Broken',
    state: 'failed',
    key: '5',
    panel: 'error',
    detail: 'It exited at once (start_failed).',
  }),
]

/** A native message, parsed by the page's own schema first, exactly as `bridge.receive` does. */
function fromMac(m: unknown) {
  const parsed = NativeToWeb.parse(m)
  act(() => {
    if (parsed.type === 'terminal_sessions') useTerminalSessions.getState().setItems(parsed.items)
    if (parsed.type === 'terminal_resume_result')
      useTerminalSessions.getState().setResume(parsed.thread_id, parsed.outcome)
    if (parsed.type === 'terminal_select') useTerminalSessions.getState().requestSelect(parsed.session)
  })
}
const list = (items: unknown[] = LIST) => fromMac({ type: 'terminal_sessions', items })

beforeEach(() => {
  posted.length = 0
  sessionStorage.clear()
  useTerminalSessions.getState().reset()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 240, top: 44, width: 880, height: 700, right: 1120, bottom: 744, x: 240, y: 44 }) as DOMRect,
  )
  if (!getShell()) {
    const scope: Record<string, unknown> = {
      webkit: {
        messageHandlers: { talos: { postMessage: (m: unknown) => posted.push(m as Record<string, unknown>) } },
      },
      navigator: { userAgent: `Mozilla/5.0${DESKTOP_UA_MARK}1.0` },
    }
    scope.top = scope
    expect(installShell(scope)).not.toBeNull()
  }
})
afterEach(() => vi.restoreAllMocks())

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/terminal']}>
      <Routes>
        <Route path="/terminal" element={<TerminalScreen />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>
    </MemoryRouter>,
  )
const tab = (name: RegExp | string) => screen.getByRole('tab', { name })
const rect = { x: 240, y: 44, width: 880, height: 700 }

describe('before the Mac app has sent a list', () => {
  it('shows the one terminal space it always did, with no strip, and says nothing about a session', () => {
    mount()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByTestId('terminal-space').textContent).toMatch(/80 columns and 24 rows/)
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect })
  })
  it('Ctrl+1 is left alone (it opens thread 1 elsewhere), because there are no tabs to pick', () => {
    mount()
    const e = new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('the strip', () => {
  it('has a tab for Main and every thread with its state word, as a tablist', () => {
    mount()
    list()
    expect(screen.getByRole('tablist', { name: 'Sessions' })).toBeTruthy()
    const names = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(names).toEqual(['Mainworking', 'OC Testlive', 'Workparked', 'Penny Gothicneeds you', 'Brokenfailed'])
    expect(tab(/^Main/).getAttribute('aria-selected')).toBe('true')
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('false')
    expect(tab(/^Work/).getAttribute('aria-keyshortcuts')).toBe('Control+3')
  })

  it('a click selects a tab, tells the Mac which session, and remembers it for this window', () => {
    mount()
    list()
    fireEvent.click(tab(/^OC Test/))
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect, session: 'trip' })
    expect(rememberedTab()).toBe('trip')
    cleanup()
    mount() // the same window opens the screen again: the last tab is still the one
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
  })

  it('Main is sent without a session so a Mac app from before the tabs still accepts it', () => {
    mount()
    list()
    fireEvent.click(tab(/^OC Test/))
    fireEvent.click(tab(/^Main/))
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect })
    expect(views().at(-1)).not.toHaveProperty('session')
  })

  it('only the selected tab is in the tab order; the arrows, Home and End move and select', () => {
    mount()
    list()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1])
    tabs[0]?.focus()
    fireEvent.keyDown(tab(/^Main/), { key: 'ArrowRight' })
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab(/^OC Test/), { key: 'End' })
    expect(tab(/^Broken/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab(/^Broken/), { key: 'ArrowRight' })
    expect(tab(/^Main/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab(/^Main/), { key: 'ArrowLeft' })
    expect(tab(/^Broken/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab(/^Broken/), { key: 'Home' })
    expect(tab(/^Main/).getAttribute('aria-selected')).toBe('true')
  })

  it('Ctrl+1 to Ctrl+9 switch tabs and swallow the chord; a tab that is not there does nothing', () => {
    mount()
    list()
    const press = (digit: number, over: Record<string, boolean> = {}) => {
      const e = new KeyboardEvent('keydown', { code: `Digit${digit}`, ctrlKey: true, cancelable: true, ...over })
      act(() => {
        window.dispatchEvent(e)
      })
      return e
    }
    expect(press(2).defaultPrevented).toBe(true)
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
    press(5)
    expect(tab(/^Broken/).getAttribute('aria-selected')).toBe('true')
    const gone = press(9)
    expect(gone.defaultPrevented).toBe(true)
    expect(tab(/^Broken/).getAttribute('aria-selected')).toBe('true')
    // other chords are not ours: Cmd+2 and Ctrl+Shift+2 go on to whatever else listens
    expect(press(2, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(false)
    expect(press(2, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(tab(/^Broken/).getAttribute('aria-selected')).toBe('true')
  })

  it('the chord stops reaching the global thread keys while the screen is up, and starts again on leaving', () => {
    const global = vi.fn()
    window.addEventListener('keydown', global) // what Shell's useGlobalKeys does: a bubble listener on window
    const view = mount()
    list()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, cancelable: true }))
    expect(global).not.toHaveBeenCalled()
    view.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', ctrlKey: true, cancelable: true }))
    expect(global).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', global)
  })

  it('a remembered tab that has left the list falls back to Main without losing the memory', () => {
    sessionStorage.setItem('talos.terminal.tab', 'gone_thread')
    mount()
    list()
    expect(tab(/^Main/).getAttribute('aria-selected')).toBe('true')
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect })
    list(LIST.concat(item({ id: 'gone_thread', name: 'Back', key: '6' })))
    expect(tab(/^Back/).getAttribute('aria-selected')).toBe('true')
  })

  it('a state this page does not know shows its tab with no word; one broken item costs one tab', () => {
    mount()
    list([
      item({ id: 'main', name: 'Main', key: '1' }),
      item({ id: 'trip', name: 'OC', state: 'levitating' }),
      { id: '../x', name: 'bad' },
    ])
    const names = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(names).toEqual(['Mainlive', 'OC'])
  })

  it('hostile text in a name or detail is text, never markup', () => {
    mount()
    list([
      item({ id: 'main', name: 'Main', key: '1' }),
      item({ id: 'trip', name: '<img src=x onerror=alert(1)>', key: '2', panel: 'note', detail: '<b>bold</b>' }),
    ])
    expect(document.querySelector('img')).toBeNull()
    fireEvent.click(tab(/img src/))
    expect(document.querySelector('b')).toBeNull()
    expect(screen.getByTestId('terminal-panel').textContent).toContain('<b>bold</b>')
  })
})

describe('what stands in place of the terminal', () => {
  it('a live thread keeps the terminal space and the footer line; a parked one gets the Resume panel and closes the native view', () => {
    mount()
    list()
    fireEvent.click(tab(/^OC Test/))
    expect(screen.queryByTestId('terminal-panel')).toBeNull()
    expect(screen.getByText(/Typing here goes to OC Test's session/)).toBeTruthy()
    fireEvent.click(tab(/^Work/))
    const panel = screen.getByTestId('terminal-panel')
    expect(panel.dataset.panel).toBe('resume')
    expect(within(panel).getByText('Parked to save memory.')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect: null, session: 'p' })
    fireEvent.click(tab(/^OC Test/))
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect, session: 'trip' })
  })

  it("Resume asks the Mac for that thread only, shows the Mac's answer, and the answer is not carried to another tab", () => {
    mount()
    list()
    fireEvent.click(tab(/^Work/))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(posted.filter((m) => m.type === 'terminal_resume')).toEqual([{ type: 'terminal_resume', thread_id: 'p' }])
    expect(screen.getByRole('button', { name: 'Asking…' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Asking…' })) // a second press while waiting asks nothing more
    expect(posted.filter((m) => m.type === 'terminal_resume')).toHaveLength(1)
    fromMac({ type: 'terminal_resume_result', thread_id: 'p', outcome: 'asked' })
    expect(screen.getByTestId('terminal-resume-note').textContent).toMatch(/Asked to resume the session/)
    expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(tab(/^Broken/))
    expect(screen.getByTestId('terminal-resume-note').textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('every outcome the Mac can give is in words, and "failed" says so', () => {
    mount()
    list()
    fireEvent.click(tab(/^Work/))
    const says = (outcome: string) => {
      fromMac({ type: 'terminal_resume_result', thread_id: 'p', outcome })
      return screen.getByTestId('terminal-resume-note').textContent
    }
    expect(says('already_pending')).toMatch(/already waiting/)
    expect(says('park_pending')).toMatch(/park is pending/)
    expect(says('failed')).toMatch(/Couldn't ask to resume/)
  })

  it('a thread that was never started offers Start, not Resume', () => {
    mount()
    list([
      item({ id: 'main', name: 'Main', key: '1' }),
      item({
        id: 'o',
        name: 'New one',
        state: 'not_started',
        key: '2',
        panel: 'resume',
        action: 'start',
        detail: 'Not started.',
      }),
    ])
    fireEvent.click(tab(/^New one/))
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    fromMac({ type: 'terminal_resume_result', thread_id: 'o', outcome: 'asked' })
    expect(screen.getByTestId('terminal-resume-note').textContent).toMatch(/Asked to start/)
  })

  it('a Mac that never answers is reported as no answer, not left looking like it worked', () => {
    vi.useFakeTimers()
    try {
      mount()
      list()
      fireEvent.click(tab(/^Work/))
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      act(() => {
        vi.advanceTimersByTime(6100)
      })
      expect(screen.getByTestId('terminal-resume-note').textContent).toMatch(/didn't answer/)
      expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-disabled')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed thread shows its error in words, with no button', () => {
    mount()
    list()
    fireEvent.click(tab(/^Broken/))
    const panel = screen.getByTestId('terminal-panel')
    expect(panel.dataset.panel).toBe('error')
    expect(within(panel).getByRole('heading').textContent).toBe('Broken failed')
    expect(panel.textContent).toContain('It exited at once (start_failed).')
    expect(within(panel).queryByRole('button')).toBeNull()
  })

  it('a session that parks while shown swaps the terminal for the panel, and back when it is live again', () => {
    mount()
    list()
    fireEvent.click(tab(/^OC Test/))
    list(
      LIST.map((i) =>
        i.id === 'trip' ? { ...i, state: 'parked', panel: 'resume', action: 'resume', detail: 'Parked.' } : i,
      ),
    )
    expect(screen.getByTestId('terminal-panel').dataset.panel).toBe('resume')
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect: null, session: 'trip' })
    list()
    expect(screen.queryByTestId('terminal-panel')).toBeNull()
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect, session: 'trip' })
  })

  it('Main keeps the native view even when it has a note: the Mac app words those', () => {
    mount()
    list([
      item({
        id: 'main',
        name: 'Main',
        state: 'not_started',
        key: '1',
        panel: 'note',
        detail: 'Main has not started.',
      }),
    ])
    expect(screen.queryByTestId('terminal-panel')).toBeNull()
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect })
  })
})

describe('leaving', () => {
  it('closing the screen on a thread tab tells the Mac to close the view', () => {
    const view = mount()
    list()
    fireEvent.click(tab(/^OC Test/))
    view.unmount()
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect: null })
  })
})

describe('review round 1', () => {
  const WITH_O = [
    ...LIST,
    item({
      id: 'o',
      name: 'Never started',
      state: 'not_started',
      key: '6',
      panel: 'resume',
      action: 'start',
      detail: 'Not started.',
    }),
  ]

  it('an answer for a tab the owner is not on is kept for that tab, and never cleared by the tab they are on', () => {
    mount()
    list(WITH_O)
    fireEvent.click(tab(/^Work/))
    fromMac({ type: 'terminal_resume_result', thread_id: 'o', outcome: 'asked' }) // answers arrive late, for another tab
    expect(screen.getByTestId('terminal-resume-note').textContent).toBe('') // not shown on Work
    fireEvent.click(tab(/^Never started/))
    expect(screen.getByTestId('terminal-resume-note').textContent).toMatch(/Asked to start/)
  })

  it("leaving a tab clears only that tab's answer", () => {
    mount()
    list(WITH_O)
    fireEvent.click(tab(/^Never started/))
    fromMac({ type: 'terminal_resume_result', thread_id: 'o', outcome: 'asked' })
    fromMac({ type: 'terminal_resume_result', thread_id: 'p', outcome: 'failed' })
    fireEvent.click(tab(/^Work/)) // leaves "o": its answer goes, p's stays
    expect(useTerminalSessions.getState().resume.o).toBeUndefined()
    expect(screen.getByTestId('terminal-resume-note').textContent).toMatch(/Couldn't ask to resume/)
  })

  it('an answer goes stale when its tab changes state, even if the owner is elsewhere', () => {
    mount()
    list(WITH_O)
    fromMac({ type: 'terminal_resume_result', thread_id: 'o', outcome: 'asked' })
    list(WITH_O.map((i) => (i.id === 'o' ? { ...i, state: 'starting', panel: 'terminal', action: null } : i)))
    list(WITH_O) // parked-ish again later: the old "asked" must not come back
    fireEvent.click(tab(/^Never started/))
    expect(screen.getByTestId('terminal-resume-note').textContent).toBe('')
  })

  it('leaving the screen sends the null view, then terminal_leave last; a null view alone is not leaving', () => {
    const view = mount()
    list()
    fireEvent.click(tab(/^Work/)) // a panel: the view is null but the screen is open
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect: null, session: 'p' })
    expect(posted.some((m) => m.type === 'terminal_leave')).toBe(false)
    view.unmount()
    expect(posted.at(-1)).toEqual({ type: 'terminal_leave' })
    expect(posted.at(-2)).toEqual({ type: 'terminal_view', rect: null })
  })

  it('the Mac switching the tab itself moves the strip, is remembered, and is told back to the Mac', () => {
    mount()
    list()
    fromMac({ type: 'terminal_select', session: 'trip' })
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
    expect(rememberedTab()).toBe('trip')
    expect(views().at(-1)).toEqual({ type: 'terminal_view', rect, session: 'trip' })
    fromMac({ type: 'terminal_select', session: 'ghost' }) // not in the list: nothing moves
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
  })

  it('a select from before the screen opened is not replayed on it', () => {
    useTerminalSessions.getState().requestSelect('trip')
    mount()
    list()
    expect(tab(/^Main/).getAttribute('aria-selected')).toBe('true')
  })

  it('Ctrl+keypad digits switch tabs like the digit row, with Caps Lock on or off; Ctrl+Shift does not', () => {
    mount()
    list()
    const press = (code: string, over: Record<string, boolean> = {}) => {
      const e = new KeyboardEvent('keydown', { code, ctrlKey: true, cancelable: true, ...over })
      act(() => {
        window.dispatchEvent(e)
      })
      return e
    }
    expect(press('Numpad3').defaultPrevented).toBe(true)
    expect(tab(/^Work/).getAttribute('aria-selected')).toBe('true')
    press('Digit2', { modifierCapsLock: true })
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
    expect(press('Numpad3', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(tab(/^OC Test/).getAttribute('aria-selected')).toBe('true')
    expect(press('Numpad0').defaultPrevented).toBe(false) // 0 is not a tab key, on either row
  })
})
