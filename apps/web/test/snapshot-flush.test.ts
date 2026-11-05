// @vitest-environment node
// The render cache is saved on a 250 ms timer. A page that goes away inside that window must still keep its last change.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  client = mk()
})
afterEach(async () => {
  client.close()
  await relay.stop()
  delete g.window
  delete g.document
})

async function online() {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  // let the connect-time snapshot settle so the next change starts a fresh debounce
  await new Promise((r) => setTimeout(r, 350))
}

describe('snapshot flush on page exit', () => {
  const id = newId('m')

  it('a change followed at once by pagehide survives a restart', async () => {
    await online()
    relay.sendToApps(reply(id, 'keep me'))
    await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === id) === true, 2000, 'row')
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
    await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === id) === true, 2000, 'row')
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
    await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === id) === true, 2000, 'row')
    await new Promise((r) => setTimeout(r, 350)) // saved
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
    await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === id) === true, 2000, 'row')
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
    await new Promise((r) => setTimeout(r, 400))
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
    await waitFor(() => client.store.getState().messages.general?.some((m) => m.id === id) === true, 2000, 'row')
    client.close()
    await storage.clear('cache')
    win.dispatchEvent(new Event('pagehide'))
    await new Promise((r) => setTimeout(r, 400))
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
    await new Promise((r) => setTimeout(r, 100))
    expect([...live]).toEqual([])
    expect(c.store.getState().connection).not.toBe('online')
  })
})
