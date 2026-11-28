// Option B (owner, 2026-11-20): Stop is a pill on a working line under the newest message, not a button in the message box.
// After a stop the strip above the box says "Stopped <agent>. Your message is kept." with Undo for 8 s.
import type { AttachmentRefT, MessageT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ERROR_MS,
  offerStopError,
  offerStopped,
  STOPPED_MS,
  StoppedStrip,
} from '../../src/features/threads/StoppedStrip.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { WorkingLineView } from '../../src/features/threads/WorkingLine.tsx'
import { resetAnnouncerForTests } from '../../src/lib/announce.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const announcerSays = () =>
  Array.from(document.querySelectorAll('#talos-announcer [aria-live="polite"]'), (r) => r.textContent).filter(Boolean)

afterEach(() => {
  cleanup()
  resetAnnouncerForTests()
  vi.useRealTimers()
})
for (const k of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const)
  (Element.prototype as unknown as Record<string, unknown>)[k] ??= () => false

let n = 0
const att: AttachmentRefT = {
  id: 'a_1',
  kind: 'image',
  mime: 'image/png',
  name: 'a.png',
  size: 3,
} as unknown as AttachmentRefT
const msg = (author: MessageT['author'], text: string, over: Partial<MessageT> = {}): MessageT =>
  ({
    id: `m_stop_${++n}`,
    thread_id: 'general',
    author,
    kind: 'text',
    text,
    format: 'plain',
    attachments: [],
    via: 'app',
    seq: 100 + n,
    created_at: new Date().toISOString(),
    ...over,
  }) as MessageT
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const setMessages = (c: FakeClient, list: MessageT[]) =>
  c.store.setState((s) => ({ ...s, messages: { ...s.messages, general: list } }))
const working = (c: FakeClient) =>
  c.store.setState((s) => ({
    ...s,
    statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
  }))
const idle = (c: FakeClient) => c.store.setState((s) => ({ ...s, statuses: {} }))
const open = (c: FakeClient) => renderWith(<ThreadScreen />, c, '/t/general', '/t/:thread')
const sentMessages = (c: FakeClient) => c.sent.filter((f) => f.type === 'message')

