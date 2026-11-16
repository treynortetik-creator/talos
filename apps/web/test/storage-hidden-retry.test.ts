// @vitest-environment node
// WebKit closes IndexedDB while the iPhone app is in the background: a write that lands then fails with UnknownError
// ("Attempt to delete range from database without an in-progress transaction", seen once on a thread, 2026-11-15), and
// the immediate retry on a fresh connection fails the same way. The write waits for the app to come back and runs then,
// so a sent message's draft is still removed and nothing rejects unseen; unless a newer write already decided that row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let opens = 0
/** How many opens hand back a connection whose every transaction fails like a suspended WebKit store. */
let deadOpens = 0
const rows = new Map<string, unknown>()

vi.mock('idb', () => ({
  openDB: async () => {
    const dead = opens++ < deadOpens
    const fail = () => {
      if (dead)
        throw new DOMException(
          'Attempt to delete range from database without an in-progress transaction',
          'UnknownError',
        )
    }
    return {
      get: async (_s: string, k: string) => (fail(), rows.get(k)),
      put: async (_s: string, v: unknown, k: string) => (fail(), void rows.set(k, v)),
      delete: async (_s: string, k: string) => (fail(), void rows.delete(k)),
      getAll: async () => (fail(), [...rows.values()]),
      clear: async () => (fail(), rows.clear()),
      close: () => {},
    }
  },
}))

import { createIdbStorage } from '../src/lib/storage.ts'

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
  show() {
    this.visibilityState = 'visible'
    this.dispatchEvent(new Event('visibilitychange'))
  }
}
let doc: FakeDocument

beforeEach(() => {
  opens = 0
  deadOpens = 0
  rows.clear()
  doc = new FakeDocument()
  vi.stubGlobal('document', doc)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const settled = async (p: Promise<unknown>) => {
  let done = false
  void p.then(
    () => (done = true),
    () => (done = true),
  )
  for (let i = 0; i < 20; i++) await Promise.resolve()
  return done
}

describe('IndexedDB while the app is in the background', () => {
  it('a delete that fails twice while hidden waits for the app to come back, then removes the row', async () => {
    rows.set('t1', 'sent words')
    const st = createIdbStorage()
    deadOpens = 2 // the first connection and the retry's both fail; the one opened after the app is back works
    doc.visibilityState = 'hidden'
    const del = st.del('drafts', 't1')
    expect(await settled(del)).toBe(false) // waiting, not failed
    expect(rows.has('t1')).toBe(true)
    doc.show()
    await expect(del).resolves.toBeUndefined()
    expect(rows.has('t1')).toBe(false)
  })

  it('in front, a store that stays dead still fails, so a send can say so', async () => {
    deadOpens = 99
    const st = createIdbStorage()
    await expect(st.del('drafts', 't1')).rejects.toMatchObject({ name: 'UnknownError' })
  })

  it('a parked write that a newer one overtook does not land over it, and the parked writes share one fresh connection', async () => {
    const st = createIdbStorage()
    deadOpens = 2
    doc.visibilityState = 'hidden'
    const older = st.put('cache', 'queue', 'q1') // fails twice and parks
    const other = st.put('cache', 'other', 'o1') // parks too, on the same dead connections
    expect(await settled(older)).toBe(false)
    expect(await settled(other)).toBe(false)
    // still hidden, the store works again for a moment (a background wake): a newer write lands at once
    await st.put('cache', 'queue', 'q2')
    expect(rows.get('queue')).toBe('q2')
    const before = opens
    doc.show()
    await expect(older).resolves.toBeUndefined()
    await expect(other).resolves.toBeUndefined()
    expect(rows.get('queue')).toBe('q2') // the stale q1 was skipped
    expect(rows.get('other')).toBe('o1') // a parked write nothing overtook still lands
    expect(opens - before).toBeLessThanOrEqual(1)
  })

  it('a parked clear does not wipe what was written after it', async () => {
    const st = createIdbStorage()
    deadOpens = 2
    doc.visibilityState = 'hidden'
    const clear = st.clear('cache')
    expect(await settled(clear)).toBe(false)
    await st.put('cache', 'fresh', 'kept')
    doc.show()
    await clear
    expect(rows.get('fresh')).toBe('kept')
  })
})
