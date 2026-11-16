// Audit O5: an error code from a newer build must not drop the frame that carries it. An `error` the relay drops leaves a
// refused card.resolve never rolled back; a result the app drops leaves its pending request waiting forever. The code
// reads as 'internal' and the message (or text) keeps the words; anything that is not a short string is still refused.
import { describe, expect, it } from 'vitest'
import { newerInParsed, parseFrame } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fx = loadFixtures()
const CARRIERS = [
  ['error', 'relay_to_app'],
  ['error', 'bridge_to_relay'],
  ['session.control.result', 'bridge_to_relay'],
  ['agent.recover.result', 'bridge_to_relay'],
] as const

describe('an error code this build does not know', () => {
  for (const [type, direction] of CARRIERS) {
    it(`${type} (${direction}) still arrives, as 'internal', with its words`, () => {
      const raw = { ...fx[type], code: 'from_a_newer_mac' }
      const r = parseFrame(raw, { direction })
      expect(r.ok).toBe(true)
      if (!r.ok || !('code' in r.frame)) throw new Error('not parsed')
      expect(r.frame.code).toBe('internal')
      const words = type === 'error' ? 'message' : 'text'
      expect((r.frame as Record<string, unknown>)[words]).toBe(fx[type][words])
    })
  }

  it('a known code is kept as it is', () => {
    const r = parseFrame(fx.error, { direction: 'relay_to_app' })
    expect(r.ok && r.frame.type === 'error' && r.frame.code).toBe('sig_invalid')
  })

  it('is still a sign of a newer peer: newerInParsed says so for it, and only for it', () => {
    for (const [type] of CARRIERS)
      expect(newerInParsed({ ...fx[type], code: 'from_a_newer_mac' })).toEqual({ kind: 'newer_shape', type })
    expect(newerInParsed(fx.error)).toEqual({ kind: 'broken' }) // a code this build lists
    expect(newerInParsed({ ...fx['session.control.result'], code: undefined })).toEqual({ kind: 'broken' })
    expect(newerInParsed({ ...fx.status, code: 'from_a_newer_mac' })).toEqual({ kind: 'broken' }) // not a code frame
    expect(newerInParsed(null)).toEqual({ kind: 'broken' })
  })

  it('a code that is not a short string is still refused', () => {
    for (const code of [7, null, { a: 1 }, 'x'.repeat(65)])
      expect(parseFrame({ ...fx.error, code }, { direction: 'relay_to_app' }).ok).toBe(false)
    expect(parseFrame({ ...fx['session.control.result'], code: 7 }, { direction: 'bridge_to_relay' }).ok).toBe(false)
  })
})
