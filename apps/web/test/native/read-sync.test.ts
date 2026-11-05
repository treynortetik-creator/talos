// D26: read state follows the notifications. Real startReadSync against a real zustand store shaped like the client's,
// a fake service-worker registration with real notification objects, and a fake iPhone plugin.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { closeWebNotifications, setWebBadge, startReadSync } from '../../src/features/pwa/readSync.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { appleThreadKey, clearNativeDelivered, retryNativeViewing, setNativeViewing } from '../../src/lib/nativePush.ts'

const NOW = Date.parse('2026-10-31T15:00:00Z')
const REF = 'r_AbCdEfGhIjKlMnOp'
const card = (id: string, state = 'pending', expires = '2026-10-31T16:00:00Z') => ({ id, state, expires_at: expires })

type Shown = { tag: string; closed: boolean; close: () => void }
const shown = (tag: string): Shown => {
  const n: Shown = {
    tag,
    closed: false,
    close() {
      n.closed = true
    },
  }
  return n
}

function world(opts: { native?: boolean; sw?: boolean } = {}) {
  const tray = [
    shown('thread:general'),
    shown('thread:inbox'),
    shown('thread:severance'),
    shown('card:c_1'),
    shown('card:c_2'),
    shown('talos-update'),
  ]
  const badge: Array<number | 'clear'> = []
  const cleared: unknown[] = []
  const scope = {
    ...(opts.native
      ? {
          Capacitor: {
            isNativePlatform: () => true,
            getPlatform: () => 'ios',
            Plugins: {
              TalosPush: { clearDelivered: async (a: unknown) => void cleared.push(a), setViewing: async () => {} },
            },
          },
        }
      : {}),
    navigator: {
      ...(opts.sw === false
        ? {}
        : { serviceWorker: { getRegistration: async () => ({ getNotifications: async () => tray }) } }),
      setAppBadge: async (n: number) => void badge.push(n),
      clearAppBadge: async () => void badge.push('clear'),
    },
  }
  const store = createStore(() => ({
    ...initialClientState(),
    connection: 'online' as const,
    readySeq: 1,
    unread: { general: 2, inbox: 1, severance: 3 } as Record<string, number>,
    cards: [card('c_1'), card('c_2')] as unknown[],
  }))
  const client = { store } as unknown as TalosClient
  const set = (p: Record<string, unknown>) => store.setState(p as never)
  return { tray, badge, cleared, scope, store, client, set }
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const open = (t: Shown[]) => t.filter((n) => !n.closed).map((n) => n.tag)

beforeEach(() => useSession.setState({ status: 'authed' }))

describe('read thread -> its web notifications close', () => {
  it('closes thread:<id> when unread hits 0, and only that thread', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    w.set({ unread: { general: 2, inbox: 1, severance: 0 } })
    await flush()
    expect(open(w.tray)).toEqual(['thread:general', 'thread:inbox', 'card:c_1', 'card:c_2', 'talos-update'])
  })

  it('a thread that was already at 0, or that goes 1 -> 2, closes nothing', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    w.set({ unread: { general: 3, inbox: 1, severance: 3, extra: 0 } })
    await flush()
    expect(open(w.tray)).toHaveLength(6)
  })

  it('a new reply after the read keeps its (new) notification: only the transition to 0 closes', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    w.set({ unread: { general: 0, inbox: 1, severance: 3 } })
    await flush()
    w.tray.push(shown('thread:general')) // a fresh push for General arrives
    w.set({ unread: { general: 1, inbox: 1, severance: 3 } })
    await flush()
    expect(w.tray.at(-1)?.closed).toBe(false)
  })
})

describe('resolved card -> its notification closes', () => {
  it('closes card:<id> when the card is no longer pending (decided here or on the Mac), leaves the other', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    w.set({ cards: [card('c_1', 'resolved'), card('c_2')] })
    await flush()
    expect(open(w.tray)).not.toContain('card:c_1')
    expect(open(w.tray)).toContain('card:c_2')
    w.set({ cards: [card('c_2')] }) // c_1 removed entirely
    await flush()
    w.set({ cards: [] })
    await flush()
    expect(open(w.tray)).not.toContain('card:c_2')
  })
})

