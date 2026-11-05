// Ask on the Help page must never cost the owner an unsent draft. It is driven from the real button, through the real
// router, into the real composer with a draft already stored for the default thread.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { loadDraft, saveDraft, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { HELP_PATH } from '../../src/features/help/content.ts'
import { HelpScreen } from '../../src/features/help/HelpScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage, type Storage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'
import { statusOf } from '../health/status.ts'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  useComposerStore.setState({ prefill: {} })
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(statusOf())),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const DEFAULT_THREAD = setup().store.getState().config?.default_thread ?? 'general'

function openHelp(storage: Storage) {
  const client = setup()
  render(
    <StorageProvider storage={storage}>
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[HELP_PATH]}>
          <Routes>
            <Route path={HELP_PATH} element={<HelpScreen />} />
            <Route path="/t/:thread" element={<Composer threadId={DEFAULT_THREAD} placeholder="Message Talos" />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
}

describe('Ask on the Help page and an unsent draft', () => {
  it('keeps the draft in the box and in storage, and puts the question under it', async () => {
    const storage = createMemoryStorage()
    await saveDraft(storage, DEFAULT_THREAD, 'half a sentence to Jordan')
    openHelp(storage)
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search Help' }), 'quiet hours')
    await userEvent.click(screen.getByTestId('help-ask'))
    const box = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toContain('I need help with Talos. quiet hours'))
    expect(box.value).toContain('half a sentence to Jordan')
    expect(box.value.indexOf('half a sentence')).toBeLessThan(box.value.indexOf('I need help'))
    // the debounced save must not overwrite the stored draft with only the question
    await waitFor(async () => expect(await loadDraft(storage, DEFAULT_THREAD)).toContain('I need help with Talos.'))
    expect(await loadDraft(storage, DEFAULT_THREAD)).toContain('half a sentence to Jordan')
  })

  it('with no draft the box holds just the question', async () => {
    const storage = createMemoryStorage()
    openHelp(storage)
    await userEvent.click(await screen.findByTestId('help-ask'))
    const box = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe('I need help with Talos.'))
  })

  it('an unreadable stored draft does not hold the question back', async () => {
    const storage = createMemoryStorage()
    storage.get = (async () => {
      throw new Error('disk gone')
    }) as Storage['get']
    openHelp(storage)
    await userEvent.click(await screen.findByTestId('help-ask'))
    const box = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe('I need help with Talos.'))
  })
})
