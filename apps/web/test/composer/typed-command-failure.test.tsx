// A typed session command that is refused on the phone gives the command back, and keeps what was typed meanwhile.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

const held: { finish: (o: { kind: 'error'; text: string; local: true }) => void } = { finish: () => {} }

vi.mock('../../src/features/session/store.ts', async (orig) => {
  const real = await orig<typeof import('../../src/features/session/store.ts')>()
  return {
    ...real,
    useSessionController: () => ({
      ...real.useSessionController(),
      typed: (_t: string, body: string) =>
        body === '/compact'
          ? () =>
              new Promise((res) => {
                held.finish = res
              })
          : null,
    }),
  }
})

afterEach(cleanup)

describe('a typed command refused on the phone', () => {
  it('keeps both the command and what was typed while it ran', async () => {
    const client = createFakeClient()
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <Composer threadId="general" />
        </ClientProvider>
      </StorageProvider>,
    )
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await userEvent.type(box, '/compact')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(box.value).toBe('')
    await userEvent.type(box, 'newer words')
    held.finish({ kind: 'error', text: 'Not now.', local: true })
    await waitFor(() => expect(box.value).toBe('/compact\n\nnewer words'))
  })
})
