// @vitest-environment jsdom
// Pausing a locked voice note makes a preview: an object URL over everything recorded so far. Resuming revokes it
// (useComposerVoice.togglePause). Sending or cancelling while paused only forgets the URL (`setPreview(null)`), so the
// recording's bytes stay pinned in memory until the page is reloaded: one leaked copy per paused voice note.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () =>
    Promise.resolve({
      cancel() {},
      pause() {},
      resume() {},
      snapshot: async () => new Blob(['so far']),
      elapsedMs: () => 5_000,
      endedByItself: () => false,
      stop: async () => ({
        blob: new Blob(['all of it'], { type: 'audio/webm' }),
        mime: 'audio/webm',
        durationMs: 5_000,
        waveform: '',
        endedByItself: false,
      }),
    }),
}))

const made: string[] = []
const revoked: string[] = []
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  made.length = 0
  revoked.length = 0
  URL.createObjectURL = () => {
    const u = `blob:preview-${made.length + 1}`
    made.push(u)
    return u
  }
  URL.revokeObjectURL = (u: string) => void revoked.push(u)
})
afterEach(() => {
  cleanup()
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})

async function pausedRecording() {
  const client = Object.assign(setup({}), {
    uploadMedia: vi.fn(async () => ({ media_id: 'md_1', kind: 'file', mime: 'audio/webm', name: 'n', size: 1 })),
    sendVoiceNote: vi.fn(async () => {}),
  }) as ReturnType<typeof setup>
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="t1" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
  fireEvent.click(screen.getByTestId('mic'))
  await screen.findByTestId('recorder-locked')
  fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }))
  await screen.findByLabelText('Preview recording')
  expect(made).toEqual(['blob:preview-1'])
}

describe('voice note preview', () => {
  it('is released when the paused recording is sent', async () => {
    await pausedRecording()
    fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }))
    await waitFor(() => expect(screen.queryByTestId('recorder-locked')).toBeNull())
    await new Promise((r) => setTimeout(r, 30))
    expect(revoked).toEqual(['blob:preview-1'])
  })

  it('is released when the paused recording is cancelled', async () => {
    await pausedRecording()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    await waitFor(() => expect(screen.queryByTestId('recorder-locked')).toBeNull())
    await new Promise((r) => setTimeout(r, 30))
    expect(revoked).toEqual(['blob:preview-1'])
  })
})
