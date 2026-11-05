// @vitest-environment jsdom
import { newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampTransform,
  fitScale,
  ImageViewer,
  MAX_ZOOM,
  rememberOpener,
  zoomAbout,
} from '../../src/features/threads/ImageViewer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

const att = {
  media_id: newId('md'),
  kind: 'image' as const,
  role: 'attachment' as const,
  mime: 'image/png',
  name: 'photo.png',
  size: 3,
  sha256: 'a'.repeat(64),
}

describe('zoom math', () => {
  it('fits to 92% of the viewport and scales small images up', () => {
    expect(fitScale(100, 50, 1000, 800)).toBeCloseTo(9.2)
    expect(fitScale(4000, 1000, 1000, 800)).toBeCloseTo(0.23)
    expect(fitScale(0, 0, 1000, 800)).toBe(1)
  })
  it('keeps the point under the cursor fixed', () => {
    const t = zoomAbout({ s: 1, x: 0, y: 0 }, 2, 100, 40)
    expect(t).toEqual({ s: 2, x: -100, y: -40 })
    // the image point under (100,40) before: p = 100; after: x + s*p = -100 + 200 = 100
    expect(t.x + t.s * 100).toBe(100)
  })
  it('clamps scale to [1, 8x] and pan to the image edge', () => {
    expect(clampTransform({ s: 99, x: 0, y: 0 }, 400, 300, 1000, 800).s).toBe(MAX_ZOOM)
    expect(clampTransform({ s: 0.2, x: 50, y: 50 }, 400, 300, 1000, 800)).toEqual({ s: 1, x: 0, y: 0 })
    expect(clampTransform({ s: 4, x: 9999, y: -9999 }, 400, 300, 1000, 800)).toEqual({ s: 4, x: 300, y: -200 })
  })
})

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 450 })
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 300 })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function open(onClose = vi.fn()) {
    const r = render(
      <ClientProvider client={createFakeClient()}>
        <ImageViewer att={att} onClose={onClose} />
      </ClientProvider>,
    )
    return { onClose, img: screen.getByAltText('photo.png') as HTMLImageElement, ...r }
  }

  it('is a named dialog and opens fitted to ~92% of the viewport', () => {
    const { img } = open()
    expect(screen.getByRole('dialog', { name: 'photo.png' })).toBeTruthy()
    expect(parseFloat(img.style.width)).toBeCloseTo(920) // 1000 * 0.92, width-bound
    expect(parseFloat(img.style.height)).toBeCloseTo(613.33, 1)
    expect(img.dataset.zoom).toBe('1')
  })

  it('+, - and 0 zoom and reset', () => {
    const { img } = open()
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: '+' })
    expect(Number(img.dataset.zoom)).toBeCloseTo(1.25)
    fireEvent.keyDown(dialog, { key: '+' })
    fireEvent.keyDown(dialog, { key: '-' })
    expect(Number(img.dataset.zoom)).toBeCloseTo(1.25)
    fireEvent.keyDown(dialog, { key: '0' })
    expect(img.dataset.zoom).toBe('1')
    for (let i = 0; i < 40; i++) fireEvent.keyDown(dialog, { key: '+' })
    expect(Number(img.dataset.zoom)).toBe(MAX_ZOOM)
    for (let i = 0; i < 60; i++) fireEvent.keyDown(dialog, { key: '-' })
    expect(img.dataset.zoom).toBe('1')
  })

  it('wheel and ctrl+wheel zoom (non-passive, default prevented) and never go below fit', () => {
    const { img } = open()
    const stage = screen.getByTestId('image-stage')
    const ev = new WheelEvent('wheel', { deltaY: -120, clientX: 600, clientY: 400, cancelable: true, bubbles: true })
    act(() => void stage.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(true)
    expect(Number(img.dataset.zoom)).toBeGreaterThan(1)
    const pinch = new WheelEvent('wheel', { deltaY: -20, ctrlKey: true, cancelable: true, bubbles: true })
    const before = Number(img.dataset.zoom)
    act(() => void stage.dispatchEvent(pinch))
    expect(Number(img.dataset.zoom)).toBeGreaterThan(before)
    act(() => void stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100000, bubbles: true, cancelable: true })))
    expect(img.dataset.zoom).toBe('1')
  })

  it('double-click toggles fit and 2x', () => {
    const { img } = open()
    fireEvent.doubleClick(img, { clientX: 500, clientY: 400 })
    expect(Number(img.dataset.zoom)).toBe(2)
    fireEvent.doubleClick(img, { clientX: 500, clientY: 400 })
    expect(img.dataset.zoom).toBe('1')
  })

  it('closes on a click outside the image and on Escape, but not when clicking the image', () => {
    const { onClose, img } = open()
    img.getBoundingClientRect = () => ({ left: 100, right: 900, top: 100, bottom: 700 }) as DOMRect
    fireEvent.click(img, { clientX: 500, clientY: 400 })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('image-stage'), { clientX: 5, clientY: 5 })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('returns focus to the image that opened it', async () => {
    const btn = document.createElement('button')
    document.body.append(btn)
    rememberOpener(btn)
    const client = createFakeClient()
    const { rerender } = render(
      <ClientProvider client={client}>
        <ImageViewer att={att} onClose={() => {}} />
      </ClientProvider>,
    )
    rerender(
      <ClientProvider client={client}>
        <ImageViewer att={null} onClose={() => {}} />
      </ClientProvider>,
    )
    await waitFor(() => expect(document.activeElement).toBe(btn))
    btn.remove()
  })
})
