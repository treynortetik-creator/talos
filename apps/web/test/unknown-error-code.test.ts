// @vitest-environment node
// Protocol audit O5, the app side: an error with a code this build does not list arrives (read as 'internal', so a pending
// request fails instead of waiting forever) AND is still noted as coming from a newer build, once.
import { parseFrame } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { createUnknownNotes, unknownOfParsed } from '../src/lib/unknownFrames.ts'

const error = {
  v: 1,
  type: 'error',
  id: '01JBF3V7Q8K2M4N6P8R0S2T40J',
  ts: '2026-10-28T15:32:10.120Z',
  ref: '01JBF3V7Q8K2M4N6P8R0S2T40M',
  code: 'from_a_newer_relay',
  message: 'something new went wrong',
}

describe('an error code from a newer build', () => {
  it('arrives as internal with its words, and is noted once', () => {
    const r = parseFrame(error, { direction: 'relay_to_app' })
    expect(r.ok && r.frame.type === 'error' && [r.frame.code, r.frame.message]).toEqual([
      'internal',
      'something new went wrong',
    ])
    const notes: string[] = []
    const note = createUnknownNotes((text) => notes.push(text))
    note(unknownOfParsed(error))
    note(unknownOfParsed({ ...error, id: '01JBF3V7Q8K2M4N6P8R0S2T40K' }))
    expect(notes).toHaveLength(1)
  })

  it('a code this build lists notes nothing', () => {
    expect(unknownOfParsed({ ...error, code: 'mac_offline' })).toBeNull()
  })
})
