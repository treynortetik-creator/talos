// Dictation tools (Wispr Flow and friends) put text in the box without a keystroke: a clipboard paste, setRangeText, or a
// value set straight on the element. The box must keep it and send it, with or without an input event.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

function mount() {
  const client = createFakeClient()
  const send = vi.spyOn(client, 'sendMessage').mockResolvedValue(undefined as never)
  render(
    <ClientProvider client={client}>
      <Composer threadId="general" />
    </ClientProvider>,
  )
  return { send, box: screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement }
}

// What the page sees when a tool writes through the element's native setter, bypassing React's value tracker.
function nativeSet(el: HTMLTextAreaElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  set?.call(el, v)
}

describe('composer takes programmatic text', () => {
  it('setRangeText plus an input event is kept and sent', async () => {
    const { send, box } = mount()
    box.focus()
    box.setRangeText('from dictation', 0, 0, 'end')
    fireEvent.input(box)
    expect(box.value).toBe('from dictation')
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'from dictation' }))
  })

  it('a native value change with no event is read on focus and survives the next render', async () => {
    const { send, box } = mount()
    nativeSet(box, 'silent insert')
    fireEvent.focus(box)
    fireEvent.blur(box)
    expect(box.value).toBe('silent insert')
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'silent insert' }))
  })

  it('Enter sends text that never reached React state', () => {
    const { send, box } = mount()
    nativeSet(box, 'enter me')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'enter me' }))
  })

  it('a paste whose file list throws still lets the text in', () => {
    const { box } = mount()
    const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    e.clipboardData = {
      get files(): never {
        throw new Error('lazy clipboard')
      },
    }
    box.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('focus after sending', () => {
  it('Send does not take focus on mouse down, and the box is focused after the click', async () => {
    const { box } = mount()
    box.focus()
    fireEvent.change(box, { target: { value: 'hi' } })
    const btn = await screen.findByRole('button', { name: 'Send' })
    expect(fireEvent.mouseDown(btn)).toBe(false) // default prevented: focus stays in the box
    fireEvent.click(btn)
    await vi.waitFor(() => expect(document.activeElement).toBe(box))
  })
})

describe('paste is inserted by the handler', () => {
  // Chrome can drop the default insert when the system clipboard changes mid-paste (dictation tools restore the old
  // clipboard right after). Only the handler may insert here: jsdom has no default paste action at all.
  const paste = (box: HTMLTextAreaElement, text: string) =>
    fireEvent.paste(box, { clipboardData: { files: [], getData: (t: string) => (t === 'text/plain' ? text : '') } })

  it('inserts the text at the selection, sends it, twice in a row', async () => {
    const { send, box } = mount()
    for (const word of ['first', 'second']) {
      box.focus()
      expect(paste(box, word)).toBe(false) // default prevented: we inserted it ourselves
      expect(box.value).toBe(word)
      fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
      await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: word })))
      await vi.waitFor(() => expect(box.value).toBe(''))
    }
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('replaces the selection and keeps the surrounding text', () => {
    const { box } = mount()
    fireEvent.change(box, { target: { value: 'a XX b' } })
    box.setSelectionRange(2, 4)
    paste(box, 'yy')
    expect(box.value).toBe('a yy b')
  })
})
