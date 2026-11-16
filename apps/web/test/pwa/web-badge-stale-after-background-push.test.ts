// The installed web app's icon number after a push that arrived while the page slept. The service worker sets the icon
// itself from the push (`sw.ts`: `setAppBadge(n.badge)`), so the icon can differ from the number the page last set. When
// the page comes back and the relay's snapshot says the count is what the page last set (the new reply was read on
// another device meanwhile), the page must put its number back on the icon. `startReadSync` compares with its own
// `lastBadge` only, so it sets nothing and the icon keeps the push's number. The iPhone twin (`startNativeBadge`) sends
// the number again on every return to the front for exactly this reason.
import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { startReadSync } from '../../src/features/pwa/readSync.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'

const NOW = Date.parse('2026-10-31T15:00:00Z')

function world() {
  // What the icon shows: the last number anything (the page or the service worker) set on it.
  const icon = { value: 0 }
  const navigator = {
    setAppBadge: async (n: number) => {
      icon.value = n
    },
    clearAppBadge: async () => {
      icon.value = 0
    },
  }
  const store = createStore(() => ({
    ...initialClientState(),
    connection: 'online' as const,
    readySeq: 1,
    unread: { general: 2 } as Record<string, number>,
  }))
  return { icon, navigator, store, client: { store } as unknown as TalosClient }
}

beforeEach(() => useSession.setState({ status: 'authed' }))

describe('web app badge after a push that arrived while the page slept', () => {
  it('goes back to the real count when the snapshot arrives and the page is in front again', () => {
    const w = world()
    const stop = startReadSync(w.client, { navigator: w.navigator }, () => NOW)
    expect(w.icon.value).toBe(2)

    // The page sleeps (socket gone). A reply arrives: the service worker shows the push and sets the icon to 3.
    w.store.setState({ connection: 'offline' } as never)
    void w.navigator.setAppBadge(3)
    expect(w.icon.value).toBe(3)

    // The owner reads that reply on the Mac, then opens this app again: the socket reconnects and the relay's snapshot
    // says two unread, the same as before the page slept.
    w.store.setState({ connection: 'online', readySeq: 2, unread: { general: 2 } } as never)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(w.icon.value).toBe(2)
    stop()
  })
})
