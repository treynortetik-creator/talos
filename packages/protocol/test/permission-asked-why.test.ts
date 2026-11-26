// Why a permission card asked (Wave 0, item 0.9). Only one reason can be proved today: the call matches an ask rule in the
// this agent's settings (`your_rule`). Claude Code does not say when its own safety check asked, so there is no such value:
// the field is optional, sits outside the binding, and anything a reader does not know reads as unset (no line on the card).
import { describe, expect, it } from 'vitest'
import { Card, composePermissionCard, PERMISSION_ASKED_WHY_TEXT, permissionCardAllowsPrimary } from '../src/index.ts'

const compose = (extra: { asked_why?: 'your_rule' } = {}) =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'push it',
      input_preview: '{"command":"git push origin main"}',
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4B0',
    thread_id: 'general',
    now: 1_700_000_000_000,
    client_version: '2.1.312',
    ...extra,
  })

describe('asked_why on a permission card', () => {
  it('a card made without it is exactly the card as before', () => {
    const c = compose()
    expect('asked_why' in c).toBe(false)
    expect(Card.safeParse(c).success).toBe(true)
  })
  it('your_rule: parses, keeps the hash, keeps Allow', () => {
    const plain = compose()
    const c = compose({ asked_why: 'your_rule' })
    expect(c.asked_why).toBe('your_rule')
    expect(c.payload_hash).toBe(plain.payload_hash)
    expect(Card.safeParse(c).success).toBe(true)
    expect(permissionCardAllowsPrimary(c)).toBe(true)
  })
  it('a value this reader does not know (a later release, or a wrong one) reads as unset', () => {
    for (const v of ['safety_check', 'YOUR_RULE', '', 7, null, true, { a: 1 }]) {
      const r = Card.safeParse({ ...compose(), asked_why: v })
      expect(r.success, String(v)).toBe(true)
      if (r.success) expect(r.data.asked_why).toBeUndefined()
    }
  })
  it('the words: one plain line for the one proved reason, and nothing for any other', () => {
    expect(PERMISSION_ASKED_WHY_TEXT.your_rule).toBe("Asked because of an ask rule in this agent's settings.")
    expect(Object.keys(PERMISSION_ASKED_WHY_TEXT)).toEqual(['your_rule'])
  })
})
