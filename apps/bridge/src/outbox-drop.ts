// An outbox row the bridge gave up on: the agent hears about it, because the app and the relay never will.
import { type BridgeContext, defaultThreadRef } from './context.ts'
import { systemNotification } from './notify.ts'
import type { DropReason } from './transport.ts'

/** An outbox row was given up on: the agent hears about it (the app and relay never will). */
export function tellAgentOfDrop(
  ctx: BridgeContext,
  row: { id: string; type: string; reason: DropReason; cardKind?: string },
) {
  const why =
    row.reason === 'expired'
      ? 'was undelivered for over 24 hours'
      : row.reason === 'refused'
        ? row.cardKind
          ? `was refused: the relay does not know the card kind "${row.cardKind}"`
          : 'was refused by the relay'
        : 'is too large for the relay'
  void ctx
    .emit(
      systemNotification({
        thread: defaultThreadRef(ctx),
        text: `A ${row.type} you sent never reached the relay and was dropped (${why}). ${
          row.cardKind ? 'Update the relay, then send it again if it matters.' : 'Send it again if it matters.'
        }`,
        ts: new Date(ctx.clock.now()).toISOString(),
        id: `outbox-drop-${row.id}`,
      }),
    )
    .catch(() => {})
}