describe('the working line (screen)', () => {
  it('says who is working, with a Stop pill that is not red, and no Stop in the message box', async () => {
    const c = setup()
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1' }))
    const line = await screen.findByTestId('stop-line')
    expect(line.textContent).toContain('Talos is working…')
    const stop = within(line).getByRole('button', { name: 'Stop your agent' })
    expect(stop.textContent).toBe('Stop')
    expect(stop.className).toMatch(/text-accent-text/)
    expect(stop.className).not.toMatch(/danger/)
    expect(within(screen.getByTestId('composer')).queryByRole('button', { name: /Stop/ })).toBeNull()
    expect(screen.queryByTestId('composer-stop')).toBeNull()
  })

  it('sits inside the thread scroll area, after the last row', async () => {
    const c = setup()
    setMessages(c, [msg('owner', 'do it')])
    working(c)
    open(c)
    const line = await screen.findByTestId('stop-line')
    const timeline = screen.getByTestId('timeline')
    expect(timeline.contains(line)).toBe(true)
    const row = timeline.querySelector('[data-msg-id]') as HTMLElement
    expect(row.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stops once on a tap', async () => {
    const c = setup()
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Stop your agent' }))
    await waitFor(() => expect(c.session.controls.filter((x) => x.action === 'stop')).toHaveLength(1))
    expect(c.session.controls.at(-1)).toMatchObject({ thread_id: 'general', action: 'stop', turn_id: 'turn_1' })
  })

  it('shows the text alone when Stop cannot be offered', async () => {
    const c = setup()
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1', capabilities: ['compact'] }))
    const line = await screen.findByTestId('stop-line')
    expect(line.textContent).toContain('is working…')
    expect(within(line).queryByRole('button')).toBeNull()
  })

  it('is gone when the thread is not working', async () => {
    const c = setup()
    working(c)
    open(c)
    await screen.findByTestId('stop-line')
    act(() => idle(c))
    await waitFor(() => expect(screen.queryByTestId('stop-line')).toBeNull())
  })

  it('a refused stop says why, above the message box (not in the line), and shows no Stopped strip', async () => {
    const c = setup()
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1' }))
    c.session.failNext('turn_mismatch', 'That turn already ended.')
    await userEvent.click(await screen.findByRole('button', { name: 'Stop your agent' }))
    const err = await screen.findByTestId('stop-line-error')
    expect(err.textContent).toMatch(/already ended/i)
    expect(err.className).toMatch(/text-danger/)
    expect(err.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('composer').contains(err)).toBe(false)
    expect(screen.getByTestId('stop-line').contains(err)).toBe(false)
    expect(screen.getByTestId('composer').compareDocumentPosition(err) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
  })

  it('an error that lands as the turn ends stays visible after the line is gone', async () => {
    const c = setup()
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1' }))
    c.session.failNext('turn_mismatch', 'That turn already ended.')
    await userEvent.click(await screen.findByRole('button', { name: 'Stop your agent' }))
    act(() => {
      idle(c)
      c.session.patch({ busy: false, turn_id: undefined })
    })
    await waitFor(() => expect(screen.queryByTestId('stop-line')).toBeNull())
    const err = await screen.findByTestId('stop-line-error')
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.getByTestId('stop-line-error')).toBe(err)
  })

  it('with the keyboard: Enter on Stop moves focus to Undo', async () => {
    const c = setup()
    setMessages(c, [msg('agent', 'on it'), msg('owner', 'please do it')])
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1' }))
    const stop = await screen.findByRole('button', { name: 'Stop your agent' })
    act(() => stop.focus())
    expect(document.activeElement).toBe(stop)
    await userEvent.keyboard('{Enter}')
    const undo = await screen.findByRole('button', { name: 'Undo' })
    await waitFor(() => expect(document.activeElement).toBe(undo))
  })

  it('an ok stop shows the Stopped strip above the box', async () => {
    const c = setup()
    setMessages(c, [msg('agent', 'on it'), msg('owner', 'please do it')])
    working(c)
    open(c)
    act(() => c.session.patch({ busy: true, turn_id: 'turn_1' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Stop your agent' }))
    const strip = await screen.findByTestId('stopped-strip')
    // no live role of its own (it appears already filled, which a screen reader skips): the announcer says it
    expect(strip.getAttribute('role')).toBeNull()
    await waitFor(() => expect(announcerSays()).toEqual(['Stopped Talos. Undo is available']))
    expect(strip.textContent).toContain('Stopped Talos. Your message is kept.')
    expect(within(strip).getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})

describe('the working line (view)', () => {
  it('Stopping your agent, Stopping… and disabled while a stop is in flight', () => {
    const onStop = vi.fn()
    render(<WorkingLineView agent="Atlas" showStop busy onStop={onStop} />)
    const b = screen.getByRole('button', { name: 'Stopping your agent' }) as HTMLButtonElement
    expect(b.textContent).toBe('Stopping…')
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(onStop).not.toHaveBeenCalled()
  })
  it('names the agent; a tap calls onStop once', () => {
    const onStop = vi.fn()
    render(<WorkingLineView agent="Atlas" showStop busy={false} onStop={onStop} />)
    expect(screen.getByText('Atlas is working…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop your agent' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
  it('no button without showStop', () => {
    render(<WorkingLineView agent="Atlas" showStop={false} busy={false} onStop={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the Stopped strip', () => {
  const strip = (c: FakeClient) =>
    render(
      <ClientProvider client={c}>
        <MemoryRouter>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <StoppedStrip threadId="general" />
                  <textarea aria-label="Message" className="composer-box" />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
  const mine = () => [msg('agent', 'on it'), msg('owner', 'the last one', { attachments: [att], reply_to: 'm_prev' })]

  it('appears after an ok stop and is gone after 8 s', () => {
    vi.useFakeTimers()
    const c = setup()
    setMessages(c, mine())
    strip(c)
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
    act(() => offerStopped(c, 'general'))
    expect(screen.getByTestId('stopped-strip').textContent).toContain('Stopped Talos. Your message is kept.')
    act(() => {
      vi.advanceTimersByTime(STOPPED_MS - 1)
    })
    expect(screen.queryByTestId('stopped-strip')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
    expect(STOPPED_MS).toBe(8000)
  })

  it('Undo sends the last owner message again with its attachments and reply_to, once', async () => {
    const c = setup()
    setMessages(c, mine())
    strip(c)
    act(() => offerStopped(c, 'general'))
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    await waitFor(() => expect(sentMessages(c)).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(sentMessages(c)).toHaveLength(1)
    expect(sentMessages(c)[0]).toMatchObject({
      thread_id: 'general',
      text: 'the last one',
      attachments: [att],
      reply_to: 'm_prev',
    })
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
  })

  it.each([
    ['sent', 'Message sent again'],
    ['queued', "Saved. It sends when you're back online."],
    ['held_unpinned', 'Saved. It sends once this device is approved.'],
  ] as const)('Undo says what happened to the resend: %s', async (state, words) => {
    const c = setup()
    setMessages(c, mine())
    vi.spyOn(c, 'sendMessage').mockResolvedValue({ clientMsgId: 'm_again', state })
    strip(c)
    act(() => offerStopped(c, 'general'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(announcerSays()).toContain(words))
    expect(announcerSays().filter((w) => w !== words && w.startsWith('Message sent'))).toEqual([])
  })

  it('two taps before the re-render send once (the guard, not the unmount)', async () => {
    const c = setup()
    setMessages(c, mine())
    const spy = vi.spyOn(c, 'sendMessage').mockImplementation(() => new Promise(() => {}))
    strip(c)
    act(() => offerStopped(c, 'general'))
    const undo = screen.getByRole('button', { name: 'Undo' })
    act(() => {
      fireEvent.click(undo)
      fireEvent.click(undo)
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  const hook = () => msg('hook', 'PR opened', { kind: 'event' })
  const clock = (c: FakeClient, ms: number) => c.store.setState((s) => ({ ...s, clockOffset: ms }))

  it('a hook row after the owner message still offers Undo', () => {
    const c = setup()
    setMessages(c, [msg('agent', 'a'), msg('owner', 'do it'), hook()])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
  it('owner, hook, owner is two owner messages: no Undo', () => {
    const c = setup()
    setMessages(c, [msg('agent', 'a'), msg('owner', 'one'), hook(), msg('owner', 'two')])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
  it('a system row ends the run of owner messages', () => {
    const c = setup()
    setMessages(c, [msg('owner', 'one'), msg('system', 'You stopped your agent'), msg('owner', 'two')])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
  it('a phone clock 3 min slow: a 4-min-old stored message (relay time) gets no Undo', () => {
    const c = setup()
    clock(c, 180_000) // the relay is 3 min ahead of this phone
    setMessages(c, [msg('agent', 'a'), msg('owner', 'old', { created_at: ago(240_000 - 180_000) })])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
  it('a phone clock 3 min fast: a 30-s-old stored message (relay time) still gets Undo', () => {
    const c = setup()
    clock(c, -180_000) // the relay is 3 min behind this phone
    setMessages(c, [msg('agent', 'a'), msg('owner', 'fresh', { created_at: ago(180_000 + 30_000) })])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
  it('a message stamped well in the future (beyond 5 s) counts as too old', () => {
    const c = setup()
    setMessages(c, [msg('agent', 'a'), msg('owner', 'odd', { created_at: ago(-60_000) })])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
  it('a local row with no seq is timed on the local clock, whatever the offset', () => {
    const c = setup()
    clock(c, 180_000)
    setMessages(c, [msg('agent', 'a'), msg('owner', 'mine', { seq: undefined, created_at: ago(10_000) })])
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('focus stays in the message box when the owner started typing before the stop landed', () => {
    const c = setup()
    setMessages(c, mine())
    strip(c)
    const box = screen.getByLabelText('Message')
    act(() => box.focus())
    act(() => offerStopped(c, 'general', { focus: true }))
    expect(document.activeElement).toBe(box)
  })

  const noUndo: Array<[string, (c: FakeClient) => void]> = [
    [
      'the owner message is 3 minutes old',
      (c) => setMessages(c, [msg('agent', 'a'), msg('owner', 'old', { created_at: ago(180_000) })]),
    ],
    [
      'two owner messages came since the last agent row',
      (c) => setMessages(c, [msg('agent', 'a'), msg('owner', 'one'), msg('owner', 'two')]),
    ],
    ['the owner message is not the newest row', (c) => setMessages(c, [msg('owner', 'one'), msg('agent', 'a')])],
    ['it is a Run', (c) => setMessages(c, [msg('agent', 'a'), msg('owner', 'Run exactly this:\n\n```sh\nls\n```')])],
    ['it is a share', (c) => setMessages(c, [msg('agent', 'a'), msg('owner', 'look', { via: 'share' })])],
    ['it is a voice note', (c) => setMessages(c, [msg('agent', 'a'), msg('owner', '', { kind: 'voice_note' })])],
    ['there is no owner message', (c) => setMessages(c, [msg('agent', 'hello')])],
  ]
  for (const [why, setup_] of noUndo)
    it(`no Undo, and no "Your message is kept", when ${why}`, () => {
      const c = setup()
      setup_(c)
      strip(c)
      act(() => offerStopped(c, 'general'))
      const el = screen.getByTestId('stopped-strip')
      expect(el.textContent).toBe('Stopped Talos.')
      expect(el.textContent).not.toContain('Your message is kept')
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    })

  it('a resend that throws keeps the strip with an alert and no Undo', async () => {
    const c = setup()
    setMessages(c, mine())
    vi.spyOn(c, 'sendMessage').mockRejectedValue(new Error('offline'))
    strip(c)
    act(() => offerStopped(c, 'general'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't send it again. Your message is still in the thread.")
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByTestId('stopped-strip')).toBeTruthy()
  })

  it('goes when the owner sends something else', async () => {
    const c = setup()
    setMessages(c, mine())
    strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.getByTestId('stopped-strip')).toBeTruthy()
    await act(async () => {
      await c.sendMessage({ threadId: 'general', text: 'something else' })
    })
    await waitFor(() => expect(screen.queryByTestId('stopped-strip')).toBeNull())
  })

  it('goes when the owner leaves the thread', () => {
    const c = setup()
    setMessages(c, mine())
    const r = strip(c)
    act(() => offerStopped(c, 'general'))
    expect(screen.getByTestId('stopped-strip')).toBeTruthy()
    r.unmount()
    act(() => offerStopped(c, 'general')) // nobody is on the thread: nothing is kept for later
    strip(c)
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
  })

  it('focus: Undo takes it when Stop had it, and the message box gets it back when the strip times out', () => {
    vi.useFakeTimers()
    const c = setup()
    setMessages(c, mine())
    strip(c)
    act(() => offerStopped(c, 'general', { focus: true }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }))
    act(() => {
      vi.advanceTimersByTime(STOPPED_MS + 1)
    })
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText('Message'))
  })

  it('focus goes to the message box when there is no Undo', () => {
    const c = setup()
    setMessages(c, [msg('agent', 'hello')])
    strip(c)
    act(() => offerStopped(c, 'general', { focus: true }))
    expect(document.activeElement).toBe(screen.getByLabelText('Message'))
  })

  it('a stop error shows above the box, goes after 10 s, and goes on the next send', async () => {
    vi.useFakeTimers()
    const c = setup()
    setMessages(c, mine())
    strip(c)
    act(() => offerStopError('general', 'That turn already ended.'))
    const err = screen.getByTestId('stop-line-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('already ended')
    act(() => {
      vi.advanceTimersByTime(ERROR_MS - 1)
    })
    expect(screen.queryByTestId('stop-line-error')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('stop-line-error')).toBeNull()
    vi.useRealTimers()
    act(() => offerStopError('general', 'Again.'))
    expect(screen.getByTestId('stop-line-error')).toBeTruthy()
    await act(async () => {
      await c.sendMessage({ threadId: 'general', text: 'next' })
    })
    await waitFor(() => expect(screen.queryByTestId('stop-line-error')).toBeNull())
  })
})
