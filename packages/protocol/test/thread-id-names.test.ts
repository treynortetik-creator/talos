import { describe, expect, it } from 'vitest'
import { isInheritedName, ownValue, ReadyFrame, ThreadId } from '../src/index.ts'

// A thread id is used as an object key in the app and the relay. A name that every object already has (`constructor`)
// makes `messages[id]` find a function, not "nothing yet". NEW ids avoid such names; ids already stored still parse,
// or a config.json written before the rule would stop the bridge and a ready frame would fail as a whole.
describe('ThreadId parsing never gets stricter', () => {
  const inherited = Object.getOwnPropertyNames(Object.prototype)

  it.each(inherited)('still parses a stored id %s', (name) => {
    // names that fit the id pattern parse; the rest (`__defineGetter__` etc.) never did, and still do not
    const fitsOldPattern = /^[a-z][a-z0-9_]{0,31}$/.test(name)
    expect(ThreadId.safeParse(name).success).toBe(fitsOldPattern)
  })

  it('still refuses all, and ids that never fit', () => {
    expect(ThreadId.safeParse('all').success).toBe(false)
    expect(ThreadId.safeParse('Constructor').success).toBe(false)
  })

  it('a ready frame carrying a thread, an unread count and a read mark called constructor parses whole', () => {
    const t = '2026-10-28T15:00:00.000Z'
    const r = ReadyFrame.safeParse({
      v: 1,
      id: '01JBF3V7Q8K2M4N6P8R0S1T2V3',
      ts: t,
      type: 'ready',
      session_id: 'rs_x',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: { bridge_online: true, last_seen: t, queue_depth: 0 },
      threads: [{ id: 'constructor', name: 'Constructor', kind: 'agent', order: 1, created_at: t }],
      unread: JSON.parse('{"constructor":2}'),
    })
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true)
  })
})

describe('isInheritedName', () => {
  it('names the Object.prototype members, and only them', () => {
    for (const n of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])
      expect(isInheritedName(n)).toBe(true)
    for (const n of ['general', 'constructor_thread', 'my_constructor']) expect(isInheritedName(n)).toBe(false)
  })
})

describe('ownValue', () => {
  it('reads an own key, and reads a prototype-named key that is not set as absent', () => {
    const rec: Record<string, number> = { general: 3 }
    expect(ownValue(rec, 'general')).toBe(3)
    expect(ownValue(rec, 'constructor')).toBeUndefined()
    expect(ownValue(rec, '__proto__')).toBeUndefined()
    expect(ownValue(rec, 'toString')).toBeUndefined()
  })
  it('reads a prototype-named key that IS set as its value', () => {
    const rec = JSON.parse('{"constructor":[1],"__proto__":[2]}') as Record<string, number[]>
    expect(ownValue(rec, 'constructor')).toEqual([1])
    expect(ownValue(rec, '__proto__')).toEqual([2])
  })
  it('reads undefined from an undefined record', () => {
    expect(ownValue<number>(undefined, 'x')).toBeUndefined()
  })
})
