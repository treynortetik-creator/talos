// The call error line, rendered inside the real thread screen (the real ThreadScreen, with its per-thread remount, and the
// real composer and call button), not a stand-in.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { CallController } from '../../src/features/voice/callController.ts'
import { setCallController } from '../../src/features/voice/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { expectNothingLeftOpen, fakeDeps } from './fakes.ts'

for (const k of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const)
  (Element.prototype as unknown as Record<string, unknown>)[k] ??= () => false

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  setCallController(null)
  vi.useRealTimers()
  localStorage.clear()
})

function Nav() {
  const go = useNavigate()
  return (
    <>
      <button type="button" onClick={() => go('/t/other')}>
        go-other
      </button>
      <button type="button" onClick={() => go('/t/general')}>
        go-general
      </button>
    </>
  )
}

const refuse = () => ({ fetchResponses: [new Response('{}', { status: 503 }), new Response('{}', { status: 503 })] })

function mount(over: Parameters<typeof fakeDeps>[0] = refuse()) {
  const f = fakeDeps(over)
  const c = new CallController(f.deps)
  setCallController(c)
  const client = createFakeClient()
  client.store.setState((s) => ({
    ...s,
    threads: [
      ...s.threads,
      {
        id: 'other',
        name: 'Other',
        kind: 'fixed' as const,
        order: 9,
        notify: 'all' as const,
        voice_context: 'recent' as const,
        archived: false,
        created_at: '2026-10-01T00:00:00.000Z',
      },
    ],
  }))
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/t/general']}>
        <Routes>
          <Route path="/t/:thread" element={<ThreadScreen />} />
        </Routes>
        <Nav />
      </MemoryRouter>
    </ClientProvider>,
  )
  return { c, f, client }
}

const callButton = () => screen.findByRole('button', { name: 'Start a live call' })
const box = () => document.querySelector('.composer-box') as HTMLTextAreaElement

describe('call error in the real thread screen', () => {
  it('a failed call shows its line from the real call button, and tapping the line takes it away', async () => {
    const { c, f } = mount()
    await userEvent.click(await callButton())
    const line = await screen.findByTestId('call-error')
    expect(line.textContent).toContain("Live voice isn't set up on this relay.")
    expect(line.getAttribute('role')).toBe('alert')
    await userEvent.click(line.querySelector('button') as HTMLButtonElement)
    expect(screen.queryByTestId('call-error')).toBeNull()
    expect(c.store.getState().error).toBeNull()
    expectNothingLeftOpen(f)
  })

  it('the line is not part of the call button (nothing floats over the thread)', async () => {
    mount()
    await userEvent.click(await callButton())
    const line = await screen.findByTestId('call-error')
    expect(line.closest('span.relative')).toBeNull()
    expect(line.className).not.toMatch(/absolute|fixed/)
  })

  it('going from this thread to another and back within the fade does not bring the old line back', async () => {
    const { c } = mount()
    await userEvent.click(await callButton())
    await screen.findByTestId('call-error')
    await userEvent.click(screen.getByRole('button', { name: 'go-other' }))
    await waitFor(() => expect(screen.queryByTestId('call-error')).toBeNull())
    expect(c.store.getState().error).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'go-general' }))
    await callButton()
    expect(screen.queryByTestId('call-error')).toBeNull()
  })

  it('an error from a call started on one thread shows on the thread the owner moved to while it connected', async () => {
    let refuseMic!: (e: unknown) => void
    const { c } = mount({
      getUserMedia: () =>
        new Promise<MediaStream>((_, reject) => {
          refuseMic = reject
        }),
    })
    await userEvent.click(await callButton())
    await userEvent.click(screen.getByRole('button', { name: 'go-other' }))
    await waitFor(() => expect(box()).not.toBeNull())
    expect(c.store.getState().threadId).toBe('general')
    await act(async () => refuseMic(Object.assign(new Error('x'), { name: 'NotAllowedError' })))
    const line = await screen.findByTestId('call-error')
    expect(line.textContent).toContain('Allow the microphone')
    // and it is gone again once he leaves the thread he saw it on
    await userEvent.click(screen.getByRole('button', { name: 'go-general' }))
    await callButton()
    expect(screen.queryByTestId('call-error')).toBeNull()
  })

  it('goes away on its own after the timeout', async () => {
    const { c } = mount({
      fetchResponses: [new Response('{}', { status: 503 })],
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as number),
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(await callButton())
    await screen.findByTestId('call-error')
    await act(() => vi.advanceTimersByTimeAsync(10_500))
    expect(screen.queryByTestId('call-error')).toBeNull()
    expect(c.store.getState().error).toBeNull()
  })

  it('starting another call removes the old line while it connects', async () => {
    const { c } = mount()
    await userEvent.click(await callButton())
    await screen.findByTestId('call-error')
    void c.start(createFakeClient(), 'general')
    await waitFor(() => expect(screen.queryByTestId('call-error')).toBeNull())
  })
})

describe('focus when the line is dismissed', () => {
  it('a tap keeps focus (and the on-screen keyboard) in the box, even with text in it', async () => {
    mount()
    await userEvent.click(await callButton())
    const line = await screen.findByTestId('call-error')
    await userEvent.click(box())
    await userEvent.keyboard('hello')
    expect(document.activeElement).toBe(box())
    await userEvent.click(line.querySelector('button') as HTMLButtonElement)
    expect(screen.queryByTestId('call-error')).toBeNull()
    expect(document.activeElement).toBe(box())
    expect(box().value).toBe('hello')
    await userEvent.clear(box()) // the draft outlives the render
  })

  it('a tap with the box not focused does not steal focus onto the call button', async () => {
    mount()
    await userEvent.click(await callButton())
    const line = await screen.findByTestId('call-error')
    await userEvent.click(line.querySelector('button') as HTMLButtonElement)
    expect(document.activeElement).not.toBe(await callButton())
  })

  it('by keyboard, Enter on the line moves focus to the call button', async () => {
    mount()
    await userEvent.click(await callButton())
    const line = await screen.findByTestId('call-error')
    const dismiss = line.querySelector('button') as HTMLButtonElement
    dismiss.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByTestId('call-error')).toBeNull()
    expect(document.activeElement).toBe(await callButton())
  })

  it('by keyboard with text in the box (no call button) focus goes to the box, not the page', async () => {
    mount()
    await userEvent.click(await callButton())
    const line = await screen.findByTestId('call-error')
    await userEvent.click(box())
    await userEvent.keyboard('hello')
    expect(screen.queryByRole('button', { name: 'Start a live call' })).toBeNull()
    ;(line.querySelector('button') as HTMLButtonElement).focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByTestId('call-error')).toBeNull()
    expect(document.activeElement).toBe(box())
    expect(document.activeElement).not.toBe(document.body)
    await userEvent.clear(box())
  })
})
