// Package C (D5, D14): Delete and Edit on a failed row; Copy and Reply on a message (menu from the button, a right-click
// or a long press); Reply is sent as `reply_to` and shows as a quote; code blocks have Copy.
import type { MessageT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

beforeEach(() => useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {} }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const msg = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'agent',
    kind: 'text',
    text: 'The venue is booked for Saturday.',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as MessageT

function mount(m: MessageT, client: TalosClient = setup({}), meta = createMetaStore(), withComposer = false) {
  const view = render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MetaProvider store={meta}>
          <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
          {withComposer && <Composer threadId="general" placeholder="Message" />}
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>,
  )
  return { client, meta, ...view }
}

describe('D5 failed rows', () => {
  const failedClient = () => {
    const client = setup({}) as unknown as TalosClient & {
      discardMessage: ReturnType<typeof vi.fn>
      retryMessage: ReturnType<typeof vi.fn>
    }
    client.discardMessage = vi.fn(async () => {})
    client.retryMessage = vi.fn()
    return client
  }
  const owner = (over: Partial<MessageT> = {}) => msg({ author: 'owner', text: 'my long words', ...over })

  it('a retryable failure offers Retry, Edit and Delete', () => {
    const meta = createMetaStore()
    const m = owner()
    meta.setState({ failed: { [m.id]: 'retry' } })
    mount(m, failedClient(), meta)
    expect(screen.getByRole('button', { name: 'Failed, tap to retry' })).toBeTruthy()
    expect(screen.getByTestId('send-failed-edit')).toBeTruthy()
    expect(screen.getByTestId('send-failed-delete')).toBeTruthy()
  })

  it('a final failure (can never send) still has Edit and Delete', () => {
    const meta = createMetaStore()
    const m = owner()
    meta.setState({ failed: { [m.id]: 'final' } })
    mount(m, failedClient(), meta)
    expect(screen.getByText("Couldn't send this message.")).toBeTruthy()
    expect(screen.getByTestId('send-failed-edit')).toBeTruthy()
    expect(screen.getByTestId('send-failed-delete')).toBeTruthy()
  })

  it('Delete discards that message', async () => {
    const meta = createMetaStore()
    const m = owner()
    meta.setState({ failed: { [m.id]: 'retry' } })
    const client = failedClient()
    mount(m, client, meta)
    fireEvent.click(screen.getByTestId('send-failed-delete'))
    await waitFor(() => expect(client.discardMessage).toHaveBeenCalledWith(m.id))
  })

  it('Edit discards it and puts the text and files back in the box', async () => {
    const meta = createMetaStore()
    const att = {
      media_id: 'md_a',
      kind: 'file',
      role: 'attachment',
      mime: 'text/plain',
      name: 'a.txt',
      size: 1,
      sha256: '0'.repeat(64),
    }
    const m = owner({ attachments: [att as never] })
    meta.setState({ failed: { [m.id]: 'retry' } })
    const client = failedClient()
    mount(m, client, meta)
    fireEvent.click(screen.getByTestId('send-failed-edit'))
    await waitFor(() => expect(client.discardMessage).toHaveBeenCalledWith(m.id))
    expect(useComposerStore.getState().prefill.general).toEqual({ text: 'my long words', mode: 'append' })
    expect(useComposerStore.getState().chips.general?.[0]).toMatchObject({ name: 'a.txt', state: 'ready' })
  })
})

