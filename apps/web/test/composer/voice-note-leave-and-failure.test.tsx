// @vitest-environment jsdom
// The edges around a locked voice note: leaving before the microphone is even ready, a recorder that fails on Send, and
// a pause preview that is still being made when the recording is cancelled.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const rec = vi.hoisted(() => ({
  cancelled: 0,
  stopFails: false,
  ready: null as null | (() => void),
  waitForReady: false,
  snapshot: null as null | ((b: Blob) => void),
  holdSnapshot: false,
}))
vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () => {
    const handle = {
      cancel() {
        rec.cancelled++
      },
      pause() {},
      resume() {},
      snapshot: () =>
        rec.holdSnapshot
          ? new Promise<Blob>((res) => {
              rec.snapshot = res
            })
          : Promise.resolve(new Blob(['so far'])),
      elapsedMs: () => 5_000,
      endedByItself: () => false,
      stop: async () => {
        if (rec.stopFails) throw new Error('recorder failed')
        return { blob: new Blob(['x']), mime: 'audio/webm', durationMs: 5_000, waveform: '', endedByItself: false }
      },
    }
    if (!rec.waitForReady) return Promise.resolve(handle)
    // The permission prompt is still up: the recorder exists only once the test says so.
    return new Promise<typeof handle>((res) => {
      rec.ready = () => res(handle)
    })
  },
}))

const made: string[] = []
const revoked: string[] = []
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  Object.assign(rec, {
    cancelled: 0,
    stopFails: false,
    ready: null,
    waitForReady: false,
    snapshot: null,
    holdSnapshot: false,
  })
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

function box() {
  const client = Object.assign(setup({}), {
    uploadMedia: vi.fn(async () => ({ media_id: 'md_1', kind: 'file', mime: 'audio/webm', name: 'n', size: 1 })),
    sendVoiceNote: vi.fn(async () => {}),
  }) as ReturnType<typeof setup> & { uploadMedia: ReturnType<typeof vi.fn>; sendVoiceNote: ReturnType<typeof vi.fn> }
  const view = render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="t1" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
  return { client, ...view }
}

describe('a locked voice note at its edges', () => {
  it('cancels a recorder that only became ready after the owner left the thread', async () => {
    rec.waitForReady = true
    const { unmount } = box()
    fireEvent.click(screen.getByTestId('mic'))
    await screen.findByTestId('recorder-locked')
    unmount() // gone while the browser is still asking for the microphone
    expect(rec.cancelled).toBe(0)
    rec.ready?.() // the owner allows it; nothing is on screen to stop it with
    await waitFor(() => expect(rec.cancelled).toBe(1))
  })

  it('says so, and sends nothing, when the recorder fails on Send', async () => {
    rec.stopFails = true
    const { client } = box()
    fireEvent.click(screen.getByTestId('mic'))
    await screen.findByTestId('recorder-locked')
    fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }))
    const line = await screen.findByRole('alert')
    expect(line.textContent).toContain('The recording failed, so no voice note was sent.')
    expect(client.uploadMedia).not.toHaveBeenCalled()
    expect(client.sendVoiceNote).not.toHaveBeenCalled()
    expect(rec.cancelled).toBe(1) // the microphone is let go
    expect(screen.queryByTestId('recorder-locked')).toBeNull()
  })

  it('makes no preview for a pause whose recording was cancelled meanwhile, and shows none on the next one', async () => {
    rec.holdSnapshot = true
    box()
    fireEvent.click(screen.getByTestId('mic'))
    await screen.findByTestId('recorder-locked')
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' }))
    await waitFor(() => expect(rec.snapshot).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    await waitFor(() => expect(screen.queryByTestId('recorder-locked')).toBeNull())
    rec.snapshot?.(new Blob(['late'])) // the snapshot of the cancelled recording arrives now
    await new Promise((r) => setTimeout(r, 30))
    expect(made.filter((u) => !revoked.includes(u))).toEqual([]) // nothing left pinned
    // The next recording starts clean: no preview of the one before.
    rec.holdSnapshot = false
    fireEvent.click(screen.getByTestId('mic'))
    await screen.findByTestId('recorder-locked')
    expect(screen.queryByLabelText('Preview recording')).toBeNull()
  })
})
