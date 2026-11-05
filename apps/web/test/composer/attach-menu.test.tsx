// The + menu closes the moment a choice is made, a file is picked or the picker is cancelled, and typing can continue.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  startRecorder: () => Promise.resolve({ cancel() {}, elapsedMs: () => 0 }),
}))

// chips are kept per thread outside the component now, so one test's attachments must not leak into the next
afterEach(() => {
  cleanup()
  useComposerStore.setState({ chips: {} })
})

function mount() {
  const client = setup({})
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId="t1" placeholder="Message" />
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}
const openMenu = () => {
  const trigger = screen.getByRole('button', { name: 'Attach' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(trigger)
}
const photoInput = () => screen.getByTestId('pick-photos') as HTMLInputElement
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement
const menuIsOpen = () => screen.queryByTestId('attach-photos') !== null

describe('+ menu', () => {
  it('opens with the three choices', () => {
    mount()
    openMenu()
    expect(screen.getByTestId('attach-photos').textContent).toContain('Photo library')
    expect(screen.getByTestId('attach-camera').textContent).toContain('Camera')
    expect(screen.getByTestId('attach-files').textContent).toContain('Files')
  })

  it('closes as soon as a choice is made and opens that picker', async () => {
    mount()
    const click = vi.spyOn(photoInput(), 'click')
    openMenu()
    fireEvent.click(screen.getByTestId('attach-photos'))
    expect(click).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(menuIsOpen()).toBe(false))
  })

  it('stays closed after a photo is picked, attaches it, and hands focus back to the box', async () => {
    const client = mount()
    const up = vi.spyOn(client, 'uploadMedia')
    openMenu()
    fireEvent.click(screen.getByTestId('attach-photos'))
    fireEvent.change(photoInput(), { target: { files: [new File(['x'], 'IMG_8114.png', { type: 'image/png' })] } })
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1))
    expect(screen.getByText('IMG_8114.png')).toBeTruthy()
    expect(menuIsOpen()).toBe(false)
    expect(document.activeElement).toBe(box())
  })

  it('closes and returns focus to the box when the picker is cancelled', async () => {
    mount()
    openMenu()
    fireEvent.click(screen.getByTestId('attach-camera'))
    fireEvent(screen.getByTestId('pick-camera'), new Event('cancel'))
    await waitFor(() => expect(menuIsOpen()).toBe(false))
    expect(document.activeElement).toBe(box())
  })

  it('picking from each of the three inputs behaves the same', async () => {
    const client = mount()
    const up = vi.spyOn(client, 'uploadMedia')
    for (const id of ['pick-photos', 'pick-camera', 'pick-files']) {
      fireEvent.change(screen.getByTestId(id), {
        target: { files: [new File(['x'], `${id}.png`, { type: 'image/png' })] },
      })
    }
    await waitFor(() => expect(up).toHaveBeenCalledTimes(3))
  })

  it('a menu dismissed without choosing still closes and does not steal focus into the box', async () => {
    mount()
    openMenu()
    expect(menuIsOpen()).toBe(true)
    fireEvent.keyDown(screen.getByTestId('attach-photos'), { key: 'Escape' })
    await waitFor(() => expect(menuIsOpen()).toBe(false))
    expect(document.activeElement).not.toBe(box())
  })

  it('a pick with no files (picker returned nothing) still closes the menu and keeps typing possible', () => {
    mount()
    fireEvent.change(photoInput(), { target: { files: [] } })
    expect(menuIsOpen()).toBe(false)
    expect(document.activeElement).toBe(box())
  })
})

describe('+ menu and voice notes', () => {
  it('a menu left open when recording starts does not come back open afterwards', async () => {
    mount()
    openMenu()
    expect(menuIsOpen()).toBe(true)
    fireEvent.click(screen.getByTestId('mic')) // a tap locks recording directly
    await screen.findByTestId('recorder-locked')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    await screen.findByTestId('pick-files')
    expect(menuIsOpen()).toBe(false)
  })
})
