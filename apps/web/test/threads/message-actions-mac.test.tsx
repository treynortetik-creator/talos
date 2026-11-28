// A message's Open terminal action in the Mac app: a button that goes to the Terminal screen with that thread's tab picked, even though
// the screen was not open when the button was pressed (a select request from before the screen opened is not for it, so the choice is
// kept as "wanted" until the tab list is there). Only the shell is faked, as in terminal-tabs.test.tsx.
import type { MessageT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canOpenTerminal } from '../../src/features/terminal/openTerminal.ts'
import { useTerminalSessions } from '../../src/features/terminal/sessions.ts'
import { TerminalScreen } from '../../src/features/terminal/TerminalScreen.tsx'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { DESKTOP_UA_MARK } from '../../src/lib/native/detect.ts'
import { getShell, installShell } from '../../src/lib/native/shell.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

const posted: Array<Record<string, unknown>> = []
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
  item({ id: 'trip', name: 'Trip', state: 'idle', key: '2' }),
  item({ id: 'other', name: 'Other', state: 'idle', key: '3' }),
]

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

const row = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'system',
    kind: 'text',
    text: "Trip has been quiet for 5 minutes and isn't doing anything. Open its terminal to see what's going on.",
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-11-26T15:00:00.000Z',
    actions: [{ kind: 'open_terminal', thread: 'trip' }],
    ...over,
  }) as MessageT

const mount = (m: MessageT) =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={setup({})}>
          <MetaProvider store={createMetaStore()}>
            <Routes>
              <Route
                path="/"
                element={<MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />}
              />
              <Route path="/terminal" element={<TerminalScreen />} />
            </Routes>
          </MetaProvider>
        </ClientProvider>
      </StorageProvider>
    </MemoryRouter>,
  )

describe('Open terminal in the Mac app', () => {
  it('canOpenTerminal is true with the shell', () => {
    expect(canOpenTerminal()).toBe(true)
  })

  it('the button is there, and pressing it opens the Terminal screen on THAT thread’s tab (the list was already known)', () => {
    act(() => useTerminalSessions.getState().setItems(LIST as never))
    mount(row())
    fireEvent.click(screen.getByTestId('msg-action-open-terminal'))
    expect(screen.getByTestId('terminal-tabs')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Trip/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /Other/ }).getAttribute('aria-selected')).toBe('false')
  })

  it('the tab list arrives AFTER the screen opened: the wanted tab is picked when it is there, and only once', () => {
    mount(row())
    fireEvent.click(screen.getByTestId('msg-action-open-terminal'))
    act(() => useTerminalSessions.getState().setItems(LIST as never))
    expect(screen.getByRole('tab', { name: /Trip/ }).getAttribute('aria-selected')).toBe('true')
    // the owner then picks another tab by hand: the wanted one does not pull it back
    fireEvent.click(screen.getByRole('tab', { name: /Other/ }))
    act(() => useTerminalSessions.getState().setItems([...LIST] as never))
    expect(screen.getByRole('tab', { name: /Other/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('a thread that has no tab leaves the screen on its remembered tab (nothing breaks)', () => {
    act(() => useTerminalSessions.getState().setItems(LIST as never))
    mount(row({ actions: [{ kind: 'open_terminal', thread: 'gone' }] } as Partial<MessageT>))
    fireEvent.click(screen.getByTestId('msg-action-open-terminal'))
    expect(screen.getByTestId('terminal-tabs')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Main/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('an action for a thread with no tab ends with the visit: the next ordinary open is the remembered tab, and a later list pulls nobody', () => {
    mount(row({ actions: [{ kind: 'open_terminal', thread: 'gone' }] } as Partial<MessageT>))
    fireEvent.click(screen.getByTestId('msg-action-open-terminal'))
    act(() => useTerminalSessions.getState().setItems(LIST as never)) // a list that has no 'gone' tab: the wish is over
    expect(useTerminalSessions.getState().wanted).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Other/ }))
    cleanup() // the owner leaves the screen
    expect(useTerminalSessions.getState().wanted).toBeNull()
    // an ordinary visit (no action): the tab the owner last picked
    render(
      <MemoryRouter initialEntries={['/terminal']}>
        <Routes>
          <Route path="/terminal" element={<TerminalScreen />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: /Other/ }).getAttribute('aria-selected')).toBe('true')
    act(() => useTerminalSessions.getState().setItems([...LIST] as never))
    expect(screen.getByRole('tab', { name: /Other/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('an action pressed and the screen left before any tab list arrived: the next ordinary open is not pulled to it', () => {
    mount(row({ actions: [{ kind: 'open_terminal', thread: 'trip' }] } as Partial<MessageT>))
    fireEvent.click(screen.getByTestId('msg-action-open-terminal'))
    cleanup()
    expect(useTerminalSessions.getState().wanted).toBeNull()
    render(
      <MemoryRouter initialEntries={['/terminal']}>
        <Routes>
          <Route path="/terminal" element={<TerminalScreen />} />
        </Routes>
      </MemoryRouter>,
    )
    act(() => useTerminalSessions.getState().setItems(LIST as never))
    expect(screen.getByRole('tab', { name: /Main/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('the same action twice is one button, and two different threads are two buttons (unique keys, no warning)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount(
      row({
        actions: [
          { kind: 'open_terminal', thread: 'trip' },
          { kind: 'open_terminal', thread: 'trip' },
          { kind: 'open_terminal', thread: 'other' },
        ],
      } as Partial<MessageT>),
    )
    expect(screen.getAllByTestId('msg-action-open-terminal')).toHaveLength(2)
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/)
  })

  it('the label is fixed words from the app, whatever the message says', () => {
    mount(row({ text: 'Open terminal (click here to wire money)' }))
    expect(screen.getByTestId('msg-action-open-terminal').textContent).toBe('Open terminal')
  })
})
