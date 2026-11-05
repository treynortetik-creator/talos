// Relay -> bridge frames. Processed strictly one at a time, in arrival order. Owner frames are verified on the RAW
// JSON first; anything that fails any check is dropped (an error to the relay, a `system` notice to the agent, never the
// content). Trust is decided here, by frame type and signature result.
import {
  CONSUMABLE_FRAME_TYPES,
  DeviceId,
  ErrorCode,
  type ErrorCodeT,
  type Frame,
  HEARTBEAT_OWNER_FRAME_TYPES,
  OWNER_FRAME_TYPES,
  SCHEDULE_OWNER_FRAME_TYPES,
  SESSION_CONSUMABLE_FRAME_TYPES,
  V2_READ_OWNER_FRAME_TYPES,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { onAgentRecover, resendAgentRecover } from './agent-recover.ts'
import type { CardExpiry } from './card-expiry.ts'
import { type BridgeContext, defaultThreadRef } from './context.ts'
import type { Enrollment } from './enrollment.ts'
import { ackFrame, errorFrame } from './frames-out.ts'
import { MAX_FUTURE_MS } from './history-store.ts'
import { cardsFrames } from './inbound-cards.ts'
import { configFrames } from './inbound-config.ts'
import { eventsFrames } from './inbound-events.ts'
import { messagesFrames } from './inbound-messages.ts'
import { readsFrames } from './inbound-reads.ts'
import { runsFrames } from './inbound-runs.ts'
import { scheduleFrames } from './inbound-schedule.ts'
import { CLOCK_OFF_MESSAGE, type Item, type Of, type OwnerCheck } from './inbound-shared.ts'
import { systemNotification } from './notify.ts'
import { onThreadSessionControl } from './router/controls.ts'
import { LiveTransport } from './transport.ts'

export { CLOCK_OFF_MESSAGE } from './inbound-shared.ts'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
// session.control is consumable here ("consumed" = its result was recorded, C2.5); session.spawn is WP-C7's, not yet.
// thread.session.control (docs/OPTION-C.md) follows session.control: consumed once its result is recorded
const CONSUMABLE = new Set<string>([
  ...CONSUMABLE_FRAME_TYPES,
  ...SESSION_CONSUMABLE_FRAME_TYPES.filter((t) => t === 'session.control'),
  'thread.session.control',
  'agent.recover',
])
const SCHEDULE_OWNER = new Set<string>([...SCHEDULE_OWNER_FRAME_TYPES, ...HEARTBEAT_OWNER_FRAME_TYPES])
const V2_READ = new Set<string>(V2_READ_OWNER_FRAME_TYPES)
/**
 * Signed owner READS that are ephemeral: never queued, never acked, answered on the read queue. A failed one is refused
 * with the fixed error and its id is NOT remembered (docs/PROTOCOL.md "Signed history reads"): marking it would let
 * unsigned junk grow seen_ids for 8 days, and checking seen_ids before the signature would be a key-less seen-id oracle.
 */
const EPHEMERAL_READ = new Set<string>([...V2_READ_OWNER_FRAME_TYPES, 'history.request', 'media.fetch'])
const OTHER_DURABLE = new Set(['config.patch', 'device.enrolled', 'device.revoked'])
const MAX_AGE_MS = 8 * 24 * 3600_000

export const BACKLOG_AFTER_MS = 15 * 60_000
const SIG_NOTICE_LIMIT = 5
const SIG_NOTICE_WINDOW_MS = 10 * 60_000

export type InboundOptions = { settleMs?: number; maxSettleMs?: number }

export class Inbound {
  private queue: Promise<void> = Promise.resolve()
  /** Signature checks for schedule frames: a queue of its own, so a slow scheduler never delays a chat message (S3.1). */
  schedQueue: Promise<void> = Promise.resolve()
  /** Signed v2 reads (search, memory): their own queue, so a search never waits behind chat (docs/V2-FEATURES.md V1.3). */
  readQueue: Promise<void> = Promise.resolve()
  /** Signed MCP-app requests (MCP-APPS-SPEC M4.3): their own queue, so a slow app never delays chat. */
  appQueue: Promise<void> = Promise.resolve()
  inflight = new Set<string>()
  private collecting = false
  private collected: Item[] = []
  private settleTimer: unknown = null
  private maxTimer: unknown = null
  private sigNotices: number[] = []

  constructor(
    readonly ctx: BridgeContext,
    private readonly enroll: Enrollment,
    readonly expiry: CardExpiry,
    private readonly opts: InboundOptions = {},
  ) {}

  /** Resolves when everything queued so far has been processed (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue
  }

  // ---- entry points ------------------------------------------------------------------------------------------

  /** After `ready` the relay re-sends every unconsumed frame in one burst; collect it so old owner items batch. */
  onReady() {
    // A reconnect inside the previous burst's settle window: those items are acked `delivered` and held in `inflight`, so
    // the replay would skip them. Process them now instead of dropping them.
    this.flushCollected()
    this.collecting = true
    this.collected = []
    this.armSettle()
    this.maxTimer = this.ctx.clock.setTimeout(() => this.flushCollected(), this.opts.maxSettleMs ?? 2000)
  }

  /**
   * A relay frame that did not parse. Owner frames with a missing, malformed (a DER signature is longer than 86 chars) or
   * extra-field body are signature failures: nothing of them is delivered. Anything consumable is acked `consumed` after
   * the error, so it cannot sit in the relay's replay buffer.
   */
  onBadFrame(raw: Record<string, unknown> | undefined, message: string) {
    const { ctx } = this
    const id = typeof raw?.id === 'string' && ULID.test(raw.id) ? raw.id : undefined
    const type = typeof raw?.type === 'string' ? raw.type : ''
    // history.request and media.fetch are signed owner reads too (they are not in OWNER_FRAME_TYPES: their handlers differ)
    const ownerFrame = (OWNER_FRAME_TYPES as readonly string[]).includes(type) || EPHEMERAL_READ.has(type)
    ctx.log.warn('relay frame did not parse', { id, type, message })
    if (!id) {
      ctx.transport.sendEphemeral(errorFrame(ctx.clock.now(), 'bad_frame', message))
      return
    }
    // A signed read that did not parse gets the one fixed refusal whether or not its id was ever used: only a valid
    // signature learns that, so the seen-id check below is skipped for it and nothing of it is remembered.
    const ephemeral = EPHEMERAL_READ.has(type)
    if (
      (type === 'history.request' || type === 'media.fetch') &&
      (typeof raw?.osig !== 'string' || typeof raw?.device_id !== 'string')
    )
      return this.refuseUnsigned(id, type)
    if (!ephemeral && ctx.store.hasSeen(id)) {
      if (OTHER_DURABLE.has(type)) this.ack(id, 'delivered') // already dealt with; let the relay forget it
      return
    }
    if (this.inflight.has(id)) return
    if (SCHEDULE_OWNER.has(type) && raw) return this.onBadScheduleFrame(raw, id, type, message)
    this.queue = this.queue
      .then(async () => {
        const item = { raw: raw ?? {}, frame: { type, id } as unknown as Frame, receivedAt: ctx.clock.now() } as Item
        if (ownerFrame) {
          const dev = DeviceId.safeParse(raw?.device_id)
          return this.ownerFailed(item, {
            ok: false,
            reason: 'unparseable_owner_frame',
            ...(dev.success ? { deviceId: dev.data } : {}),
          })
        }
        this.reject(item, 'bad_frame', message)
      })
      .catch((e) => ctx.log.error('bad frame handling failed', { error: (e as Error).message }))
  }

  onFrame(raw: Record<string, unknown>, frame: Frame) {
    const { ctx } = this
    if (SCHEDULE_OWNER.has(frame.type)) return this.onScheduleFrame({ raw, frame, receivedAt: ctx.clock.now() })
    if (V2_READ.has(frame.type)) return this.onReadFrame({ raw, frame, receivedAt: ctx.clock.now() })
    if (frame.type === 'history.request') return this.onHistoryFrame({ raw, frame, receivedAt: ctx.clock.now() })
    if (frame.type === 'media.fetch') return this.onMediaFetchFrame({ raw, frame, receivedAt: ctx.clock.now() })
    if (frame.type === 'app.request') return this.onAppFrame({ raw, frame, receivedAt: ctx.clock.now() })
    // A revoke must beat any read already waiting on the read queue: apply it on arrival, ahead of the main queue (which
    // can be blocked behind the agent). The queued handler below still posts the notice and acks; revoking twice is a no-op.
    // No seen-id skip: a redelivered old revoke can only hit the id it named, and a revoked id is a permanent tombstone
    // (devices.pin refuses it), so a device enrolled again always has a NEW id and is never touched.
    if (frame.type === 'device.revoked') {
      try {
        ctx.devices.revoke(frame.device_id, new Date(ctx.clock.now()).toISOString())
      } catch (e) {
        ctx.log.error('early device revoke failed', { error: (e as Error).message })
      }
    }
    switch (frame.type) {
      case 'ack':
        return // handled by the transport
      case 'error':
        ctx.log.warn('relay reported an error', { code: frame.code, ref: frame.ref })
        // an error{ref} for a durable frame we sent means the relay will never accept it: drop the outbox row, fail the tool
        if (frame.ref && ctx.transport instanceof LiveTransport)
          ctx.transport.onError(frame.ref, frame.code, frame.message)
        return
    }
    const consumable = CONSUMABLE.has(frame.type)
    if (consumable || OTHER_DURABLE.has(frame.type)) {
      if (ctx.store.hasSeen(frame.id)) {
        if (frame.type === 'session.control' || frame.type === 'thread.session.control')
          ctx.session.resend(frame.control_id) // the stored result, not a second run
        if (frame.type === 'agent.recover') resendAgentRecover(ctx, frame.control_id)
        if (frame.type === 'native.act' && !this.resendRefusal(frame.id)) return // not sent: no ack, so the relay replays it again
        this.ack(frame.id, consumable ? 'consumed' : 'delivered')
        return
      }
      if (this.inflight.has(frame.id)) {
        // still being worked on: a consumable can be acked `delivered` (the relay keeps it until `consumed`); a
        // config.patch / device.* is acked once, by done(), after it has been applied
        if (consumable) this.ack(frame.id, 'delivered')
        return
      }
      this.inflight.add(frame.id)
      // `delivered` makes the relay forget config.patch / device.enrolled / device.revoked, so those are acked only after
      // processing (done()): a crash in between leaves them in the relay's buffer and they are replayed
      if (consumable) this.ack(frame.id, 'delivered')
    }
    const item: Item = { raw, frame, receivedAt: ctx.clock.now() }
    if (this.collecting && consumable) {
      this.collected.push(item)
      this.armSettle()
      return
    }
    this.enqueue([item], false)
  }

  // ---- schedule frames (docs/SCHEDULES.md S2.2) -----------------------------------------------------------------

  // ---- signed v2 reads (docs/V2-FEATURES.md V1.3) ------------------------------------------------------------------

  /** Resolves when every queued read has been answered (tests). */
  readsIdle(): Promise<void> {
    return this.readQueue
  }

  /** Resolves when every queued app request has been handled (tests). */
  appsIdle(): Promise<void> {
    return this.appQueue
  }

  // ---- batching ----------------------------------------------------------------------------------------------

  private armSettle() {
    if (this.settleTimer) this.ctx.clock.clearTimeout(this.settleTimer)
    this.settleTimer = this.ctx.clock.setTimeout(() => this.flushCollected(), this.opts.settleMs ?? 250)
  }

  private flushCollected() {
    if (!this.collecting) return
    this.collecting = false
    if (this.settleTimer) this.ctx.clock.clearTimeout(this.settleTimer)
    if (this.maxTimer) this.ctx.clock.clearTimeout(this.maxTimer)
    this.settleTimer = this.maxTimer = null
    const items = this.collected
    this.collected = []
    if (items.length) this.enqueue(items, true)
  }

  private enqueue(items: Item[], fromReplay: boolean) {
    this.queue = this.queue
      .then(() => this.processBatch(items, fromReplay))
      .catch((e) => this.ctx.log.error('inbound batch failed', { error: (e as Error).message }))
  }

  private async processBatch(items: Item[], fromReplay: boolean) {
    let backlog: Item[] = []
    if (fromReplay) {
      for (const it of items) {
        if (it.frame.type !== 'message' && it.frame.type !== 'voice_note') continue
        it.owner = await this.verifyOwner(it)
        // A Run is never folded into a backlog note: that note gets a fresh time, and a Run is judged on its own age.
        if (
          it.owner.ok &&
          (it.frame as Of<'message'>).intent !== 'run' &&
          this.isStale(it) &&
          !this.ctx.store.hasSeen((it.frame as Of<'message'>).client_msg_id)
        )
          backlog.push(it)
      }
      if (backlog.length < 2) backlog = []
    }
    if (backlog.length) await this.guard(backlog[0] as Item, () => this.handleBacklog(backlog), backlog)
    for (const it of items) {
      if (backlog.includes(it)) continue
      await this.guard(it, () => this.processOne(it), [it])
    }
  }

  /** One bad frame must not stop the queue; it stays unconsumed and the relay re-sends it on the next hello. */
  private async guard(_first: Item, fn: () => Promise<void>, all: Item[]) {
    try {
      await fn()
    } catch (e) {
      this.ctx.log.error('frame processing failed', {
        type: _first.frame.type,
        id: _first.frame.id,
        error: (e as Error).message,
      })
      for (const it of all) this.inflight.delete(it.frame.id)
    }
  }

  receivedAtOf(it: Item): number {
    const r = (it.raw.relay as { received_at?: string } | undefined)?.received_at
    const t = r ? Date.parse(r) : Date.parse(it.frame.ts)
    return Number.isFinite(t) ? t : it.receivedAt
  }
  private isStale(it: Item): boolean {
    return this.ctx.clock.now() - this.receivedAtOf(it) > BACKLOG_AFTER_MS
  }

  // ---- acks and rejections ------------------------------------------------------------------------------------

  private ack(ref: string, stage: 'delivered' | 'consumed') {
    this.ctx.transport.sendEphemeral(ackFrame(this.ctx.clock.now(), ref, stage))
  }

  fire(frame: Frame) {
    this.ctx.transport
      .sendDurable(frame)
      .catch((e) => this.ctx.log.warn('durable send failed', { type: frame.type, error: (e as Error).message }))
  }

  /** Seen + consumed. Marking happens only after the notification went out, so a crash before it replays the frame. */
  done(it: Item, extraIds: string[] = [], outcome = 'ok') {
    const { ctx } = this
    const now = ctx.clock.now()
    ctx.store.markSeen(it.frame.id, now, outcome)
    for (const id of extraIds) ctx.store.markSeen(id, now, outcome)
    this.inflight.delete(it.frame.id)
    if (CONSUMABLE.has(it.frame.type)) this.ack(it.frame.id, 'consumed')
    else if (OTHER_DURABLE.has(it.frame.type)) this.ack(it.frame.id, 'delivered')
  }

  /**
   * A replayed notification tap this Mac already refused. The first refusal may have gone out on a socket that died, and the
   * relay told the phone "done", so the stored outcome is sent again (the relay turns it into the failed-tap push). Returns
   * false when the refusal could not be sent now; the caller then does not ack and the relay replays the tap once more.
   */
  private resendRefusal(id: string): boolean {
    const { ctx } = this
    const outcome = ctx.store.seenOutcome(id)
    if (!outcome?.startsWith('rejected:')) return true
    const parsed = ErrorCode.safeParse(outcome.slice('rejected:'.length))
    return ctx.transport.sendEphemeral(
      errorFrame(
        ctx.clock.now(),
        parsed.success ? parsed.data : 'internal',
        'That tap did not go through. Open Talos to check.',
        id,
      ),
    )
  }

  /** error{ref, code} to the relay, then consumed, so the frame does not sit in the replay buffer for a week. */
  reject(
    it: Item,
    code: ErrorCodeT,
    message: string,
    extraIds: string[] = [],
    fields?: Array<{ path: string; message: string }>,
  ) {
    const sent = this.ctx.transport.sendEphemeral(errorFrame(this.ctx.clock.now(), code, message, it.frame.id, fields))
    if (!sent && it.frame.type === 'native.act') {
      // The relay told the phone "done" when it queued this tap, so the refusal must not be lost with the socket. Do not mark
      // the id seen and do not say `consumed`: the relay keeps the frame and sends it again on the next hello, and the
      // refusal is decided again and sent then.
      this.ctx.log.warn('refusal of a notification tap not sent; the relay will replay the tap', {
        id: it.frame.id,
        code,
      })
      this.inflight.delete(it.frame.id)
      return
    }
    this.done(it, extraIds, `rejected:${code}`)
  }

  // ---- owner frames --------------------------------------------------------------------------------------------

  /**
   * Pinned device, signature over the RAW JSON (never a zod-parsed copy), `ts` within now+2 min / now-8 days. The
   * duplicate-id check happened on receipt; `client_msg_id` replays are caught by the caller.
   */
  async verifyOwner(it: Item, maxAgeMs = MAX_AGE_MS): Promise<OwnerCheck> {
    const { ctx } = this
    const rawDevice = it.raw.device_id
    const parsed = DeviceId.safeParse(rawDevice)
    if (!parsed.success) return { ok: false, reason: 'bad_device_id' }
    const deviceId = parsed.data
    const jwk = ctx.devices.pinnedKey(deviceId)
    if (!jwk)
      return { ok: false, reason: ctx.devices.isRevoked(deviceId) ? 'device_revoked' : 'device_not_pinned', deviceId }
    if (!(await verifyOwnerFrame(it.raw, jwk))) return { ok: false, reason: 'bad_signature', deviceId }
    const ts = Date.parse(it.frame.ts)
    const now = ctx.clock.now()
    if (!Number.isFinite(ts) || ts > now + MAX_FUTURE_MS || ts < now - maxAgeMs)
      return { ok: false, reason: 'stale_ts', deviceId }
    return { ok: true, deviceId }
  }

  async ownerFailed(it: Item, why: Extract<OwnerCheck, { ok: false }>) {
    const { ctx } = this
    ctx.log.security('owner frame dropped', {
      type: it.frame.type,
      id: it.frame.id,
      reason: why.reason,
      device_id: why.deviceId,
    })
    // The signature held but `ts` is outside the window: a phone clock that is off (or a relay replaying an old frame,
    // refused all the same). Say so plainly, and raise no forged-signature alarm to the agent or the owner.
    // An ephemeral read that failed is answered and forgotten: nothing lands in seen_ids (a relay or a stolen session
    // could otherwise grow it by 30 junk frames a second for 8 days, each costing a signature check).
    const refuse = (code: ErrorCodeT, message: string) => {
      if (!EPHEMERAL_READ.has(it.frame.type)) return this.reject(it, code, message)
      ctx.transport.sendEphemeral(errorFrame(ctx.clock.now(), code, message, it.frame.id))
      this.inflight.delete(it.frame.id)
    }
    if (why.reason === 'stale_ts') return refuse('stale', CLOCK_OFF_MESSAGE)
    refuse('sig_invalid', 'signature check failed')
    const now = ctx.clock.now()
    this.sigNotices = this.sigNotices.filter((t) => now - t < SIG_NOTICE_WINDOW_MS)
    if (this.sigNotices.length >= SIG_NOTICE_LIMIT) return // a flood of forged frames must not flood the agent either
    this.sigNotices.push(now)
    const id = why.deviceId ?? 'unknown'
    await ctx.emit(
      systemNotification({
        thread: defaultThreadRef(ctx),
        text: `A message from device ${id} failed its signature check and was dropped.`,
        ts: new Date(now).toISOString(),
        id: it.frame.id,
      }),
    )
  }

  // ---- dispatch --------------------------------------------------------------------------------------------------

  private async processOne(it: Item) {
    const f = it.frame
    switch (f.type) {
      case 'message':
      case 'voice_note':
      case 'card.resolve':
      case 'voice.ask':
      case 'session.control':
      case 'thread.session.control':
      case 'agent.recover':
      case 'config.patch': {
        const owner = it.owner ?? (await this.verifyOwner(it))
        if (!owner.ok) return this.ownerFailed(it, owner)
        if (f.type === 'thread.session.control') return onThreadSessionControl(this.ctx, f, () => this.done(it))
        if (f.type === 'agent.recover') return onAgentRecover(this.ctx, f, () => this.done(it))
        if (f.type === 'message') return this.onMessage(it, f)
        if (f.type === 'voice_note') return this.onVoiceNote(it, f)
        if (f.type === 'card.resolve') return this.onCardResolve(it, f)
        if (f.type === 'voice.ask') return this.onVoiceAsk(it, f)
        if (f.type === 'session.control') return this.ctx.session.onControl(f, () => this.done(it))
        return this.onConfigPatch(it, f)
      }
      case 'native.act':
        return this.onNativeAct(it, f)
      case 'hook.event':
        return this.onHookEvent(it, f)
      case 'hook.digest':
        return this.onHookDigest(it, f)
      case 'voice.ended':
        return this.onVoiceEnded(it, f)
      case 'share.item':
        return this.onShareItem(it, f)
      case 'problem.item':
        return this.onProblemItem(it, f)
      case 'device.enrolled':
        await this.enroll.onEnrolled(f)
        return this.done(it)
      case 'device.revoked':
        await this.enroll.onRevoked(f)
        return this.done(it)
      default:
        this.ctx.log.warn('unhandled relay frame', { type: f.type })
    }
  }

  // ---- native actions (Reply / Approve from a notification) ---------------------------------------------------------

  // ---- messages --------------------------------------------------------------------------------------------------

  // ---- cards -----------------------------------------------------------------------------------------------------

  // ---- voice, hooks ------------------------------------------------------------------------------------------------

  // ---- frame families ------------------------------------------------------------------------------------------
  // The handlers live in inbound-*.ts, one file per family. Each method here forwards to its handler with the same arguments.

  private onScheduleFrame(...args: Parameters<typeof scheduleFrames.onScheduleFrame>) {
    return scheduleFrames.onScheduleFrame.apply(this, args)
  }

  private onBadScheduleFrame(...args: Parameters<typeof scheduleFrames.onBadScheduleFrame>) {
    return scheduleFrames.onBadScheduleFrame.apply(this, args)
  }

  private onReadFrame(...args: Parameters<typeof readsFrames.onReadFrame>) {
    return readsFrames.onReadFrame.apply(this, args)
  }

  private onHistoryFrame(...args: Parameters<typeof readsFrames.onHistoryFrame>) {
    return readsFrames.onHistoryFrame.apply(this, args)
  }

  refuseUnsigned(...args: Parameters<typeof readsFrames.refuseUnsigned>) {
    return readsFrames.refuseUnsigned.apply(this, args)
  }

  private onMediaFetchFrame(...args: Parameters<typeof readsFrames.onMediaFetchFrame>) {
    return readsFrames.onMediaFetchFrame.apply(this, args)
  }

  private onAppFrame(...args: Parameters<typeof readsFrames.onAppFrame>) {
    return readsFrames.onAppFrame.apply(this, args)
  }

  refuseReplay(...args: Parameters<typeof readsFrames.refuseReplay>) {
    return readsFrames.refuseReplay.apply(this, args)
  }

  answerRead(...args: Parameters<typeof readsFrames.answerRead>) {
    return readsFrames.answerRead.apply(this, args)
  }

  onHistoryRequest(...args: Parameters<typeof readsFrames.onHistoryRequest>) {
    return readsFrames.onHistoryRequest.apply(this, args)
  }

  onMediaFetch(...args: Parameters<typeof readsFrames.onMediaFetch>) {
    return readsFrames.onMediaFetch.apply(this, args)
  }

  fetchAttachments(...args: Parameters<typeof messagesFrames.fetchAttachments>) {
    return messagesFrames.fetchAttachments.apply(this, args)
  }

  record(...args: Parameters<typeof messagesFrames.record>) {
    return messagesFrames.record.apply(this, args)
  }

  seq(...args: Parameters<typeof messagesFrames.seq>) {
    return messagesFrames.seq.apply(this, args)
  }

  messageExtras(...args: Parameters<typeof messagesFrames.messageExtras>) {
    return messagesFrames.messageExtras.apply(this, args)
  }

  messageRow(...args: Parameters<typeof messagesFrames.messageRow>) {
    return messagesFrames.messageRow.apply(this, args)
  }

  onMessage(...args: Parameters<typeof messagesFrames.onMessage>) {
    return messagesFrames.onMessage.apply(this, args)
  }

  afterOwnerNotify(...args: Parameters<typeof messagesFrames.afterOwnerNotify>) {
    return messagesFrames.afterOwnerNotify.apply(this, args)
  }

  voiceNoteContent(...args: Parameters<typeof messagesFrames.voiceNoteContent>) {
    return messagesFrames.voiceNoteContent.apply(this, args)
  }

  private onVoiceNote(...args: Parameters<typeof messagesFrames.onVoiceNote>) {
    return messagesFrames.onVoiceNote.apply(this, args)
  }

  private handleBacklog(...args: Parameters<typeof messagesFrames.handleBacklog>) {
    return messagesFrames.handleBacklog.apply(this, args)
  }

  onRun(...args: Parameters<typeof runsFrames.onRun>) {
    return runsFrames.onRun.apply(this, args)
  }

  private onNativeAct(...args: Parameters<typeof cardsFrames.onNativeAct>) {
    return cardsFrames.onNativeAct.apply(this, args)
  }

  onCardResolve(...args: Parameters<typeof cardsFrames.onCardResolve>) {
    return cardsFrames.onCardResolve.apply(this, args)
  }

  tellAgent(...args: Parameters<typeof cardsFrames.tellAgent>) {
    return cardsFrames.tellAgent.apply(this, args)
  }

  endUndelivered(...args: Parameters<typeof cardsFrames.endUndelivered>) {
    return cardsFrames.endUndelivered.apply(this, args)
  }

  cardNotDelivered(...args: Parameters<typeof cardsFrames.cardNotDelivered>) {
    return cardsFrames.cardNotDelivered.apply(this, args)
  }

  sweepInterrupted(...args: Parameters<typeof cardsFrames.sweepInterrupted>) {
    return cardsFrames.sweepInterrupted.apply(this, args)
  }

  closeDecided(...args: Parameters<typeof cardsFrames.closeDecided>) {
    return cardsFrames.closeDecided.apply(this, args)
  }

  private onConfigPatch(...args: Parameters<typeof configFrames.onConfigPatch>) {
    return configFrames.onConfigPatch.apply(this, args)
  }

  private onVoiceAsk(...args: Parameters<typeof eventsFrames.onVoiceAsk>) {
    return eventsFrames.onVoiceAsk.apply(this, args)
  }

  private onVoiceEnded(...args: Parameters<typeof eventsFrames.onVoiceEnded>) {
    return eventsFrames.onVoiceEnded.apply(this, args)
  }

  private onShareItem(...args: Parameters<typeof eventsFrames.onShareItem>) {
    return eventsFrames.onShareItem.apply(this, args)
  }

  private onProblemItem(...args: Parameters<typeof eventsFrames.onProblemItem>) {
    return eventsFrames.onProblemItem.apply(this, args)
  }

  private onHookEvent(...args: Parameters<typeof eventsFrames.onHookEvent>) {
    return eventsFrames.onHookEvent.apply(this, args)
  }

  private onHookDigest(...args: Parameters<typeof eventsFrames.onHookDigest>) {
    return eventsFrames.onHookDigest.apply(this, args)
  }
}
