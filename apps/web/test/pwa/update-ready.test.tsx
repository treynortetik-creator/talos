// A newer build is out while this page runs an old one (src/lib/appUpdate.ts, src/features/pwa/UpdateReady.tsx). A reload
// happens only once it would load the new build (the new worker took over, or no worker), at a safe moment, once per new
// version; otherwise a one-tap Reload.
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { UpdateReady } from '../../src/features/pwa/UpdateReady.tsx'
import {
  askWorkerForUpdate,
  checkServerVersion,
  claimAutoReload,
  IDLE_BEFORE_TIMER_RELOAD_MS,
  noteActivity,
  noteServerVersion,
  reloadTried,
  reloadWouldHelp,
  resetAppUpdate,
  safeToReload,
  setWorkerUpdater,
  useAppUpdate,
  VERSION_CHECK_EVERY_MS,
  watchServiceWorker,
} from '../../src/lib/appUpdate.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { HOLD_CAP_MS, holdReload, reloadHolds, resetReloadHolds } from '../../src/lib/reloadHold.ts'

type Listener = () => void
/** A service worker container: `controller` set means a worker already serves this page. */
function fakeWorker(controller: boolean) {
  const listeners: Listener[] = []
  const c = {
    controller: controller ? {} : null,
    addEventListener: (_: string, f: Listener) => listeners.push(f),
    removeEventListener: (_: string, f: Listener) => listeners.splice(listeners.indexOf(f), 1),
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: c, configurable: true })
  return {
    /** A worker claims a page that had none: the controller is set, then the change fires. */
    claim: () => {
      c.controller = {}
    },
    handOver: () => {
      for (const f of [...listeners]) f()
    },
  }
}
const safe = { busy: false, path: '/t/general' }

beforeEach(() => {
  resetAppUpdate()
  resetReloadHolds()
  setWorkerUpdater(null)
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useComposerStore.setState({ chips: {}, sendFailure: {}, replyTo: {}, dropped: {}, prefill: {} })
})

