// Deny with a note (Wave 0, item 0.8): the owner's few words travel in the signed `note` of a `kill` card.resolve and reach
// the hook's deny answer. Every new field is optional: an older app, bridge or hook behaves exactly as before.
import { describe, expect, it } from 'vitest'
import {
  Card,
  CardResolveFrame,
  cleanDenyNote,
  composePermissionCard,
  HubHubLine,
  PERMISSION_DENY_NOTE_MAX,
  permissionCardAllowsPrimary,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()

const request = {
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'remove it',
  input_preview: '{"command":"rm -rf build"}',
}
const compose = (extra: { deny_note?: boolean } = {}) =>
  composePermissionCard({
    request,
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4B0',
    thread_id: 'general',
    now: 1_700_000_000_000,
    client_version: '2.1.312',
    ...extra,
  })

describe('cleanDenyNote', () => {
  it('passes plain words through unchanged', () => {
    expect(cleanDenyNote('use the staging bucket instead')).toBe('use the staging bucket instead')
  })
  it('folds every kind of line break and space into one space, and trims', () => {
    expect(cleanDenyNote('  use\n\tthe\r\nstaging bucket  instead  ')).toBe('use the staging bucket instead')
  })
  it('removes control, bidi and zero-width characters, and lone surrogates', () => {
    const junk = [0, 0x202e, 0x200b, 0x2060, 0xd800].map((c) => String.fromCharCode(c))
    expect(cleanDenyNote(`a${junk[0]}b${junk[1]}c${junk[2]}d${junk[3]}e${junk[4]}f`)).toBe('abcdef')
  })
  it('keeps quotes, backslashes, emoji and non-Latin text (the JSON builder escapes them)', () => {
    const s = `say "hi" ${String.fromCharCode(92)} \u{1F600} \u65e5\u672c\u8a9e`
    expect(cleanDenyNote(s)).toBe(s)
  })
  it('cuts at the cap by code point, never inside a surrogate pair', () => {
    const out = cleanDenyNote('😀'.repeat(PERMISSION_DENY_NOTE_MAX + 50)) as string
    expect([...out].length).toBe(PERMISSION_DENY_NOTE_MAX)
    expect(() => encodeURIComponent(out)).not.toThrow() // throws on a lone surrogate
  })
  it('gives nothing for empty, blank, invisible-only or non-string input', () => {
    expect(cleanDenyNote('')).toBeUndefined()
    expect(cleanDenyNote(' \n\t ')).toBeUndefined()
    expect(cleanDenyNote('​‮')).toBeUndefined()
    expect(cleanDenyNote(undefined)).toBeUndefined()
    expect(cleanDenyNote(42 as never)).toBeUndefined()
  })
  it('the cap is 300', () => {
    expect(PERMISSION_DENY_NOTE_MAX).toBe(300)
  })
})

describe('the deny_note card flag', () => {
  it('a card made without it is exactly the card as before', () => {
    const c = compose()
    expect('deny_note' in c).toBe(false)
    expect(Card.safeParse(c).success).toBe(true)
  })
  it('a card with it parses, keeps its hash and still allows Allow', () => {
    const plain = compose()
    const c = compose({ deny_note: true })
    expect(c.deny_note).toBe(true)
    expect(c.payload_hash).toBe(plain.payload_hash)
    expect(Card.safeParse(c).success).toBe(true)
    expect(permissionCardAllowsPrimary(c)).toBe(true)
  })
  it('a value a reader does not know reads as unset', () => {
    const r = Card.safeParse({ ...compose(), deny_note: 'yes' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.deny_note).toBeUndefined()
  })
})

describe('card.resolve and the hub answer', () => {
  const base = fixtures['card.resolve'] as Record<string, unknown>
  it('an old kill with no note still parses', () => {
    expect(CardResolveFrame.safeParse({ ...base, action: 'kill' }).success).toBe(true)
  })
  it('a kill with a note parses (the note was always allowed, up to 2000)', () => {
    expect(CardResolveFrame.safeParse({ ...base, action: 'kill', note: 'use the staging bucket' }).success).toBe(true)
  })
  it('perm_result: the old shape parses; a note is optional and capped', () => {
    const line = { t: 'perm_result', id: 'h_1', decision: 'deny', reason: 'owner' }
    expect(HubHubLine.safeParse(line).success).toBe(true)
    const withNote = HubHubLine.safeParse({ ...line, note: 'use staging' })
    expect(withNote.success).toBe(true)
    if (withNote.success) expect((withNote.data as { note?: string }).note).toBe('use staging')
    expect(HubHubLine.safeParse({ ...line, note: 'x'.repeat(401) }).success).toBe(false)
  })
})
