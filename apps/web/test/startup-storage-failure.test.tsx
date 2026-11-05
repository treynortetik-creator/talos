// @vitest-environment jsdom
// The real App and Gate with a client whose storage will not open. The owner must see an error with a way forward, not
// an endless splash, and "Try again" must work once storage comes back.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  vi.resetModules()
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
  window.history.pushState({}, '', '/')
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

async function mount(
  storageBroken: { value: boolean },
  opts: {
    keyed?: boolean
    queued?: boolean
    hang?: boolean
    clearBroken?: boolean
    offline?: boolean
    /** Collects every clear and del the app asks the storage for. */
    removed?: string[]
  } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (opts.offline) throw new TypeError('Failed to fetch') // the relay cannot be reached
      return Response.json({ signed_in: true, device_pinned: true })
    }),
  )
  const { App } = await import('../src/App.tsx')
  const { createSocketClient } = await import('../src/lib/socketClient.ts')
  const { createMemoryStorage } = await import('../src/lib/storage.ts')
  const inner = createMemoryStorage()
  if (opts.queued)
    await inner.put('outbox', '01JZ0000000000000000000001', {
      id: '01JZ0000000000000000000001',
      order: 1,
      kind: 'message',
      clientMsgId: 'm_01JZ0000000000000000000001',
      threadId: 'general',
      bytes: '{}',
    })
  const refuse = () => {
    if (storageBroken.value) throw new DOMException('The database connection is closing.', 'InvalidStateError')
  }
  const storage = {
    ...inner,
    async get(...a: Parameters<typeof inner.get>) {
      if (opts.hang) return new Promise<never>(() => {}) // the open never answers
      if (!opts.keyed) refuse()
      return inner.get(...a)
    },
    async del(...a: Parameters<typeof inner.del>) {
      opts.removed?.push(`del ${a.join(' ')}`)
      return inner.del(...a)
    },
    async clear(...a: Parameters<typeof inner.clear>) {
      opts.removed?.push(`clear ${a.join(' ')}`)
      if (opts.clearBroken) throw new DOMException('The database connection is closing.', 'InvalidStateError')
      return inner.clear(...a)
    },
    async all(...a: Parameters<typeof inner.all>) {
      refuse()
      return inner.all(...a)
    },
  } as typeof inner
  const client = createSocketClient({ storage, wsUrl: 'ws://127.0.0.1:1/ws', isOnline: () => false })
  if (opts.keyed) await client.ensureDevice() // the key is already there; only reading the queue fails
  render(<App client={client} storage={storage} />)
  return client
}

describe('startup with unreadable storage', () => {
  it('shows an error with a Try again button instead of an endless splash, and recovers on retry', async () => {
    const broken = { value: true }
    await mount(broken)
    const retry = await screen.findByRole('button', { name: /try again/i }, { timeout: 10_000 })
    expect(screen.getByRole('alert').textContent).toMatch(/storage|read what it saved/i)
    expect(document.activeElement).toBe(retry) // focus lands on the way forward

    broken.value = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('button', { name: /try again/i })).toBeNull(), { timeout: 10_000 })
    // the device has no key yet, so the owner goes on to enroll rather than back to the error
    await waitFor(() => expect(window.location.pathname).toBe('/enroll'), { timeout: 10_000 })
  })

  it('a queue that cannot be read when the socket starts shows the same error, and Try again starts it', async () => {
    const broken = { value: true }
    const client = await mount(broken, { keyed: true, queued: true })
    const retry = await screen.findByRole('button', { name: /try again/i }, { timeout: 10_000 })
    expect(client.store.getState().deviceId).not.toBeNull() // the key loaded; only start() failed
    expect(client.outboxSize()).toBe(0)
    broken.value = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('button', { name: /try again/i })).toBeNull(), { timeout: 10_000 })
    // start() ran to the end this time: the saved queue is loaded again, so the waiting message is not forgotten
    await waitFor(() => expect(client.outboxSize()).toBe(1), { timeout: 10_000 })
  })
})

describe('the recovery screens at the Gate', () => {
  it('while storage never answers, the splash has a "Taking too long?" link that leads to Try again and the instructions', async () => {
    await mount({ value: false }, { hang: true })
    fireEvent.click(await screen.findByRole('button', { name: /taking too long/i }, { timeout: 10_000 }))
    expect(screen.getByText(/still opening/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
    expect(screen.getByText(/clear this site's data/i)).toBeTruthy()
  })

  it('a storage that will not open shows Try again and the instructions, and nothing in the app deletes the database', async () => {
    const deleted = vi.fn()
    vi.stubGlobal('indexedDB', { deleteDatabase: deleted })
    const removed: string[] = []
    const broken = { value: true }
    await mount(broken, { removed })
    const retry = await screen.findByRole('button', { name: /try again/i }, { timeout: 10_000 })
    expect(screen.getByText(/clear this site's data/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reset|delete/i })).toBeNull()
    fireEvent.click(retry) // still broken: the same screen again
    await screen.findByRole('button', { name: /try again/i }, { timeout: 10_000 })
    expect(deleted).not.toHaveBeenCalled()
    expect(removed).toEqual([]) // no record was cleared or deleted either: the owner's saved data is untouched
  })

  it('an unfinished wipe that kept the queue says so on the screen the Gate shows', async () => {
    window.localStorage.setItem('talos-app:wipe-pending', 'keep')
    await mount({ value: false }, { keyed: true, clearBroken: true })
    expect((await screen.findByRole('alert', {}, { timeout: 10_000 })).textContent).toMatch(/unsent messages are kept/i)
  })
})

describe('storage that never answers while the relay cannot be reached', () => {
  /** The cache read is held to the same limit as the /api/me request: that wait is the only timer here, so the test shortens it. */
  async function shortenTheWait() {
    const { ME_WAIT_MS } = await import('../src/features/auth/session.ts')
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
      real(fn, ms === ME_WAIT_MS ? 0 : ms, ...a)) as typeof setTimeout)
  }

  it('ends on the offline screen with a Retry button that works once storage answers', async () => {
    await shortenTheWait()
    const opts = { hang: true, offline: true }
    await mount({ value: false }, opts)
    const retry = await screen.findByRole('button', { name: /retry/i }, { timeout: 10_000 })
    expect(screen.getByText(/offline/i)).toBeTruthy()
    opts.hang = false // storage comes back and so does the relay
    opts.offline = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).toBeNull(), { timeout: 10_000 })
    await waitFor(() => expect(window.location.pathname).toBe('/enroll'), { timeout: 10_000 }) // authed, no key yet
  })

  it('a healthy start is unchanged: no offline screen', async () => {
    await shortenTheWait()
    await mount({ value: false })
    await waitFor(() => expect(window.location.pathname).toBe('/enroll'), { timeout: 10_000 })
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })
})
