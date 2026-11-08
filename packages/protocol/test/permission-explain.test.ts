// The plain explanation on a permission card: its wire shape, the chip text, and the promise that it can never change what the
// owner approves (it is outside the binding and outside permissionCardAllowsPrimary) or break an older reader.
import { describe, expect, it } from 'vitest'
import {
  bindingFrom,
  Card,
  CardUpdateFrame,
  composePermissionCard,
  EXPLAIN_FAILED_TEXT,
  EXPLAIN_GIVE_UP_MS,
  EXPLAIN_TAGS,
  explainChip,
  explainShown,
  moreSevereTag,
  PermissionExplain,
  payloadHash,
  permissionCardAllowsPrimary,
} from '../src/index.ts'

const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const compose = (explain?: boolean) =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run the tests',
      input_preview: '{"command": "pnpm test"}',
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
    thread_id: 'general',
    now: NOW,
    client_version: '2.1.312',
    ...(explain ? { explain: true } : {}),
  })

describe('the explanation shape', () => {
  it('has exactly the five tags, least to most severe', () => {
    expect([...EXPLAIN_TAGS]).toEqual([
      'Reads files',
      'Changes files',
      'Sends over the internet',
      'Installs',
      'Deletes',
    ])
    expect(moreSevereTag('Reads files', 'Deletes')).toBe('Deletes')
    expect(moreSevereTag('Installs', 'Sends over the internet')).toBe('Installs')
    expect(moreSevereTag('Changes files', 'Changes files')).toBe('Changes files')
  })

  it('accepts pending, ready and failed; refuses an unknown tag, extra fields on a ready one and an empty sentence', () => {
    expect(PermissionExplain.safeParse({ status: 'pending' }).success).toBe(true)
    expect(PermissionExplain.safeParse({ status: 'failed' }).success).toBe(true)
    const ready = { status: 'ready', tag: 'Deletes', mismatch: true, sentence: 'It deletes things.' }
    expect(PermissionExplain.safeParse(ready).success).toBe(true)
    expect(PermissionExplain.safeParse({ ...ready, tag: 'Safe' }).success).toBe(false)
    expect(PermissionExplain.safeParse({ ...ready, sentence: '' }).success).toBe(false)
    expect(PermissionExplain.safeParse({ ...ready, sentence: 'a'.repeat(701) }).success).toBe(false)
  })

  it('the chip is the tag, or the tag and "Doesn\'t match"', () => {
    expect(explainChip({ tag: 'Changes files', mismatch: false })).toBe('Changes files')
    expect(explainChip({ tag: 'Deletes', mismatch: true })).toBe("Deletes · Doesn't match")
  })

  it('what a card shows: waiting until the give-up time, then the failed text; a ready one always', () => {
    const created = new Date(NOW).toISOString()
    expect(explainShown({ status: 'pending' }, created, NOW + 1000)).toEqual({ kind: 'waiting' })
    expect(explainShown({ status: 'pending' }, created, NOW + EXPLAIN_GIVE_UP_MS)).toEqual({ kind: 'failed' })
    expect(explainShown({ status: 'failed' }, created, NOW)).toEqual({ kind: 'failed' })
    const ready = { status: 'ready', tag: 'Reads files', mismatch: false, sentence: 'Lists.' } as const
    expect(explainShown(ready, created, NOW + 10 * EXPLAIN_GIVE_UP_MS)).toEqual({ kind: 'ready', explain: ready })
    expect(explainShown(undefined, created, NOW)).toEqual({ kind: 'none' })
    expect(EXPLAIN_FAILED_TEXT).toBe("Couldn't explain this one")
  })
})

describe('on the card', () => {
  it('a card composed with explain starts pending; without it there is no field at all', () => {
    expect(compose(true).explain).toEqual({ status: 'pending' })
    expect('explain' in compose(false)).toBe(false)
  })

  it('the explanation is outside the binding: the hash and Allow are the same with or without it', () => {
    const plain = compose(false)
    const withIt = compose(true)
    expect(withIt.payload_hash).toBe(plain.payload_hash)
    expect(payloadHash(bindingFrom(withIt))).toBe(withIt.payload_hash)
    expect(permissionCardAllowsPrimary(withIt)).toBe(true)
    const ready = { ...withIt, explain: { status: 'ready', tag: 'Deletes', mismatch: true, sentence: 'x' } as const }
    expect(permissionCardAllowsPrimary(ready)).toBe(true)
    expect(payloadHash(bindingFrom(ready))).toBe(plain.payload_hash)
  })

  it('a card with a malformed explain still parses; the field is just dropped', () => {
    const c = JSON.parse(JSON.stringify(compose(true)))
    c.explain = { status: 'ready', tag: 'Weird' }
    const parsed = Card.parse(c)
    expect(parsed.explain).toBeUndefined()
    expect(parsed.id).toBe(c.id)
  })

  it('a card.update may carry the explanation; one without it parses as before', () => {
    const base = {
      v: 1,
      id: '01JBF3V7Q8K2M4N6P8R0S2T4E1',
      ts: '2026-11-07T12:00:00.000Z',
      type: 'card.update',
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
      state: 'pending',
    }
    expect(CardUpdateFrame.safeParse(base).success).toBe(true)
    const withIt = CardUpdateFrame.parse({ ...base, explain: { status: 'failed' } })
    expect(withIt.explain).toEqual({ status: 'failed' })
    // a frame an older reader (no explain field in its schema) gets: the object parser drops the unknown key and nothing else changes
    const old = CardUpdateFrame.omit({ explain: true }).parse({ ...base, explain: { status: 'failed' } })
    expect(old).toEqual(CardUpdateFrame.omit({ explain: true }).parse(base))
  })
})
