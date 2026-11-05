// While a voice note is being recorded the text box is gone. Text that changes meanwhile must still be what the box is
// judged against afterwards, or a later outside write that matches the old words is never noticed.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { prefillComposer, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'

vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () =>
    Promise.resolve({
      cancel() {},
      pause() {},
      resume() {},
      snapshot: async () => new Blob(['x']),
      elapsedMs: () => 1500,
      stop: async () => ({ blob: new Blob(['a']), mime: 'audio/webm', durationMs: 1500, waveform: '' }),
    }),
}))

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  useComposerStore.setState({ chips: {} })
})

describe('text that changes during a recording', () => {
  it('is what a later write onto the box is compared with', async () => {
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={createFakeClient()}>
          <Composer threadId="general" />
        </ClientProvider>
      </StorageProvider>,
    )
    fireEvent.click(screen.getByTestId('mic'))
    await screen.findByTestId('recorder-locked')
    act(() => prefillComposer('general', 'xyz', 'replace')) // the box is not on screen: nothing is drawn
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    const box = (await screen.findByRole('textbox', { name: 'Message' })) as HTMLTextAreaElement
    expect(box.value).toBe('xyz')
    box.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    set?.call(box, '') // an outside clear: the words drawn before the recording were empty
    await new Promise((r) => setTimeout(r, 450))
    act(() => useComposerStore.getState().setChips('general', [])) // any later render
    expect(box.value).toBe('')
  })
})
