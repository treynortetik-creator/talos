// The remote terminal's frames (frames-term.ts), piece 1: a read-only view of the agent's tmux pane. A stream of its own: none of
// these is durable, consumable or stored. Every schema is strict with no defaults, so a frame that parses is exactly what was
// sent. MUST_REJECT is the list of bodies each frame refuses; the control beside it is the same frame without the fault.
import { describe, expect, it } from 'vitest'
import {
  AppToRelay,
  BridgeToRelay,
  b64urlEncode,
  CONSUMABLE_FRAME_TYPES,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  OWNER_FRAME_TYPES,
  parseFrame,
  RelayToApp,
  RelayToBridge,
  TERM_FRAME_TYPES,
  TERM_KEY_MAX_BYTES,
  TERM_OUT_MAX_BYTES,
  TERM_VIEW_FEATURE,
  termBytes,
  verifyOwnerFrame,
} from '../src/index.ts'
import { loadFixtures, loadTestKey } from './helpers.ts'

const fixtures = loadFixtures()
const clone = <T>(v: T): Record<string, unknown> => structuredClone(v) as Record<string, unknown>
const bytesB64 = (n: number) => b64urlEncode(new Uint8Array(n).fill(0x41))

const OWNER = ['term.open', 'term.resume', 'term.close'] as const
const TO_APP = ['term.opened', 'term.key', 'term.out', 'term.closed'] as const

describe('term.* frame set', () => {
  it('the eight frames are known, with a fixture each, and the feature is named', () => {
    expect([...TERM_FRAME_TYPES].sort()).toEqual(
      [
        'term.ack',
        'term.close',
        'term.closed',
        'term.key',
        'term.open',
        'term.opened',
        'term.out',
        'term.resume',
      ].sort(),
    )
    for (const t of TERM_FRAME_TYPES) expect(fixtures[t], `fixture ${t}`).toBeDefined()
    expect(TERM_VIEW_FEATURE).toBe('term-view/1')
  })

  it('opening, resuming and closing are owner-signed; the credit and everything the Mac sends are not', () => {
    for (const t of OWNER) expect(OWNER_FRAME_TYPES as readonly string[]).toContain(t)
    for (const t of ['term.ack', ...TO_APP]) expect(OWNER_FRAME_TYPES as readonly string[]).not.toContain(t)
  })

  it('never durable, never consumable: the stream is not on the chat path', () => {
    for (const t of TERM_FRAME_TYPES) {
      expect(DURABLE_FRAME_TYPES as readonly string[]).not.toContain(t)
      expect(CONSUMABLE_FRAME_TYPES as readonly string[]).not.toContain(t)
    }
  })

  it('each frame travels only its own ways', () => {
    const where = (t: string) =>
      Object.entries(DIRECTION_TYPES)
        .filter(([, list]) => (list as readonly string[]).includes(t))
        .map(([d]) => d)
        .sort()
    for (const t of OWNER) expect(where(t)).toEqual(['app_to_relay', 'relay_to_bridge'])
    expect(where('term.ack')).toEqual(['app_to_relay', 'relay_to_bridge'])
    for (const t of TO_APP.filter((x) => x !== 'term.closed'))
      expect(where(t)).toEqual(['bridge_to_relay', 'relay_to_app'])
    // the relay says term.closed itself, both ways: to the page for a lag, and to the Mac when the page's socket has closed
    // (it cannot sign a term.close for the owner)
    expect(where('term.closed')).toEqual(['bridge_to_relay', 'relay_to_app', 'relay_to_bridge'])
    expect(AppToRelay.safeParse(fixtures['term.out']).success).toBe(false)
    expect(RelayToApp.safeParse(fixtures['term.out']).success).toBe(true)
    expect(BridgeToRelay.safeParse(fixtures['term.out']).success).toBe(true)
    expect(RelayToBridge.safeParse(fixtures['term.open']).success).toBe(true)
  })

  it('a good frame parses to exactly what was sent: no default adds a field', () => {
    for (const t of TERM_FRAME_TYPES) {
      const r = parseFrame(fixtures[t])
      expect(r.ok, t).toBe(true)
      if (r.ok) expect(r.frame).toEqual(fixtures[t])
    }
  })

  it('the signed ones verify under the test key, and a changed byte does not', async () => {
    const key = loadTestKey()
    for (const t of OWNER) {
      expect(await verifyOwnerFrame(fixtures[t] as Record<string, unknown>, key.publicJwk), t).toBe(true)
      expect(await verifyOwnerFrame({ ...clone(fixtures[t]), term_id: 'tm_' + '0'.repeat(26) }, key.publicJwk), t).toBe(
        false,
      )
    }
  })
})

describe('term bytes', () => {
  it('the caps: 16 KiB raw in a term.out, 128 KiB raw in a term.key, and a frame at the cap parses', () => {
    expect(TERM_OUT_MAX_BYTES).toBe(16 * 1024)
    expect(TERM_KEY_MAX_BYTES).toBe(128 * 1024)
    const out = clone(fixtures['term.out'])
    expect(parseFrame({ ...out, bytes_b64: bytesB64(TERM_OUT_MAX_BYTES) }).ok).toBe(true)
    const key = clone(fixtures['term.key'])
    expect(parseFrame({ ...key, bytes_b64: bytesB64(TERM_KEY_MAX_BYTES) }).ok).toBe(true)
  })

  it('termBytes decodes base64url and refuses anything else', () => {
    expect([...termBytes('QUJD')]).toEqual([0x41, 0x42, 0x43])
    expect(() => termBytes('QUJD=')).toThrow()
    expect(() => termBytes('Q')).toThrow()
  })
})

