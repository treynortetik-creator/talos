// Review fixes: a plain word never sends a slash command; a held Enter never leaks past the palette; focus returns only on Esc or Close;
// the palette stays out of an open dialog and the approval sheet; IME Enter does nothing; no Keyboard shortcuts item on a phone.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialogOpen } from '../../src/features/palette/actions.ts'
import { Palette } from '../../src/features/palette/Palette.tsx'
import { usePalette } from '../../src/features/palette/store.ts'
import { getSessionController } from '../../src/features/session/store.ts'
import { enterApproval } from '../../src/lib/approvalOpen.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { Shell } from '../../src/Shell.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  fireEvent.keyUp(window, { key: 'Enter' }) // a run by key leaves Enter swallowed until it comes up
  act(() => usePalette.getState().close())
  cleanup()
  document.body.querySelectorAll('[data-test-foreign]').forEach((n) => {
    n.remove()
  })
})

function Where() {
  const l = useLocation()
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>
}
const where = () => screen.getByTestId('where').textContent
const input = () => screen.getByRole('combobox')
const open = (mode: 'palette' | 'needs' | 'new' = 'palette') => act(() => usePalette.getState().open(mode))
const type = (v: string) => fireEvent.change(input(), { target: { value: v } })

async function mount(
  over: { phone?: boolean; hasSession?: boolean; toggleSession?: () => boolean; extra?: React.ReactNode } = {},
) {
  const client = setup({ cards: [] })
  const send = vi.spyOn(client, 'sendMessage').mockResolvedValue({ clientMsgId: 'x', state: 'sent' })
  const ctl = getSessionController(client)
  const run = vi.spyOn(ctl, 'runPalette')
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/t/general']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Palette
                  mac
                  phone={over.phone ?? false}
                  hasSession={over.hasSession ?? false}
                  ctx={over.toggleSession ? { toggleSession: over.toggleSession } : {}}
                />
                {over.extra}
              </>
            }
          />
        </Routes>
        <Where />
      </MemoryRouter>
    </ClientProvider>,
  )
  // the fake mod sends its command list once the controller is running
  await waitFor(() => expect(ctl.store.getState().inventory).toBeTruthy())
  return { client, send, run }
}

describe('a slash command is only ever sent on purpose', () => {
  it('a plain word lists no command; Enter searches messages with that word, and nothing is sent', async () => {
    const { send, run } = await mount()
    open()
    type('deploy')
    expect(screen.queryByRole('option', { name: /\/deploy/ })).toBeNull()
    expect(screen.getAllByRole('option')[0]?.textContent).toMatch(/Search messages/)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(where()).toBe('/search?q=deploy')
    expect(send).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
  it('a plain word that names an allowed command still only searches', async () => {
    const { send, run } = await mount()
    open()
    type('release')
    expect(screen.queryByRole('option', { name: /\/release-notes/ })).toBeNull()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(where()).toBe('/search?q=release')
    expect(send).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
  it('/deploy (Mac only) is listed as blocked, with the composer’s reason, and Enter sends nothing', async () => {
    const { send, run } = await mount()
    open()
    type('/deploy')
    const opt = screen.getByRole('option', { name: /\/deploy/ })
    expect(opt.getAttribute('aria-disabled')).toBe('true')
    expect(opt.textContent).toMatch(/At the Mac only/)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toMatch(/At the Mac only/)
    expect(screen.getByRole('combobox')).toBeTruthy() // still open, saying why
  })
  it('a Mac-only built-in (/permissions) is blocked the same way, by the same rule as the composer picker', async () => {
    const { run } = await mount()
    open()
    type('/permissions')
    const opt = screen.getByRole('option', { name: /\/permissions/ })
    expect(opt.getAttribute('aria-disabled')).toBe('true')
    expect(opt.textContent).toMatch(/Run this at the Mac/)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(run).not.toHaveBeenCalled()
  })
  it('an allowed /release-notes is sent, and the outcome is shown', async () => {
    const { send, run } = await mount()
    open()
    type('/release-notes')
    const opt = screen.getByRole('option', { name: /\/release-notes/ })
    expect(opt.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(run).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ threadId: 'general', text: '/release-notes' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Sent/))
  })
  it('a command never sorts above Search messages for a plain word, and Search is still last for a / query', async () => {
    await mount()
    open()
    type('re')
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(names.some((n) => n.startsWith('/'))).toBe(false)
    expect(names.at(-1)).toMatch(/Search messages/)
  })
})

describe('Enter in the palette', () => {
  it('Enter that confirms an input-method choice (keyCode 229) runs nothing', async () => {
    await mount()
    open()
    type('settings')
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })
    expect(where()).toBe('/t/general')
  })
  it('a held Enter after running "Session panel" never reaches the message box (no send)', async () => {
    const toggle = vi.fn(() => true)
    const sent = vi.fn()
    await mount({
      hasSession: true,
      toggleSession: toggle,
      extra: <textarea aria-label="Message" onKeyDown={(e) => e.key === 'Enter' && sent()} />,
    })
    open()
    type('Session panel')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(toggle).toHaveBeenCalledTimes(1)
    const box = screen.getByLabelText('Message')
    const held = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })
    fireEvent(box, held)
    expect(held.defaultPrevented).toBe(true)
    expect(sent).not.toHaveBeenCalled()
    // once the key is up, Enter is the page's again
    fireEvent.keyUp(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toHaveBeenCalledTimes(1)
  })
  it('a held Enter does not press a focused button (the default action is cancelled)', async () => {
    const clicked = vi.fn()
    await mount({
      extra: (
        <button type="button" onClick={clicked}>
          Allow
        </button>
      ),
    })
    open()
    type('settings')
    fireEvent.keyDown(input(), { key: 'Enter' })
    const held = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })
    fireEvent(screen.getByRole('button', { name: 'Allow' }), held)
    expect(held.defaultPrevented).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
  })
  it('a click on an item does not swallow Enter (no key was down)', async () => {
    const sent = vi.fn()
    await mount({ extra: <textarea aria-label="Message" onKeyDown={(e) => e.key === 'Enter' && sent()} /> })
    open()
    type('settings')
    fireEvent.click(screen.getAllByRole('option')[0] as HTMLElement)
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
    expect(sent).toHaveBeenCalledTimes(1)
  })
})