describe('the signs of a newer build', () => {
  it("the server's version differing from this bundle's asks the worker to look; never for an unknown or equal version", () => {
    const ask = vi.fn()
    setWorkerUpdater(ask)
    noteServerVersion('a446f3e', 'a446f3e')
    noteServerVersion('dev', 'a446f3e')
    noteServerVersion('b81c0de', '0.0.0')
    expect(useAppUpdate.getState().ready).toBe(false)
    noteServerVersion('b81c0de', 'a446f3e')
    expect(useAppUpdate.getState()).toMatchObject({ ready: true, target: 'b81c0de', handedOver: false })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('a new worker taking over a page that had one; the first install is not an update', () => {
    let w = fakeWorker(false)
    watchServiceWorker()
    w.claim()
    w.handOver()
    // the first install claiming the page: not an update, and not a reason to reload later either
    expect(useAppUpdate.getState()).toMatchObject({ ready: false, handedOver: false })
    w.handOver() // a real update on the same page later
    expect(useAppUpdate.getState()).toMatchObject({ ready: true, handedOver: true })
    resetAppUpdate()
    w = fakeWorker(true)
    watchServiceWorker()
    w.handOver()
    expect(useAppUpdate.getState()).toMatchObject({ ready: true, handedOver: true })
  })

  it('asks the worker at most once a minute, unless forced; an ask before registration runs when it registers', () => {
    askWorkerForUpdate(1_000_000) // nothing registered yet
    const ask = vi.fn()
    setWorkerUpdater(ask)
    expect(ask).toHaveBeenCalledTimes(1)
    askWorkerForUpdate(Date.now() + 30_000)
    expect(ask).toHaveBeenCalledTimes(1)
    askWorkerForUpdate(Date.now() + 30_000, true)
    expect(ask).toHaveBeenCalledTimes(2)
    askWorkerForUpdate(Date.now() + 30_000 + 61_000) // a minute after the forced one
    expect(ask).toHaveBeenCalledTimes(3)
  })
})

describe('when a reload is worth it, and safe', () => {
  it('worth it only once the new worker is in, or when no worker serves the page', () => {
    fakeWorker(true)
    expect(reloadWouldHelp()).toBe(false) // the old worker would serve the old build again
    useAppUpdate.setState({ handedOver: true })
    expect(reloadWouldHelp()).toBe(true)
    useAppUpdate.setState({ handedOver: false })
    fakeWorker(false)
    expect(reloadWouldHelp()).toBe(true)
  })

  it('safe only visible, off Settings, with no dialog, typed text or composer state', () => {
    expect(safeToReload(safe)).toBe(true)
    expect(safeToReload({ ...safe, busy: true })).toBe(false)
    expect(safeToReload({ ...safe, path: '/settings/notifications' })).toBe(false)
    document.body.innerHTML = '<div role="dialog"></div>'
    expect(safeToReload(safe)).toBe(false)
    document.body.innerHTML = '<textarea>half a message</textarea>'
    expect(safeToReload(safe)).toBe(false)
    document.body.innerHTML = '<textarea>  </textarea>'
    expect(safeToReload(safe)).toBe(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    expect(safeToReload(safe)).toBe(false)
  })

  it('one automatic reload per new version, however often it is seen; the next deploy is a new one', () => {
    expect(claimAutoReload('b81c0de')).toBe(true)
    expect(claimAutoReload('b81c0de')).toBe(false)
    expect(claimAutoReload('c0ffee1')).toBe(true)
    expect(claimAutoReload(null)).toBe(true) // a worker hand-over with no server version
    expect(claimAutoReload(null)).toBe(false)
    expect(sessionStorage.getItem('talos.updateReloadedFor')).toMatch(/>worker$/) // keyed from this build, so the next one differs
  })

  it('a reload already made toward a version from this build is known as tried; another version is not', () => {
    expect(reloadTried('b81c0de')).toBe(false)
    claimAutoReload('b81c0de')
    expect(reloadTried('b81c0de')).toBe(true)
    expect(reloadTried('c0ffee1')).toBe(false)
  })
})

describe('UpdateReady', () => {
  const show = (reload: () => void, path = '/t/general') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <UpdateReady reload={reload} />
      </MemoryRouter>,
    )

  it('a cold start on the stale precache: no reload until the new worker takes over, then one', () => {
    const w = fakeWorker(true)
    const reload = vi.fn()
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).not.toHaveBeenCalled() // the old worker would serve the old build again
    // no banner either: the old worker would serve the old build again, so a Reload can't help yet
    expect(screen.queryByTestId('update-ready')).toBeNull()
    act(() => w.handOver())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the banner waits for the new worker: on Settings (no automatic reload) it shows only after the hand-over', () => {
    const w = fakeWorker(true)
    const reload = vi.fn()
    show(reload, '/settings/about')
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(screen.queryByTestId('update-ready')).toBeNull()
    act(() => w.handOver())
    expect(screen.getByTestId('update-ready')).toBeTruthy()
    expect(reload).not.toHaveBeenCalled() // it is on Settings
  })

  it('a claim made before the hand-over does not use up the reload after it', () => {
    fakeWorker(false)
    const reload = vi.fn()
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).toHaveBeenCalledTimes(1)
    cleanup()
    resetAppUpdateKeepingClaim()
    const w = fakeWorker(true) // the old worker answered: the same build is back
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('update-ready')).toBeNull()
    act(() => w.handOver())
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a page loaded with no controller that a worker then claims keeps its banner', () => {
    const w = fakeWorker(false)
    const reload = vi.fn()
    show(reload, '/settings/about')
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(screen.getByTestId('update-ready')).toBeTruthy()
    w.claim()
    act(() => w.handOver())
    expect(screen.getByTestId('update-ready')).toBeTruthy()
    expect(reloadWouldHelp()).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  })

  it("a first install's claim is not a hand-over: a later version waits for the worker that brings it", () => {
    const w = fakeWorker(false)
    const reload = vi.fn()
    show(reload, '/settings/about')
    w.claim()
    act(() => w.handOver()) // the first worker installs and claims the page: no update known
    act(() => noteServerVersion('b81c0de', 'a446f3e')) // hours later
    expect(reloadWouldHelp()).toBe(false) // the first worker's precache would answer the old build
    expect(screen.queryByTestId('update-ready')).toBeNull()
    act(() => w.handOver()) // the new worker
    expect(screen.getByTestId('update-ready')).toBeTruthy()
    expect(reloadWouldHelp()).toBe(true)
  })

  it('a version no reload can reach: one automatic reload, then no banner for that version; the next version shows it', () => {
    fakeWorker(false)
    const reload = vi.fn()
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).toHaveBeenCalledTimes(1)
    cleanup()
    resetAppUpdateKeepingClaim()
    show(reload) // what the reload brought back: the same old build
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('update-ready')).toBeNull()
    act(() => noteServerVersion('c0ffee1', 'a446f3e'))
    expect(reload).toHaveBeenCalledTimes(2) // a new target gets its one automatic reload
    // the banner was drawn before the reload claimed it and nothing re-renders in this simulation; the real page is gone
    expect(screen.getByTestId('update-ready')).toBeTruthy()
  })

  it('a tapped Reload that comes back to the same build does not show the banner again for that version', async () => {
    fakeWorker(false)
    const reload = vi.fn()
    show(reload, '/settings/about') // no automatic reload here
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(screen.getByTestId('update-ready')).toBeTruthy()
    await userEvent.click(screen.getByTestId('update-reload'))
    expect(reload).toHaveBeenCalledTimes(1)
    cleanup()
    resetAppUpdateKeepingClaim()
    show(reload, '/settings/about')
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(screen.queryByTestId('update-ready')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('not on a call, not on a hidden page, not on Settings, not with composer state; back to the front with nothing to lose, it does', () => {
    fakeWorker(false)
    const reload = vi.fn()
    useComposerStore.setState({ replyTo: { general: { id: 'm1', author: 'agent', excerpt: 'x' } } })
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).not.toHaveBeenCalled() // a quote is held
    act(() => useComposerStore.setState({ replyTo: {} }))
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(reload).not.toHaveBeenCalled()
    hidden.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never on a Settings page', () => {
    fakeWorker(false)
    const reload = vi.fn()
    show(reload, '/settings/about')
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('update-ready')).toBeTruthy()
  })
})

