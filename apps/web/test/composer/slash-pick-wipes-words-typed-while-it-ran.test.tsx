// @vitest-environment jsdom
// A command picked from the `/` list (/compact can take minutes at the Mac) leaves the box alone while it runs. When the
// answer comes back, `useComposerKeyboard.choose` empties the box and deletes the stored draft without looking at what is
// in it now, so a message the owner started meanwhile is gone. The typed path (`useComposerSend`) takes the command off
// the box first and never touches later words (test/composer/typed-command-failure.test.tsx).
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { loadDraft, saveDraft } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

type Answer = { kind: 'ok'; text: string }
const held: { finish: (o: Answer) => void; asked: string[] } = { finish: () => {}, asked: [] }

vi.mock('../../src/features/session/store.ts', async (orig) => {
  const real = await orig<typeof import('../../src/features/session/store.ts')>()
  return {
    ...real,
    useSessionController: () => ({
      ...real.useSessionController(),
      // The Mac takes its time: the answer arrives when the test says so.
      runPalette: (_thread: string, pick: { name: string }) => {
        held.asked.push(pick.name)
        return new Promise<Answer>((res) => {
          held.finish = res
        })
      },
    }),
  }
})

afterEach(cleanup)

describe('a command picked from the / list that answers late', () => {
  it('keeps the message the owner typed while it ran', async () => {
    const storage = createMemoryStorage()
    const client = setup({})
    render(
      <StorageProvider storage={storage}>
        <ClientProvider client={client}>
          <Composer threadId="general" />
        </ClientProvider>
      </StorageProvider>,
    )
    await new Promise((r) => setTimeout(r, 30)) // the inventory and the (empty) draft arrive
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    await userEvent.type(box, '/compa')
    await userEvent.keyboard('{Enter}') // picks /compact from the list
    await waitFor(() => expect(held.asked).toEqual(['compact']))

    // Compacting is under way. The owner writes the next message meanwhile.
    await userEvent.clear(box)
    await userEvent.type(box, 'newer words')
    await new Promise((r) => setTimeout(r, 350)) // the draft is saved
    expect(await loadDraft(storage, 'general')).toBe('newer words')

    held.finish({ kind: 'ok', text: 'Compacted.' })
    await screen.findByText('Compacted.')
    expect(box.value).toBe('newer words')
    expect(await loadDraft(storage, 'general')).toBe('newer words')
  })

  async function pickCompact(storage: ReturnType<typeof createMemoryStorage>) {
    held.asked.length = 0
    const view = render(
      <StorageProvider storage={storage}>
        <ClientProvider client={setup({})}>
          <Composer threadId="general" />
        </ClientProvider>
      </StorageProvider>,
    )
    await new Promise((r) => setTimeout(r, 30))
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    await userEvent.type(box, '/compa')
    await new Promise((r) => setTimeout(r, 350)) // "/compa" is the saved draft
    expect(await loadDraft(storage, 'general')).toBe('/compa')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(held.asked).toEqual(['compact']))
    return { box, ...view }
  }

  it('still empties the box and the draft when nothing was typed meanwhile', async () => {
    const storage = createMemoryStorage()
    const { box } = await pickCompact(storage)
    held.finish({ kind: 'ok', text: 'Compacted.' })
    await screen.findByText('Compacted.')
    expect(box.value).toBe('')
    await waitFor(async () => expect(await loadDraft(storage, 'general')).toBe(''))
  })

  it('clears the picked words from the stored draft when the owner left the thread while it ran', async () => {
    const storage = createMemoryStorage()
    const { unmount } = await pickCompact(storage)
    unmount() // another thread is opened; "/compa" is flushed as this thread's draft
    held.finish({ kind: 'ok', text: 'Compacted.' })
    await waitFor(async () => expect(await loadDraft(storage, 'general')).toBe(''))
  })

  it('leaves a draft written from elsewhere alone when the owner left the thread while it ran', async () => {
    const storage = createMemoryStorage()
    const { unmount } = await pickCompact(storage)
    unmount()
    await saveDraft(storage, 'general', 'written on the way back') // e.g. the thread reopened and typed in
    held.finish({ kind: 'ok', text: 'Compacted.' })
    await new Promise((r) => setTimeout(r, 50))
    expect(await loadDraft(storage, 'general')).toBe('written on the way back')
  })
})
