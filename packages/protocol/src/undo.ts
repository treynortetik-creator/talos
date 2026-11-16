// "Undo to here" (apps/bridge/src/undo): put a folder back the way it was before an owner message's turn.
import { z } from 'zod'
import { WireErrorCode } from './errors.ts'
import { frame, ownerFrame } from './frame-base.ts'
import { CardId, IsoTs, MsgId, ThreadId, Ulid } from './ids.ts'

/**
 * The relay and the app know the undo card (kind 'undo') and the undo frames. Only the relay advertises it (the bridge's
 * hello is at its 20-feature cap): the bridge cards nothing, and puts no `undo` on a receipt or a history row, without it.
 * The app learns the bridge can undo from a message's `undo` state, which only such a bridge sets.
 */
export const UNDO_FEATURE = 'undo/1'

/** An owner message's undo point: saved, too large to save, or not saved. */
export const UndoPointState = z.enum(['ready', 'not_saved', 'too_large'])
export type UndoPointStateT = z.infer<typeof UndoPointState>
/**
 * A message's undo point as the app sees it (on the message, and on its `delivered` receipt). An unreadable value (a newer
 * state) reads as absent: the row stays, without the action.
 */
export const UndoMark = z.object({ state: UndoPointState }).optional().catch(undefined)

/**
 * "Undo to here" from the phone: the bridge answers with an undo card for this owner message, or says why not, in an
 * `undo.request.result` under the same `control_id`. Signed and strict, like every owner frame. Nothing is restored
 * until the owner approves the card.
 */
export const UndoRequestFrame = ownerFrame('undo.request', {
  control_id: Ulid,
  thread_id: ThreadId,
  message_id: MsgId,
})
export const UndoRequestResultFrame = frame('undo.request.result', {
  control_id: Ulid,
  ok: z.boolean(),
  code: WireErrorCode.optional(),
  text: z.string().max(4000), // plain: why not, or empty
  card_id: CardId.optional(), // the undo card the bridge made
  at: IsoTs,
})
export const UNDO_OWNER_FRAME_TYPES = ['undo.request'] as const
export const UNDO_BRIDGE_FRAME_TYPES = ['undo.request.result'] as const

/** What an undo card binds: the message and the exact point it restores (a commit or a copy folder). */
export const UndoCardPayload = z.strictObject({
  v: z.literal(1),
  message_id: MsgId,
  kind: z.enum(['git', 'copy']),
  root: z.string().max(4096),
  commit_id: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  path: z.string().max(4096).optional(),
  /** When the point was taken: a point taken again (the same copy folder) is not the one the card showed. */
  created_at: z.number().int().nonnegative(),
})
export type UndoCardPayloadT = z.infer<typeof UndoCardPayload>
