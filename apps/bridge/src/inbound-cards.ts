// Card decisions: taps from the app, taps from a notification, and what happens when the agent is not told.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.

import { join } from 'node:path'
import {
  cardNotice,
  cardOffersAlways,
  checkNativeAct,
  clipUnits,
  type ErrorCodeT,
  NATIVE_APPROVE_MAX_AGE_MS,
  nativeReplyMessageId,
  noticeSubtitle,
  shownHash,
} from '@talos-app/protocol'
import { isRuleAskCard } from './action-rule-asks.ts'
import { addFromOwnerTap } from './always-allow.ts'
import { type CardCliResult, hasCliField, runCardCli } from './card-cli.ts'
import type { LedgerRow, ResolutionRecord } from './cards-ledger.ts'
import { localClock } from './clock-meta.ts'
import { postSystemNotice, threadRef } from './context.ts'
import { cardUpdateFrame } from './frames-out.ts'
import { writeJsonAtomic } from './fsutil.ts'
import type { Inbound } from './inbound.ts'
import { CLOCK_OFF_MESSAGE, type Item, type Of, oneLine } from './inbound-shared.ts'
import { cardActionNotification } from './notify.ts'
import { say } from './owner-words.ts'
import { isPeerAddressCard } from './peer/address-ask.ts'
import { isPermissionModeCard } from './permission-mode.ts'
import { isPluginAddCard } from './plugins/agent-plugins.ts'
import { isSessionErrorCard } from './router/session-error-cards.ts'
import { isUpdateResendCard } from './router/update-resend.ts'
import { isScreenAllowCard } from './screen-consent.ts'

