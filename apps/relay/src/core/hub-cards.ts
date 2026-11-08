// Card decisions: a tap in the app, a tap on a notification, and putting a card back when the Mac refuses it.
// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks (session, pairing,
// schema) are in hub-app-conn.ts and hub-app-frames.ts; some handlers here run their own device, seen-id, step-up
// or card-state checks, so read both when auditing trust.
import {
  type ActBodyT,
  type CardT,
  cardNotice,
  type FrameOf,
  type MessageT,
  NATIVE_ACT_FEATURE,
  NATIVE_ACT_TYPE,
  type NativeActWireT,
  nativeReplyMessageId,
  noticeSubtitle,
  sha256Hex,
  shownHash,
} from '@talos-app/protocol'
import { consumeStepupToken } from '../auth/contract.ts'
import { checkResolve } from './cards.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import type { BridgeFeatures } from './features.ts'
import type { AppConn, Hub, HubDeps } from './hub.ts'
import type { StoredFrame } from './store.ts'
import { DAY_MS, longTimeout, mkFrame } from './util.ts'

/** What the cards handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type CardsCtx = {
  d: HubDeps
  bridgeFeatures: BridgeFeatures
  ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean
  acceptOwner(
    a: AppConn,
    frame: { id: string; type: string },
    raw: Record<string, unknown>,
    threadId: string | null,
    extraKeys?: string[],
    alsoWrite?: () => void,
  ): StoredFrame | null
  appError(a: AppConn, code: string, message: string, ref?: unknown): void
  sendApp(a: AppConn, frame: Record<string, unknown>): void
  fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void
  stampForApps(frame: Record<string, unknown>): StoredFrame
  enqueueRow(stamped: StoredFrame, ttlMs: number): void
  afterEnqueue(stamped: StoredFrame): void
  cardTimers: Map<string, unknown>
  expireCard(card: CardT): void
  agentConfig(): ReturnType<Hub['agentConfig']>
  nativeApproveCard(body: unknown): string | undefined
  putCardBackToPending(cardId: string, reason: string): void
}

export const cardsFrames = {
  /** Arms the timer that expires a pending card when its time comes. */
  scheduleCardExpiry(this: CardsCtx, cardId: string, expiresAt: number): void {
    const prev = this.cardTimers.get(cardId)
    if (prev) this.d.clock.clearTimeout(prev)
    longTimeout(
      this.d.clock,
      () => {
        this.cardTimers.delete(cardId)
        const card = this.d.store.getCard(cardId)
        if (card?.state === 'pending') this.expireCard(card)
      },
      expiresAt - this.d.clock.now(),
      (h) => this.cardTimers.set(cardId, h),
    )
  },

  expireCard(this: CardsCtx, card: CardT): void {
    if (this.d.store.getCard(card.id)?.state !== 'pending') return
    this.d.store.setCardState(card.id, { state: 'expired' })
    const stamped = this.stampForApps(
      mkFrame(this.d.clock, 'card.update', { card_id: card.id, state: 'expired', reason: 'expired' }),
    )
    this.fanOut(stamped)
  },

  /** The `card.resolve` frame: device check, duplicate check, step-up, then the card-state check. The `case` of that name in Hub.onAppFrameBuiltin. */
  async onCardResolve(
    this: CardsCtx,
    a: AppConn,
    frame: FrameOf<'card.resolve'>,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const store = this.d.store
    if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    const dup = store.seen(`of:${frame.id}`)
    if (dup !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: dup }))
    const known = store.getCard(frame.card_id)
    if (!known) return this.appError(a, 'card_not_pending', 'unknown card', frame.id)
    // Step-up comes first: a reused or wrong-purpose token is refused as such even when the card has already moved on.
    if (known.risk === 'high' && frame.action === 'primary') {
      if (typeof frame.stepup_token !== 'string')
        return this.appError(a, 'stepup_required', 'step-up required for this card', frame.id)
      const ok = await consumeStepupToken({
        token: frame.stepup_token,
        purpose: `card:${frame.card_id}`,
        session: a.session,
      })
      if (!ok) return this.appError(a, 'stepup_invalid', 'step-up token is invalid for this card', frame.id)
    }
    const check = checkResolve(store, this.d.clock, frame)
    if (!check.ok) {
      this.appError(a, check.code, check.message, frame.id)
      if (check.expired) this.expireCard(check.expired)
      return
    }
    // A second resolve of the same card finds it no longer pending, whatever the bridge does with the first. The card
    // change is written in the same transaction as the outbox row, so a failed write leaves the card pending.
    this.acceptOwner(a, frame, raw, check.card.thread_id, [], () =>
      store.setCardState(frame.card_id, { state: 'resolved' }),
    )
    return
  },

  /**
   * A Reply or an Approve that a phone signed with its notification key and posted to `/api/native/act`. By the time it
   * gets here the route has checked the whole chain (`checkNativeAct`) and that the device is pinned and not revoked. This
   * is the same gate the socket path applies, in the same order: the thread or card must exist, a high-risk card is never
   * approved here (it needs the passkey step-up a notification cannot give), the card must be pending, unexpired and
   * unchanged, and the text the phone says it showed must be the text this card produces.
   *
   * One transaction from the claim to the outbox row: a crash or a failed write leaves nothing behind (no claim, no event,
   * no card change), so a retry runs from the start and "done" is only ever answered for something that is queued. The
   * sends to the Mac and the apps happen after the commit.
   */
  acceptNativeAct(
    this: CardsCtx,
    check: { frame: NativeActWireT; act: ActBodyT },
    raw: Record<string, unknown>,
  ): { ok: true; duplicate: boolean } | { ok: false; status: 400 | 403 | 404 | 409; code: string; message: string } {
    const store = this.d.store
    const f = check.frame
    const act = check.act
    const hash = sha256Hex(`${f.id}\n${f.ts}\n${f.grant}\n${f.body}\n${f.asig}`)
    // An older Mac drops a frame type it does not know. When the last hello says so, say so now instead of "done".
    if (this.bridgeFeatures.known() && !this.bridgeFeatures.has(NATIVE_ACT_FEATURE))
      return {
        ok: false,
        status: 409,
        code: 'mac_update_needed',
        message: 'Update Talos on your Mac to use notification buttons.',
      }
    type Done = { duplicate: boolean; after?: () => void }
    let done: Done
    try {
      done = store.db.transaction((): Done => {
        const claim = store.claimNativeAct(f.device_id, f.id, hash, 24 * 3600_000)
        if (claim === 'same') return { duplicate: true }
        if (claim === 'conflict') throw new NativeRefusal(409, 'replay', 'That action id was already used.')
        if (act.a === 'reply') {
          const threads = this.agentConfig()?.threads ?? DEFAULT_AGENT_CONFIG.threads
          if (!threads.some((t) => t.id === act.thread_id))
            throw new NativeRefusal(404, 'unknown_thread', 'No such thread.')
          const msgId = nativeReplyMessageId(f.id)
          if (store.seen(`cm:${msgId}`) !== undefined) return { duplicate: true }
          const stamped = store.appendEvent({ frame: raw, audience: 'bridge', threadId: act.thread_id })
          store.remember(`cm:${msgId}`, stamped.relay.seq)
          const message: MessageT = {
            id: msgId,
            thread_id: act.thread_id,
            seq: stamped.relay.seq,
            author: 'owner',
            kind: 'text',
            format: 'plain',
            attachments: [],
            via: 'app',
            receipt: 'sent',
            created_at: stamped.relay.received_at,
            text: act.text,
          }
          // The app's own copy, stored for apps: catch-up and thread history show the question even if the app was closed.
          const forApps = this.stampForApps(mkFrame(this.d.clock, 'message.stored', { client_msg_id: msgId, message }))
          this.enqueueRow(stamped, this.d.env.BUFFER_DAYS * DAY_MS)
          return {
            duplicate: false,
            after: () => {
              this.afterEnqueue(stamped)
              this.fanOut(forApps)
            },
          }
        }
        const known = store.getCard(act.card_id)
        if (!known) throw new NativeRefusal(404, 'card_not_pending', 'unknown card')
        if (known.risk === 'high')
          throw new NativeRefusal(
            403,
            'stepup_required',
            'This card needs your passkey. Open it in the app to approve.',
          )
        const notice = cardNotice(known)
        if (!notice.complete)
          throw new NativeRefusal(
            403,
            'open_in_app',
            'This card has more than a notification can show. Open it in the app.',
          )
        if (
          shownHash(notice.text, noticeSubtitle(known.thread_id, this.agentConfig() ?? DEFAULT_AGENT_CONFIG)) !==
          act.shown
        )
          throw new NativeRefusal(409, 'card_hash_mismatch', 'What the notification showed is not what this card says.')
        const verdict = checkResolve(store, this.d.clock, {
          card_id: act.card_id,
          action: 'primary',
          payload_hash: act.payload_hash,
        } as FrameOf<'card.resolve'>)
        if (!verdict.ok) throw new NativeRefusal(409, verdict.code, verdict.message, verdict.expired)
        const stamped = store.appendEvent({ frame: raw, audience: 'bridge', threadId: verdict.card.thread_id })
        store.setCardState(act.card_id, { state: 'resolved' })
        this.enqueueRow(stamped, this.d.env.BUFFER_DAYS * DAY_MS)
        return { duplicate: false, after: () => this.afterEnqueue(stamped) }
      })()
    } catch (e) {
      if (!(e instanceof NativeRefusal)) throw e // the transaction rolled back, claim included; the route answers 500
      if (e.expired) this.expireCard(e.expired)
      return { ok: false, status: e.status, code: e.code, message: e.message }
    }
    done.after?.()
    return { ok: true, duplicate: done.duplicate }
  },

  /**
   * The Mac refused a card.resolve before acting on it: put the card back to pending so the next tap can work. A native
   * Approve is the same case with a different frame: the relay marked the card resolved when it queued the tap, so ANY
   * refusal of that frame (stale, not pinned, bad signature, step-up, an older Mac that cannot parse it) must undo it.
   * The guard below keeps a card the Mac did decide (it sends card.update with a resolution) from being touched.
   */
  rollbackRejectedResolve(this: CardsCtx, frame: FrameOf<'error'>): void {
    if (!frame.ref) return
    const ev = this.d.store.getEventByFrameId(frame.ref) as { type?: string; card_id?: string; body?: string } | null
    let cardId: string | undefined
    if (ev?.type === 'card.resolve') {
      if (!['sig_invalid', 'device_not_pinned', 'unauthorized', 'bad_frame'].includes(frame.code)) return
      cardId = ev.card_id
    } else if (ev?.type === NATIVE_ACT_TYPE) {
      cardId = this.nativeApproveCard(ev.body)
    }
    if (typeof cardId === 'string') this.putCardBackToPending(cardId, 'resolve_rejected')
  },

  /** The card a stored native.act frame approves, or undefined for a reply or a body this build cannot read. */
  nativeApproveCard(this: CardsCtx, body: unknown): string | undefined {
    try {
      const b = JSON.parse(String(body)) as { a?: unknown; card_id?: unknown }
      return b.a === 'approve' && typeof b.card_id === 'string' ? b.card_id : undefined
    } catch {
      return undefined
    }
  },

  /** A card past its expiry is expired instead: nothing re-arms its timer, so a pending one would never be closed. */
  putCardBackToPending(this: CardsCtx, cardId: string, reason: string): void {
    let card: CardT | null
    try {
      card = this.d.store.getCard(cardId)
    } catch {
      return // a card row that no longer opens stays as it is; it must not stop the reports after it
    }
    if (card?.state !== 'resolved' || card.resolution || card.result) return
    const expired = Date.parse(card.expires_at) <= this.d.clock.now()
    const state = expired ? 'expired' : 'pending'
    if (!this.d.store.setCardState(card.id, { state })) return
    this.fanOut(
      this.stampForApps(
        mkFrame(this.d.clock, 'card.update', { card_id: card.id, state, reason: expired ? 'expired' : reason }),
      ),
    )
  },
}

/** A native action the relay refuses. Thrown inside the transaction so everything it wrote is rolled back. */
class NativeRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly expired?: CardT,
  ) {
    super(message)
  }
}
