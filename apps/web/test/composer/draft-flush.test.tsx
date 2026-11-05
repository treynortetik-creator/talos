// A draft typed just before leaving a thread (inside the 300 ms debounce) is saved on the way out, not dropped.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { loadDraft } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

describe('composer draft', () => {
  it('is saved when the composer unmounts before the debounce fires', async () => {
    const storage = createMemoryStorage()
    const client = setup({})
    const ui = (
      <StorageProvider storage={storage}>
        <ClientProvider client={client}>
          <Composer threadId="errands" placeholder="Message Talos" />
        </ClientProvider>
      </StorageProvider>
    )
    const { unmount } = render(ui)
    await new Promise((r) => setTimeout(r, 20)) // let the stored draft (none) load
    await userEvent.type(screen.getByLabelText('Message'), 'over here')
    unmount() // well inside 300 ms
    await new Promise((r) => setTimeout(r, 20))
    expect(await loadDraft(storage, 'errands')).toBe('over here')
  })
})
