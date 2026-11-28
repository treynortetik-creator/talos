// The Ask buttons (an inbox item, the item sheet in a thread, a schedule) must never cost the owner an unsent draft. Each is
// driven from the real button, through the real router, into the real composer with a draft already stored for the thread.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { saveDraft, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { useTellAgent } from '../../src/features/schedules/SchedulesScreen.tsx'
import { ItemSheet } from '../../src/features/threads/ItemSheet.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { makeItem, setup } from '../cards/helpers.tsx'

beforeEach(() => {
  useComposerStore.setState({ prefill: {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

const DEFAULT_THREAD = setup().store.getState().config?.default_thread ?? 'general'
const DRAFT = 'half a sentence to Jordan'

function Tell() {
  const tell = useTellAgent()
  return (
    <button type="button" onClick={() => tell('Set up a scheduled job: ')}>
      Tell the agent
    </button>
  )
}

async function mount(ui: React.ReactElement, thread: string, items = [makeItem({ title: 'Invoice question' })]) {
  const storage = createMemoryStorage()
  await saveDraft(storage, thread, DRAFT)
  const client = setup({ inbox: items })
  render(
    <StorageProvider storage={storage}>
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/start']}>
          <Routes>
            <Route path="/start" element={ui} />
            <Route path="/t/:thread" element={<Composer threadId={thread} placeholder="Message Talos" />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  return { storage, client }
}

const boxHasBoth = async (words: string) => {
  const box = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
  await waitFor(() => expect(box.value).toContain(words))
  expect(box.value).toContain(DRAFT)
  expect(box.value.indexOf(DRAFT)).toBeLessThan(box.value.indexOf(words))
}

describe('Ask buttons add to a draft', () => {
  it('Ask on an inbox item keeps the draft in the default thread', async () => {
    await mount(<InboxScreen />, DEFAULT_THREAD)
    await userEvent.click(screen.getByText('Invoice question'))
    await userEvent.click(await screen.findByRole('button', { name: /^Ask / }))
    await boxHasBoth('re: Invoice question')
  })

  it('Ask on a schedule (Tell the agent) keeps the draft', async () => {
    await mount(<Tell />, DEFAULT_THREAD)
    await userEvent.click(screen.getByRole('button', { name: 'Tell the agent' }))
    await boxHasBoth('Set up a scheduled job:')
  })

  it('Ask in the item sheet keeps the draft in the inbox thread', async () => {
    const item = makeItem({ title: 'Sheet item' })
    await mount(<ItemSheet item={item} onClose={() => {}} />, 'inbox', [item])
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ask / }))
    await waitFor(() => expect(useComposerStore.getState().prefill.inbox?.mode).toBe('append'))
  })
})