type Case = [string, (f: Record<string, unknown>) => Record<string, unknown>]
const without = (k: string): Case => [`no ${k}`, (f) => (({ [k]: _x, ...rest }) => rest)(f)]
const set = (name: string, k: string, v: unknown): Case => [name, (f) => ({ ...f, [k]: v })]

const COMMON: Case[] = [
  ['an extra field', (f) => ({ ...f, extra: 1 })],
  set('a term_id that is not tm_ + a ULID', 'term_id', 'tm_short'),
  set('a term_id of another kind', 'term_id', `ar_${'0'.repeat(26)}`),
  without('term_id'),
]
const SIGNED: Case[] = [without('osig'), without('device_id'), set('a DER-length osig', 'osig', 'A'.repeat(90))]
const BYTES: Case[] = [
  set('base64 with padding', 'bytes_b64', 'QUJD='),
  set('standard-alphabet characters', 'bytes_b64', 'QU+/'),
  set('a length that no byte count makes', 'bytes_b64', 'QUJDR'),
  set('a space inside', 'bytes_b64', 'QU JD'),
  set('bytes that are not text', 'bytes_b64', 12),
  without('bytes_b64'),
  set('a negative offset', 'at', -1),
  set('a fractional offset', 'at', 1.5),
  set('an offset that is not a number', 'at', '5'),
]
const MUST_REJECT: Record<(typeof TERM_FRAME_TYPES)[number], Case[]> = {
  'term.open': [
    ...COMMON,
    ...SIGNED,
    set("tier 'type' (piece 2, refused here)", 'tier', 'type'),
    set("tier 'shell' (piece 3, refused here)", 'tier', 'shell'),
    set('a wrong-case tier', 'tier', 'View'),
    without('tier'),
    set('a target that is neither main nor a thread id', 'target', 'Not A Thread'),
    set('an empty target', 'target', ''),
    set('a path as a target', 'target', '../shell'),
    without('target'),
    set('zero columns', 'cols', 0),
    set('absurd rows', 'rows', 100000),
    set('fractional columns', 'cols', 80.5),
    without('rows'),
  ],
  'term.resume': [
    ...COMMON,
    ...SIGNED,
    set('a negative offset', 'from', -5),
    set('a fractional offset', 'from', 0.5),
    without('from'),
    set('an offset past the safe integers', 'from', Number.MAX_SAFE_INTEGER + 2),
  ],
  'term.close': [...COMMON, ...SIGNED],
  'term.ack': [
    ...COMMON,
    set('a negative credit', 'upto', -1),
    set('an offset that is not a number', 'upto', 'a lot'),
    without('upto'),
    [
      'a signature on the credit (it is unsigned)',
      (f) => ({ ...f, osig: 'A'.repeat(86), device_id: 'd_aaaaaaaaaaaaaaaaaaaa' }),
    ],
  ],
  'term.opened': [
    ...COMMON,
    set("tier 'shell'", 'tier', 'shell'),
    set("tier 'type'", 'tier', 'type'),
    set('zero columns', 'cols', 0),
    set('an idle time of zero', 'idle_s', 0),
    set('a max time that is not a number', 'max_s', 'forever'),
    without('max_s'),
  ],
  'term.key': [
    ...COMMON,
    ...BYTES,
    ['one byte over 128 KiB', (f) => ({ ...f, bytes_b64: bytesB64(TERM_KEY_MAX_BYTES + 1) })],
  ],
  'term.out': [
    ...COMMON,
    ...BYTES,
    ['one byte over 16 KiB', (f) => ({ ...f, bytes_b64: bytesB64(TERM_OUT_MAX_BYTES + 1) })],
    ['a 20 KiB body', (f) => ({ ...f, bytes_b64: bytesB64(20 * 1024) })],
  ],
  'term.closed': [
    ...COMMON,
    set('a reason that is not a word', 'why', 'Idle Timeout!'),
    set('an empty reason', 'why', ''),
    set('an enormous reason', 'why', 'x'.repeat(200)),
    without('why'),
  ],
}

describe('MUST_REJECT: every term.* frame refuses what it must', () => {
  for (const t of TERM_FRAME_TYPES) {
    it(`${t}: the control parses, then each fault is refused`, () => {
      const good = clone(fixtures[t])
      expect(parseFrame(good).ok, `${t} control`).toBe(true)
      expect(MUST_REJECT[t].length).toBeGreaterThanOrEqual(5)
      for (const [name, mutate] of MUST_REJECT[t]) {
        const r = parseFrame(mutate(clone(good)))
        expect(r.ok, `${t}: ${name}`).toBe(false)
      }
    })
  }

  it('a term.out cannot carry a keyframe size, and a term.key can carry a term.out one', () => {
    const big = { ...clone(fixtures['term.out']), bytes_b64: bytesB64(TERM_OUT_MAX_BYTES + 1) }
    expect(parseFrame(big).ok).toBe(false)
    expect(parseFrame({ ...clone(fixtures['term.key']), bytes_b64: bytesB64(TERM_OUT_MAX_BYTES + 1) }).ok).toBe(true)
  })

  it('target may be main or a thread id', () => {
    const open = clone(fixtures['term.open'])
    for (const target of ['main', 'release_notes', 'inbox'])
      expect(parseFrame({ ...open, target }).ok, target).toBe(true)
  })
})
