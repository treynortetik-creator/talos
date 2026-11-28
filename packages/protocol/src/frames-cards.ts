// The three card frames. Split out of frames.ts, which re-exports them.
import { z } from 'zod'
import { DIALOG_MAX_OPTIONS } from './dialog-files.ts'
import { frame, ownerFrame } from './frame-base.ts'
import { CardId, Sha256Ref } from './ids.ts'
import { Card } from './models.ts'
import { PermissionExplain } from './permission-explain.ts'

export const CardCreateFrame = frame('card.create', { card: Card })

export const CardResolveFrame = ownerFrame('card.resolve', {
  card_id: CardId,
  action: z.enum(['primary', 'kill', 'revise']),
  payload_hash: Sha256Ref, // recomputed by the app from what it rendered (8.4)
  edited: z
    .strictObject({
      fields: z.array(z.strictObject({ key: z.string().max(40), value: z.string().max(20_000) })),
      body: z.string().max(20_000).optional(),
    })
    .optional(),
  edited_hash: Sha256Ref.optional(),
  note: z.string().max(2000).optional(), // revise text
  /**
   * Which button of a `dialog` card the owner pressed: its index in the card's `options`, in screen order. Signed with the
   * rest of the frame. Only a dialog card with options takes one; every other card, and a login dialog (one "Open on the
   * Mac" button, no options), is answered without it. Absent from every frame an older app sends.
   */
  choice: z
    .number()
    .int()
    .min(0)
    .max(DIALOG_MAX_OPTIONS - 1)
    .optional(),
  /**
   * The owner's own words for a dialog card's free-text option (the agent's question, `Other…`): one line, signed with the rest of the frame, so the
   * Mac types exactly what the owner wrote and nothing a program edited in. Only with a `choice` that is that card's `free_text` index.
   */
  text: z.string().min(1).max(120).optional(),
  /**
   * "Always allow <kind>": with action 'primary' on a card that offers it (cardOffersAlways), the owner also allows that kind from now on
   * (owner ruling 2026-11-14). Signed with the rest of the frame, so only the owner's own tap carries it; the bridge adds the
   * kind to `always_allow` only after it verifies that signature for this card. Ignored on any other action or kind.
   */
  always: z.literal(true).optional(),
  /**
   * "Allow for this session": with action 'primary' on a permission card the hook raised that offers it (`session_allow`), the owner
   * also lets the same kind of call through for the rest of that Claude Code session. Signed with the rest of the frame, so only the
   * owner's own tap carries it. Ignored on any other action or card. Absent from every frame an older app sends.
   */
  session: z.literal(true).optional(),
  /**
   * With `session: true`: the sha256 of the canonical {tool, content} list the app showed on the button (permission.ts `sessionRulesHash`),
   * signed with the rest of the frame. The bridge and the hook compare it with the rules they hold; a mismatch, or none (an older app),
   * is a plain allow. So a relay cannot have the phone show one rule and the owner sign another.
   */
  session_hash: Sha256Ref.optional(),
  stepup_token: z.string().max(200).optional(), // old apps only (the passkey step-up, removed 2026-11-14): stripped, never read
  stepup: z.unknown().optional(), // old apps only (the passkey step-up, removed 2026-11-14): accepted, never read
})

export const CardUpdateFrame = frame('card.update', {
  card_id: CardId,
  state: Card.shape.state,
  resolution: Card.shape.resolution,
  result: Card.shape.result,
  reason: z.string().max(80).optional(), // expired, mac_offline_too_long, hash_mismatch, ...
  /** A permission card's explanation (permission-explain.ts); the update leaves the card's state alone. Older readers ignore it. */
  explain: PermissionExplain.optional().catch(undefined),
})