describe('focus', () => {
  it('goes back where it was on Esc', async () => {
    await mount({ extra: <button type="button">Opener</button> })
    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()
    open()
    await waitFor(() => expect(document.activeElement).toBe(input()))
    fireEvent.keyDown(input(), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
  it('goes back on Close (phone)', async () => {
    await mount({ phone: true, extra: <button type="button">Opener</button> })
    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
  it('does not go back after an item ran: the key that ran it must not land on the old button', async () => {
    await mount({ extra: <button type="button">Opener</button> })
    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()
    open()
    type('Memory')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    await new Promise((r) => setTimeout(r, 50))
    expect(document.activeElement).not.toBe(opener)
  })
})

describe('the phone has no shortcut list', () => {
  it('Keyboard shortcuts is not an item on a phone, and is on a computer', async () => {
    await mount({ phone: true })
    open()
    expect(screen.queryByRole('option', { name: /Keyboard shortcuts/ })).toBeNull()
    cleanup()
    act(() => usePalette.getState().close())
    await mount()
    open()
    expect(screen.getByRole('option', { name: /Keyboard shortcuts/ })).toBeTruthy()
  })
})

describe('dialogs and the approval sheet own the keyboard', () => {
  it('dialogOpen: another dialog counts, the palette’s own does not, and an open approval counts', () => {
    expect(dialogOpen(false)).toBe(false)
    const foreign = document.createElement('div')
    foreign.setAttribute('role', 'dialog')
    foreign.setAttribute('data-state', 'open')
    foreign.setAttribute('data-test-foreign', '')
    document.body.append(foreign)
    expect(dialogOpen(false)).toBe(true)
    foreign.setAttribute('data-palette', '')
    expect(dialogOpen(false)).toBe(false)
    foreign.remove()
    expect(dialogOpen(true)).toBe(true)
  })

  function shell() {
    const client = setup({ cards: [] })
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="*" element={<Where />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
  }
  const ctrl = (code: string, key: string) =>
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { code, key, ctrlKey: true, cancelable: true })))

  it('Ctrl+K opens the palette, and Ctrl+K again closes it (its own dialog does not block it)', async () => {
    shell()
    ctrl('KeyK', 'k')
    await waitFor(() => expect(usePalette.getState().mode).toBe('palette'))
    ctrl('KeyK', 'k')
    expect(usePalette.getState().mode).toBeNull()
  })
  it('Ctrl+K and Ctrl+J inside the New thread editor do not wipe it', async () => {
    shell()
    act(() => usePalette.getState().open('new'))
    await screen.findByRole('dialog')
    ctrl('KeyK', 'k')
    ctrl('KeyJ', 'j')
    expect(usePalette.getState().mode).toBe('new')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('nothing opens under another open dialog: palette, Needs-you list, shortcuts', async () => {
    shell()
    const foreign = document.createElement('div')
    foreign.setAttribute('role', 'dialog')
    foreign.setAttribute('data-state', 'open')
    foreign.setAttribute('data-test-foreign', '')
    document.body.append(foreign)
    ctrl('KeyK', 'k')
    ctrl('KeyJ', 'j')
    ctrl('Slash', '/')
    expect(usePalette.getState().mode).toBeNull()
    expect(where()).toBe('/')
  })
  it('nothing opens under the approval sheet', async () => {
    shell()
    let release = () => {}
    act(() => {
      release = enterApproval()
    })
    ctrl('KeyK', 'k')
    ctrl('KeyJ', 'j')
    ctrl('Slash', '/')
    ctrl('KeyF', 'f')
    expect(usePalette.getState().mode).toBeNull()
    expect(where()).toBe('/')
    act(() => release())
    ctrl('KeyK', 'k')
    await waitFor(() => expect(usePalette.getState().mode).toBe('palette'))
  })
})