/** A reload: the page state starts over, sessionStorage (the claim) survives. */
function resetAppUpdateKeepingClaim() {
  useAppUpdate.setState({ ready: false, handedOver: false, target: null })
}

// The service worker's hand-over reloads a freshly started page at once. A Run or send made just before it (the owner's first
// tap, or the old-client spec's click 70 ms ahead of the claim) is in flight then: a reload would take the page's own record of
// it (the Run's "Sent" line) while the message may already be with the agent. Anything in flight gives up that fast reload for
// good: it must not fire the moment the ack lands (when the line says "Sent") either, so it waits for the owner to be still.
describe('a hand-over while a send is in flight', () => {
  const show = (reload: () => void, meta = createMetaStore()) =>
    render(
      <MemoryRouter initialEntries={['/t/general']}>
        <MetaProvider store={meta}>
          <UpdateReady reload={reload} running="a446f3e" />
        </MetaProvider>
      </MemoryRouter>,
    )
  const healthzSame = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, version: 'b81c0de' }) }) as unknown as Response),
    )

  it('a send in flight at the hand-over: no reload then, none when the ack lands, one once the owner has been still', async () => {
    vi.useFakeTimers()
    try {
      healthzSame()
      const w = fakeWorker(true)
      const reload = vi.fn()
      show(reload)
      act(() => noteServerVersion('b81c0de', 'a446f3e'))
      const release = holdReload() // the tap on Run, in the cold window
      act(() => w.handOver())
      expect(reload).not.toHaveBeenCalled()
      act(() => release()) // the ack: the Run's line now says Sent
      expect(reload, 'not the moment the ack lands: the line would be wiped a round trip later').not.toHaveBeenCalled()
      vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS - 1_000)
      noteActivity() // the owner touches the screen just before the minute's look
      await act(async () => {
        vi.advanceTimersByTime(1_001)
      })
      expect(reload, 'the owner was active a moment ago').not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS) // still for a minute now
      })
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('a hand-over that waited for the composer is not retried on the next hold being released, minutes later', () => {
    const w = fakeWorker(true)
    const reload = vi.fn()
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    act(() => useComposerStore.setState({ prefill: { general: 'half a message' } as never }))
    act(() => w.handOver())
    expect(reload).not.toHaveBeenCalled() // something typed
    act(() => useComposerStore.setState({ prefill: {} }))
    let release = () => {}
    act(() => {
      release = holdReload() // a later send
    })
    act(() => release())
    expect(reload, 'only the real hand-over moment is tried at once').not.toHaveBeenCalled()
  })

  it('rows only sitting in the device queue (unacked ids, failed sends) do not block the update', () => {
    const w = fakeWorker(true)
    const reload = vi.fn()
    const meta = createMetaStore()
    show(reload, meta)
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    act(() => meta.setState({ queuedIds: ['m_held'], failed: { m_final: 'final', m_retry: 'retry' } }))
    act(() => w.handOver())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a hold lets go by itself after 30 s, so a hung device store cannot block the reload that would cure it', () => {
    vi.useFakeTimers()
    try {
      holdReload()
      expect(reloadHolds.getState().holds).toBe(1)
      vi.advanceTimersByTime(HOLD_CAP_MS - 1)
      expect(reloadHolds.getState().holds).toBe(1)
      vi.advanceTimersByTime(2)
      expect(reloadHolds.getState().holds).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tap on Reload while a send is in flight waits for it, says so in plain words, then reloads once', () => {
    const w = fakeWorker(true)
    const reload = vi.fn()
    show(reload)
    const release = holdReload()
    act(() => noteServerVersion('b81c0de', 'a446f3e'))
    act(() => w.handOver())
    act(() => screen.getByTestId('update-reload').click())
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByText('Updating after your message is sent')).toBeTruthy()
    act(() => release())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('holds are counted one per call and released once', () => {
    const a = holdReload()
    const b = holdReload()
    expect(reloadHolds.getState().holds).toBe(2)
    a()
    a()
    expect(reloadHolds.getState().holds).toBe(1)
    b()
    expect(reloadHolds.getState().holds).toBe(0)
    expect(safeToReload({ busy: true, path: '/t/general' })).toBe(false)
  })
})

