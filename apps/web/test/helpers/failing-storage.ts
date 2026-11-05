// A storage layer that can refuse, the way IndexedDB does when it is full, blocked or its connection is lost. Wraps a real
// (memory) storage so everything else behaves normally; arm a fault, run the code under test, then check what the owner sees.
import { createMemoryStorage, type Storage, type StoreName } from '../../src/lib/storage.ts'

type Op = 'get' | 'put' | 'del' | 'all' | 'clear'
export type StorageFault = {
  op: Op
  /** Only this store. Omitted: any store. */
  store?: StoreName
  /** How many matching calls fail before it heals. Omitted: every call fails until `heal()`. */
  times?: number
  message?: string
}

export type FailingStorage = Storage & {
  /** Arms a fault. Returns how many calls it has refused so far (for assertions). */
  fail(fault: StorageFault): { readonly refused: number }
  /** Removes every armed fault. */
  heal(): void
}

export function createFailingStorage(base: Storage = createMemoryStorage()): FailingStorage {
  const faults: Array<StorageFault & { left: number; refused: number }> = []
  const check = (op: Op, store?: StoreName) => {
    const f = faults.find((x) => x.op === op && (x.store === undefined || x.store === store) && x.left > 0)
    if (!f) return
    f.left--
    f.refused++
    throw new DOMException(f.message ?? 'The database connection is closing.', 'InvalidStateError')
  }
  return {
    async get<T>(store: StoreName, key: string) {
      check('get', store)
      return base.get<T>(store, key)
    },
    async put(store, key, value) {
      check('put', store)
      return base.put(store, key, value)
    },
    async del(store, key) {
      check('del', store)
      return base.del(store, key)
    },
    async all<T>(store: StoreName) {
      check('all', store)
      return base.all<T>(store)
    },
    async clear(store) {
      check('clear', store)
      return base.clear(store)
    },
    ...(base.putSync
      ? {
          putSync(store: StoreName, key: string, value: unknown) {
            check('put', store)
            base.putSync?.(store, key, value)
          },
        }
      : {}),
    fail(fault) {
      const armed = { ...fault, left: fault.times ?? Number.POSITIVE_INFINITY, refused: 0 }
      faults.push(armed)
      return {
        get refused() {
          return armed.refused
        },
      }
    },
    heal() {
      faults.length = 0
    },
  }
}
