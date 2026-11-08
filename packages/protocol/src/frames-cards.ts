// The three card frames. Split out of frames.ts, which re-exports them.
import { z } from 'zod'
import { DIALOG_MAX_OPTIONS } from './dialog-files.ts'
import { frame, ownerFrame } from './frame-base.ts'
import { CardId, Sha256Ref } from './ids.ts'
import { Card } from './models.ts'
import { PermissionExplain } from './permission-explain.ts'
import { StepupAssertion } from './stepup.ts'

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
  stepup_token: z.string().max(200).optional(), // relay-checked, stripped before forwarding, not signed
  /** Raw WebAuthn assertion, verified by the BRIDGE (docs/CLAUDE-CODE.md C3.6). Signed; the relay never strips it. */
  stepup: StepupAssertion.optional(),
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