describe('web app badge', () => {
  it('follows open cards plus unread (O21), once per change; an expired card does not count', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    expect(w.badge).toEqual([8]) // 2 open cards + 2 + 1 + 3 unread
    w.set({ cards: [card('c_1'), card('c_2'), card('c_3', 'pending', '2026-10-31T14:00:00Z')] }) // expired: not counted
    expect(w.badge).toEqual([8])
    w.set({ unread: { general: 9, inbox: 1, severance: 3 } })
    expect(w.badge.at(-1)).toBe(15)
    w.set({ unread: {}, cards: [card('c_2')] })
    expect(w.badge.at(-1)).toBe(1)
    w.set({ cards: [] })
    expect(w.badge.at(-1)).toBe('clear')
  })

  it('does not wipe a right number while the socket has not answered yet; signed out clears and closes nothing', async () => {
    const w = world()
    w.set({ connection: 'connecting', cards: [], readySeq: undefined })
    startReadSync(w.client, w.scope, () => NOW)
    expect(w.badge).toEqual([])
    w.set({ connection: 'online', cards: [card('c_1')] }) // online, but the relay's snapshot has not landed yet
    expect(w.badge).toEqual([])
    w.set({ readySeq: 2 })
    expect(w.badge).toEqual([7]) // 1 open card + 6 unread (O21)
    useSession.setState({ status: 'anon' })
    expect(w.badge.at(-1)).toBe('clear')
    w.set({ unread: { general: 0, inbox: 1, severance: 3 } })
    await flush()
    expect(open(w.tray)).toContain('thread:general')
  })

  it('opening the app never blanks the icon: a session still loading, or an error, leaves it alone; only signed out clears', async () => {
    const w = world()
    useSession.setState({ status: 'loading' })
    w.set({ cards: [], readySeq: undefined, connection: 'connecting' })
    startReadSync(w.client, w.scope, () => NOW)
    expect(w.badge).toEqual([]) // main.tsx starts this while the session is still loading
    useSession.setState({ status: 'authed' })
    expect(w.badge).toEqual([]) // authed but no snapshot yet
    w.set({ connection: 'online' }) // socketClient sets this one tick before it dispatches ready
    expect(w.badge).toEqual([])
    w.set({ cards: [card('c_1')], readySeq: 1 })
    expect(w.badge).toEqual([7]) // 1 open card + 6 unread (O21)
    useSession.setState({ status: 'error' })
    w.set({ cards: [] })
    expect(w.badge).toEqual([7]) // an unknown session is not a signed-out one
    useSession.setState({ status: 'anon' })
    expect(w.badge.at(-1)).toBe('clear')
  })

  it('a browser without the API, or without a service worker, does nothing and never throws', async () => {
    const w = world({ sw: false })
    expect(await closeWebNotifications(['thread:general'], w.scope)).toBe(0)
    expect(() => setWebBadge(3, {})).not.toThrow()
    expect(() => setWebBadge(3, { navigator: { setAppBadge: () => Promise.reject(new Error('no')) } })).not.toThrow()
    startReadSync(w.client, w.scope, () => NOW)()
  })

  it('stopping stops', async () => {
    const w = world()
    const off = startReadSync(w.client, w.scope, () => NOW)
    off()
    w.set({ unread: { general: 0, inbox: 1, severance: 3 } })
    await flush()
    expect(open(w.tray)).toHaveLength(6)
  })
})

