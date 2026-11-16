// @vitest-environment node
// The saved render cache is read back by key. A cache written by another build, or damaged, can hold the wrong shape under
// a known key; a list that is not a list must be left out, never handed to code that maps over it (bug hunt 2026-11-10,
// web "plausible": `pickSnapshot` had no shape check).
import { expect, it } from 'vitest'
import { pickSnapshot } from '../src/lib/socket-state.ts'

it('keeps well-shaped parts and drops wrong-shaped ones, each on its own', () => {
  const good = {
    messages: { general: [] },
    threads: [],
    cards: [],
    inbox: [],
    unread: { general: 2 },
    statuses: {},
    appStates: {},
    lastSeq: 7,
  }
  expect(pickSnapshot(good as never)).toEqual(good)

  const bad = {
    messages: { general: 'not a list', ok: [] },
    threads: 'x',
    cards: { length: 1 },
    inbox: 5,
    unread: [1, 2],
    statuses: 'busy',
    appStates: null,
    config: 'cfg',
    lastSeq: '7',
  }
  const out = pickSnapshot(bad as never)
  expect(out).toEqual({ messages: { ok: [] } })
})

it('a non-number unread count is dropped without losing the others', () => {
  const out = pickSnapshot({ unread: { a: 1, b: 'two', c: -1, d: 1.5 } } as never)
  expect(out.unread).toEqual({ a: 1 })
})

it('a `__proto__` thread key in the cache cannot reach the prototype', () => {
  const snap = JSON.parse('{"messages":{"__proto__":[{"id":"x"}],"general":[]},"unread":{"__proto__":3}}')
  const out = pickSnapshot(snap)
  expect(Object.getPrototypeOf(out.messages)).toBe(Object.prototype)
  expect(({} as Record<string, unknown>).id).toBeUndefined()
  expect(Object.hasOwn(out.messages ?? {}, 'general')).toBe(true)
})
