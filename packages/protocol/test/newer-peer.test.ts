// What a frame that did not parse says about itself: a newer peer's frame, or just a broken one. Real frames come from the
// golden fixtures; the "newer" ones are those same frames with the one change a later build would make.
import { describe, expect, it } from 'vitest'
import { classifyUnparsed, looksSigned, parseFrame, SIGNED_FRAME_TYPES } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const replyFixture = () => structuredClone(fixtures.reply) as Record<string, unknown>
const readyFixture = () => structuredClone(fixtures.ready) as Record<string, unknown>

const dir = 'relay_to_app' as const

describe('classifyUnparsed', () => {
  it('a frame type nobody here knows is a newer peer, named by its type', () => {
    expect(classifyUnparsed({ type: 'hologram.show', id: 'x' }, dir)).toEqual({
      kind: 'unknown_type',
      type: 'hologram.show',
    })
  })

  it('an extra field on a relay-to-app frame already parses today (the schemas are loose there): known frames are unchanged', () => {
    const f = { ...replyFixture(), shiny_new_field: 1 }
    expect(parseFrame(f, { direction: dir }).ok).toBe(true)
  })

  it('a field this build does not list on a strict (owner-signed) frame is a newer peer', () => {
    const f = { ...(fixtures.message as Record<string, unknown>), shiny_new_field: 1 }
    expect(parseFrame(f, { direction: 'app_to_relay' }).ok).toBe(false)
    expect(classifyUnparsed(f, 'app_to_relay')).toEqual({ kind: 'newer_shape', type: 'message' })
  })

  it('a known type with an enum value this build does not list is a newer peer', () => {
    const base = replyFixture() as { message: Record<string, unknown> }
    const f = { ...base, message: { ...base.message, kind: 'hologram' } }
    expect(parseFrame(f, { direction: dir }).ok).toBe(false)
    expect(classifyUnparsed(f, dir)).toEqual({ kind: 'newer_shape', type: 'reply' })
  })

  it('a future protocol version is a newer peer', () => {
    const f = { ...readyFixture(), v: 2 }
    expect(parseFrame(f, { direction: dir }).ok).toBe(false)
    expect(classifyUnparsed(f, dir)).toEqual({ kind: 'newer_shape', type: 'ready' })
  })

  it('a known type with a missing or wrong-typed field is broken, not newer', () => {
    const { message: _m, ...noMessage } = replyFixture() as Record<string, unknown>
    expect(classifyUnparsed(noMessage, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...replyFixture(), id: 12 }, dir)).toEqual({ kind: 'broken' })
  })

  it('a known type sent the wrong way round is broken', () => {
    expect(classifyUnparsed(replyFixture(), 'app_to_relay')).toEqual({ kind: 'broken' })
  })

  it('a frame that parses, junk, and hostile type names are all "broken" (no note, no type echoed)', () => {
    expect(classifyUnparsed(replyFixture(), dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed(null, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed([1], dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ type: 5 }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ type: '<script>alert(1)</script>' }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ type: 'a'.repeat(65) }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ type: '__proto__' }, dir)).toEqual({ kind: 'unknown_type', type: '__proto__' })
  })

  it('a missing, null or wrong-typed value is broken even though zod calls it an unlisted value', () => {
    const base = replyFixture() as { message: Record<string, unknown> }
    const { kind: _k, ...noKind } = base.message
    expect(classifyUnparsed({ ...base, message: noKind }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...base, message: { ...base.message, author: null } }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...base, message: { ...base.message, kind: 7 } }, dir)).toEqual({ kind: 'broken' })
    const { v: _v, ...noV } = replyFixture()
    expect(classifyUnparsed(noV, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...replyFixture(), v: null }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...replyFixture(), v: '2' }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...replyFixture(), v: 0 }, dir)).toEqual({ kind: 'broken' })
    expect(classifyUnparsed({ ...replyFixture(), v: 1.5 }, dir)).toEqual({ kind: 'newer_shape', type: 'reply' })
    expect(classifyUnparsed({ ...fixtures.error, code: 12345 }, dir)).toEqual({ kind: 'broken' })
  })

  it('v above ours is newer; an unlisted string code is newer', () => {
    expect(classifyUnparsed({ ...replyFixture(), v: 12345 }, dir)).toEqual({ kind: 'newer_shape', type: 'reply' })
    expect(classifyUnparsed({ ...fixtures.error, code: 'brand_new_code' }, dir)).toEqual({
      kind: 'newer_shape',
      type: 'error',
    })
  })

  it('an unknown tag in a discriminated union is newer; a missing or non-string tag is broken', () => {
    const ar = fixtures['app.request'] as Record<string, unknown>
    expect(classifyUnparsed({ ...ar, method: 'ui/brand_new' }, 'app_to_relay')).toEqual({
      kind: 'newer_shape',
      type: 'app.request',
    })
    expect(classifyUnparsed({ ...ar, method: 5 }, 'app_to_relay')).toEqual({ kind: 'broken' })
    const { method: _m, ...noMethod } = ar
    expect(classifyUnparsed(noMethod, 'app_to_relay')).toEqual({ kind: 'broken' })
  })
})

describe('signed frames', () => {
  it('are read from the schemas: every owner-signed, native and signed-read type is in, plain frames are out', () => {
    for (const t of [
      'message',
      'voice_note',
      'card.resolve',
      'native.act',
      'history.request',
      'media.fetch',
      'app.request',
    ])
      expect(SIGNED_FRAME_TYPES.has(t), t).toBe(true)
    for (const t of ['reply', 'ready', 'ping', 'error']) expect(SIGNED_FRAME_TYPES.has(t), t).toBe(false)
  })

  it('looksSigned also catches an unknown type that carries a signature field', () => {
    expect(looksSigned({ type: 'future.owner.thing', osig: 'x' })).toBe(true)
    expect(looksSigned({ type: 'future.owner.thing', owner_sig: 'x' })).toBe(true)
    expect(looksSigned({ type: 'hologram.show' })).toBe(false)
    expect(looksSigned(null)).toBe(false)
  })
})
