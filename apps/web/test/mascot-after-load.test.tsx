// @vitest-environment jsdom
// A mascot clip is never put on the page before its load event: a <video> holds that event until its media is ready, which
// held a whole page's load for seconds on a slow connection. Until then the still shows; the clip comes once the page loaded.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('before the load event: the still, no video; after it: the clip', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }) as MediaQueryList)
  const real = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState')
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' })
  try {
    vi.resetModules()
    const { Mascot } = await import('../src/ui/Mascot.tsx')
    const { container } = render(<Mascot state="worried" size={120} decorative />)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/mascot/talos-worried.png')
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' })
    await act(async () => {
      window.dispatchEvent(new Event('load'))
    })
    expect(container.querySelector('video')).not.toBeNull()
  } finally {
    // biome-ignore lint/performance/noDelete: put the jsdom getter back
    delete (document as unknown as Record<string, unknown>).readyState
    if (real) Object.defineProperty(Document.prototype, 'readyState', real)
  }
})
