// `ready.read_upto`: the relay's per-thread read mark. An older relay omits it; a junk value costs only the field.
import { describe, expect, it } from 'vitest'
import { ReadyFrame } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()

describe('ready.read_upto', () => {
  it('parses a per-thread read mark', () => {
    const r = ReadyFrame.safeParse({ ...fixtures.ready, read_upto: { general: 12, inbox: 0 } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.read_upto).toEqual({ general: 12, inbox: 0 })
  })
  it('an older relay that omits it still parses', () => {
    const { read_upto: _gone, ...old } = fixtures.ready as Record<string, unknown>
    const r = ReadyFrame.safeParse(old)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.read_upto).toBeUndefined()
  })
  it('a bad value drops the field, not the whole ready', () => {
    const r = ReadyFrame.safeParse({ ...fixtures.ready, read_upto: { general: -4 } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.read_upto).toBeUndefined()
  })
})
