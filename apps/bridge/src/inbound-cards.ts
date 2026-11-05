// Card decisions: taps from the app, taps from a notification, and what happens when the agent is not told.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { join } from 'node:path'
import {
  cardNotice,
  checkNativeAct,
  type ErrorCodeT,
  NATIVE_APPROVE_MAX_AGE_MS,
  nativeReplyMessageId,
  noticeSubtitle,
  shownHash,
} from '@talos-app/protocol'
import type { LedgerRow, ResolutionRecord } from './cards-ledger.ts'
import { localClock } from './clock-meta.ts'
import { postSystemNotice, threadRef } from './context.ts'
import { cardUpdateFrame } from './frames-out.ts'
import { writeJsonAtomic } from './fsutil.ts'
import type { Inbound } from './inbound.ts'
import { CLOCK_OFF_MESSAGE, type Item, type Of, oneLine } from './inbound-shared.ts'
import { cardActionNotification } from './notify.ts'

export const cardsFrames = {
  /**
   * A Reply or Approve the phone signed with its notification key. The relay already checked it, and is not trusted for
   * that: the chain is checked again here against the device key THIS Mac pinned (device key -> grant -> action key), then
   * the action becomes the same message or card resolution an app frame would have been, through the same handlers, so
   * every later rule (seen ids, known thread, card state, payload hash, permission cards) applies unchanged. One rule is
   * added: a high-risk card is never approved this way, whatever the relay says (it needs the passkey step-up a
   * notification cannot give).
   */
  async onNativeAct(this: Inbound, it: Item, f: Of<'native.act'>) {
    const { ctx } = this
    const deny = (code: ErrorCodeT, message: string, reason: string) => {
      ctx.log.security('native action refused', { id: f.id, device_id: f.device_id, reason })
      return this.reject(it, code, message)
    }
    const pub = ctx.devices.pinnedKey(f.device_id)
    if (!pub)
      return deny(
        'device_not_pinned',
        'This phone is not trusted by your Mac.',
        ctx.devices.isRevoked(f.device_id) ? 'device_revoked' : 'device_not_pinned',
      )
    // Judged at the moment the relay took the tap, not at this Mac's wake-up: a Mac that slept for an hour still takes
    // what was tapped before it slept. The relay's stamp may be at most eight days old (checkNativeAct enforces it).
    const stamp = Date.parse((it.raw.relay as { received_at?: string } | undefined)?.received_at ?? '')
    const check = await checkNativeAct(
      it.raw,
      pub,
      ctx.clock.now(),
      Number.isFinite(stamp) ? { receivedAtMs: stamp } : {},
    )
    if (!check.ok) {
      if (check.reason === 'act_future' || check.reason === 'stale')
        return deny('stale', CLOCK_OFF_MESSAGE, check.reason)
      if (check.reason === 'act_stale')
        return deny('stale', 'That tap came too late to run. Do it again from the app.', check.reason)
      return deny('sig_invalid', 'signature check failed', check.reason)
    }
    const act = check.act
    const owner = { v: 1 as const, id: f.id, ts: f.ts, device_id: f.device_id, osig: check.grant.osig, relay: f.relay }
    it.owner = { ok: true, deviceId: f.device_id }
    if (act.a === 'reply') {
      return this.onMessage(it, {
        ...owner,
        type: 'message',
        thread_id: act.thread_id,
        client_msg_id: nativeReplyMessageId(f.id),
        text: act.text,
        attachments: [],
      } as Of<'message'>)
    }
    // Twelve hours, on THIS Mac's clock, from when the phone signed the tap. The relay's stamp is unsigned and cannot stretch
    // it. Past it the card stays pending (the refusal tells the relay to put it back) and the owner gets the failed-tap push.
    if (ctx.clock.now() - Date.parse(f.ts) > NATIVE_APPROVE_MAX_AGE_MS)
      return deny('stale', 'That Approve waited too long. Open the card in the app.', 'approve_too_old')
    const row = ctx.ledger.get(act.card_id)
    if (row?.binding.risk === 'high')
      return deny('stepup_required', 'This card needs your passkey. Open it in the app to approve.', 'high_risk')
    // Approvals bind what was shown. The words the notification displayed are rebuilt here from THIS Mac's copy of the
    // card; the phone signed a hash of what it displayed. A relay that sealed other words, or a card that cannot be shown
    // whole in a notification, is refused. (A card the ledger does not know falls through to the normal resolve refusal.)
    if (row) {
      const notice = cardNotice(row.binding)
      if (!notice.complete)
        return deny(
          'card_hash_mismatch',
          'This card has more than a notification can show. Open it in the app.',
          'not_whole',
        )
      if (shownHash(notice.text, noticeSubtitle(row.binding.thread_id, ctx.config.config)) !== act.shown)
        return deny('card_hash_mismatch', 'What the notification showed does not match this card.', 'shown_mismatch')
    }
    return this.onCardResolve(
      it,
      {
        ...owner,
        type: 'card.resolve',
        card_id: act.card_id,
        action: 'primary',
        payload_hash: act.payload_hash,
      } as Of<'card.resolve'>,
      // The tap is as old as the relay's stamp says, not as old as this Mac's sleep (the same rule as a Reply above). The
      // card's own expiry still wins: ledger.resolve checks it against this Mac's clock.
      Number.isFinite(stamp) ? { ageAtMs: stamp } : {},
    )
  },

  async onCardResolve(this: Inbound, it: Item, f: Of<'card.resolve'>, opts: { ageAtMs?: number } = {}) {
    const { ctx } = this
    const nowMs = ctx.clock.now()
    // A permission card is answered by Claude Code's prompt, never by the agent. Refused here, before the ledger moves.
    const pre = ctx.permission.precheck(f.card_id, f.action)
    if (pre.handled && !pre.ok) {
      ctx.log.security('permission card resolve refused', { card_id: f.card_id, code: pre.code })
      return this.reject(it, pre.code, pre.reason)
    }
    const out = ctx.ledger.resolve(
      {
        card_id: f.card_id,
        action: f.action,
        payload_hash: f.payload_hash,
        edited: f.edited,
        edited_hash: f.edited_hash,
        note: f.note,
        ts: f.ts,
      },
      nowMs,
      { ...opts, frameId: it.frame.id },
    )
    if (!out.ok) {
      ctx.log.security('card resolve rejected', { card_id: f.card_id, code: out.code, reason: out.reason })
      if (out.row) {
        if (out.newlyExpired)
          await this.expiry.announce(
            f.card_id,
            out.reason === 'mac_offline_too_long' ? 'mac_offline_too_long' : 'expired',
          )
        else
          this.fire(
            cardUpdateFrame(nowMs, {
              card_id: f.card_id,
              state: out.row.state,
              reason: out.reason,
              // what the card was decided as: without it a killed card replayed as `done` would read as sent
              ...(out.row.resolution ? { resolution: out.row.resolution } : {}),
            }),
          )
      }
      return this.reject(it, out.code, out.reason)
    }
    this.expiry.cancel(f.card_id)
    const row = out.row
    if (pre.handled) {
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      const sent = await ctx.permission.onResolved(row, f.action)
      // The card says "failed" in the app either way. A tap from a notification was answered "done" by the relay, so it also
      // gets a refusal: the relay turns that into the failed-tap push, and the owner is not left thinking the Allow went through.
      if (!sent.ok && it.frame.type === 'native.act') return this.reject(it, sent.code, sent.reason)
      this.closeDecided(f.card_id, nowMs, out.resolution) // a refused or failed send is already `failed`: this skips it
      return this.done(it)
    }
    let payloadPath: string | undefined
    if (f.action === 'primary') {
      payloadPath = join(ctx.paths.approved, `${f.card_id}.json`)
      writeJsonAtomic(payloadPath, out.approved, 0o600)
    }
    // MCP apps: an `app_action` card is handled by the app service (the bridge runs it, or the agent is told to)
    let appExtra: string | undefined
    if (row.binding.kind === 'app_action') {
      const r = ctx.apps?.onCardResolved(row, f.action, out.approved.payload, payloadPath) ?? { notifyAgent: false }
      if (!r.notifyAgent) {
        ctx.ledger.settled(f.card_id) // the agent is not told about this one, so there is no hand-over to track
        this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
        this.closeDecided(f.card_id, nowMs, out.resolution)
        return this.done(it)
      }
      appExtra = r.extra
    } else if (row.binding.kind === 'config' && row.actor === 'bridge') {
      // A settings card (O1): the BRIDGE applies what the owner approved, after checking the allowlist again
      // 'resolved' goes out FIRST: a refusal inside apply() sends 'failed' with no await in front of it, and every app keeps
      // the last frame it saw, so 'resolved' after 'failed' would hide the refusal and leave "Working on it" for good.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      ctx.configProposals?.onCardResolved(row, f.action, out.approved, f.card_id, f.note)
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.actor === 'bridge') {
      // A schedule card: the BRIDGE applies what the owner approved (S3.4); the agent is told, never asked to act.
      ctx.schedules?.onCardResolved(row, f.action, out.approved, f.card_id, f.note)
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    }
    // ONE attempt to tell the agent, never repeated. The `telling` marker was written with `resolved`; it is cleared when the
    // write returns, either way. A marker found at startup means the process died mid-write (see `sweepInterrupted`).
    // 'resolved' goes out before the write: a card ended while the write is pending sends 'failed', and every app keeps the
    // last frame it saw, so a 'resolved' sent after the write would bury it.
    this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
    const told = await this.tellAgent(row, appExtra)
    if (told) this.closeDecided(f.card_id, nowMs, out.resolution)
    else
      this.endUndelivered(
        row,
        out.resolution,
        "Your agent didn't get this, so nothing ran. Ask it again when it's back.",
        false,
      )
    this.done(it)
  },

  /** Writes the owner's decision to the agent's channel. True when the write returned. */
  async tellAgent(this: Inbound, row: LedgerRow, appExtra?: string): Promise<boolean> {
    const { ctx } = this
    const res = row.resolution as ResolutionRecord
    const payloadPath = res.action === 'primary' ? join(ctx.paths.approved, `${row.id}.json`) : undefined
    try {
      await ctx.emit(
        cardActionNotification({
          thread: threadRef(ctx, row.thread_id),
          card: { id: row.id, title: row.binding.title, primary_label: row.binding.primary_label },
          action: res.action,
          ts: res.at,
          edited: res.edited,
          ...(payloadPath ? { payloadPath, payloadHash: res.payload_hash } : {}),
          note: res.note,
          clock: localClock(ctx, res.at),
          ...(appExtra && res.action === 'primary' ? { extra: appExtra } : {}),
        }),
      )
      return true
    } catch (e) {
      ctx.log.warn('card decision not delivered to the agent', { card_id: row.id, error: (e as Error).message })
      return false
    } finally {
      ctx.ledger.settled(row.id)
    }
  },

  /**
   * A decision that did not reach the agent is ended where the owner can see it, and never sent again. An approval ends
   * failed (`ran: false` when we know nothing ran, unset when we cannot know); a Kill or Ask for changes just closes.
   */
  endUndelivered(this: Inbound, row: LedgerRow, res: ResolutionRecord, text: string, unknown: boolean) {
    const { ctx } = this
    const title = oneLine(row.binding.title).slice(0, 80)
    let notice = text
    // an app request the agent may never run: the gate must refuse it from here on
    if (row.binding.kind === 'app_action' && res.action === 'primary')
      void ctx.apps
        ?.onDecisionNotDelivered(row)
        .catch((e) => ctx.log.warn('app request not closed', { error: (e as Error).message }))
    if (res.action === 'primary') {
      if (ctx.ledger.finish(row.id, false))
        this.fire(
          cardUpdateFrame(ctx.clock.now(), {
            card_id: row.id,
            state: 'failed',
            result: {
              ok: false,
              text,
              at: new Date(ctx.clock.now()).toISOString(),
              ran: unknown ? ('unknown' as const) : false,
            },
          }),
        )
    } else {
      const what = res.action === 'kill' ? 'Kill' : 'request for changes'
      notice = unknown
        ? `Your ${what} may not have reached your agent. Check before asking again.`
        : `Your ${what} didn't reach your agent. Nothing was running.`
      this.closeDecided(row.id, ctx.clock.now(), res)
    }
    void postSystemNotice(ctx, res.action === 'primary' ? `"${title}": ${notice}` : notice, {
      thread: threadRef(ctx, row.thread_id),
    }).catch((e) => ctx.log.warn('owner notice not posted', { error: (e as Error).message }))
  },

  /**
   * A decision held for a worker ended without the agent acting on it. `told: false` is main being unable to take it at the
   * deadline (nothing ran); `told: 'unknown'` is the worker having read it and stopped (it may have run). An approval still
   * `resolved` ends failed; a Kill or request for changes was closed when the tap was held, so it only needs the note.
   */
  cardNotDelivered(this: Inbound, cardId: string, told: false | 'unknown' = false) {
    const row = this.ctx.ledger.get(cardId)
    const res = row?.resolution
    if (!row || !res) return
    if (!(row.state === 'resolved' || (res.action !== 'primary' && row.state === 'done'))) return
    this.endUndelivered(
      row,
      res,
      told
        ? "This thread's session stopped before it finished this. It may have run. Check before asking again."
        : "Your agent didn't get this, so nothing ran. Ask it again when it's back.",
      told === 'unknown',
    )
  },

  /**
   * At startup: a decision whose write was in flight when the process stopped or died. We cannot know whether the agent got
   * it, so it is never sent again. The card ends, the owner is told to check, and the tap that made the decision is marked
   * seen so the relay's replay of it is consumed quietly.
   */
  sweepInterrupted(this: Inbound) {
    const { ctx } = this
    for (const { cardId, frameId } of ctx.ledger.interrupted()) {
      ctx.ledger.settled(cardId)
      if (frameId) ctx.store.markSeen(frameId, ctx.clock.now())
      const row = ctx.ledger.get(cardId)
      if (row?.state !== 'resolved' || !row.resolution) continue
      this.endUndelivered(row, row.resolution, 'This may not have reached your agent. Check before asking again.', true)
    }
  },

  /**
   * A killed or revised card has nothing left to run, so no `card_result` will come: end it here, after the `resolved`
   * frame (an app keeps the last frame it saw). Only the ledger decides: a card already failed or finished is left alone.
   */
  closeDecided(this: Inbound, cardId: string, nowMs: number, resolution: ResolutionRecord) {
    if (resolution.action === 'primary') return
    if (!this.ctx.ledger.closeDecided(cardId)) return
    this.fire(cardUpdateFrame(nowMs, { card_id: cardId, state: 'done', resolution }))
  },
}
