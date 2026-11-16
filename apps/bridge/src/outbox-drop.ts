// An outbox row the bridge gave up on: the relay refused it for good, it is too large to send, or (never a reply or a
// card) it waited out the retention window. Nothing else will ever say so, so this does: the agent is told, in the thread
// the frame was for, which reply or card it was; and for a reply or a card the owner gets a line in that thread too.
import { type BridgeContext, defaultThreadRef, postSystemNotice, threadRef } from './context.ts'
import { systemNotification } from './notify.ts'
import type { DropReason } from './transport.ts'

type Dropped = {
  id: string
  type: string
  json?: string
  reason: DropReason
  cardKind?: string
  ageMs?: number
  attempts?: number
}

const EXCERPT_CHARS = 160
const excerpt = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > EXCERPT_CHARS ? `${one.slice(0, EXCERPT_CHARS)}…` : one
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** What the dropped frame was, read from the frame itself and the Mac's own records. Never throws: a row may be damaged. */
function describe(
  ctx: BridgeContext,
  row: Dropped,
): { thread?: string; agent?: string; owner?: string; replyId?: string } {
  let f: Record<string, unknown>
  try {
    f = JSON.parse(row.json ?? '') as Record<string, unknown>
  } catch {
    return {}
  }
  if (row.type === 'reply') {
    const m = (f.message ?? {}) as Record<string, unknown>
    const id = str(m.id)
    const said = excerpt(str(m.text) ?? '')
    return {
      ...(str(m.thread_id) ? { thread: str(m.thread_id) as string } : {}),
      ...(id ? { replyId: id } : {}),
      agent: `It was ${id ? `message ${id}` : 'a reply'}${said ? `: "${said}"` : ''}. The owner never saw it and it is no longer in the history.`,
      // A dropped notice of the bridge's own gets no notice in turn: against a relay that refuses every reply, each
      // one would raise the next.
      ...(m.author === 'system'
        ? {}
        : { owner: `A reply from your agent could not be delivered${said ? `: "${said}"` : '.'}` }),
    }
  }
  if (row.type === 'card.create' || row.type === 'card.update') {
    const card = (f.card ?? {}) as Record<string, unknown>
    const id = str(f.card_id) ?? str(card.id)
    if (!id) return {}
    // the card's own row in the history carries its title; the ledger knows its thread
    const title = str(card.title) ?? ctx.store.getMessage(`m_${id.slice(2)}`)?.text?.split('\n')[0]
    const thread = str(card.thread_id) ?? ctx.ledger.get(id)?.thread_id
    const named = `card ${id}${title ? ` ("${excerpt(title)}")` : ''}`
    return {
      ...(thread ? { thread } : {}),
      agent:
        row.type === 'card.create'
          ? `It was ${named}. The owner never saw the card.`
          : `It was an update to ${named}${str(f.state) ? `, to state "${str(f.state)}"` : ''}. The app may still show the card as it was before.`,
      owner:
        row.type === 'card.create'
          ? `A card from your agent could not be delivered${title ? `: "${excerpt(title)}"` : '.'}`
          : `An update to ${title ? `the card "${excerpt(title)}"` : 'a card'} could not be delivered, so the card here may show an old state.`,
    }
  }
  return {}
}

/** An outbox row was given up on: the agent hears about it (the app and relay never will), and where it matters the owner. */
export function tellAgentOfDrop(ctx: BridgeContext, row: Dropped) {
  const why =
    row.reason === 'expired'
      ? `was undelivered for ${Math.max(1, Math.floor((row.ageMs ?? 0) / (24 * 3_600_000)))} days${row.attempts ? `, offered to the relay ${row.attempts} times` : ''}`
      : row.reason === 'refused'
        ? row.cardKind
          ? `was refused: the relay does not know the card kind "${row.cardKind}"`
          : 'was refused by the relay'
        : row.reason === 'unreadable'
          ? 'could not be read back from the queue'
          : 'is too large for the relay'
  const what = describe(ctx, row)
  // only a thread that still exists: a notice for a removed one would itself be refused
  const thread = what.thread && ctx.config.thread(what.thread) ? threadRef(ctx, what.thread) : defaultThreadRef(ctx)
  // A reply nothing will deliver must not stay in the Mac's history, where read_thread would treat it as said.
  if (what.replyId) {
    try {
      ctx.store.deleteMessage(what.replyId)
    } catch (e) {
      ctx.log.warn('dropped reply not removed from the history', { id: what.replyId, error: (e as Error).message })
    }
  }
  const then = row.cardKind ? 'Update the relay, then send it again if it matters.' : 'Send it again if it matters.'
  const text = `A ${row.type} you sent never reached the relay and was dropped (${why}). ${what.agent ? `${what.agent} ` : ''}${then}`
  void ctx
    .emit(
      systemNotification({ thread, text, ts: new Date(ctx.clock.now()).toISOString(), id: `outbox-drop-${row.id}` }),
    )
    .catch((e) => ctx.log.warn('outbox drop not told to the agent', { id: row.id, error: (e as Error).message }))
  if (what.owner)
    void postSystemNotice(ctx, `${what.owner} (It ${why}.)`, { thread }).catch((e) =>
      ctx.log.warn('outbox drop not shown to the owner', { id: row.id, error: (e as Error).message }),
    )
}