export const cardsFrames = {
  /**
   * A Reply or Approve the phone signed with its notification key. The relay already checked it, and is not trusted for
   * that: the chain is checked again here against the device key THIS Mac pinned (device key -> grant -> action key), then
   * the action becomes the same message or card resolution an app frame would have been, through the same handlers, so
   * every later rule (seen ids, known thread, card state, payload hash, permission cards) applies unchanged. One rule is
   * added: a high-risk card is never approved this way, whatever the relay says (it is approved in the app, never from the
   * lock screen; no passkey since 2026-11-14).
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
        say({ mac: 'This phone is not trusted by your Mac.', linux: 'This phone is not trusted by your computer.' }),
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
      // it waits for its undo point on its session's lane, not on the serial queue (inbound-lanes.ts)
      return this.queueOnLane(it, act.thread_id, () =>
        this.onMessage(it, {
          ...owner,
          type: 'message',
          thread_id: act.thread_id,
          client_msg_id: nativeReplyMessageId(f.id),
          text: act.text,
          attachments: [],
        } as Of<'message'>),
      )
    }
    // Twelve hours, on THIS Mac's clock, from when the phone signed the tap. The relay's stamp is unsigned and cannot stretch
    // it. Past it the card stays pending (the refusal tells the relay to put it back) and the owner gets the failed-tap push.
    if (ctx.clock.now() - Date.parse(f.ts) > NATIVE_APPROVE_MAX_AGE_MS)
      return deny('stale', 'That Approve waited too long. Open the card in the app.', 'approve_too_old')
    const row = ctx.ledger.get(act.card_id)
    if (row?.binding.risk === 'high')
      return deny('open_in_app', 'This card is approved in the app, not from a notification.', 'high_risk')
    // a permission-mode change is allowed from the card in the app only: its Allow is the owner's signed card.resolve
    if (row && isUpdateResendCard(row.binding))
      return deny('open_in_app', 'This card is answered in the app, not from a notification.', 'update_resend_card')
    if (row && isSessionErrorCard(row.binding))
      return deny('open_in_app', 'This card is answered in the app, not from a notification.', 'session_error_card')
    if (row && isPeerAddressCard(row.binding))
      return deny('open_in_app', 'This card is answered in the app, not from a notification.', 'peer_address_card')
    if (row && isPermissionModeCard(row.binding))
      return deny('open_in_app', 'This card is approved in the app, not from a notification.', 'permission_mode_card')
    // a card with talos-app commands on it is approved in the app: only his signed card.resolve there runs them (card-cli.ts)
    if (row && hasCliField(row.binding))
      return deny('open_in_app', 'This card is approved in the app, not from a notification.', 'cli_card')
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
    // A tap from the app is timed like a notification's Approve: the 10-minute rule is judged at the moment the relay took the
    // frame (the relay's `received_at`, unsigned, never later than this Mac's clock), and the owner's device-signed `ts` may
    // be at most twelve hours old on THIS Mac's clock. So a Mac that slept after the tap still takes it, and a relay cannot
    // stretch the wait. The card's own expiry, the hash, the card state and the duplicate checks are the ledger's and are untouched.
    const appTap = it.frame.type === 'card.resolve'
    const stamp = Date.parse((it.raw.relay as { received_at?: string } | undefined)?.received_at ?? '')
    const resolveOpts =
      appTap && opts.ageAtMs === undefined
        ? {
            ...(Number.isFinite(stamp) ? { ageAtMs: Math.min(stamp, nowMs) } : {}),
            maxTapAgeMs: NATIVE_APPROVE_MAX_AGE_MS,
          }
        : opts
    // A permission card is answered by Claude Code's prompt, never by the agent. Refused here, before the ledger moves.
    const pre = ctx.permission.precheck(f.card_id, f.action)
    if (pre.handled && !pre.ok) {
      ctx.log.security('permission card resolve refused', { card_id: f.card_id, code: pre.code })
      return this.reject(it, pre.code, pre.reason)
    }
    // A dialog card is answered by the Mac pressing a key, never by the agent. Refused here, before the ledger moves.
    // an open AskUserQuestion's cards (permission/question.ts) are answered through its hook, not by a key press
    const qst = ctx.questions?.precheck(f)
    if (qst?.handled && !qst.ok) {
      ctx.log.security('question card resolve refused', { card_id: f.card_id, code: qst.code })
      return this.reject(it, qst.code, qst.reason)
    }
    const dlg = qst?.handled ? undefined : ctx.dialogs?.precheck(f, f.device_id)
    if (dlg?.handled && !dlg.ok) {
      ctx.log.security('dialog card resolve refused', { card_id: f.card_id, code: dlg.code })
      return this.reject(it, dlg.code, dlg.reason)
    }
    // "Always allow" is refused whole, before the ledger moves, on a card that does not offer it (a question card, a permission
    // card, a card a notification cannot approve, a settings card that touches a trust key): the card stays pending. On Kill or
    // Ask for changes the flag is ignored, as it always was (it rides only on a primary tap, which is the only one that adds).
    if (f.always === true) {
      const known = ctx.ledger.get(f.card_id)
      if (known && f.action === 'primary' && !cardOffersAlways(known.binding))
        return this.reject(it, 'bad_frame', 'this card does not offer Always allow')
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
      { ...resolveOpts, frameId: it.frame.id, ...(dlg?.handled ? { by: dlg.by } : {}) },
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
      return this.reject(
        it,
        out.code,
        out.code === 'stale' ? 'That tap waited too long. Tap the card again in the app.' : out.reason,
      )
    }
    this.expiry.cancel(f.card_id)
    const row = out.row
    if (qst?.handled && qst.ok) {
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      ctx.questions?.onResolved(row, qst.choice, qst.text)
      return this.done(it)
    }
    if (dlg?.handled && dlg.ok) {
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await ctx.dialogs?.onResolved(row, dlg.choice, it.raw)
      return this.done(it)
    }
    // "Always allow <kind>" (always-allow.ts): only the owner's own signed tap in the app (never a notification's Approve), on the
    // primary button of a card that offers it (checked before the ledger moved), after the signature and the ledger checks above.
    // A rule-ask card records its own grant when it is answered (action-rule-asks.ts). This runs BEFORE the handler applies the card,
    // so a grant is saved even if the apply then fails: accepted, the owner did choose "always" for that kind.
    if (f.always === true && f.action === 'primary' && it.frame.type === 'card.resolve' && !isRuleAskCard(row.binding))
      await addFromOwnerTap(ctx, row.binding.kind, row.thread_id).catch((e) =>
        ctx.log.warn('always allow not recorded', { card: f.card_id, error: (e as Error).message }),
      )
    if (pre.handled) {
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      // the card.resolve's signed `note` is the owner's Deny note (relay.ts keeps it only for a Deny to a hook)
      // `session` and `session_hash` are signed in the card.resolve too (never a notification's tap): "Allow for this session", only for a hook card
      // that offers it, and only when the hash is that of the rules this bridge holds
      const sent = await ctx.permission.onResolved(
        row,
        f.action,
        f.note,
        it.frame.type === 'card.resolve' && f.session === true,
        it.frame.type === 'card.resolve' ? f.session_hash : undefined,
      )
      // The card says "failed" in the app either way. A tap from a notification was answered "done" by the relay, so it also
      // gets a refusal: the relay turns that into the failed-tap push, and the owner is not left thinking the Allow went through.
      if (!sent.ok && it.frame.type === 'native.act') return this.reject(it, sent.code, sent.reason)
      this.closeDecided(f.card_id, nowMs, out.resolution) // a refused or failed send is already `failed`: this skips it
      return this.done(it)
    }
    if (row.actor === 'bridge' && isRuleAskCard(row.binding)) {
      // An "Allow once" card for one of the kit's ask rules (action-rule-asks.ts): the BRIDGE holds the approval it makes, and only
      // from here, after the owner's signature and the ledger checks. "Always allow" rides only in a signed card.resolve.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      const always = f.always === true && f.action === 'primary' && it.frame.type === 'card.resolve'
      await (ctx.actionRuleAsks?.onResolved(row, f.action, always) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('action rule card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    }
    // A card that names talos-app commands (card-cli.ts): the agent is never told to run them. The BRIDGE runs what the owner was
    // shown, here, only on his signed card.resolve; Kill and Ask for changes go to the agent as for any card.
    if (f.action === 'primary' && row.actor === 'agent' && hasCliField(row.binding))
      return this.applyCliCard(it, row, out.resolution, nowMs)
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
    } else if (row.actor === 'bridge' && isScreenAllowCard(row.binding)) {
      // A screen consent card (screen-consent.ts): the Mac allows the app only from the owner's own signed tap, so the frame
      // goes over as received. The agent is never told; it was answered at once and tries again.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await (ctx.screenConsent?.onResolved(row, f.action, it.raw) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('screen consent card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.actor === 'bridge' && isPluginAddCard(row.binding)) {
      // "Add the <plugin> plugin to your agent?": the BRIDGE installs it, only on the owner's own signed tap (plugins/agent-plugins.ts)
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      // not awaited: a settings card holds every lane while it is handled, and an install takes up to minutes
      void (ctx.agentPlugins?.onResolved(row, f.action) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('plugin card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.actor === 'bridge' && isUpdateResendCard(row.binding)) {
      // "Talos updated while <thread> was working": the BRIDGE sends the message again, only on the owner's own signed tap in the app
      // (router/update-resend.ts). The agent is never told about the card.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await (ctx.updateResend?.onResolved(row, f.action, it.frame.type) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('update resend card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.actor === 'bridge' && isSessionErrorCard(row.binding)) {
      // "<thread> stopped: <what>": the BRIDGE starts a fresh conversation or sends the last message again, only on the owner's own signed
      // tap in the app (router/session-error-cards.ts). The agent is never told about the card.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await (ctx.sessionErrors?.onResolved(row, f.action, it.frame.type) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('session error card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.actor === 'bridge' && isPeerAddressCard(row.binding)) {
      // "<agent> has a new address": the BRIDGE sends the waiting messages to the new address, only on the owner's own signed tap in
      // the app (peer/address-ask.ts). The agent is never told about the card.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await (ctx.peerAddressAsk?.onResolved(row, f.action, it.frame.type) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('peer address card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.actor === 'bridge' && isPermissionModeCard(row.binding)) {
      // A permission-mode consent card (permission-mode.ts): the bridge writes the Mac's request file after the owner's yes, looking
      // at the lock again. The agent is never told; it was answered at once and tries again.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await (ctx.permissionModeConsent?.onResolved(row, f.action, it.frame.type) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('permission mode card not applied', { card: f.card_id, error: (e as Error).message }),
      )
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.binding.kind === 'config' && row.actor === 'bridge') {
      // A settings card (O1): the BRIDGE applies what the owner approved, after checking the allowlist again
      // 'resolved' goes out FIRST: a refusal inside apply() sends 'failed' with no await in front of it, and every app keeps
      // the last frame it saw, so 'resolved' after 'failed' would hide the refusal and leave "Working on it" for good.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      ctx.configProposals?.onCardResolved(row, f.action, out.approved, f.card_id, f.note)
      this.closeDecided(f.card_id, nowMs, out.resolution)
      return this.done(it)
    } else if (row.binding.kind === 'undo' && row.actor === 'bridge') {
      // An undo card: the BRIDGE restores what the owner approved (undo/card.ts). Awaited, so whatever this session is sent
      // next finds the files already back.
      this.fire(cardUpdateFrame(nowMs, { card_id: f.card_id, state: 'resolved', resolution: out.resolution }))
      await (ctx.undoCards?.onResolved(row, f.action, out.approved, f.card_id) ?? Promise.resolve()).catch((e) =>
        ctx.log.warn('undo card apply failed', { card: f.card_id, error: (e as Error).message }),
      )
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

  /**
   * Runs the commands of an approved card (card-cli.ts), posts what they printed to the card's thread and records the result in the
   * ledger. The `telling` marker stays until the end: a bridge that dies mid-run leaves it, and startup ends the card as "may have run".
   */
  async applyCliCard(this: Inbound, it: Item, row: LedgerRow, resolution: ResolutionRecord, nowMs: number) {
    const { ctx } = this
    this.fire(cardUpdateFrame(nowMs, { card_id: row.id, state: 'resolved', resolution }))
    let r: CardCliResult
    try {
      if (it.frame.type !== 'card.resolve') {
        const text = 'Open this card in the app to approve it, so nothing was run.'
        r = { ok: false, ran: 0, text, owner: text }
      } else {
        const { runCli } = await import('./cli-main.ts')
        r = await runCardCli(ctx, row, runCli)
      }
    } catch (e) {
      const text = `Nothing was confirmed: ${(e as Error).message}`
      r = { ok: false, ran: 0, text, owner: text }
    }
    ctx.log.security('card commands run', { card: row.id, thread: row.thread_id, ok: r.ok, ran: r.ran })
    ctx.ledger.settled(row.id)
    if (ctx.ledger.finish(row.id, r.ok))
      this.fire(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: r.ok ? 'done' : 'failed',
          result: { ok: r.ok, text: r.owner, at: new Date(ctx.clock.now()).toISOString(), ran: r.ran > 0 },
        }),
      )
    // The thread gets the summary only: a message there is something the agent reads back (read_thread). What the commands printed is
    // in the card's own result for the owner.
    const title = clipUnits(oneLine(row.binding.title), 80)
    await postSystemNotice(ctx, `"${title}": ${r.text}`, { thread: threadRef(ctx, row.thread_id) }).catch((e) =>
      ctx.log.warn('card output not posted', { error: (e as Error).message }),
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
    const title = clipUnits(oneLine(row.binding.title), 80)
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
      this.endUndelivered(
        row,
        row.resolution,
        hasCliField(row.binding)
          ? 'Talos stopped while running this card. Some of it may have run: check before asking again.'
          : 'This may not have reached your agent. Check before asking again.',
        true,
      )
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