describe('D14 message actions', () => {
  it('Copy puts the message text on the clipboard', async () => {
    const write = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    mount(msg())
    fireEvent.click(screen.getByTestId('msg-actions'))
    fireEvent.click(await screen.findByTestId('msg-copy'))
    await waitFor(() => expect(write).toHaveBeenCalledWith('The venue is booked for Saturday.'))
    expect(await screen.findByText('Copied')).toBeTruthy()
  })

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } })
    document.execCommand = vi.fn(() => false)
    mount(msg())
    fireEvent.click(screen.getByTestId('msg-actions'))
    fireEvent.click(await screen.findByTestId('msg-copy'))
    expect(await screen.findByText("Couldn't copy")).toBeTruthy()
  })

  it('right-click opens the same menu', async () => {
    mount(msg())
    fireEvent.contextMenu(screen.getByText('The venue is booked for Saturday.'))
    expect(await screen.findByTestId('msg-reply')).toBeTruthy()
  })

  it('a 500 ms touch press opens it; a short tap does not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mount(msg())
      const row = screen.getByText('The venue is booked for Saturday.')
      fireEvent.pointerDown(row, { pointerType: 'touch' })
      act(() => void vi.advanceTimersByTime(200))
      fireEvent.pointerUp(row, { pointerType: 'touch' })
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.queryByTestId('msg-reply')).toBeNull()
      fireEvent.pointerDown(row, { pointerType: 'touch' })
      act(() => void vi.advanceTimersByTime(600))
      expect(screen.getByTestId('msg-reply')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Reply shows a bar above the box and the next send carries reply_to', async () => {
    const m = msg()
    const client = setup({})
    const send = vi.spyOn(client, 'sendMessage')
    mount(m, client, createMetaStore(), true)
    fireEvent.click(screen.getByTestId('msg-actions'))
    fireEvent.click(await screen.findByTestId('msg-reply'))
    expect(screen.getByTestId('reply-bar').textContent).toContain('The venue is booked')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'thanks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]?.[0]).toMatchObject({ text: 'thanks', replyTo: m.id })
    await waitFor(() => expect(screen.queryByTestId('reply-bar')).toBeNull()) // used once
  })

  it('a message that has reply_to shows what it answers', () => {
    const client = setup({})
    const parent = msg({ id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U4', text: 'Is the room booked?' })
    client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [parent] } }))
    mount(msg({ reply_to: parent.id }), client)
    expect(screen.getByTestId('msg-quote').textContent).toBe('Is the room booked?')
  })

  it('code blocks get a Copy button that copies just the code', async () => {
    const write = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    mount(msg({ format: 'markdown', text: 'Run:\n\n```sh\nls -la\n```' }))
    const btn = await screen.findByRole('button', { name: 'Copy code' })
    fireEvent.click(btn)
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect((write.mock.calls[0] as unknown as string[])[0]?.trim()).toBe('ls -la')
  })
})

describe('the Copy button in the meta line', () => {
  it('copies the message text and shows Copied, then goes back to the icon', async () => {
    const write = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mount(msg())
      const btn = screen.getByRole('button', { name: 'Copy message' })
      expect(screen.getByTestId('msg-copy-note').textContent).toBe('')
      fireEvent.click(btn)
      await waitFor(() => expect(write).toHaveBeenCalledWith('The venue is booked for Saturday.'))
      expect((await screen.findByText('Copied')).getAttribute('role')).toBe('status')
      expect(screen.getByTestId('msg-copy-note').className).not.toContain('sr-only')
      await act(async () => {
        vi.advanceTimersByTime(2100)
      })
      expect(screen.getByTestId('msg-copy-note').textContent).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is on an owner message too', () => {
    mount(msg({ author: 'owner', text: 'my words' }))
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
  })

  it('is not on a row with no text', () => {
    mount(msg({ text: undefined }))
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
  })

  it('says so in words when the clipboard and the fallback both refuse', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } })
    document.execCommand = vi.fn(() => false)
    mount(msg())
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    expect(await screen.findByText("Couldn't copy")).toBeTruthy()
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('leaves the menu Copy alone', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } })
    mount(msg())
    fireEvent.click(screen.getByTestId('msg-actions'))
    expect(await screen.findByTestId('msg-copy')).toBeTruthy()
    expect(screen.getByTestId('msg-share')).toBeTruthy()
  })
})
