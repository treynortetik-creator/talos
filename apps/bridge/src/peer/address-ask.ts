// A linked agent's address changed while messages for it were still waiting. The messages were written for the old address, so
// they are HELD and the owner is asked once: "Send them to the new address?" It is a card of the `config` kind (told apart by its
// payload, like the update-resend offer), answered only by the owner's own signed tap in the app. Yes sends the waiting messages
// to the new address; No refuses them. Nothing here reads or shows a message's text.
import {
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  clipUnits,
  newId,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { assertFrameFits } from '../transport.ts'

/** How long the ask stays on the owner's screen. */
export const ADDRESS_ASK_EXPIRY_MS = 24 * 3600_000

export const ADDRESS_ASK_TEXT = {
  title: (peer: string) => clipUnits(`${peer} has a new address`, 120),
  body: (peer: string, count: number) =>
    `The address for ${peer} changed. ${count === 1 ? 'A message is' : `${count} messages are`} waiting that ${count === 1 ? 'was' : 'were'} written for the old one. Send ${count === 1 ? 'it' : 'them'} to the new address?`,
  warning: 'Only say yes if you changed this address yourself.',
  sent: 'Sent them to the new address.',
  sentSome: (n: number, count: number) =>
    `Sent ${n} of ${count} to the new address. ${count - n === 1 ? 'One' : 'The others'} gave up before you answered and did not go.`,
  noneLeft: 'None of them were still waiting: they gave up before you answered, so nothing was sent.',
  refused: 'Did not send them.',
  keptOther: 'The address changed again since this question, so nothing was refused here.',
  notFromHere: 'Open the card in the app to answer it.',
  changedAgain: 'The address changed again. Nothing was sent.',
} as const

/** A card of this ask (the `config` kind, told apart by its payload). */
export function isPeerAddressCard(binding: Pick<CardBinding, 'kind' | 'payload'>): boolean {
  if (binding.kind !== 'config') return false
  const p = binding.payload as Record<string, unknown> | null | undefined
  return typeof p === 'object' && p !== null && typeof p.peer_address === 'object' && p.peer_address !== null
}

/** The address as shown to the owner: the host only, since the rest of an inbox address is not for reading out. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return 'an unknown address'
  }
}

type Deps = {
  /** The address this bridge would send to now, or undefined when the agent is no longer linked. */
  currentUrl(peer: string): string | undefined
  /** Messages for `peer` still waiting that were queued for another address than `url`. */
  waiting(peer: string, url: string): number
  /** Yes: they go to `url` now. Returns how many were still waiting. */
  release(peer: string, url: string): number
  /** No: they are refused. */
  refuse(peer: string, url: string): void
}

export class PeerAddressAsk {
  constructor(
    private readonly ctx: BridgeContext,
    private readonly deps: Deps,
  ) {}

  /** Is an ask for this agent and address already on the owner's screen? */
  private asked(peer: string, url: string): boolean {
    return this.ctx.ledger.list('pending').some((r) => {
      const p = (r.binding.payload as { peer_address?: { peer?: unknown; url?: unknown } } | undefined)?.peer_address
      return r.actor === 'bridge' && isPeerAddressCard(r.binding) && p?.peer === peer && p.url === url
    })
  }

  /** One ask per agent and new address at a time. False when none could be shown (the caller tries again later). */
  async ask(a: { peer: string; from: string; to: string }): Promise<boolean> {
    const { ctx } = this
    if (this.asked(a.peer, a.to)) return true
    const now = ctx.clock.now()
    const count = this.deps.waiting(a.peer, a.to)
    if (count === 0) return true
    const thread = ctx.config.config.default_thread
    const parsed = Card.safeParse({
      id: newId('c'),
      thread_id: thread,
      kind: 'config' as const,
      title: ADDRESS_ASK_TEXT.title(a.peer),
      summary: 'Messages are waiting.',
      destination: [
        { label: 'Agent', value: clipUnits(a.peer, 80) },
        { label: 'Old address', value: clipUnits(hostOf(a.from), 80) },
        { label: 'New address', value: clipUnits(hostOf(a.to), 80) },
      ],
      body: ADDRESS_ASK_TEXT.body(a.peer, count),
      body_format: 'plain' as const,
      fields: [],
      attachments: [],
      warning: ADDRESS_ASK_TEXT.warning,
      primary_label: 'Send them',
      kill_label: "Don't send",
      allow_edit: false,
      allow_revise: false,
      risk: 'low' as const,
      origin: 'background' as const,
      payload: { v: 1, peer_address: { peer: a.peer, url: a.to, count } },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ADDRESS_ASK_EXPIRY_MS).toISOString(),
    })
    if (!parsed.success) return false
    const card: CardT = parsed.data
    if (validateCard(card).length) return false
    card.payload_hash = payloadHash(bindingFrom(card))
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch {
      return false
    }
    ctx.ledger.create(card, 'bridge')
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      ctx.log.warn('peer address ask not sent', { error: (e as Error).message })
      return false
    }
    ctx.expiry?.sync()
    return true
  }

  /** The owner answered (inbound has checked the tap and moved the ledger). Only the in-app Send them sends anything. */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', via: string): Promise<void> {
    const p = (row.binding.payload as { peer_address?: { peer?: unknown; url?: unknown; count?: unknown } } | undefined)
      ?.peer_address
    const peer = typeof p?.peer === 'string' ? p.peer : ''
    const url = typeof p?.url === 'string' ? p.url : ''
    const count = typeof p?.count === 'number' ? p.count : 0
    if (!peer || !url) return this.end(row, false, ADDRESS_ASK_TEXT.changedAgain)
    // what the owner was shown must still be the address in use, for No as for Yes: another change since means another ask, and
    // the messages written for the address now linked are that ask's to answer
    const current = this.deps.currentUrl(peer) === url
    if (action !== 'primary') {
      if (!current) return this.end(row, true, ADDRESS_ASK_TEXT.keptOther)
      this.deps.refuse(peer, url)
      return this.end(row, true, ADDRESS_ASK_TEXT.refused)
    }
    if (via !== 'card.resolve') return this.end(row, false, ADDRESS_ASK_TEXT.notFromHere)
    if (!current) return this.end(row, false, ADDRESS_ASK_TEXT.changedAgain)
    const n = this.deps.release(peer, url)
    if (n === 0) return this.end(row, false, ADDRESS_ASK_TEXT.noneLeft)
    if (count > n) return this.end(row, false, ADDRESS_ASK_TEXT.sentSome(n, count))
    return this.end(row, true, ADDRESS_ASK_TEXT.sent)
  }

  private async end(row: LedgerRow, ok: boolean, text: string): Promise<void> {
    const { ctx } = this
    ctx.ledger.finish(row.id, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: { ok, text: clipUnits(text, 500), at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }
}
