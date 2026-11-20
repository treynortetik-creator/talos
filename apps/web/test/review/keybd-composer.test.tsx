// Phone composer regression test: the + menu's cancel path.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(() => cleanup())

describe('+ menu', () => {
  it('a cancelled picker hands focus back to the box', async () => {
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={setup({})}>
          <Composer threadId="t1" placeholder="Message" />
        </ClientProvider>
      </StorageProvider>,
    )
    const input = await screen.findByTestId('pick-files')
    fireEvent(input, new Event('cancel'))
    expect(document.activeElement).toBe(screen.getByLabelText('Message'))
  })
})
