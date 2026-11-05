// Package C review round (screens): Edit keeps a draft and a reply, a voice note has no Edit, the inbox box keeps what a
// refused send was carrying.
import type { MessageT } from '@talos-app/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider, type TalosClient, TalosClientError } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { makeItem, renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {} }))
afterEach(cleanup)

const msg = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'owner',
    kind: 'text',
    text: 'doomed words',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as MessageT

function failedClient() {
  const client = setup({}) as unknown as TalosClient & { discardMessage: ReturnType<typeof vi.fn> }
  client.discardMessage = vi.fn(async () => {})
  return client
}

function mount(m: MessageT, client: TalosClient, withComposer = false) {
  const meta = createMetaStore()
  meta.setState({ failed: { [m.id]: 'final' } })
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MetaProvider store={meta}>
          <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
          {withComposer && <Composer threadId="general" placeholder="Message" />}
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>,
  )
}

describe('Edit on a failed message', () => {
  it('adds the words after a draft that is already in the box instead of replacing it', async () => {
    mount(msg(), failedClient(), true)
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'my new draft' } })
    fireEvent.click(screen.getByTestId('send-failed-edit'))
    await waitFor(() => expect(box.value).toContain('doomed words'))
    expect(box.value).toContain('my new draft')
  })

  it('an empty box simply gets the words', async () => {
    mount(msg(), failedClient(), true)
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.click(screen.getByTestId('send-failed-edit'))
    await waitFor(() => expect(box.value).toBe('doomed words'))
  })

  it('a failed reply comes back as a reply: the quote bar returns with it', async () => {
    const client = failedClient()
    const parent = msg({ id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U4', author: 'agent', text: 'Is the room booked?' })
    client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [parent] } }))
    mount(msg({ reply_to: parent.id }), client, true)
    fireEvent.click(screen.getByTestId('send-failed-edit'))
    await waitFor(() => expect(screen.getByTestId('reply-bar').textContent).toContain('Is the room booked?'))
    expect(useComposerStore.getState().replyTo.general?.id).toBe(parent.id)
  })

  it('a failed voice note offers Delete only: there are no words to take back', () => {
    mount(msg({ kind: 'voice_note', text: undefined, attachments: [] }), failedClient())
    expect(screen.getByTestId('send-failed-delete')).toBeTruthy()
    expect(screen.queryByTestId('send-failed-edit')).toBeNull()
  })
})

describe('the inbox box', () => {
  it('keeps the words and says why when the app refuses the message (over 32,000 characters)', async () => {
    const client = setup({ inbox: [makeItem()] })
    vi.spyOn(client, 'sendMessage').mockRejectedValue(new TalosClientError('too_large', 'That message is too long.'))
    renderWith(<InboxScreen />, client)
    const box = screen.getByRole('textbox', { name: 'Ask Talos about your inbox' }) as HTMLInputElement
    await userEvent.type(box, 'a long question')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByTestId('inbox-ask-error')).textContent).toContain('too long')
    expect(box.value).toBe('a long question')
  })

  it('control: a message that is taken clears the box', async () => {
    const client = setup({ inbox: [makeItem()] })
    renderWith(<InboxScreen />, client)
    const box = screen.getByRole('textbox', { name: 'Ask Talos about your inbox' }) as HTMLInputElement
    await userEvent.type(box, 'anything urgent?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(box.value).toBe(''))
    expect(screen.queryByTestId('inbox-ask-error')).toBeNull()
  })
})
