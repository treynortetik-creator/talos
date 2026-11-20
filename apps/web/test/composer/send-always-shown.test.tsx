// Send is always on screen (the owner, 2026-11-20: "there's no button to hit Send"). With nothing to send it is dimmed and
// marked aria-disabled, and a tap or Enter sends nothing; with words or a ready attachment it sends; while an upload runs it
// waits, dimmed.
import type { AttachmentRefT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

beforeEach(() => useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {} }))
afterEach(cleanup)

const mount = (client = setup({})) =>
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="general" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement
const send = () => screen.getByRole('button', { name: 'Send' })
const ref = {
  media_id: 'md_a',
  kind: 'file',
  role: 'attachment',
  mime: 'text/plain',
  name: 'a.txt',
  size: 1,
  sha256: '0'.repeat(64),
} as AttachmentRefT

describe('Send is always there', () => {
  it('an empty box shows Send, dimmed and aria-disabled; a tap and Enter send nothing', async () => {
    const client = setup({})
    const spy = vi.spyOn(client, 'sendMessage')
    mount(client)
    expect(send().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(send())
    fireEvent.keyDown(box(), { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 30))
    expect(spy).not.toHaveBeenCalled()
  })

  it('typing turns the same Send on, and it sends', async () => {
    const client = setup({})
    const spy = vi.spyOn(client, 'sendMessage')
    mount(client)
    const before = send()
    fireEvent.change(box(), { target: { value: 'hello' } })
    expect(send()).toBe(before) // the same element: nothing is swapped in
    expect(send().getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(send())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    // the box empties after the send: Send stays, dimmed again
    await waitFor(() => expect(send().getAttribute('aria-disabled')).toBe('true'))
  })

  it('whitespace only is nothing to send', () => {
    mount()
    fireEvent.change(box(), { target: { value: '   \n ' } })
    expect(send().getAttribute('aria-disabled')).toBe('true')
  })

  it('a ready attachment alone turns Send on; an upload still running keeps it dimmed and sends nothing', async () => {
    const client = setup({})
    const spy = vi.spyOn(client, 'sendMessage')
    mount(client)
    act(() =>
      useComposerStore.setState({
        chips: { general: [{ key: 'k1', name: 'a.txt', size: 1, state: 'uploading', progress: 0.3 } as never] },
      }),
    )
    fireEvent.change(box(), { target: { value: 'with a file' } })
    expect(send().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(send())
    await new Promise((r) => setTimeout(r, 30))
    expect(spy).not.toHaveBeenCalled()
    fireEvent.change(box(), { target: { value: '' } })
    act(() =>
      useComposerStore.setState({
        chips: { general: [{ key: 'k1', name: 'a.txt', size: 1, state: 'ready', ref } as never] },
      }),
    )
    expect(send().getAttribute('aria-disabled')).toBeNull()
  })
})
