// WP-I5: the iPhone icon badge follows the Needs-you count.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { startNativeBadge } from '../../src/features/native/badge.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'

const NOW = Date.parse('2026-10-31T15:00:00Z')
const card = (id: string, state: string, expires: string) => ({ id, state, expires_at: expires })
function world(plugin = true) {
  const calls: unknown[] = []
  const scope = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: plugin ? { TalosPush: { setBadge: async (a: unknown) => void calls.push(a) } } : {},
    },
  }
  const store = createStore(() => ({ ...initialClientState(), cards: [] as unknown[] }))
  const client = { store } as unknown as TalosClient
  const set = (cards: unknown[]) => store.setState({ cards } as never)
  return { scope, calls, client, set }
}
beforeEach(() => useSession.setState({ status: 'authed' }))

describe('native badge', () => {
  it('counts pending, unexpired cards and only calls the plugin when the number changes', () => {
    const w = world()
    startNativeBadge(w.client, w.scope, () => NOW)
    expect(w.calls).toEqual([{ count: 0 }])
    w.set([
      card('a', 'pending', '2026-10-31T16:00:00Z'),
      card('b', 'pending', '2026-10-31T14:00:00Z'), // expired
      card('c', 'resolved', '2026-10-31T16:00:00Z'),
    ])
    expect(w.calls.at(-1)).toEqual({ count: 1 })
    const n = w.calls.length
    w.set([card('a', 'pending', '2026-10-31T16:00:00Z'), card('c', 'resolved', '2026-10-31T16:00:00Z')])
    expect(w.calls.length).toBe(n)
  })
  it('signed out reads zero, and stopping stops', () => {
    const w = world()
    const off = startNativeBadge(w.client, w.scope, () => NOW)
    w.set([card('a', 'pending', '2026-10-31T16:00:00Z')])
    useSession.setState({ status: 'anon' })
    expect(w.calls.at(-1)).toEqual({ count: 0 })
    off()
    const n = w.calls.length
    w.set([card('a', 'pending', '2026-10-31T16:00:00Z'), card('b', 'pending', '2026-10-31T16:00:00Z')])
    useSession.setState({ status: 'authed' })
    expect(w.calls.length).toBe(n)
  })
  it('an older shell without the plugin, or a browser: nothing is called', () => {
    const spy = vi.fn()
    const w = world(false)
    startNativeBadge(w.client, w.scope, () => NOW)()
    startNativeBadge(w.client, {}, () => NOW)()
    expect(w.calls).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('native viewing thread', () => {
  it('tells the shell which thread is on screen, and does nothing without the plugin method', async () => {
    const { setNativeViewing } = await import('../../src/lib/nativePush.ts')
    const calls: unknown[] = []
    const scope = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosPush: { setViewing: async (a: unknown) => void calls.push(a) } },
      },
    }
    setNativeViewing('general', scope)
    setNativeViewing(null, scope)
    expect(calls).toEqual([{ thread: 'general' }, { thread: null }])
    expect(() => setNativeViewing('general', { Capacitor: { Plugins: {} } })).not.toThrow()
  })
})