describe('a phone that slept while the thread was read elsewhere: the snapshot reconciles the tray', () => {
  it('on ready, a thread at 0 and a card no longer pending leave the tray even though no transition was seen', async () => {
    const w = world()
    w.set({ unread: {}, readySeq: undefined, connection: 'connecting', cards: [] }) // asleep: nothing unread, nothing known
    startReadSync(w.client, w.scope, () => NOW)
    await flush()
    expect(open(w.tray)).toHaveLength(6) // no snapshot yet: nothing is touched
    // the relay's snapshot: General and Severance were read on the Mac (0 = what the phone already held); Inbox has 1 unread;
    // c_2 is still pending, c_1 was decided
    w.set({ connection: 'online', readySeq: 1, unread: { inbox: 1 }, cards: [card('c_1', 'resolved'), card('c_2')] })
    await flush()
    expect(open(w.tray)).toEqual(['thread:inbox', 'card:c_2', 'talos-update'])
  })

  it('a later ready keeps closing what the new snapshot contradicts, and never closes a thread that is unread', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    w.tray.push(shown('thread:general'))
    w.set({ readySeq: 2 }) // same unread {general: 2, inbox: 1, severance: 3}: all still unread
    await flush()
    expect(w.tray.at(-1)?.closed).toBe(false)
    expect(open(w.tray)).toContain('thread:general')
    w.set({ unread: { general: 2 }, readySeq: 3 })
    await flush()
    expect(open(w.tray)).not.toContain('thread:severance')
    expect(open(w.tray)).toContain('thread:general')
  })

  it('signed out: a snapshot closes nothing', async () => {
    const w = world()
    useSession.setState({ status: 'anon' })
    startReadSync(w.client, w.scope, () => NOW)
    w.set({ unread: {}, readySeq: 2 })
    await flush()
    expect(open(w.tray)).toHaveLength(6)
  })

  it('every ready also asks the shell for the ref of the thread on screen again (a failed first lookup)', async () => {
    const w = world({ native: true })
    const retry = vi.fn()
    startReadSync(
      w.client,
      w.scope,
      () => NOW,
      async (t) => t,
      retry,
    )
    expect(retry).not.toHaveBeenCalled()
    w.set({ readySeq: 2 })
    expect(retry).toHaveBeenCalledTimes(1)
    w.set({ unread: { general: 0 } }) // not a ready
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('iPhone: a thread whose ref lookup failed before is asked again on the next ready, and cleared then', async () => {
    const w = world({ native: true })
    let up = false
    const keyFor = async (t: string) => (t === 'general' || t === 'inbox' ? t : up ? REF : null)
    startReadSync(w.client, w.scope, () => NOW, keyFor)
    w.set({ unread: { general: 2, inbox: 1, severance: 0 } }) // read; the lookup fails (offline), so it is skipped
    await flush()
    await flush()
    expect(w.cleared).toEqual([])
    up = true
    w.set({ readySeq: 2 })
    await flush()
    await flush()
    const tags = (w.cleared.at(-1) as { tags: string[] }).tags
    expect(tags).toContain(`thread:${REF}`)
    expect(tags).not.toContain('thread:general') // still unread
  })
})

describe('iPhone: delivered notifications are cleared by what Apple saw', () => {
  const keyFor = async (t: string) => (t === 'severance' ? REF : t === 'general' || t === 'inbox' ? t : null)

  it('General by id, a named thread by its ref (never its id), a card by its id', async () => {
    const w = world({ native: true })
    startReadSync(w.client, w.scope, () => NOW, keyFor)
    w.set({ unread: { general: 0, inbox: 1, severance: 0 }, cards: [card('c_1', 'resolved'), card('c_2')] })
    await flush()
    await flush()
    const tags = (w.cleared.at(-1) as { tags: string[] }).tags
    expect([...tags].sort()).toEqual([`thread:${REF}`, 'card:c_1', 'thread:general'].sort())
    expect(tags).not.toContain('thread:severance') // Apple never saw the id
  })

  it('a thread whose ref cannot be learned is skipped, not guessed', async () => {
    const w = world({ native: true })
    startReadSync(
      w.client,
      w.scope,
      () => NOW,
      async () => null,
    )
    w.set({ unread: { general: 2, inbox: 1, severance: 0 } })
    await flush()
    await flush()
    expect(w.cleared).toEqual([]) // nothing named: the plugin is not called with an empty list
  })

  it('an older shell without clearDelivered, or no shell: the web path still works and nothing throws', async () => {
    const w = world()
    startReadSync(w.client, w.scope, () => NOW)
    w.set({ unread: { general: 0, inbox: 1, severance: 3 } })
    await flush()
    expect(w.cleared).toEqual([])
    expect(() => clearNativeDelivered(['thread:general'], {})).not.toThrow()
  })
})

describe('appleThreadKey / setNativeViewing: the ref the page tells the shell', () => {
  it('General and Inbox are their own key; a named thread asks the relay once and caches; a failure is not cached', async () => {
    expect(await appleThreadKey('general')).toBe('general')
    const ask = vi.fn(async () => ({ ref: REF }))
    expect(await appleThreadKey('named_a', ask)).toBe(REF)
    expect(await appleThreadKey('named_a', ask)).toBe(REF)
    expect(ask).toHaveBeenCalledTimes(1)
    const fail = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ref: REF })
    expect(await appleThreadKey('named_b', fail)).toBeNull()
    expect(await appleThreadKey('named_b', fail)).toBe(REF)
    expect(await appleThreadKey('named_c', async () => ({ ref: 'not a ref' }))).toBeNull()
    expect(await appleThreadKey('named_d', async () => ({}))).toBeNull()
  })

  it('tells the shell the ref for a named thread (after the lookup), the id for General, and drops a lookup the owner left behind', async () => {
    const told: unknown[] = []
    const scope = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosPush: { setViewing: async (a: unknown) => void told.push(a) } },
      },
    }
    setNativeViewing('general', scope)
    expect(told.at(-1)).toEqual({ thread: 'general' })
    setNativeViewing('named_e', scope, async () => ({ ref: REF }))
    expect(told.at(-1)).toEqual({ thread: null }) // left General at once
    await flush()
    expect(told.at(-1)).toEqual({ thread: REF })
    // moves on before the answer arrives: the stale lookup must not set the old thread
    let release: (v: unknown) => void = () => {}
    setNativeViewing('named_f', scope, () => new Promise((r) => (release = r)))
    setNativeViewing(null, scope)
    release({ ref: 'r_ZzZzZzZzZzZzZzZz' })
    await flush()
    expect(told.at(-1)).toEqual({ thread: null })
    // an unknown thread (404): nothing is silenced
    setNativeViewing('named_g', scope, async () => {
      throw new Error('404')
    })
    await flush()
    expect(told.at(-1)).toEqual({ thread: null })
  })

  it('a failed ref lookup for the thread on screen is retried on the next ready, and the banner then stays quiet', async () => {
    const told: unknown[] = []
    const scope = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosPush: { setViewing: async (a: unknown) => void told.push(a) } },
      },
    }
    let calls = 0
    const ask = async () => {
      if (++calls === 1) throw new Error('offline')
      return { ref: REF }
    }
    setNativeViewing('named_retry', scope, ask)
    await flush()
    expect(told.at(-1)).toEqual({ thread: null }) // lookup failed: nothing silenced
    retryNativeViewing(scope, ask)
    await flush()
    expect(told.at(-1)).toEqual({ thread: REF })
    const n = told.length
    retryNativeViewing(scope, ask) // nothing waiting any more
    await flush()
    expect(told).toHaveLength(n)
  })
})
