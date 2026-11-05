import { describe, expect, it } from 'vitest'
import {
  applyCardEdits,
  bindingFrom,
  Card,
  type CardBinding,
  checkEditAllowed,
  editedHash,
  MAX_CARD_PAYLOAD_BYTES,
  payloadHash,
  validateCard,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const base = Card.parse((loadFixtures()['card.create'] as { card: unknown }).card)
const emailCard = Card.parse({
  ...base,
  kind: 'email',
  fields: [
    { key: 'to', label: 'To', value: 'a@example.com', editable: true },
    { key: 'cc', label: 'Cc', value: '', editable: true },
    { key: 'subject', label: 'Subject', value: 'Hello', editable: false },
  ],
})
const binding = bindingFrom(emailCard)

describe('applyCardEdits / editedHash (vectors)', () => {
  it('replaces fields by key, keeps order and flags, leaves others untouched', () => {
    const next = applyCardEdits(binding, { fields: [{ key: 'cc', value: 'b@example.com' }] })
    expect(next.fields.map((f) => [f.key, f.value])).toEqual([
      ['to', 'a@example.com'],
      ['cc', 'b@example.com'],
      ['subject', 'Hello'],
    ])
    expect(next.fields[1]?.editable).toBe(true)
    expect(next.body).toBe(binding.body)
  })
  it('replaces the body only when it is present', () => {
    expect(applyCardEdits(binding, { fields: [{ key: 'to', value: 'x@example.com' }] }).body).toBe(binding.body)
    expect(applyCardEdits(binding, { fields: [], body: '' }).body).toBe('')
  })
  it('does not mutate the binding', () => {
    const copy = structuredClone(binding)
    applyCardEdits(binding, { fields: [{ key: 'to', value: 'x@example.com' }], body: 'new' })
    expect(binding).toEqual(copy)
  })
  it('editedHash is independent of the order of the edited list and equals payloadHash of the result', () => {
    const a = editedHash(binding, {
      fields: [
        { key: 'to', value: 'x@example.com' },
        { key: 'cc', value: 'y@example.com' },
      ],
    })
    const b = editedHash(binding, {
      fields: [
        { key: 'cc', value: 'y@example.com' },
        { key: 'to', value: 'x@example.com' },
      ],
    })
    expect(a).toBe(b)
    expect(a).toBe(
      payloadHash(
        applyCardEdits(binding, {
          fields: [
            { key: 'to', value: 'x@example.com' },
            { key: 'cc', value: 'y@example.com' },
          ],
        }),
      ),
    )
    expect(a).not.toBe(payloadHash(binding))
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  it('an edit that changes nothing hashes like the original (the bridge compares with the ledger)', () => {
    expect(editedHash(binding, { fields: [{ key: 'to', value: 'a@example.com' }] })).toBe(payloadHash(binding))
  })
})

describe('checkEditAllowed', () => {
  it('accepts editable fields and an editable body', () => {
    expect(checkEditAllowed(binding, { fields: [{ key: 'to', value: 'z' }], body: 'b' })).toEqual({ ok: true })
  })
  it.each([
    ['a non-editable field', { fields: [{ key: 'subject', value: 'x' }] }],
    ['an unknown field', { fields: [{ key: 'nope', value: 'x' }] }],
    [
      'a duplicate field',
      {
        fields: [
          { key: 'to', value: 'x' },
          { key: 'to', value: 'y' },
        ],
      },
    ],
    ['an empty edit', { fields: [] }],
  ])('forbids %s', (_n, edited) => {
    expect(checkEditAllowed(binding, edited)).toMatchObject({ ok: false, code: 'card_edit_forbidden' })
  })
  it('forbids everything when allow_edit is false', () => {
    expect(checkEditAllowed({ ...binding, allow_edit: false }, { fields: [{ key: 'to', value: 'x' }] })).toMatchObject({
      ok: false,
    })
  })
  it('forbids a body edit for kinds other than email, message and publish', () => {
    const deploy: CardBinding = { ...binding, kind: 'deploy' }
    expect(checkEditAllowed(deploy, { fields: [], body: 'x' })).toMatchObject({
      ok: false,
      code: 'card_edit_forbidden',
    })
    for (const kind of ['email', 'message', 'publish'] as const) {
      expect(checkEditAllowed({ ...binding, kind }, { fields: [], body: 'x' })).toEqual({ ok: true })
    }
  })
})

describe('allow_edit lives in the binding', () => {
  it('flipping it changes the hash and turns every edit into card_edit_forbidden', () => {
    const off = { ...binding, allow_edit: false }
    expect(payloadHash(off)).not.toBe(payloadHash(binding))
    expect(checkEditAllowed(off, { fields: [{ key: 'to', value: 'x' }] })).toMatchObject({
      ok: false,
      code: 'card_edit_forbidden',
    })
  })
})

describe('validateCard', () => {
  it('requires a destination except for decision and generic', () => {
    expect(validateCard({ ...base, destination: [] })).toContain('destination_required')
    expect(validateCard({ ...base, kind: 'decision', destination: [] })).toEqual([])
    expect(validateCard({ ...base, kind: 'generic', destination: [] })).toEqual([])
    expect(validateCard(base)).toEqual([])
  })
  it('caps the payload at 64 KiB after JCS', () => {
    const small = { x: 'a'.repeat(1000) }
    const big = { x: 'a'.repeat(MAX_CARD_PAYLOAD_BYTES) }
    expect(validateCard({ ...base, payload: small })).toEqual([])
    expect(validateCard({ ...base, payload: big })).toContain('payload_too_large')
  })
  it('rejects a card that expires before it was created', () => {
    expect(validateCard({ ...base, expires_at: base.created_at })).toContain('expires_before_created')
  })
})
