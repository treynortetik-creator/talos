// @vitest-environment jsdom
// A voice note whose recording cannot be saved on the phone says so, and no second copy is queued by a fallback.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
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
      snapshot: async () => new Blob(['x']),
      elapsedMs: () => 1500,
      stop: async () => ({
        blob: new Blob(['abc'], { type: 'audio/webm' }),
        mime: 'audio/webm',
        durationMs: 1500,
        waveform: '',
      }),
    }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useComposerStore.setState({ chips: {} })
})
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
})

function mount(over: Record<string, unknown>) {
  const client = Object.assign(setup({}), over) as ReturnType<typeof setup>
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="t1" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}

async function recordAndSend() {
  fireEvent.click(screen.getByTestId('mic'))
  await screen.findByTestId('recorder-locked')
  fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }))
}

describe('voice note save failure', () => {
  it('offline: the failed save is shown, and the queue was asked once', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false })
    const queueVoiceNote = vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    mount({ queueVoiceNote })
    await recordAndSend()
    await waitFor(() => expect(screen.getByText(/was not sent/i)).toBeTruthy())
    expect(queueVoiceNote).toHaveBeenCalledTimes(1)
  })

  it('online: a failed send falls back to the queue once, and a failed save there is shown too', async () => {
    const queueVoiceNote = vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    const sendVoiceNote = vi.fn().mockRejectedValue(new Error('socket'))
    const uploadMedia = vi.fn().mockResolvedValue({
      media_id: 'md_01JZ0000000000000000000000',
      kind: 'voice_note',
      role: 'attachment',
      mime: 'audio/webm',
      name: 'v.webm',
      size: 3,
      sha256: 'a'.repeat(64),
    })
    const client = mount({ queueVoiceNote, sendVoiceNote, uploadMedia })
    client.store.setState((s) => ({ ...s, connection: 'online' }))
    await recordAndSend()
    await waitFor(() => expect(screen.getByText(/was not sent/i)).toBeTruthy())
    expect(sendVoiceNote).toHaveBeenCalledTimes(1)
    expect(queueVoiceNote).toHaveBeenCalledTimes(1)
  })
})
