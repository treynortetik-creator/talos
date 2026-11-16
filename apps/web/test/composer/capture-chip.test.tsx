// The screenshot hotkey in the composer: a capture dropped for a thread becomes a chip with a thumbnail, the box takes
// focus for a line of text, ✕ removes it (and lets its picture go), and nothing is sent until the owner sends.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const created: string[] = []
const revoked: string[] = []
beforeEach(() => {
  useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {}, dropFocus: {} })
  created.length = 0
  revoked.length = 0
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:thumb-${++n}`
    created.push(u)
    return u
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const mount = (threadId: string, client = setup({})) =>
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId={threadId} placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Screenshot 2026-11-13 at 09.30.00.png', { type: 'image/png' })

describe('a capture in the composer', () => {
  it('waits for the composer, then shows a chip with its thumbnail and focuses the box; nothing is sent', async () => {
    const client = setup({})
    const send = vi.spyOn(client, 'sendMessage')
    useComposerStore.getState().dropFiles('general', [png()], { focus: true }) // before the thread's composer is up
    mount('general', client)
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy())
    const thumb = screen.getByTestId('chip-thumb') as HTMLImageElement
    expect(thumb.getAttribute('src')).toBe(created[0])
    expect(thumb.getAttribute('alt')).toBe('') // the name beside it says what it is
    expect(screen.getByTestId('chip').textContent).toContain('Screenshot 2026-11-13 at 09.30.00.png')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Message')))
    expect(send).not.toHaveBeenCalled()
  })

  it('✕ removes it and lets the picture go', async () => {
    mount('general')
    useComposerStore.getState().dropFiles('general', [png()], { focus: true })
    await waitFor(() => expect(screen.getByTestId('chip-thumb')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Screenshot 2026-11-13 at 09\.30\.00\.png/ }))
    await waitFor(() => expect(screen.queryByTestId('chip')).toBeNull())
    expect(revoked).toEqual(created)
  })

  it('a dropped file that is not an image has no thumbnail, and an ordinary drop does not move focus', async () => {
    mount('general')
    useComposerStore.getState().dropFiles('general', [new File(['hi'], 'notes.txt', { type: 'text/plain' })])
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy())
    expect(screen.queryByTestId('chip-thumb')).toBeNull()
    expect(document.activeElement).not.toBe(screen.getByLabelText('Message'))
  })

  it('a large image gets no thumbnail; one the browser cannot draw hides its thumbnail; the name stays', async () => {
    mount('general')
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'photo.jpg', { type: 'image/jpeg' })
    useComposerStore.getState().dropFiles('general', [big])
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy())
    expect(screen.queryByTestId('chip-thumb')).toBeNull()
    expect(created).toEqual([]) // not even read
    cleanup()
    useComposerStore.setState({ chips: {}, dropped: {}, dropFocus: {} })
    mount('general')
    useComposerStore.getState().dropFiles('general', [new File(['x'], 'shot.heic', { type: 'image/heic' })])
    const thumb = await screen.findByTestId('chip-thumb')
    fireEvent.error(thumb)
    await waitFor(() => expect(screen.queryByTestId('chip-thumb')).toBeNull())
    expect(screen.getByTestId('chip').textContent).toContain('shot.heic')
  })
})
