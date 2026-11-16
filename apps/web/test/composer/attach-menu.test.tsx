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

describe('+ menu: the picker opens inside the tap', () => {
  it('clicks the input while the menu is still open, then closes it', async () => {
    mount()
    let openAtClick: boolean | null = null
    vi.spyOn(photoInput(), 'click').mockImplementation(() => {
      openAtClick = menuIsOpen()
    })
    openMenu()
    fireEvent.click(screen.getByTestId('attach-photos'))
    expect(openAtClick).toBe(true)
    await waitFor(() => expect(menuIsOpen()).toBe(false))
  })
})

describe('+ menu per platform', () => {
  const g = globalThis as unknown as Record<string, unknown>
  const realUa = navigator.userAgent
  const setUa = (ua: string) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
  afterEach(() => {
    delete g.Capacitor
    delete (window as unknown as Record<string, unknown>).matchMedia
    setUa(realUa)
    vi.restoreAllMocks()
  })
  const shell = (picker: Record<string, unknown>) => {
    g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { TalosPicker: picker } }
  }

  it('in the iPhone app, Photos calls TalosPicker and never clicks an input', async () => {
    const pickPhotos = vi.fn(() =>
      Promise.resolve({ files: [{ name: 'a.jpg', mime: 'image/jpeg', base64: btoa('x') }] }),
    )
    shell({ pickPhotos, takePhoto: vi.fn(), pickFiles: vi.fn() })
    const client = mount()
    const up = vi.spyOn(client, 'uploadMedia')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    openMenu()
    fireEvent.click(screen.getByTestId('attach-photos'))
    expect(pickPhotos).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1))
    expect(click).not.toHaveBeenCalled()
  })

  it('in the iPhone app, a missing camera shows the message and attaches nothing', async () => {
    shell({
      pickPhotos: vi.fn(),
      pickFiles: vi.fn(),
      takePhoto: () => Promise.reject({ message: 'This device has no camera.' }),
    })
    const client = mount()
    const up = vi.spyOn(client, 'uploadMedia')
    openMenu()
    fireEvent.click(screen.getByTestId('attach-camera'))
    expect(await screen.findByText(/no camera/)).toBeTruthy()
    expect(up).not.toHaveBeenCalled()
  })

  it('in iPhone Safari, + clicks the one plain input and opens no menu', () => {
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')
    ;(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: true })
    mount()
    const files = screen.getByTestId('pick-files') as HTMLInputElement
    expect(files.getAttribute('accept')).toBeNull()
    expect(files.multiple).toBe(true)
    const click = vi.spyOn(files, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    expect(click).toHaveBeenCalledTimes(1)
    expect(menuIsOpen()).toBe(false)
  })

  it('on desktop the menu shows three entries', () => {
    mount()
    openMenu()
    expect(screen.getAllByTestId(/^attach-/)).toHaveLength(3)
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
