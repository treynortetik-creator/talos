import { describe, expect, it } from 'vitest'
import {
  AppToRelay,
  BridgeToRelay,
  CONSUMABLE_FRAME_TYPES,
  DIRECTION_TYPES,
  type Direction,
  DURABLE_FRAME_TYPES,
  FRAME_TYPES,
  isFrameFor,
  OWNER_FRAME_TYPES,
  parseFrame,
  parseFrameText,
  RelayToApp,
  RelayToBridge,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const ID_PATTERNS: Record<string, RegExp> = {
  m_: /^m_[0-9A-HJKMNP-TV-Z]{26}$/,
  c_: /^c_[0-9A-HJKMNP-TV-Z]{26}$/,
  e_: /^e_[0-9A-HJKMNP-TV-Z]{26}$/,
  md_: /^md_[0-9A-HJKMNP-TV-Z]{26}$/,
  d_: /^d_[a-z2-7]{20}$/,
  cn_: /^cn_[0-9A-Za-z]{22}$/,
}

function walk(v: unknown, visit: (key: string, value: unknown) => void) {
  if (Array.isArray(v)) for (const x of v) walk(x, visit)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x)
      walk(x, visit)
    }
  }
}

describe('fixtures', () => {
  it('has a fixture for every frame type (hello has two)', () => {
    const covered = new Set(
      Object.keys(fixtures).map((n) => n.split('.hello')[0] && (n.startsWith('hello.') ? 'hello' : n)),
    )
    for (const t of FRAME_TYPES) expect(covered.has(t), `missing fixture for ${t}`).toBe(true)
    expect(fixtures['hello.app']).toBeDefined()
    expect(fixtures['hello.bridge']).toBeDefined()
  })

  for (const [name, frame] of Object.entries(fixtures)) {
    it(`${name} parses`, () => {
      const res = parseFrame(frame)
      expect(res.ok, JSON.stringify(res)).toBe(true)
    })

    it(`${name}: every id matches its regex`, () => {
      expect(frame.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      walk(frame, (key, value) => {
        if (typeof value !== 'string') return
        if (key === 'device_id') expect(value).toMatch(ID_PATTERNS['d_'] as RegExp)
        if (key === 'client_msg_id' || key === 'message_id') expect(value).toMatch(ID_PATTERNS['m_'] as RegExp)
        if (key === 'card_id') expect(value).toMatch(ID_PATTERNS['c_'] as RegExp)
        if (key === 'event_id') expect(value).toMatch(ID_PATTERNS['e_'] as RegExp)
        if (key === 'media_id') expect(value).toMatch(ID_PATTERNS['md_'] as RegExp)
        if (key === 'connection') expect(value).toMatch(ID_PATTERNS['cn_'] as RegExp)
        if (key === 'id' && /^(m|c|e|md|d|cn)_/.test(value)) {
          const prefix = `${value.split('_')[0]}_`
          expect(value).toMatch(ID_PATTERNS[prefix] as RegExp)
        }
      })
    })
  }

  it('owner frames round-trip through parseFrame unchanged (no defaults rewrite them)', () => {
    for (const t of OWNER_FRAME_TYPES) {
      const raw = fixtures[t] as Record<string, unknown>
      const res = parseFrame(raw)
      expect(res.ok).toBe(true)
      if (res.ok) expect(JSON.parse(JSON.stringify(res.frame))).toEqual(raw)
    }
  })

  it('owner frames reject unknown fields (strict)', () => {
    for (const t of OWNER_FRAME_TYPES) {
      const res = parseFrame({ ...(fixtures[t] as object), sneaky: 1 })
      expect(res.ok).toBe(false)
    }
  })

  it('owner frames reject a DER-length or missing osig', () => {
    const f = fixtures.message as Record<string, unknown>
    expect(parseFrame({ ...f, osig: `MEUCIQ${'A'.repeat(90)}` }).ok).toBe(false)
    const { osig: _o, ...noSig } = f
    expect(parseFrame(noSig).ok).toBe(false)
  })

  it('owner frame attachments need an explicit role (no defaults inside signed frames)', () => {
    const f = structuredClone(fixtures.voice_note) as { attachment: Record<string, unknown> }
    f.attachment.role = undefined
    delete f.attachment.role
    expect(parseFrame(f).ok).toBe(false)
  })

  it('allows the relay to add a top-level relay object to an owner frame', () => {
    const f = { ...fixtures.message, relay: { seq: 4182, received_at: '2026-10-28T15:32:10.311Z' } }
    expect(parseFrame(f).ok).toBe(true)
  })
})

describe('parseFrame', () => {
  it('turns an unknown type into bad_frame instead of throwing', () => {
    expect(parseFrame({ v: 1, type: 'nope', id: 'x', ts: 'y' })).toMatchObject({ ok: false, code: 'bad_frame' })
    expect(parseFrame({ v: 1, type: '__proto__' })).toMatchObject({ ok: false, code: 'bad_frame' })
    expect(parseFrame({ v: 1, type: 'toString' })).toMatchObject({ ok: false, code: 'bad_frame' })
  })
  it.each([null, 5, 'x', [], undefined])('rejects non-object %s', (v) => {
    expect(parseFrame(v)).toMatchObject({ ok: false, code: 'bad_frame' })
  })
  it('rejects a wrong protocol version', () => {
    expect(parseFrame({ ...fixtures.ping, v: 2 }).ok).toBe(false)
  })
  it('enforces direction when asked', () => {
    expect(parseFrame(fixtures['hook.event'], { direction: 'relay_to_bridge' }).ok).toBe(true)
    expect(parseFrame(fixtures['hook.event'], { direction: 'app_to_relay' })).toMatchObject({ ok: false })
  })
  it('parseFrameText enforces size limits and JSON validity', () => {
    expect(parseFrameText('{not json', { authenticated: true })).toMatchObject({ ok: false, code: 'bad_frame' })
    const big = JSON.stringify({ ...fixtures.ping, nonce: 'x'.repeat(70 * 1024) })
    expect(parseFrameText(big, { authenticated: false })).toMatchObject({ ok: false, code: 'too_large' })
    expect(parseFrameText(JSON.stringify(fixtures.ping), { authenticated: false }).ok).toBe(true)
  })
})

describe('direction unions', () => {
  const unions: Record<Direction, { safeParse: (v: unknown) => { success: boolean } }> = {
    app_to_relay: AppToRelay,
    relay_to_app: RelayToApp,
    bridge_to_relay: BridgeToRelay,
    relay_to_bridge: RelayToBridge,
  }
  for (const [dir, types] of Object.entries(DIRECTION_TYPES) as Array<[Direction, readonly string[]]>) {
    it(`${dir}: every listed type has a fixture the union accepts`, () => {
      for (const t of types) {
        const name = t === 'hello' ? (dir === 'app_to_relay' ? 'hello.app' : 'hello.bridge') : t
        const fx = fixtures[name]
        expect(fx, `fixture ${name}`).toBeDefined()
        expect(unions[dir].safeParse(fx).success, `${dir} accepts ${name}`).toBe(true)
        expect(isFrameFor(dir, { type: t })).toBe(true)
      }
    })
  }
  it('every frame type is routed somewhere', () => {
    const routed = new Set(Object.values(DIRECTION_TYPES).flat())
    for (const t of FRAME_TYPES) expect(routed.has(t), t).toBe(true)
  })
  it('durable and consumable sets only name real frame types', () => {
    for (const t of [...DURABLE_FRAME_TYPES, ...CONSUMABLE_FRAME_TYPES]) expect(FRAME_TYPES).toContain(t)
    for (const t of CONSUMABLE_FRAME_TYPES) expect(DIRECTION_TYPES.relay_to_bridge).toContain(t)
  })
})

describe('two-stage ack (delivered / consumed)', () => {
  it('ack accepts stage delivered, consumed or none', () => {
    const base = fixtures.ack as Record<string, unknown>
    expect(parseFrame({ ...base, stage: 'delivered' }).ok).toBe(true)
    expect(parseFrame({ ...base, stage: 'consumed' }).ok).toBe(true)
    const { stage: _s, ...noStage } = base
    expect(parseFrame(noStage).ok).toBe(true)
    expect(parseFrame({ ...base, stage: 'read' }).ok).toBe(false)
  })
  it('bridge may send ack and replay.request; apps may not', () => {
    expect(isFrameFor('bridge_to_relay', { type: 'ack' })).toBe(true)
    expect(isFrameFor('bridge_to_relay', { type: 'replay.request' })).toBe(true)
    expect(isFrameFor('app_to_relay', { type: 'replay.request' })).toBe(false)
  })
  it('replay.request needs 1..200 ulids', () => {
    const base = fixtures['replay.request'] as Record<string, unknown>
    expect(parseFrame({ ...base, ids: [] }).ok).toBe(false)
    expect(parseFrame({ ...base, ids: Array.from({ length: 201 }, () => (base.ids as string[])[0]) }).ok).toBe(false)
    expect(parseFrame({ ...base, ids: ['not-a-ulid'] }).ok).toBe(false)
  })
})

describe('original_ts on a re-signed owner frame', () => {
  it('message and voice_note accept the time the words were first written, and still refuse other unknown fields', () => {
    for (const type of ['message', 'voice_note']) {
      const base = fixtures[type] as Record<string, unknown>
      expect(parseFrame({ ...base, original_ts: '2026-10-20T09:00:00.000Z' }).ok, type).toBe(true)
      expect(parseFrame({ ...base, original_ts: 'last week' }).ok, type).toBe(false)
      expect(parseFrame({ ...base, surprise: 1 }).ok, type).toBe(false)
    }
  })
})