describe('a page kept open, and a slow install', () => {
  const show = (reload: () => void) =>
    render(
      <MemoryRouter initialEntries={['/t/general']}>
        <UpdateReady reload={reload} />
      </MemoryRouter>,
    )

  it('looks for a newer worker each time it comes to the front, before any update is known', () => {
    fakeWorker(true)
    const ask = vi.fn()
    setWorkerUpdater(ask)
    ask.mockClear()
    show(vi.fn())
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('an update seen during the cold start reloads at a hand-over that comes after it', () => {
    const w = fakeWorker(true)
    const reload = vi.fn()
    show(reload)
    act(() => noteServerVersion('b81c0de', 'a446f3e')) // seen while the page is young
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000) // the install took a minute
    act(() => w.handOver())
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

// The iPhone app has no service worker (WKWebView without app-bound domains), and /api/me is read only at sign-in: an app
// kept open never learned of a new build (Delphi's simulator run, 2026-11-14: 150 s in front, no banner). The relay's
// version is read again from /healthz when the page comes to the front and every few minutes while it stays there.
describe("the relay's version, read again while the page stays open", () => {
  const healthz = (version: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => ({ ok: true, version }) }) as unknown as Response)

  it('a newer version from /healthz makes the update ready; at most one read every half minute', async () => {
    const f = healthz('b81c0de')
    await checkServerVersion({ now: 1_000_000, fetch: f, running: 'a446f3e' })
    expect(f).toHaveBeenCalledWith('/healthz', expect.objectContaining({ cache: 'no-store' }))
    expect(useAppUpdate.getState()).toMatchObject({ ready: true, target: 'b81c0de' })
    await checkServerVersion({ now: 1_020_000, fetch: f, running: 'a446f3e' })
    expect(f).toHaveBeenCalledTimes(1)
    await checkServerVersion({ now: 1_031_000, fetch: f, running: 'a446f3e' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('the same version, a failed read, a refused answer or a missing version change nothing', async () => {
    let t = 2_000_000
    for (const f of [
      healthz('a446f3e'),
      healthz('b81c0de', false),
      healthz(undefined),
      vi.fn(async () => {
        throw new Error('offline')
      }),
    ]) {
      t += 61_000
      await checkServerVersion({ now: t, fetch: f as never, running: 'a446f3e' })
    }
    expect(useAppUpdate.getState().ready).toBe(false)
  })

  it('an app kept in front reads it every minute; a newer build shows the banner and reloads at a safe moment', async () => {
    vi.useFakeTimers()
    try {
      fakeWorker(false) // the iPhone app: no service worker, so a reload loads the new build
      const f = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          ({ ok: true, json: async () => ({ ok: true, version: 'b81c0de' }) }) as unknown as Response,
      )
      vi.stubGlobal('fetch', f)
      const reload = vi.fn()
      render(
        <MemoryRouter>
          <UpdateReady reload={reload} running="a446f3e" />
        </MemoryRouter>,
      )
      expect(f).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS + 1)
      })
      expect(f).toHaveBeenCalledWith('/healthz', expect.objectContaining({ cache: 'no-store' }))
      expect(screen.getByTestId('update-ready')).toBeTruthy()
      expect(reload, 'still for a minute, nothing typed, no dialog: a safe moment').toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("a worker ask that throws never silences the relay's version read (the timer and coming to the front)", async () => {
    vi.useFakeTimers()
    try {
      // a browser whose register() gave no usable registration (Playwright's serviceWorkers: 'block', red main 2026-11-14)
      setWorkerUpdater(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'update')")
      })
      const f = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          ({ ok: true, json: async () => ({ ok: true, version: 'b81c0de' }) }) as unknown as Response,
      )
      vi.stubGlobal('fetch', f)
      render(
        <MemoryRouter>
          <UpdateReady reload={() => {}} running="a446f3e" />
        </MemoryRouter>,
      )
      await act(async () => {
        vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS + 1)
      })
      expect(f).toHaveBeenCalledWith('/healthz', expect.objectContaining({ cache: 'no-store' }))
      expect(screen.getByTestId('update-ready')).toBeTruthy()
      // and coming to the front reads again, past the throttle, with the worker still throwing
      await act(async () => {
        vi.advanceTimersByTime(31_000)
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(f).toHaveBeenCalledTimes(2)
      // the server's version at sign-in (/api/me) takes the same forced ask: it never throws either
      expect(() => noteServerVersion('c0ffee1', 'a446f3e')).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('a page in the background reads nothing, and coming to the front reads at once', async () => {
    vi.useFakeTimers()
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const f = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          ({ ok: true, json: async () => ({ ok: true, version: 'a446f3e' }) }) as unknown as Response,
      )
      vi.stubGlobal('fetch', f)
      render(
        <MemoryRouter>
          <UpdateReady reload={() => {}} running="a446f3e" />
        </MemoryRouter>,
      )
      await act(async () => {
        vi.advanceTimersByTime(3 * VERSION_CHECK_EVERY_MS)
      })
      expect(f, 'hidden: no reads').not.toHaveBeenCalled()
      vis.mockReturnValue('visible')
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(f).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('update-ready'), 'the same version: no banner').toBeNull()
    } finally {
      vis.mockRestore()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('the timer never reloads with a dialog open, nor while the owner is using the page; a later still moment does', async () => {
    vi.useFakeTimers()
    try {
      fakeWorker(false)
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (_url: string, _init?: RequestInit) =>
            ({ ok: true, json: async () => ({ ok: true, version: 'b81c0de' }) }) as unknown as Response,
        ),
      )
      const reload = vi.fn()
      render(
        <MemoryRouter>
          <div role="dialog" data-testid="dialog" />
          <UpdateReady reload={reload} running="a446f3e" />
        </MemoryRouter>,
      )
      await act(async () => {
        vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS + 1)
      })
      expect(screen.getByTestId('update-ready')).toBeTruthy()
      expect(reload, 'a dialog is open').not.toHaveBeenCalled()
      // the dialog closes, but the owner is still scrolling: no reload under a reader
      screen.getByTestId('dialog').setAttribute('role', 'presentation')
      await act(async () => {
        vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS - IDLE_BEFORE_TIMER_RELOAD_MS / 2)
        noteActivity()
        vi.advanceTimersByTime(IDLE_BEFORE_TIMER_RELOAD_MS / 2 + 1)
      })
      expect(reload, 'used just now').not.toHaveBeenCalled()
      // still for a full minute: the next tick reloads
      await act(async () => {
        vi.advanceTimersByTime(VERSION_CHECK_EVERY_MS)
      })
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
