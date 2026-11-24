// @vitest-environment jsdom
// "Can the system's own controls reach a clip here?" is asked of the device, not guessed from the platform name.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCapacitorPlatform } from '../src/lib/capacitorPlatform.ts'
import { webPlatform } from '../src/lib/platform.ts'

afterEach(() => vi.unstubAllGlobals())

const withNavigator = (n: object) => vi.stubGlobal('navigator', n)

describe('web adapter', () => {
  it('has controls when the browser has the Media Session API (phones, desktop browsers: media keys)', () => {
    withNavigator({ mediaSession: { setActionHandler: () => {} } })
    expect(webPlatform.mediaSession.controls?.()).toBe(true)
  })
  it('has none without it (an older browser)', () => {
    withNavigator({})
    expect(webPlatform.mediaSession.controls?.()).toBe(false)
    withNavigator({ mediaSession: {} })
    expect(webPlatform.mediaSession.controls?.()).toBe(false)
  })
})

describe('iPhone shell adapter', () => {
  const scope = (plugin?: object, ms = false) => {
    withNavigator(ms ? { mediaSession: { setActionHandler: () => {} } } : {})
    return { Capacitor: { Plugins: plugin ? { TalosAudio: plugin } : {} } }
  }
  it('has controls when the TalosAudio plugin can publish Now Playing', () => {
    expect(createCapacitorPlatform(scope({ setNowPlaying: async () => {} })).mediaSession.controls?.()).toBe(true)
  })
  it("falls back to the page's own Media Session in an older shell, and has none if that is missing too", () => {
    expect(createCapacitorPlatform(scope(undefined, true)).mediaSession.controls?.()).toBe(true)
    expect(createCapacitorPlatform(scope(undefined, false)).mediaSession.controls?.()).toBe(false)
  })
})
