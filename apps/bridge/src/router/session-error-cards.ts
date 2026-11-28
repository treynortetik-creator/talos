// The card for a thread session that stopped on an API error or a refusal (session-error-watch.ts finds it). Two buttons: Clear session
// (a fresh conversation; the old one is kept) and Retry (the owner's last message sent again). Modelled line for line on
// update-resend.ts: a `config` card made by the bridge (never by an agent), told apart by its payload, answered only by the owner's own
// signed `card.resolve` in the app. Nothing on the card comes from the transcript's text: the words are session-error-words.ts, the
// message lines are the owner's own held message (never text from the file), and the payload hash binds the thread, the session, the
// failed record and what each button does. A stale card (the thread has another session now) does nothing.
import {
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  clipUnits,
  newId,
  payloadHash,
  ThreadId,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { redelivered } from '../main-resend.ts'
import type { Notification } from '../notify.ts'
import { assertFrameFits } from '../transport.ts'
import type { WorkersReader } from '../worker/files.ts'
import { controlThreadSession } from './session-control.ts'
import type { Episode, Found } from './session-error-watch.ts'
import * as W from './session-error-words.ts'
import { fieldsFor, offerable, shownLine } from './update-resend.ts'

/** How long the offer stays on the owner's screen. */
export const OFFER_EXPIRY_MS = 24 * 60 * 60 * 1000
type Act = 'retry' | 'clear' | 'dismiss'

/** A card of this offer (the `config` kind, told apart by its payload, like the update-resend card). */
export function isSessionErrorCard(binding: Pick<CardBinding, 'kind' | 'payload'>): boolean {
  if (binding.kind !== 'config') return false
  const p = binding.payload as Record<string, unknown> | null | undefined
  return typeof p === 'object' && p !== null && typeof p.session_error === 'object' && p.session_error !== null
}

type Payload = {
  thread: string
  session: string
  record: string
  reason: string
  primary: Act
  other: Act
  message?: string
}
function payloadOf(row: LedgerRow): Payload | undefined {
  const p = (row.binding.payload as { session_error?: Record<string, unknown> } | undefined)?.session_error
  if (!p) return undefined
  const act = (v: unknown): Act | undefined => (v === 'retry' || v === 'clear' || v === 'dismiss' ? v : undefined)
  const primary = act(p.primary)
  const other = act(p.other)
  if (
    !primary ||
    !other ||
    typeof p.thread !== 'string' ||
    typeof p.session !== 'string' ||
    typeof p.record !== 'string' ||
    typeof p.reason !== 'string'
  )
    return undefined
  return {
    thread: p.thread,
    session: p.session,
    record: p.record,
    reason: p.reason,
    primary,
    other,
    ...(typeof p.message === 'string' ? { message: p.message } : {}),
  }
}

type Deps = {
  /** The owner's message as this bridge recorded it when it was handed to a thread, by id. */
  held(id: string): Notification | undefined
  /** What was last handed to a thread (newest first): its row id, when it was routed (ms), and what it was. */
  latest(thread: string): { id: string; at: number; n: Notification }[]
  /** Would the router hand this message to the thread's own session (not to main, not refused) right now? */
  wouldGoToWorker(n: Notification): boolean
  /** Who claimed a message: `main`, `worker:<thread>`, or nobody. */
  claimedBy(id: string): string | undefined
  /** Does the router hold a route row for this id (a copy queued)? */
  copyHeld(id: string): boolean
  /** The same path every owner message takes to a thread (the router's own): `queued` only when the thread's session now holds a NEW row for it. */
  route(n: Notification, supersedes?: string): Promise<'queued' | 'main' | 'refused' | 'answered'>
  workers: () => WorkersReader
  /** The uuid of the last conversation record of a session's transcript now (undefined: unreadable). */
  lastRecord(cwd: string, session: string): string | undefined
}

export class SessionErrorCards {
  constructor(
    private readonly ctx: BridgeContext,
    private readonly deps: Deps,
  ) {}

  /** The episode, offered: a card, or one plain line when the card cannot be shown (never silent), or the sign-in line for a signed-out session. */
  async raise(e: Episode): Promise<void> {
    const { ctx } = this
    const ref = threadRef(ctx, e.thread)
    const plain = (text: string) =>
      postSystemNotice(ctx, text, { thread: ref }).catch((err) =>
        ctx.log.warn('session error line not posted', { error: (err as Error).message }),
      )
    if (e.found.kind === 'auth') return void (await plain(W.AUTH_LINE()))
    const kind = e.found.kind
    const ok = await this.offer({
      thread: e.thread,
      name: ref.name,
      session: e.session,
      found: e.found,
      ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
    })
    if (!ok) await plain(W.plainLine(ref.name, kind, this.bodyOf(e.found)))
  }

  private bodyOf(f: Found): string {
    switch (f.kind) {
      case 'refusal':
        return W.BODY.refusal(f.refusal ?? 'other')
      case 'too_big':
        return W.BODY.too_big
      case 'servers':
        return W.BODY.servers
      case 'rate':
        return W.BODY.rate
      default:
        return W.BODY.other(f.what ?? 'unknown')
    }
  }

  /** One offer for one failed record. False when none could be shown (the caller then says the plain words). */
  async offer(a: {
    thread: string
    name: string
    session: string
    found: Found
    startedAt?: number
  }): Promise<boolean> {
    const { ctx } = this
    if (a.found.kind === 'auth' || !ThreadId.safeParse(a.thread).success) return false
    const now = ctx.clock.now()
    // Retry only for the message that started the turn that failed: the NEWEST thing handed to the thread, an owner message of the
    // thread's own, sent after the last good answer and no later than the failure. A message sent again is named by its original.
    const last = this.deps.latest(a.thread)[0]
    const orig = last ? (last.id.includes('~retry') ? last.id.slice(0, last.id.indexOf('~retry')) : last.id) : undefined
    const held = last && orig ? (orig === last.id ? last.n : this.deps.held(orig)) : undefined
    // with no good answer in the part of the file that was read, only a message of this session, sent within the hour, can be the failed one
    const floor = Math.max(a.startedAt ?? 0, now - 3600_000)
    const fits =
      last !== undefined && last.at <= (a.found.at ?? Number.POSITIVE_INFINITY) && last.at > (a.found.prevAt ?? floor)
    const msg = fits && offerable(held) && held.meta.thread_id === a.thread ? held : undefined
    const msgId = msg ? orig : undefined
    const retryFirst = a.found.kind === 'servers' || a.found.kind === 'rate' || a.found.kind === 'other'
    let primary: Act
    let other: Act
    if (msgId) [primary, other] = retryFirst ? ['retry', 'clear'] : ['clear', 'retry']
    else [primary, other] = ['clear', 'dismiss']
    const label = (x: Act) => (x === 'retry' ? W.BUTTONS.retry : x === 'clear' ? W.BUTTONS.clear : W.DISMISS_BUTTON)
    const parsed = Card.safeParse({
      id: newId('c'),
      thread_id: a.thread,
      kind: 'config' as const,
      title: clipUnits(W.title(a.name, a.found.kind), 120),
      summary: W.SUMMARY,
      destination: [{ label: 'Thread', value: clipUnits(a.name, 80) }],
      body: this.bodyOf(a.found),
      body_format: 'plain' as const,
      fields: msgId ? fieldsFor(this.deps.held, [msgId]) : [],
      attachments: [],
      ...(msgId ? { warning: W.RETRY_WARNING } : {}),
      primary_label: label(primary),
      kill_label: label(other),
      allow_edit: false,
      allow_revise: false,
      risk: 'low' as const,
      origin: 'background' as const,
      payload: {
        v: 1,
        session_error: {
          thread: a.thread,
          session: a.session,
          record: a.found.uuid,
          reason: a.found.kind,
          primary,
          other,
          ...(msgId ? { message: msgId } : {}),
        },
      },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + OFFER_EXPIRY_MS).toISOString(),
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
      ctx.log.warn('session error offer not sent', { error: (e as Error).message })
      return false
    }
    ctx.expiry?.sync()
    // an earlier card of this thread is about an older failure: it ends now, so a tap on it can never act on a thread that moved on
    for (const r of ctx.ledger.list('pending')) {
      if (r.id === card.id || r.thread_id !== a.thread || !isSessionErrorCard(r.binding) || !ctx.ledger.expire(r.id))
        continue
      ctx.expiry?.cancel(r.id)
      ctx.transport
        .sendDurable(cardUpdateFrame(ctx.clock.now(), { card_id: r.id, state: 'expired', reason: 'superseded' }))
        .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    }
    return true
  }

  /** The owner answered (inbound has checked the tap and moved the ledger). Only a signed tap in the app does anything. */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', via: string): Promise<void> {
    const p = payloadOf(row)
    if (!p || action === 'revise') return this.end(row, false, W.RESULT.failed('that card is not readable'))
    const act = action === 'primary' ? p.primary : p.other
    if (act === 'dismiss') return this.end(row, true, W.RESULT.dismissed)
    if (via !== 'card.resolve') return this.end(row, false, W.RESULT.notFromHere, true)
    const { ctx } = this
    const file = this.deps.workers().read()
    const entry = file?.threads[p.thread]
    if (!entry || entry.session_id !== p.session) return this.end(row, false, W.RESULT.stale, true)
    // the thread must still be where the failure left it: a later turn (or an unreadable transcript) means nothing is done
    if (this.deps.lastRecord(entry.cwd, p.session) !== p.record) return this.end(row, false, W.RESULT.movedOn, true)
    if (act === 'clear') {
      const r = controlThreadSession(ctx, { thread_id: p.thread, action: 'fresh', by: 'owner' }, this.deps.workers())
      ctx.log.info('session error: clear tapped', { card: row.id, ok: r.ok })
      return this.end(row, r.ok, r.ok ? W.RESULT.cleared : W.RESULT.failed(r.text.replace(/[.\s]+$/, '')))
    }
    return this.retry(row, p, entry.state === 'busy')
  }

  private async retry(row: LedgerRow, p: Payload, busy: boolean): Promise<void> {
    const { ctx } = this
    if (busy) return this.end(row, false, W.RESULT.busy, true)
    const id = p.message
    const n = id ? this.deps.held(id) : undefined
    // what the owner was shown must still be what would go: the card's own line against the held message now
    const shown = row.binding.fields.map((f) => f.value)
    if (!id || !offerable(n) || n.meta.thread_id !== p.thread || shownLine(n) !== shown[0])
      return this.end(row, false, W.RESULT.gone, true)
    const copy = (() => {
      const c = redelivered(n, 'retry')
      // one copy per failed record: the same message can fail again and be offered again
      return { content: c.content, meta: { ...c.meta, message_id: `${id}~retry~${p.record}` } }
    })()
    const key = `session_error_retried:${p.record}`
    const claim = `session_error_retrying:${p.record}`
    // the main session already took the original (its time to wait passed): it answered, so nothing is sent again
    if (this.deps.claimedBy(id) === 'main') return this.end(row, false, W.RESULT.mainAnswered, true)
    // once per failed record, whoever taps and however often. A claim left by a crash holds only if its copy really was queued; with no copy
    // (the crash came first, and the original was never retired) it is dropped and the retry goes on
    const copyId = copy.meta.message_id as string
    if (ctx.store.kvGet(claim) !== undefined && !this.deps.copyHeld(copyId) && this.deps.claimedBy(copyId) !== 'main')
      ctx.store.kvDelete(claim) // (a copy that went to MAIN holds no route row, but it was sent: the key stands)
    if (ctx.store.kvGet(key) !== undefined || ctx.store.kvGet(claim) !== undefined)
      return this.end(row, false, W.RESULT.already, true)
    // the router must be going to hand it to the thread's own session: a stopping or failed one, a start the usage limits block, or a
    // thread that is no longer its own would send it to MAIN, and the owner would then send it again by hand
    if (!this.deps.wouldGoToWorker(copy)) return this.end(row, false, W.RESULT.failed(W.RESULT.notRunning), true)
    ctx.store.kvSet(claim, String(ctx.clock.now())) // before the send: a second tap or a crash never sends it twice
    try {
      // the router queues the copy and, in the same transaction, retires the original if the session has not read it (an error before its
      // read_inbound), so read_inbound returns the copy ALONE and the agent answers once; a message it already read is left as it is
      const outcome = await this.deps.route(copy, id)
      if (outcome === 'answered') return this.end(row, false, W.RESULT.mainAnswered, true) // main took the original while this waited: no copy was queued
      if (outcome === 'refused') return this.end(row, false, W.RESULT.failed('the message could not be sent again'))
      ctx.store.kvSet(key, String(ctx.clock.now())) // sent: to the session, or (the router changed its mind) to main: never a second send
      if (outcome === 'main') return this.end(row, true, W.RESULT.sentToMain)
      ctx.log.info('session error: retry tapped', { card: row.id })
      return this.end(row, true, W.RESULT.retried)
    } catch (e) {
      ctx.log.error('session error retry failed', { error: (e as Error).message })
      return this.end(row, false, W.RESULT.failed('the message could not be sent'))
    } finally {
      ctx.store.kvDelete(claim)
    }
  }

  /** `nothingRan`: the card says nothing was done (`ran: false`), so the app shows these words as the headline, not "Couldn't change it · Ask Talos to retry". */
  private async end(row: LedgerRow, ok: boolean, text: string, nothingRan = false): Promise<void> {
    const { ctx } = this
    ctx.ledger.finish(row.id, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: {
            ok,
            text: clipUnits(text, 500),
            at: new Date(ctx.clock.now()).toISOString(),
            ...(nothingRan ? { ran: false as const } : {}),
          },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }
}
