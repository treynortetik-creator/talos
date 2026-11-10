// Review finding #42 (web items): no paste chord is swallowed, a failed text send is surfaced and restored, and an
// unparsable push still shows a fixed fallback notification.
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { notificationForPush } from '../../src/features/pwa/pushLogic.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { useGlobalKeys } from '../../src/lib/useKeyboard.ts'

afterEach(cleanup)

function Keys({ onCall }: { onCall?: () => void }) {
  // the table has the Call chord; a handler that does not run it answers false, so the browser keeps the key
  useGlobalKeys({ onAction: (e) => (e.id === 'call' && onCall ? onCall() : false) })
  return null
}

describe('call shortcut', () => {
  const chord = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init })
  it('never takes a paste chord, even when a call handler exists', () => {
    const onCall = vi.fn()
    render(<Keys onCall={onCall} />)
    for (const init of [
      { code: 'KeyV', key: 'v', metaKey: true, shiftKey: true },
      { code: 'KeyV', key: 'v', metaKey: true },
      { code: 'Insert', key: 'Insert', shiftKey: true },
    ]) {
      const e = chord(init)
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
    expect(onCall).not.toHaveBeenCalled()
  })
  it('is taken only when a call handler exists', () => {
    render(<Keys />)
    const none = chord({ code: 'KeyK', key: 'k', metaKey: true, shiftKey: true })
    window.dispatchEvent(none)
    expect(none.defaultPrevented).toBe(false)
    cleanup()
    const onCall = vi.fn()
    render(<Keys onCall={onCall} />)
    const e = chord({ code: 'KeyK', key: 'k', metaKey: true, shiftKey: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(onCall).toHaveBeenCalledTimes(1)
  })
})

describe('Composer send failure', () => {
  it('keeps the text and says so when the client refuses the message', async () => {
    const client = createFakeClient()
    vi.spyOn(client, 'sendMessage').mockRejectedValue(new Error('boom'))
    render(
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>,
    )
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await userEvent.type(box, 'important words')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/Couldn't send/)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('important words')
  })
})

describe('unparsable push', () => {
  it('shows a fixed fallback notification and none of the payload text', () => {
    const n = notificationForPush({ title: 'x', body: 'leaked message text' })
    expect(n.title).toBe('Talos')
    expect(n.options.body).not.toMatch(/leaked/)
    expect(n.options.data.navigate).toBe('/')
    expect(notificationForPush(null).title).toBe('Talos')
  })
})
