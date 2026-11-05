// R1-1 and R1-3: one visible quoting form shared by the card and the app, and one config hash the app and the bridge both call.
import { describe, expect, it } from 'vitest'
import {
  configHash,
  HEARTBEAT_META_KEY,
  HeartbeatConfig,
  heartbeatConfigHashOf,
  heartbeatSection,
  quoteVisible,
} from '../src/index.ts'

const raw = {
  schema: 'talos.heartbeat/1',
  sources: [{ id: 'disk', kind: 'command', enabled: true, args: { argv: ['/bin/echo', 'a‮b'] }, timeout_s: 30 }],
  mutes: [],
}

describe('heartbeatConfigHashOf', () => {
  it('is configHash of the strict parse, so defaults (mode, caps) are part of what is hashed', () => {
    expect(heartbeatConfigHashOf(raw)).toBe(configHash(HeartbeatConfig.parse(raw)))
    expect(heartbeatConfigHashOf(raw)).toBe(
      heartbeatConfigHashOf({ ...raw, mode: 'shadow', wake_cap_per_day: 3, run_timeout_s: 120 }),
    )
    expect(heartbeatConfigHashOf(raw)).not.toBe(heartbeatConfigHashOf({ ...raw, wake_cap_per_day: 4 }))
  })
  it('throws on a config that is not a strict heartbeat (it never hashes something it could not write)', () => {
    expect(() => heartbeatConfigHashOf({ ...raw, extra_key: 1 })).toThrow()
  })
})

describe('quoteVisible', () => {
  it('JSON-quotes after the escape: bidi and zero-width characters become visible markers, and quotes stay visible', () => {
    expect(quoteVisible('a‮b')).toBe('"a⟦U+202E⟧b"')
    expect(quoteVisible('a​b')).toBe('"a⟦U+200B⟧b"')
    expect(quoteVisible('x "y"')).toBe('"x \\"y\\""')
  })
  it('is the form the approval card uses for argv, so the app and the card show the same word', () => {
    const text = heartbeatSection({
      op: 'create',
      after: { [HEARTBEAT_META_KEY]: HeartbeatConfig.parse(raw) },
      metaSet: true,
      slotsAfter: '09:45',
    })
    expect(text).toContain(`Runs "disk": ${quoteVisible('/bin/echo')} ${quoteVisible('a‮b')}`)
  })
})
