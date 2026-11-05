import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioMode, createCapacitorPlatform, hapticCall, installNativePlatform } from '../src/lib/capacitorPlatform'
import { getPlatform, setPlatform, webPlatform } from '../src/lib/platform'

afterEach(() => setPlatform(webPlatform))

function shell() {
  const calls: Array<[string, string, unknown]> = []
  const plugin = (name: string) =>
    new Proxy({}, { get: (_t, method: string) => async (o: unknown) => void calls.push([name, method, o]) })
  const scope = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: { Haptics: plugin('Haptics'), TalosAudio: plugin('TalosAudio') },
    },
  }
  return { scope, calls }
}

describe('capacitorPlatform adapter', () => {
  it('haptic maps onto one native Haptics call each', () => {
    const { scope, calls } = shell()
    const p = createCapacitorPlatform(scope)
    p.haptic('light')
    p.haptic('success')
    p.haptic('error')
    expect(calls).toEqual([
      ['Haptics', 'impact', { style: 'LIGHT' }],
      ['Haptics', 'notification', { type: 'SUCCESS' }],
      ['Haptics', 'notification', { type: 'ERROR' }],
    ])
    expect(hapticCall('success').method).toBe('notification')
  })

  it("audioSession.set('play-and-record') then ('playback') then ('auto') maps onto TalosAudio.setMode", () => {
    const { scope, calls } = shell()
    const p = createCapacitorPlatform(scope)
    p.audioSession.set('play-and-record')
    p.audioSession.set('playback')
    p.audioSession.set('auto')
    expect(calls).toEqual([
      ['TalosAudio', 'setMode', { mode: 'record' }],
      ['TalosAudio', 'setMode', { mode: 'playback' }],
      ['TalosAudio', 'setMode', { mode: 'idle' }],
    ])
    expect(audioMode('auto')).toBe('idle')
  })

  it('reports the shell as installed, keeps the web adapter for everything else', () => {
    const p = createCapacitorPlatform(shell().scope)
    expect(p.installState()).toBe('installed')
    expect(p.share).toBe(webPlatform.share)
    expect(p.wakeLock).toBe(webPlatform.wakeLock)
  })

  it('never throws when the plugin is missing, throws, or rejects', async () => {
    const p = createCapacitorPlatform({ Capacitor: { Plugins: {} } })
    expect(() => p.haptic('light')).not.toThrow()
    expect(() => p.audioSession.set('playback')).not.toThrow()
    const hostile = {
      Capacitor: {
        Plugins: {
          Haptics: {
            impact: () => {
              throw new Error('boom')
            },
            notification: () => Promise.reject(new Error('nope')),
          },
        },
      },
    }
    const q = createCapacitorPlatform(hostile)
    expect(() => q.haptic('light')).not.toThrow()
    expect(() => q.haptic('success')).not.toThrow()
    await Promise.resolve()
    expect(() => createCapacitorPlatform(null).haptic('light')).not.toThrow()
  })

  it('installNativePlatform swaps the adapter only inside the shell', () => {
    expect(installNativePlatform({})).toBe(false)
    expect(getPlatform()).toBe(webPlatform)
    expect(installNativePlatform(shell().scope)).toBe(true)
    expect(getPlatform()).not.toBe(webPlatform)
    expect(getPlatform().installState()).toBe('installed')
  })

  it('does not call the web audio session twice on failure', () => {
    const spy = vi.spyOn(webPlatform.audioSession, 'set')
    createCapacitorPlatform(shell().scope).audioSession.set('playback')
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
