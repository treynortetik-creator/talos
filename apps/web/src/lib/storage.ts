// Small async key/value layer over IndexedDB (db `talos-app`). The device key, the signed-bytes outbox, offline voice
// blobs, the render cache and composer drafts all live here. Tests use `createMemoryStorage()`.
import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

export type StoreName = 'keys' | 'outbox' | 'blobs' | 'cache' | 'drafts' | 'schedules' | 'problems'
export const STORE_NAMES: readonly StoreName[] = ['keys', 'outbox', 'blobs', 'cache', 'drafts', 'schedules', 'problems']

export interface Storage {
  get<T>(store: StoreName, key: string): Promise<T | undefined>
  put(store: StoreName, key: string, value: unknown): Promise<void>
  del(store: StoreName, key: string): Promise<void>
  /**
   * Like `put`, but the value is durable the moment this returns. For a page that is going away (pagehide): an IndexedDB
   * request issued then is not reliably delivered before the renderer is torn down. Optional; callers fall back to `put`.
   */
  putSync?(store: StoreName, key: string, value: unknown): void
  /** Every value in the store, in key order. */
  all<T>(store: StoreName): Promise<T[]>
  clear(store: StoreName): Promise<void>
}

export const DB_NAME = 'talos-app'
const DB_VERSION = 2 // 2: the `schedules` store (docs/SCHEDULES.md S5.2)
/**
 * The problem-report queue lives in its own database. A second store in `talos-app` would need version 3, and a browser
 * that has opened version 3 refuses every older build with a VersionError on all of it, the device key and the outbox
 * included. Rolling this build back must not cost the owner either of those.
 */
export const PROBLEMS_DB_NAME = 'talos-app-problems'
const PROBLEMS_DB_VERSION = 1
const SEPARATE_STORES: readonly StoreName[] = ['problems']
const MAIN_STORES = STORE_NAMES.filter((n) => !SEPARATE_STORES.includes(n))

interface TalosDB extends DBSchema {
  keys: { key: string; value: unknown }
  outbox: { key: string; value: unknown }
  blobs: { key: string; value: unknown }
  cache: { key: string; value: unknown }
  drafts: { key: string; value: unknown }
  schedules: { key: string; value: unknown }
  problems: { key: string; value: unknown }
}

// Mirror for `putSync`: localStorage is synchronous, so a write made inside `pagehide` is there for the next page load.
const PENDING = 'talos-app:pending:'
const pendingKey = (store: StoreName, key: string) => `${PENDING}${store}:${key}`
const ls = (): globalThis.Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
function dropPending(store: StoreName, key: string, only?: string) {
  try {
    const l = ls()
    if (!l) return
    if (only !== undefined && l.getItem(pendingKey(store, key)) !== only) return
    l.removeItem(pendingKey(store, key))
  } catch {}
}

/** A connection the browser has closed or lost (a WebKit tab that sat in the background, a deleted database). */
const isDeadConnection = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'InvalidStateError' || e.name === 'UnknownError')

export function createIdbStorage(): Storage {
  /** One connection per database, opened on first use and reopened after a refused open or a dead connection. */
  const holder = (name: string, version: number, stores: readonly StoreName[]) => {
    let dbp: Promise<IDBPDatabase<TalosDB>> | null = null
    const forget = () => {
      dbp = null
    }
    const db = () => {
      if (!dbp) {
        const opened: Promise<IDBPDatabase<TalosDB>> = openDB<TalosDB>(name, version, {
          upgrade(d) {
            for (const n of stores) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n)
          },
          // The browser dropped the connection, or another tab needs it closed for an upgrade: do not keep handing it out.
          terminated: () => {
            if (dbp === opened) forget()
          },
          blocking: () => {
            if (dbp === opened) forget()
            void opened.then((d) => d.close()).catch(() => {})
          },
        })
        dbp = opened
        // A refused open is not remembered either: the next call opens again, so a retry can work.
        opened.catch(() => {
          if (dbp === opened) forget()
        })
      }
      return dbp
    }
    return { db, forget }
  }
  const main = holder(DB_NAME, DB_VERSION, MAIN_STORES)
  const problems = holder(PROBLEMS_DB_NAME, PROBLEMS_DB_VERSION, SEPARATE_STORES)
  /**
   * Runs one operation. A connection that opened fine but has since died fails here, at transaction time: the cached
   * handle is dropped and the operation is tried once on a fresh connection, so Try again and sends recover on their own.
   */
  const run = async <T>(store: StoreName, op: (d: IDBPDatabase<TalosDB>) => Promise<T>): Promise<T> => {
    const h = SEPARATE_STORES.includes(store) ? problems : main
    const d = await h.db()
    try {
      return await op(d)
    } catch (e) {
      if (!isDeadConnection(e)) throw e
      h.forget()
      return op(await h.db())
    }
  }
  return {
    async get<T>(store: StoreName, key: string) {
      try {
        const raw = ls()?.getItem(pendingKey(store, key))
        if (raw) {
          // A write made as the last page went away: newer than anything in IndexedDB. Promote it, then drop the mirror.
          const value = JSON.parse(raw) as T
          await run(store, (d) => d.put(store, value, key))
          dropPending(store, key, raw)
          return value
        }
      } catch {}
      return (await run(store, (d) => d.get(store, key))) as T | undefined
    },
    async put(store, key, value) {
      dropPending(store, key)
      await run(store, (d) => d.put(store, value, key))
    },
    putSync(store, key, value) {
      let raw: string | undefined
      try {
        raw = JSON.stringify(value)
        ls()?.setItem(pendingKey(store, key), raw)
      } catch {
        raw = undefined // over quota or no localStorage: the IndexedDB put below is all there is
      }
      void run(store, (d) => d.put(store, value, key))
        .then(() => {
          if (raw !== undefined) dropPending(store, key, raw)
        })
        .catch(() => {})
    },
    async del(store, key) {
      dropPending(store, key)
      await run(store, (d) => d.delete(store, key))
    },
    async all<T>(store: StoreName) {
      return (await run(store, (d) => d.getAll(store))) as T[]
    },
    async clear(store) {
      try {
        const l = ls()
        if (l) {
          const prefix = `${PENDING}${store}:`
          for (const k of Object.keys(l)) if (k.startsWith(prefix)) l.removeItem(k)
        }
      } catch {}
      await run(store, (d) => d.clear(store))
    },
  }
}

export function createMemoryStorage(): Storage {
  const stores = new Map<StoreName, Map<string, unknown>>()
  const s = (n: StoreName) => {
    const found = stores.get(n)
    if (found) return found
    const m = new Map<string, unknown>()
    stores.set(n, m)
    return m
  }
  return {
    async get<T>(store: StoreName, key: string) {
      return s(store).get(key) as T | undefined
    },
    async put(store, key, value) {
      s(store).set(key, value)
    },
    async del(store, key) {
      s(store).delete(key)
    },
    putSync(store, key, value) {
      s(store).set(key, value)
    },
    async all<T>(store: StoreName) {
      return [...s(store).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v as T)
    },
    async clear(store) {
      s(store).clear()
    },
  }
}
