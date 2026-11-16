// @vitest-environment jsdom
// A voice note that is still recording when the owner leaves the thread (the composer unmounts: another thread, Settings,
// a live call taking the composer's place) must release the microphone. The composer's recorder handle lives in a ref of
// the unmounted box, so nothing can ever stop it afterwards: the recorder and its microphone stream run on for good.
// Dictation, right beside it, does stop its recorder on the way out (useDictation's `drop`).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const rec = vi.hoisted(() => ({ started: 0, released: 0 }))
vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () => {
    rec.started++
    return Promise.resolve({
      // Both ways of ending a recording stop the microphone tracks (recorder.ts `cleanup`).
      cancel() {
        rec.released++
      },
      pause() {},
      resume() {},
      snapshot: async () => new Blob(['x']),
      elapsedMs: () => 5_000,
      endedByItself: () => false,
      stop: async () => {
        rec.released++
        return { blob: new Blob(['x']), mime: 'audio/webm', durationMs: 5_000, waveform: '', endedByItself: false }
      },
    })
  },
}))

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  rec.started = 0
  rec.released = 0
})
afterEach(cleanup)

describe('voice note recording when the composer goes away', () => {
  it('stops the recorder (and with it the microphone) when the owner leaves the thread', async () => {
    const client = setup({})
    const { unmount } = render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <Composer threadId="t1" placeholder="Message" />
        </ClientProvider>
      </StorageProvider>,
    )
    fireEvent.click(screen.getByTestId('mic')) // locked recording
    await screen.findByTestId('recorder-locked')
    expect(rec.started).toBe(1)
    unmount() // the owner opens another thread
    await new Promise((r) => setTimeout(r, 50))
    expect(rec.released).toBe(1)
  })
})
