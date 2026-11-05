// Shared card logic (spec 4.5, 8.4). The app (WP7) computes `edited_hash`; the bridge (WP5) re-checks it. Both must
// call these functions, because two hand-written versions disagree on field matching, order and body handling.
import { z } from 'zod'
import { jcs, payloadHash } from './canonical.ts'
import { type CardBinding, type CardT, isBodyEditable } from './models.ts'

/** The `edited` object of `card.resolve`. */
export const CardEdits = z.strictObject({
  fields: z.array(z.strictObject({ key: z.string().max(40), value: z.string().max(20_000) })),
  body: z.string().max(20_000).optional(),
})
export type CardEditsT = z.infer<typeof CardEdits>

/**
 * The binding with the owner's edits applied. Fields are matched by `key`, keep their original order and every other
 * property; `body` is replaced only when `edited.body` is present (an absent body means "unchanged"). Keys that match no
 * field are ignored here and rejected by `checkEditAllowed`.
 */
export function applyCardEdits(binding: CardBinding, edited: CardEditsT): CardBinding {
  const byKey = new Map(edited.fields.map((f) => [f.key, f.value]))
  const next: CardBinding = {
    ...binding,
    fields: binding.fields.map((f) => (byKey.has(f.key) ? { ...f, value: byKey.get(f.key) as string } : { ...f })),
  }
  if (edited.body !== undefined) next.body = edited.body
  return next
}

/** `edited_hash` = `payloadHash(applyCardEdits(binding, edited))`. */
export function editedHash(binding: CardBinding, edited: CardEditsT): string {
  return payloadHash(applyCardEdits(binding, edited))
}

export type EditCheck = { ok: true } | { ok: false; code: 'card_edit_forbidden'; reason: string }

/**
 * Rejects edits the card does not allow: an empty edit, a duplicate or unknown field key, a non-editable field, or a body
 * edit when the body is not editable. `allow_edit` comes from the binding, so the hash covers it.
 */
export function checkEditAllowed(binding: CardBinding, edited: CardEditsT): EditCheck {
  const forbid = (reason: string): EditCheck => ({ ok: false, code: 'card_edit_forbidden', reason })
  if (!binding.allow_edit) return forbid('card does not allow edits')
  if (edited.fields.length === 0 && edited.body === undefined) return forbid('empty edit')
  const fields = new Map(binding.fields.map((f) => [f.key, f]))
  const seen = new Set<string>()
  for (const e of edited.fields) {
    if (seen.has(e.key)) return forbid(`duplicate field ${e.key}`)
    seen.add(e.key)
    const f = fields.get(e.key)
    if (!f) return forbid(`unknown field ${e.key}`)
    if (!f.editable) return forbid(`field ${e.key} is not editable`)
  }
  if (edited.body !== undefined && !isBodyEditable(binding)) {
    return forbid('body is not editable for this card kind')
  }
  return { ok: true }
}

export const MAX_CARD_PAYLOAD_BYTES = 64 * 1024

/**
 * Card rules the schema cannot express: at least one destination unless the kind is `decision` or `generic`, and the
 * opaque payload at most 64 KiB after JCS. Returns issue codes; empty means valid.
 */
export function validateCard(
  card: Pick<CardT, 'kind' | 'destination' | 'payload' | 'created_at' | 'expires_at'>,
): string[] {
  const issues: string[] = []
  // permission cards name no destination: the bound tool call is the whole card (docs/CLAUDE-CODE.md C3.2)
  if (
    card.destination.length === 0 &&
    card.kind !== 'decision' &&
    card.kind !== 'generic' &&
    card.kind !== 'permission'
  )
    issues.push('destination_required')
  if (card.payload !== undefined && new TextEncoder().encode(jcs(card.payload)).length > MAX_CARD_PAYLOAD_BYTES) {
    issues.push('payload_too_large')
  }
  if (Date.parse(card.expires_at) <= Date.parse(card.created_at)) issues.push('expires_before_created')
  return issues
}
