// @vitest-environment node
// The render cache is saved on a 250 ms timer. A page that goes away inside that window must still keep its last change.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../src/lib/storage.ts'

const g = globalThis as Record<string, unknown>
let relay: FakeRelay
let storage: Storage
let client: SocketClient
let win: EventTarget
let doc: EventTarget & { visibilityState: string }

const mk = () =>
  createSocketClient({
    storage,
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })

const reply = (id: string, text: string) =>
  mkFrame('reply', {
    message: {
      id,
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text,
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: new Date().toISOString(),
    },
  })

async function snapshotIds(): Promise<string[]> {
  const snap = await storage.get<{ messages?: Record<string, Array<{ id: string }>> }>('cache', 'snapshot')
  return (snap?.messages?.general ?? []).map((m) => m.id)
}

beforeEach(async () => {
  win = new EventTarget()
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  g.window = win
  g.document = doc
  relay = await new FakeRelay().start()
  storage = createMemoryStorage()
  // from here on every timer the client sets is a fake one, ensureDevice's and the connect-time ones included: a real one left
  // pending would write the snapshot at a moment the test does not choose
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  client = mk()
})
afterEach(async () => {
  vi.useRealTimers()
  client.close()
  await relay.stop()
  delete g.window
  delete g.document
})

// The 250 ms save debounce runs on a fake clock (setTimeout only: the sockets stay real, see beforeEach), so a test moves time
// instead of sleeping. A wait that polls with setTimeout would stall, so a test waits on the store: `until` resolves on the change.
const DEBOUNCE_PAST_MS = 350 // the save timer is 250 ms
const until = (cond: () => boolean) =>
  new Promise<void>((resolve) => {
    if (cond()) return resolve()
    const off = client.store.subscribe(() => {
      if (!cond()) return
      off()
      resolve()
    })
  })
const hasRow = (id: string) => () => client.store.getState().messages.general?.some((m) => m.id === id) === true

async function online() {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await until(() => client.store.getState().connection === 'online')
  // let the connect-time snapshot settle so the next change starts a fresh debounce: a marker frame on the same socket shows
  // the connect-time frames are in, then the clock moves past the save timer
  const marker = newId('m')
  relay.sendToApps(reply(marker, 'marker'))
  await until(hasRow(marker))
  await vi.advanceTimersByTimeAsync(DEBOUNCE_PAST_MS)
}

describe('snapshot flush on page exit', () => {
  const id = newId('m')

  it('a change followed at once by pagehide survives a restart', async () => {
    await online()
    relay.sendToApps(reply(id, 'keep me'))
    await until(hasRow(id))
    expect(await snapshotIds()).not.toContain(id) // still inside the debounce window
    win.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    expect(await snapshotIds()).toContain(id)
    client.close()
    client = mk() // the reload
    await client.start({ pinned: true })
    expect(client.store.getState().messages.general?.some((m) => m.id === id)).toBe(true)
  })

  it('visibilitychange to hidden flushes; to visible does not', async () => {
    await online()
    relay.sendToApps(reply(id, 'keep me'))
    await until(hasRow(id))
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(await snapshotIds()).not.toContain(id)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(await snapshotIds()).toContain(id)
  })

  it('a deleted row stays deleted when the page goes away inside the window', async () => {
    await online()
    relay.sendToApps(reply(id, 'doomed'))
    await until(hasRow(id))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PAST_MS) // saved
    expect(await snapshotIds()).toContain(id)
    client.store.setState((s) => ({
      messages: { ...s.messages, general: (s.messages.general ?? []).filter((m) => m.id !== id) },
    }))
    win.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    expect(await snapshotIds()).not.toContain(id)
  })

  it('nothing is written after close(): not from the timer, not from pagehide', async () => {
    await online()
    relay.sendToApps(reply(id, 'late'))
    await until(hasRow(id))
    const puts: string[] = []
    const realPut = storage.put.bind(storage)
    storage.put = async (st, k, v) => {
      puts.push(`${st}:${k}`)
      return realPut(st, k, v)
    }
    storage.putSync = (st, k) => void puts.push(`sync ${st}:${k}`)
    client.close() // the wipe path: sign-out or a 401
    await storage.clear('cache')
    // the store outlives close(): a change now, then the debounce, then a page exit
    client.store.setState((s) => ({ unread: { ...s.unread, general: 7 } }))
    await vi.advanceTimersByTimeAsync(400)
    win.dispatchEvent(new Event('pagehide'))
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(puts.filter((p) => p.includes('snapshot'))).toEqual([])
    expect(await snapshotIds()).toEqual([])
  })

  it('a save pending when close() runs is not written by the flush', async () => {
    await online()
    relay.sendToApps(reply(id, 'pending'))
    await until(hasRow(id))
    client.close()
    await storage.clear('cache')
    win.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(400)
    expect(await snapshotIds()).toEqual([])
  })

  it('close() during start() leaves no listeners behind', async () => {
    const c = mk()
    await c.ensureDevice()
    const live = new Set<string>()
    const add = win.addEventListener.bind(win)
    const rm = win.removeEventListener.bind(win)
    win.addEventListener = (t: string, ...r: never[]) => (live.add(t), add(t, ...(r as [never])))
    win.removeEventListener = (t: string, ...r: never[]) => (live.delete(t), rm(t, ...(r as [never])))
    const p = c.start({ pinned: true })
    c.close() // before start()'s awaits have finished
    await p
    await vi.advanceTimersByTimeAsync(100)
    expect([...live]).toEqual([])
    expect(c.store.getState().connection).not.toBe('online')
  })
})
