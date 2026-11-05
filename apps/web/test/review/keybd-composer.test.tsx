// Phone composer regression test: the + menu's cancel path.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () => Promise.resolve({ cancel() {}, elapsedMs: () => 0 }),
}))

afterEach(() => cleanup())

describe('+ menu after a voice note', () => {
  it('BUG-6: a cancelled picker still hands focus back once a locked recording has remounted the file inputs', async () => {
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={setup({})}>
          <Composer threadId="t1" placeholder="Message" />
        </ClientProvider>
      </StorageProvider>,
    )
    fireEvent.click(screen.getByTestId('mic')) // detail 0: the keyboard / assistive path into locked mode
    await screen.findByTestId('recorder-locked')
    expect(screen.queryByTestId('pick-files')).toBeNull() // the inputs left the DOM with the idle row
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    const input = await screen.findByTestId('pick-files')
    fireEvent(input, new Event('cancel'))
    expect(document.activeElement).toBe(screen.getByLabelText('Message'))
  })
})
