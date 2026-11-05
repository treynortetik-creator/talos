// @vitest-environment node
// IndexedDB can fail two ways: the open is refused, or a connection that opened fine dies later and every transaction on
// it fails. Neither may be remembered: the next call opens again, so "Try again" and the send queue recover on their own.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Hooks = {
  terminated?: () => void
  blocking?: () => void
  upgrade?: (d: {
    objectStoreNames: { contains: (n: string) => boolean }
    createObjectStore: (n: string) => void
  }) => void
}
let opened: Array<{ name: string; version: number; created: string[] }> = []
let opens = 0
let hooks: Hooks[] = []
/** What each successive open hands back: a healthy connection, a refused open, or one that opens and then fails every transaction. */
let plan: Array<'ok' | 'refuse' | 'dead' | 'full'> = []

vi.mock('idb', () => ({
  openDB: async (name: string, version: number, h: Hooks) => {
    const mode = plan[opens] ?? 'ok'
    opens += 1
    hooks.push(h)
    const created: string[] = []
    h.upgrade?.({
      objectStoreNames: { contains: (n) => created.includes(n) },
      createObjectStore: (n) => void created.push(n),
    })
    opened.push({ name, version, created })
    if (mode === 'refuse')
      throw new DOMException('A mutation operation was attempted on a database that did not allow it.')
    const m = new Map<string, unknown>()
    const dead = () => {
      if (mode === 'full') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      if (mode === 'dead') throw new DOMException('The database connection is closing.', 'InvalidStateError')
    }
    return {
      get: async (_s: string, k: string) => (dead(), m.get(k)),
      put: async (_s: string, v: unknown, k: string) => (dead(), void m.set(k, v)),
      delete: async () => dead(),
      getAll: async () => (dead(), [...m.values()]),
      clear: async () => dead(),
      close: () => {},
    }
  },
}))

import { createIdbStorage } from '../src/lib/storage.ts'

beforeEach(() => {
  opens = 0
  hooks = []
  opened = []
  plan = []
})

describe('createIdbStorage', () => {
  it('keeps the problem queue in its own database: the main one stays at version 2, so an older build can still open it', async () => {
    const st = createIdbStorage()
    await st.put('keys', 'device', { ok: 1 })
    await st.put('problems', 'p1', { q: 1 })
    const main = opened.find((o) => o.name === 'talos-app')
    const side = opened.find((o) => o.name === 'talos-app-problems')
    expect(main?.version).toBe(2)
    expect(main?.created).toEqual(['keys', 'outbox', 'blobs', 'cache', 'drafts', 'schedules'])
    expect(side).toMatchObject({ version: 1, created: ['problems'] })
    expect(await st.get('problems', 'p1')).toEqual({ q: 1 })
  })

  it('a problems database that will not open does not touch the keys or the outbox', async () => {
    plan = ['ok', 'refuse', 'ok'] // main opens, then the problems database is refused
    const st = createIdbStorage()
    await st.put('keys', 'device', { ok: 1 })
    await expect(st.put('problems', 'p1', { q: 1 })).rejects.toThrow()
    expect(await st.get('keys', 'device')).toEqual({ ok: 1 })
    await st.put('outbox', 'a', { id: 'a' })
    expect(opened.filter((o) => o.name === 'talos-app')).toHaveLength(1)
  })

  it('a refused open fails the call that met it, then opens again for the next one', async () => {
    plan = ['refuse', 'ok']
    const st = createIdbStorage()
    await expect(st.get('keys', 'device')).rejects.toThrow()
    await st.put('keys', 'device', { ok: 1 })
    expect(await st.get('keys', 'device')).toEqual({ ok: 1 })
    expect(opens).toBe(2)
  })

  it('a connection that opened fine and later fails at transaction time is replaced, and the call succeeds', async () => {
    plan = ['dead', 'ok']
    const st = createIdbStorage()
    await st.put('outbox', 'a', { id: 'a' }) // the first connection fails here, on a live handle
    expect(opens).toBe(2)
    expect(await st.get('outbox', 'a')).toEqual({ id: 'a' })
    expect(opens).toBe(2) // the healthy connection is reused, not reopened on every call
  })

  it('while every connection is dead the call fails, and the dead handle is not kept for later', async () => {
    plan = ['dead', 'dead', 'ok']
    const st = createIdbStorage()
    await expect(st.get('keys', 'device')).rejects.toThrow('closing')
    await st.put('keys', 'device', { ok: 1 }) // a later call opens a new connection instead of reusing a dead one
    expect(await st.get('keys', 'device')).toEqual({ ok: 1 })
  })

  it('the browser terminating the connection makes the next call open a new one', async () => {
    const st = createIdbStorage()
    await st.put('keys', 'device', { ok: 1 })
    hooks[0]?.terminated?.()
    await st.get('keys', 'device')
    expect(opens).toBe(2)
  })

  it('an error that is not a dead connection (a full disk) is passed on and the connection is kept', async () => {
    plan = ['full']
    const st = createIdbStorage()
    await expect(st.put('keys', 'device', { ok: 1 })).rejects.toThrow('quota')
    expect(opens).toBe(1)
  })
})
