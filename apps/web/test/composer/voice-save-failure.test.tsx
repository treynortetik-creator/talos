// @vitest-environment jsdom
// A voice note whose recording cannot be saved on the phone says so, and no second copy is queued by a fallback.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { captureInFlight, resetAppUpdate } from '../../src/lib/appUpdate.ts'
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
  resetAppUpdate()
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

  it('online: a failed save sends the note directly, as before', async () => {
    const queueVoiceNote = vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    const sendVoiceNote = vi.fn().mockResolvedValue({ clientMsgId: 'm_1', state: 'sent' })
    const uploadMedia = vi.fn().mockResolvedValue({ media_id: 'md_1', mime: 'audio/webm', name: 'v', size: 3 })
    const client = mount({ queueVoiceNote, sendVoiceNote, uploadMedia })
    client.store.setState((s) => ({ ...s, connection: 'online' }))
    await recordAndSend()
    await waitFor(() => expect(sendVoiceNote).toHaveBeenCalledTimes(1))
    expect(queueVoiceNote).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/was not sent/i)).toBeNull()
  })

  it('offline: a failed save keeps the recording and Retry saves the same one', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false })
    const queueVoiceNote = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockResolvedValue({ clientMsgId: 'm_1', state: 'queued' })
    mount({ queueVoiceNote })
    await recordAndSend()
    await waitFor(() => expect(screen.getByText(/was not sent/i)).toBeTruthy())
    fireEvent.click(screen.getByTestId('error-retry'))
    await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(2))
    expect(queueVoiceNote.mock.calls[1]?.[0].blob).toBe(queueVoiceNote.mock.calls[0]?.[0].blob)
    await waitFor(() => expect(screen.queryByText(/was not sent/i)).toBeNull())
  })

  it('online: a finished recording goes to the queue, with no upload from the composer', async () => {
    const queueVoiceNote = vi.fn().mockResolvedValue({ clientMsgId: 'm_1', state: 'sent' })
    const uploadMedia = vi.fn()
    const sendVoiceNote = vi.fn()
    const client = mount({ queueVoiceNote, sendVoiceNote, uploadMedia })
    client.store.setState((s) => ({ ...s, connection: 'online' }))
    await recordAndSend()
    await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(1))
    expect(queueVoiceNote.mock.calls[0]?.[0]).toMatchObject({ threadId: 't1' })
    expect(uploadMedia).not.toHaveBeenCalled()
    expect(sendVoiceNote).not.toHaveBeenCalled()
  })

  describe('kept recordings are a list', () => {
    const offline = () => vi.stubGlobal('navigator', { ...navigator, onLine: false })
    const full = () => new DOMException('full', 'QuotaExceededError')
    const queued = { clientMsgId: 'm_1', state: 'queued' }

    it('a second note that fails never drops the first: one Retry saves both', async () => {
      offline()
      const queueVoiceNote = vi
        .fn()
        .mockRejectedValueOnce(full())
        .mockRejectedValueOnce(full())
        .mockResolvedValue(queued)
      mount({ queueVoiceNote })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      await recordAndSend()
      await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(2))
      await screen.findByText(/2 voice notes not sent yet/i)
      fireEvent.click(screen.getByTestId('error-retry'))
      await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(4))
      const blobs = queueVoiceNote.mock.calls.map((c) => c[0].blob)
      expect(blobs[2]).toBe(blobs[0])
      expect(blobs[3]).toBe(blobs[1])
      await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
    })

    it('a second note that saves leaves the first kept, and Retry sends only the first', async () => {
      offline()
      const queueVoiceNote = vi.fn().mockRejectedValueOnce(full()).mockResolvedValue(queued)
      mount({ queueVoiceNote })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      await recordAndSend()
      await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(2))
      expect(screen.getByTestId('error-retry')).toBeTruthy()
      fireEvent.click(screen.getByTestId('error-retry'))
      await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(3))
      expect(queueVoiceNote.mock.calls[2]?.[0].blob).toBe(queueVoiceNote.mock.calls[0]?.[0].blob)
      await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
    })

    it('holds off automatic reloads while a recording is kept, and lets go when it is saved', async () => {
      offline()
      const queueVoiceNote = vi.fn().mockRejectedValueOnce(full()).mockResolvedValue(queued)
      mount({ queueVoiceNote })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      expect(captureInFlight()).toBe(true)
      fireEvent.click(screen.getByTestId('error-retry'))
      await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
      expect(captureInFlight()).toBe(false)
    })

    it('Retry stays after a text is sent', async () => {
      offline()
      const queueVoiceNote = vi.fn().mockRejectedValue(full())
      mount({ queueVoiceNote })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(''),
      )
      expect(screen.getByTestId('error-retry')).toBeTruthy()
    })

    it('a double tap on Retry saves the recording once', async () => {
      offline()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const queueVoiceNote = vi
        .fn()
        .mockRejectedValueOnce(full())
        .mockImplementation(async () => {
          await gate
          return queued
        })
      mount({ queueVoiceNote })
      await recordAndSend()
      const retry = await screen.findByTestId('error-retry')
      fireEvent.click(retry)
      fireEvent.click(retry)
      await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(2))
      release()
      await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
      expect(queueVoiceNote).toHaveBeenCalledTimes(2)
    })

    const mountOn = (client: ReturnType<typeof setup>, threadId: string) =>
      render(
        <StorageProvider storage={createMemoryStorage()}>
          <ClientProvider client={client}>
            <Composer threadId={threadId} placeholder="Message" />
          </ClientProvider>
        </StorageProvider>,
      )

    it('a kept recording survives the composer unmounting and remounting; Retry still works and the hold stays', async () => {
      offline()
      const queueVoiceNote = vi.fn().mockRejectedValueOnce(full()).mockResolvedValue(queued)
      const client = mount({ queueVoiceNote })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      cleanup() // back, home, settings or a call replaced the composer
      expect(captureInFlight()).toBe(true)
      mountOn(client, 't1')
      fireEvent.click(await screen.findByTestId('error-retry'))
      await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(2))
      expect(queueVoiceNote.mock.calls[1]?.[0].blob).toBe(queueVoiceNote.mock.calls[0]?.[0].blob)
      await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
      expect(captureInFlight()).toBe(false)
    })

    it('the banner shows only in the thread the kept note belongs to', async () => {
      offline()
      const queueVoiceNote = vi.fn().mockRejectedValue(full())
      const client = mount({ queueVoiceNote })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      cleanup()
      mountOn(client, 't2')
      expect(screen.queryByTestId('error-retry')).toBeNull()
      cleanup()
      mountOn(client, 't1')
      expect(await screen.findByTestId('error-retry')).toBeTruthy()
    })

    it('a direct-send fallback upload that hangs times out, and the note stays kept', async () => {
      const real = globalThis.setTimeout
      const spy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
          real(fn, ms === 120_000 ? 100 : ms, ...a)) as unknown as typeof setTimeout)
      try {
        const queueVoiceNote = vi.fn().mockRejectedValue(full())
        const uploadMedia = vi.fn(() => new Promise<never>(() => {})) // never answers, ignores its signal
        const sendVoiceNote = vi.fn()
        const client = mount({ queueVoiceNote, uploadMedia, sendVoiceNote })
        client.store.setState((s) => ({ ...s, connection: 'online' }))
        await recordAndSend()
        await screen.findByTestId('error-retry')
        expect(uploadMedia).toHaveBeenCalledTimes(1)
        expect(sendVoiceNote).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })

    it('a sign-out that wipes the queue clears the kept recordings and releases the hold', async () => {
      offline()
      let wipe = () => {}
      const queueVoiceNote = vi.fn().mockRejectedValue(full())
      mount({
        queueVoiceNote,
        onQueueWiped: (fn: () => void) => {
          wipe = fn
          return () => {}
        },
      })
      await recordAndSend()
      await screen.findByTestId('error-retry')
      expect(captureInFlight()).toBe(true)
      act(() => wipe())
      expect(screen.queryByTestId('error-retry')).toBeNull()
      expect(captureInFlight()).toBe(false)
    })

    it("Delete asks first, then drops this thread's kept recordings and releases the hold", async () => {
      offline()
      const queueVoiceNote = vi.fn().mockRejectedValue(full())
      mount({ queueVoiceNote })
      await recordAndSend()
      fireEvent.click(await screen.findByTestId('error-delete'))
      expect(screen.getByText(/Delete 1 unsent voice note\?/)).toBeTruthy()
      expect(captureInFlight()).toBe(true) // asking deletes nothing
      fireEvent.click(screen.getByTestId('error-delete-confirm'))
      await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
      expect(captureInFlight()).toBe(false)
      expect(queueVoiceNote).toHaveBeenCalledTimes(1) // never retried
    })

    describe('a wipe or a Delete while a Retry or a save is running', () => {
      const gated = () => {
        let release!: () => void
        const gate = new Promise<void>((r) => {
          release = r
        })
        return { gate, release }
      }
      const twoKept = async (queueVoiceNote: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) => {
        offline()
        const client = mount({ queueVoiceNote, ...extra })
        await recordAndSend()
        await screen.findByTestId('error-retry')
        await recordAndSend()
        await screen.findByText(/2 voice notes not sent yet/i)
        return client
      }

      it('a sign-out in the middle of a Retry sends no later note', async () => {
        const g = gated()
        let wipe = () => {}
        const queueVoiceNote = vi
          .fn()
          .mockRejectedValueOnce(full())
          .mockRejectedValueOnce(full())
          .mockImplementationOnce(async () => {
            await g.gate
            return queued
          })
          .mockResolvedValue(queued)
        await twoKept(queueVoiceNote, {
          onQueueWiped: (fn: () => void) => {
            wipe = fn
            return () => {}
          },
        })
        fireEvent.click(screen.getByTestId('error-retry'))
        await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(3))
        act(() => wipe())
        g.release()
        await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
        await new Promise((r) => setTimeout(r, 30))
        expect(queueVoiceNote).toHaveBeenCalledTimes(3) // the second note was never sent
        expect(captureInFlight()).toBe(false)
      })

      it('Delete in the middle of a Retry sends none of the deleted notes', async () => {
        const g = gated()
        const queueVoiceNote = vi
          .fn()
          .mockRejectedValueOnce(full())
          .mockRejectedValueOnce(full())
          .mockImplementationOnce(async () => {
            await g.gate
            return queued
          })
          .mockResolvedValue(queued)
        await twoKept(queueVoiceNote)
        fireEvent.click(screen.getByTestId('error-retry'))
        await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(3))
        fireEvent.click(screen.getByTestId('error-delete'))
        fireEvent.click(screen.getByTestId('error-delete-confirm'))
        g.release()
        await new Promise((r) => setTimeout(r, 30))
        expect(queueVoiceNote).toHaveBeenCalledTimes(3)
        expect(screen.queryByTestId('error-retry')).toBeNull()
        expect(captureInFlight()).toBe(false)
      })

      it('a save that fails after a sign-out is not kept again', async () => {
        const g = gated()
        let wipe = () => {}
        const queueVoiceNote = vi.fn().mockImplementationOnce(async () => {
          await g.gate
          throw full()
        })
        offline()
        mount({
          queueVoiceNote,
          onQueueWiped: (fn: () => void) => {
            wipe = fn
            return () => {}
          },
        })
        await recordAndSend()
        await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(1))
        act(() => wipe())
        g.release()
        await new Promise((r) => setTimeout(r, 30))
        expect(screen.queryByTestId('error-retry')).toBeNull()
        expect(captureInFlight()).toBe(false)
      })

      it("Delete in one thread keeps another thread's note whose save is still failing", async () => {
        offline()
        const g = gated()
        const queueVoiceNote = vi
          .fn()
          .mockRejectedValueOnce(full()) // thread t1's note is kept
          .mockImplementationOnce(async () => {
            await g.gate // thread t2's note: slow, then fails
            throw full()
          })
        const client = mount({ queueVoiceNote })
        await recordAndSend()
        await screen.findByTestId('error-retry')
        cleanup()
        mountOn(client, 't2')
        await recordAndSend()
        await waitFor(() => expect(queueVoiceNote).toHaveBeenCalledTimes(2))
        cleanup()
        mountOn(client, 't1')
        fireEvent.click(await screen.findByTestId('error-delete'))
        fireEvent.click(screen.getByTestId('error-delete-confirm'))
        await waitFor(() => expect(screen.queryByTestId('error-retry')).toBeNull())
        g.release()
        await new Promise((r) => setTimeout(r, 30))
        cleanup()
        mountOn(client, 't2')
        expect(await screen.findByTestId('error-retry')).toBeTruthy() // still kept
        expect(captureInFlight()).toBe(true)
      })
    })
  })
})
