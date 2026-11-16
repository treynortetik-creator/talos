// relay_expires_at: the relay's own expiry beside a card, outside its binding (bug hunt relay #12).
import { describe, expect, it } from 'vitest'
import { badgeCount, bindingFrom, Card, cardExpiryMs } from '../src/index.ts'

const base = Card.parse({
  id: 'c_01JBF3V7Q8K2M4N6P8R0S2T401',
  thread_id: 'general',
  kind: 'generic',
  title: 'T',
  destination: [],
  body_format: 'plain',
  primary_label: 'Yes',
  kill_label: 'No',
  risk: 'low',
  origin: 'chat',
  allow_edit: false,
  allow_revise: false,
  fields: [],
  attachments: [],
  payload: {},
  payload_hash: `sha256:${'0'.repeat(64)}`,
  state: 'pending',
  created_at: '2026-11-10T10:00:00.000Z',
  expires_at: '2026-11-10T10:10:00.000Z',
})

describe('relay_expires_at', () => {
  it('is kept by the schema, outside the binding, and read first by cardExpiryMs', () => {
    const c = Card.parse({ ...base, relay_expires_at: '2026-11-10T10:25:00.000Z' })
    expect(c.relay_expires_at).toBe('2026-11-10T10:25:00.000Z')
    expect(bindingFrom(c)).toEqual(bindingFrom(base))
    expect(cardExpiryMs(c)).toBe(Date.parse('2026-11-10T10:25:00.000Z'))
  })
  it('falls back to expires_at when absent or unreadable', () => {
    expect(cardExpiryMs(base)).toBe(Date.parse(base.expires_at))
    const junk = Card.parse({ ...base, relay_expires_at: 'soon' })
    expect(junk.relay_expires_at).toBeUndefined()
    expect(cardExpiryMs(junk)).toBe(Date.parse(base.expires_at))
  })

  it('the badge counts a card by the relay expiry too, so the icon agrees with Needs you', () => {
    const now = Date.parse('2026-11-10T10:15:00.000Z') // past expires_at, before relay_expires_at
    const slowMac = { ...base, relay_expires_at: '2026-11-10T10:25:00.000Z' }
    expect(badgeCount({ cards: [slowMac], unread: {}, threads: [] }, now)).toBe(1)
    expect(badgeCount({ cards: [base], unread: {}, threads: [] }, now)).toBe(0)
  })
})
