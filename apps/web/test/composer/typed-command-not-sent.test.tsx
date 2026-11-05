// A typed session command (/compact) that never left the phone goes back in the box; one that may have arrived does not.
// The real session controller runs; the client fails where the real one does: before anything is sent (offline), or after
// (the Mac never answered).
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { getSessionController } from '../../src/features/session/store.ts'
import { ClientProvider, NotSentError, TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

afterEach(cleanup)

async function typeCommand(fail: Error) {
  const client = createFakeClient()
  client.sendOwnerFrame = async () => {
    throw fail
  }
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>
    </StorageProvider>,
  )
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
  await userEvent.type(box, '/compact')
  // The fake client has the command list from the start (the real one gets it with the first session snapshot; before
  // it, the text is an ordinary message). Say so here, so a list that stops arriving fails this line and not the later ones.
  expect(getSessionController(client).typed('general', '/compact')).not.toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  return box
}

describe('a typed command that could not be sent', () => {
  it('offline keeps the command in the box', async () => {
    const box = await typeCommand(new NotSentError('internal', "You're offline."))
    await screen.findByText("You're offline.")
    await waitFor(() => expect(box.value).toBe('/compact'))
  })

  it('that timed out is not given back, because the Mac may have it', async () => {
    const box = await typeCommand(new TalosClientError('internal', 'The relay did not answer.'))
    await screen.findByText('The relay did not answer.')
    expect(box.value).toBe('')
  })
})

describe('the real client when it is offline', () => {
  it('refuses a session control as not sent', async () => {
    const { createSocketClient } = await import('../../src/lib/socketClient.ts')
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://127.0.0.1:1/ws',
      isOnline: () => false,
    })
    await expect(client.sendOwnerFrame?.({ type: 'session.control' })).rejects.toBeInstanceOf(NotSentError)
  })
})
