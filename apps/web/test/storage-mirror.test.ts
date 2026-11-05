// @vitest-environment node
// createIdbStorage keeps a localStorage mirror for putSync (a write made inside pagehide). The mirror is promoted by the
// next get, and dropped by put, del and clear. IndexedDB is faked in memory; localStorage is a Map.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const idb = new Map<string, Map<string, unknown>>()
const store = (n: string) => {
  const m = idb.get(n) ?? new Map<string, unknown>()
  idb.set(n, m)
  return m
}
vi.mock('idb', () => ({
  openDB: async () => ({
    get: async (s: string, k: string) => store(s).get(k),
    put: async (s: string, v: unknown, k: string) => void store(s).set(k, v),
    delete: async (s: string, k: string) => void store(s).delete(k),
    getAll: async (s: string) => [...store(s).values()],
    clear: async (s: string) => store(s).clear(),
  }),
}))

import { createIdbStorage, type Storage } from '../src/lib/storage.ts'

const g = globalThis as Record<string, unknown>
const KEY = 'talos-app:pending:cache:snapshot'
let ls: Map<string, string>
let st: Storage

beforeEach(() => {
  idb.clear()
  ls = new Map()
  const methods = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
  }
  // Object.keys(localStorage) is how clear() finds mirrored keys: list the map's keys as own enumerable props
  g.localStorage = new Proxy(methods, {
    ownKeys: () => [...ls.keys()],
    getOwnPropertyDescriptor: (_t, p) =>
      typeof p === 'string' && ls.has(p) ? { enumerable: true, configurable: true, value: ls.get(p) } : undefined,
  })
  st = createIdbStorage()
})
afterEach(() => {
  delete g.localStorage
})

describe('putSync mirror', () => {
  it('putSync writes the mirror at once, then IndexedDB, then drops the mirror', async () => {
    st.putSync?.('cache', 'snapshot', { a: 1 })
    expect(ls.get(KEY)).toBe('{"a":1}')
    await vi.waitFor(() => expect(store('cache').get('snapshot')).toEqual({ a: 1 }))
    await vi.waitFor(() => expect(ls.has(KEY)).toBe(false))
  })

  it('get promotes a leftover mirror into IndexedDB and drops it', async () => {
    store('cache').set('snapshot', { a: 'old' })
    ls.set(KEY, '{"a":"new"}')
    expect(await st.get('cache', 'snapshot')).toEqual({ a: 'new' })
    expect(store('cache').get('snapshot')).toEqual({ a: 'new' })
    expect(ls.has(KEY)).toBe(false)
  })

  it('put drops the mirror, so an older mirror cannot beat the newer put', async () => {
    ls.set(KEY, '{"a":"mirror"}')
    await st.put('cache', 'snapshot', { a: 'put' })
    expect(ls.has(KEY)).toBe(false)
    expect(await st.get('cache', 'snapshot')).toEqual({ a: 'put' })
  })

  it('del drops the mirror, so a deleted key is not promoted back', async () => {
    ls.set(KEY, '{"a":"mirror"}')
    await st.del('cache', 'snapshot')
    expect(ls.has(KEY)).toBe(false)
    expect(await st.get('cache', 'snapshot')).toBeUndefined()
  })

  it('clear drops every mirrored key of that store only', async () => {
    ls.set(KEY, '{"a":1}')
    ls.set('talos-app:pending:cache:me', '{"b":1}')
    ls.set('talos-app:pending:drafts:x', '{"c":1}')
    await st.clear('cache')
    expect(ls.has(KEY)).toBe(false)
    expect(ls.has('talos-app:pending:cache:me')).toBe(false)
    expect(ls.has('talos-app:pending:drafts:x')).toBe(true)
    expect(await st.get('cache', 'snapshot')).toBeUndefined()
  })

  it('a stale putSync completion does not drop a newer mirror', async () => {
    st.putSync?.('cache', 'snapshot', { n: 1 })
    ls.set(KEY, '{"n":2}') // a newer mirror lands before the first IndexedDB put resolves
    await vi.waitFor(() => expect(store('cache').get('snapshot')).toEqual({ n: 1 }))
    await new Promise((r) => setTimeout(r, 10))
    expect(ls.get(KEY)).toBe('{"n":2}')
  })
})
