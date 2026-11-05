// @vitest-environment jsdom
// A voice note of real length whose recording came back empty is reported, not dropped without a word.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const rec = vi.hoisted(() => ({ durationMs: 0, size: 0 }))
vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () =>
    Promise.resolve({
      cancel() {},
      pause() {},
      resume() {},
      snapshot: async () => new Blob(['x']),
      elapsedMs: () => rec.durationMs,
      endedByItself: () => false,
      stop: async () => ({
        blob: new Blob([new Uint8Array(rec.size)], { type: 'audio/webm' }),
        mime: 'audio/webm',
        durationMs: rec.durationMs,
        waveform: '',
        endedByItself: false,
      }),
    }),
}))

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  useComposerStore.setState({ chips: {} })
})

async function recordAndSend(uploadMedia: ReturnType<typeof vi.fn>) {
  const client = Object.assign(setup({}), { uploadMedia, sendVoiceNote: vi.fn() }) as ReturnType<typeof setup>
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="t1" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
  fireEvent.click(screen.getByTestId('mic'))
  await screen.findByTestId('recorder-locked')
  fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }))
}

describe('voice note stray rule', () => {
  it('a long recording with nothing in it says so and sends nothing', async () => {
    rec.durationMs = 30_000
    rec.size = 0
    const uploadMedia = vi.fn()
    await recordAndSend(uploadMedia)
    await waitFor(() => expect(screen.getByText(/Nothing was recorded/)).toBeTruthy())
    expect(uploadMedia).not.toHaveBeenCalled()
  })

  it('a short touch is dropped without a message', async () => {
    rec.durationMs = 100
    rec.size = 50
    const uploadMedia = vi.fn()
    await recordAndSend(uploadMedia)
    await waitFor(() => expect(screen.queryByTestId('recorder-locked')).toBeNull())
    expect(screen.queryByText(/Nothing was recorded/)).toBeNull()
    expect(uploadMedia).not.toHaveBeenCalled()
  })
})
