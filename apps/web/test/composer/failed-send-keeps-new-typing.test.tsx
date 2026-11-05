// A send that fails gives the sent words back and keeps what the owner typed while it was in flight: both stay in the box.
// The failure is one the real client throws before anything is queued: the outbox write to local storage was refused.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

afterEach(cleanup)

function setup() {
  const client = createFakeClient()
  let fail: (e: Error) => void = () => {}
  vi.spyOn(client, 'sendMessage').mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  render(
    // Its own storage per test: the box saves a draft per thread, and the default store is shared by the whole file.
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>
    </StorageProvider>,
  )
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
  return { box, fail: (e: Error) => fail(e) }
}

// What the outbox write throws when the browser refuses to store the signed frame.
const storageRefused = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')

describe('a failed send', () => {
  it('keeps both the sent words and what was typed while it was in flight', async () => {
    const { box, fail } = setup()
    await userEvent.type(box, 'first words')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(box.value).toBe('')
    await userEvent.type(box, 'newer words')
    fail(storageRefused())
    await screen.findByText("Couldn't send. Your message is still here.")
    expect(box.value).toBe('first words\n\nnewer words')
  })

  it('treats a box holding only spaces as empty', async () => {
    const { box, fail } = setup()
    await userEvent.type(box, 'first words')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await userEvent.type(box, '   ')
    fail(storageRefused())
    await waitFor(() => expect(box.value).toBe('first words'))
  })

  it('puts the sent words back when the box is still empty', async () => {
    const { box, fail } = setup()
    await userEvent.type(box, 'first words')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(box.value).toBe('')
    fail(storageRefused())
    await waitFor(() => expect(box.value).toBe('first words'))
  })
})
