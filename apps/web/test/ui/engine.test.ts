// Which engines make an HTML page card wait for a tap: Chromium engines do; every WebKit shell (iPhone Safari, Chrome and
// Edge on iPhone, the Mac app) runs the page at once. Firefox is not covered by the tap and is not claimed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frameFocusGuardNeeded, isChromiumEngine, isWebKitEngine } from '../../src/ui/engine.ts'

const UA = {
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  headless:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 16; SM-S941B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/150.0.0.0 Mobile Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneEdge:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 EdgiOS/156.0.0.0 Mobile/15E148 Safari/605.1.15',
  ipadChrome:
    'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0',
}

describe('isChromiumEngine', () => {
  it.each(['desktopChrome', 'headless', 'edge', 'androidChrome', 'samsung'] as const)('%s waits for a tap', (k) => {
    expect(isChromiumEngine({ userAgent: UA[k] })).toBe(true)
  })

  it.each(['macSafari', 'iphoneSafari', 'iphoneChrome', 'iphoneEdge', 'ipadChrome', 'firefox'] as const)(
    '%s runs page cards at once',
    (k) => {
      expect(isChromiumEngine({ userAgent: UA[k] })).toBe(false)
    },
  )

  it('trusts the Chromium brand when the user agent is reduced or odd, but never on an iPhone', () => {
    const brands = [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }]
    expect(isChromiumEngine({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { brands } })).toBe(true)
    expect(isChromiumEngine({ userAgent: UA.iphoneSafari, userAgentData: { brands } })).toBe(false)
  })

  it('an unknown or missing navigator is not Chromium, so nothing breaks outside a browser', () => {
    expect(isChromiumEngine({ userAgent: '' })).toBe(false)
    expect(isChromiumEngine(undefined)).toBe(false)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isWebKitEngine (where the frame focus guard stays out of the way)', () => {
  it.each(['macSafari', 'iphoneSafari', 'iphoneChrome', 'iphoneEdge', 'ipadChrome'] as const)('%s is WebKit', (k) => {
    expect(isWebKitEngine({ userAgent: UA[k] })).toBe(true)
  })

  it('the Mac app web view, which has no Safari token, is WebKit', () => {
    const wk = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
    expect(isWebKitEngine({ userAgent: wk })).toBe(true)
  })

  it.each(['desktopChrome', 'headless', 'edge', 'androidChrome', 'samsung', 'firefox'] as const)(
    '%s is not WebKit, so it is guarded',
    (k) => {
      expect(isWebKitEngine({ userAgent: UA[k] })).toBe(false)
    },
  )

  it('an unknown or missing navigator is guarded, never trusted', () => {
    expect(isWebKitEngine({ userAgent: '' })).toBe(false)
    vi.stubGlobal('navigator', undefined) // no navigator at all (not a browser): the default argument sees nothing
    expect(isWebKitEngine()).toBe(false)
    expect(frameFocusGuardNeeded()).toBe(true)
  })

  it('frameFocusGuardNeeded follows the real navigator', () => {
    expect(frameFocusGuardNeeded()).toBe(!isWebKitEngine())
  })
})
