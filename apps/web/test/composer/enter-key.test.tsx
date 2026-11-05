// Enter in the message box: a computer sends, a touch keyboard starts a new line, Shift+Enter always starts a new line, and
// Enter that confirms an input-method choice never sends. Help promises the touch and Shift rules.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function pointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('pointer: coarse') ? coarse : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
  if (typeof window !== 'undefined') window.matchMedia = globalThis.matchMedia
}

// The box keeps a draft per thread, so every test uses its own thread and none inherits another's words.
let n = 0
async function setup(coarse: boolean) {
  pointer(coarse)
  const client = createFakeClient()
  const send = vi.spyOn(client, 'sendMessage').mockResolvedValue({ clientMsgId: 'x', state: 'sent' })
  render(
    <ClientProvider client={client}>
      <Composer threadId={`general-${++n}`} />
    </ClientProvider>,
  )
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
  await userEvent.type(box, 'some words')
  return { box, send }
}

describe('Enter in the message box', () => {
  it('sends on a computer', async () => {
    const { box, send } = await setup(false)
    await userEvent.keyboard('{Enter}')
    expect(send).toHaveBeenCalledTimes(1)
    expect(box.value).toBe('')
  })

  it('does not send on a touch screen: the text stays and Enter adds a new line', async () => {
    const { box, send } = await setup(true)
    await userEvent.keyboard('{Enter}')
    expect(send).not.toHaveBeenCalled()
    expect(box.value).toBe('some words\n')
  })

  it('does not send with Shift held, on a computer', async () => {
    const { box, send } = await setup(false)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(send).not.toHaveBeenCalled()
    expect(box.value).toBe('some words\n')
  })

  it('does not send while an input method is composing', async () => {
    const { box, send } = await setup(false)
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(send).not.toHaveBeenCalled()
    expect(box.value).toBe('some words')
  })
})
