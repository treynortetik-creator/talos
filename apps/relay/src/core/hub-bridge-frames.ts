// The built-in handling of each bridge frame type once the Mac has authed: acks and the outbox, the durable frames it
// sends (replies, cards, config, threads), status, receipts, and routing an error back to the socket that caused it.
// Handlers of the Hub class (hub.ts), which forwards to them. The socket itself is in hub-bridge-conn.ts.
import { type Frame, type FrameOf, type MessageT, markdownToPlain, NATIVE_ACT_TYPE, newId } from '@talos-app/protocol'
import type { RichPushInput } from '../services.ts'
import type { AppRouter } from './apps.ts'
import { checkNewCard } from './cards.ts'
import type { EphemeralRouter } from './ephemeral.ts'
import { cardRich, countsUnread, threadOf } from './hub-helpers.ts'
import type { AppConn, BridgeConn, HubDeps, Ref } from './hub-types.ts'
import { FrameRejected, REF_TTL_MS } from './hub-types.ts'
import type { ScheduleRouter } from './schedules.ts'
import type { Store, StoredFrame } from './store.ts'
import { mkFrame } from './util.ts'

/** What the bridge-frame handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type BridgeFramesCtx = {
  d: HubDeps
  refs: Map<string, Ref>
  apps: Map<string, AppConn>
  historyReqs: Map<string, Ref & { frameId: string }>
  historyFrameIds: Map<string, number>
  appRouter: AppRouter
  ephemeral: EphemeralRouter
  schedules: ScheduleRouter
  getConfig(): ReturnType<Store['getConfig']>
  setConfig(config: NonNullable<ReturnType<Store['getConfig']>>): void
  cfg(): { default_thread: string }
  sendBridge(frame: Record<string, unknown>): void
  fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void
  stampForApps(frame: Record<string, unknown>): StoredFrame
  deliverStored(stamped: StoredFrame): void
  broadcastPresence(): void
  notify(intent: Parameters<HubDeps['push']['notify']>[0], rich?: RichPushInput): void
  scheduleCardExpiry(cardId: string, expiresAt: number): void
  addedInheritedThread(frame: Frame): string | undefined
  rollbackRejectedResolve(frame: FrameOf<'error'>): void
  noteTwoStageBridge(): void
  startQueuedTimer(seq: number, type: string): void
  clearQueuedTimer(msgId: string): void
  clearThreadQueued(threadId: string): void
  clearDerivedQueued(threadId: string): void
}

export const bridgeFrames = {
  async onBridgeFrameBuiltin(
    this: BridgeFramesCtx,
    _b: BridgeConn,
    frame: Frame,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const store = this.d.store
    switch (frame.type) {
      case 'ping':
        return this.sendBridge(mkFrame(this.d.clock, 'pong', { nonce: frame.nonce }))
      case 'pong':
      case 'hello':
        return
      case 'ack': {
        // A schedule frame's ack has no seq and no outbox row: it goes to the socket that sent the frame.
        const ref = this.refs.get(frame.ref)
        if (ref?.volatile) {
          if (this.d.clock.now() - ref.at <= REF_TTL_MS) this.apps.get(ref.socketId)?.conn.send(JSON.stringify(raw))
          return
        }
        return bridgeFrames.onBridgeAck.call(this, frame)
      }
      case 'app.response':
        return this.appRouter.onResponse(frame, raw)
      case 'schedules.snapshot':
      case 'schedule.detail':
      case 'heartbeat.test_result':
        return this.schedules.onBridgeResponse(frame, raw)
      case 'schedule.status':
        return this.schedules.onStatus(frame, raw)
      case 'replay.request': {
        const wanted = new Set(frame.ids)
        for (const row of store.outboxAll())
          if (wanted.has(row.frame_id) && (row.consumable || !row.delivered)) this.deliverStored(row.frame)
        return
      }
      case 'error':
        return bridgeFrames.forwardError.call(this, frame, raw)
      case 'receipt':
        store.setReceipt(frame.message_id, frame.state)
        if (frame.state === 'seen') this.clearQueuedTimer(frame.message_id)
        return this.fanOut(raw)
      case 'status': {
        store.setStatus(frame)
        this.clearThreadQueued(frame.thread_id)
        return this.fanOut(raw)
      }
      case 'search.results':
      case 'memory.listing':
      case 'memory.file':
      case 'memory.results':
      case 'speak.result':
      case 'fs.listing':
        return this.ephemeral.onResponse(frame, raw)
      case 'health.beat':
        // WP-V1 (core/health.ts) reads it through a bridge handler; the relay keeps the last one (V2.3, rule 1)
        return this.d.store.setState('health_beat', JSON.stringify(frame.beat))
      case 'history.page': {
        const ref = this.historyReqs.get(frame.request_id)
        this.historyReqs.delete(frame.request_id)
        const a = ref ? this.apps.get(ref.socketId) : undefined
        if (a?.authed) a.conn.send(JSON.stringify(raw))
        return
      }
      case 'reply':
      case 'card.create':
      case 'card.update':
      case 'transcript':
      case 'thread.upsert':
      case 'thread.archive':
      case 'config.sync':
      case 'inbox.update':
      case 'app.update':
      case 'device.pinned': {
        try {
          const { seq } = bridgeFrames.processBridgeDurable.call(this, frame, raw)
          this.sendBridge(mkFrame(this.d.clock, 'ack', { ref: frame.id, seq }))
        } catch (e) {
          if (e instanceof FrameRejected) {
            this.sendBridge(mkFrame(this.d.clock, 'error', { ref: frame.id, code: e.code, message: e.message }))
          } else throw e
        }
        return
      }
      default:
        return
    }
  },

  /** The bridge acked a frame it received (`delivered`) or pushed into Claude (`consumed`). */
  onBridgeAck(this: BridgeFramesCtx, frame: FrameOf<'ack'>): void {
    if (frame.stage === 'consumed') this.noteTwoStageBridge()
    const row = this.d.store.outboxRow(frame.ref)
    if (!row) return
    if (frame.stage === 'consumed') {
      this.d.store.dropOutbox(frame.ref)
      this.d.store.dropWorkFrame(frame.ref)
      this.startQueuedTimer(row.seq, row.type)
    } else {
      this.d.store.markDelivered(frame.ref)
      if (!row.consumable) this.d.store.dropOutbox(frame.ref)
    }
    this.broadcastPresence()
  },

  /** Durable frames from the bridge, over the socket or POST /bridge/post. Idempotent on the frame id. */
  processBridgeDurable(
    this: BridgeFramesCtx,
    frame: Frame,
    raw: Record<string, unknown>,
  ): { seq: number; duplicate: boolean } {
    const store = this.d.store
    const dup = store.seen(`bf:${frame.id}`)
    if (dup !== undefined) return { seq: dup, duplicate: true }
    const threadId = threadOf(raw)
    // The plain explanation of a permission card rides a card.update that repeats the card's state (older apps require the
    // field). It only fills in the stored card's explanation, and only while the card is pending and still waiting for one
    // (first answer wins); it never moves the card. The frame the apps get carries the card's real state, so an older app that
    // applies the state in it does not reopen a card the owner has already answered.
    let stored = raw
    const explainOnly =
      frame.type === 'card.update' && frame.explain !== undefined && !frame.resolution && !frame.result
        ? frame
        : undefined
    if (explainOnly) {
      const known = store.getCard(explainOnly.card_id)
      if (known) stored = { ...raw, state: known.state }
    }
    let reject: string | null = null
    if (frame.type === 'card.create') reject = checkNewCard(frame.card)
    if (reject) throw new FrameRejected('bad_frame', `card rejected: ${reject}`)
    const inherited = this.addedInheritedThread(frame)
    if (inherited) throw new FrameRejected('bad_frame', `thread id "${inherited}" is a name every object already has`)

    // The event, the seen id and the frame's own row are one transaction. If any write fails nothing is kept, no
    // dedupe id included, so the bridge's resend of the same frame is a first attempt and not an ack for nothing.
    // The pushes and timers come after the commit.
    let applyConfig = false
    const stamped = store.db.transaction((): StoredFrame => {
      const s = store.appendEvent({ frame: stored, audience: 'app', threadId, countsUnread: countsUnread(raw) })
      store.remember(`bf:${frame.id}`, s.relay.seq)
      switch (frame.type) {
        case 'card.create':
          store.putCard(frame.card)
          break
        case 'card.update':
          if (explainOnly) {
            const known = store.getCard(explainOnly.card_id)
            if (
              known?.state === 'pending' &&
              known.explain?.status === 'pending' &&
              explainOnly.explain?.status !== 'pending'
            )
              store.setCardState(explainOnly.card_id, { explain: explainOnly.explain })
            break
          }
          store.setCardState(frame.card_id, {
            state: frame.state,
            ...(frame.resolution ? { resolution: frame.resolution } : {}),
            ...(frame.result ? { result: frame.result } : {}),
          })
          break
        case 'transcript':
          store.setTranscript(frame.message_id, { text: frame.text, engine: frame.engine, status: frame.status })
          break
        case 'thread.upsert':
          store.upsertThread(frame.thread)
          break
        case 'thread.archive':
          store.archiveThread(frame.thread_id)
          break
        case 'config.sync':
          if (!this.getConfig() || frame.rev >= this.getConfig()!.rev) {
            store.setConfig(frame.config)
            applyConfig = true
          }
          break
        default:
          break
      }
      return s
    })()

    switch (frame.type) {
      case 'reply':
        this.clearThreadQueued(frame.message.thread_id)
        this.clearDerivedQueued(frame.message.thread_id)
        if (!frame.silent) {
          this.notify(
            {
              template: frame.voice_delegation_id ? 'answer_ready' : 'reply',
              thread_id: frame.message.thread_id,
            },
            frame.message.text && !frame.voice_delegation_id
              ? {
                  // a heartbeat digest carries outside text: the push says so first, so it cannot read as Talos itself
                  text: `${frame.message.heartbeat ? 'Heartbeat: ' : ''}${frame.message.format === 'plain' ? frame.message.text : markdownToPlain(frame.message.text)}`,
                }
              : undefined,
          )
        }
        break
      case 'card.create':
        this.scheduleCardExpiry(frame.card.id, Date.parse(frame.card.expires_at))
        this.notify(
          {
            template: 'needs_you',
            thread_id: frame.card.thread_id,
            card_id: frame.card.id,
            expires_at: frame.card.expires_at,
          },
          cardRich(frame.card),
        )
        break
      case 'config.sync':
        if (applyConfig) this.setConfig(frame.config)
        break
      case 'device.pinned':
        if (frame.ok) this.notify({ template: 'device_pinned' })
        break
      default:
        break
    }
    this.fanOut(stamped)
    return { seq: stamped.relay.seq, duplicate: false }
  },

  /** error{ref} from the bridge -> the socket that sent `ref` (10 min), else a system message in the frame's thread. */
  forwardError(this: BridgeFramesCtx, frame: FrameOf<'error'>, raw: Record<string, unknown>): void {
    if (!frame.ref) return
    if (this.ephemeral.onError(frame.ref, raw)) return // a read's error: to the asker or nowhere, never stored
    if (this.appRouter.onError(frame)) return // an app request's error: to the asker as a failed app.response
    // A history request's error (unsigned, forged, replayed): to the asker or nowhere, never stored as a system message.
    for (const h of this.historyReqs.values()) {
      if (h.frameId !== frame.ref) continue
      const asker = this.apps.get(h.socketId)
      if (asker?.authed) asker.conn.send(JSON.stringify(raw))
      return
    }
    // A history request whose route already expired (a slow Mac answering late): to nobody, never a thread message.
    if (this.historyFrameIds.has(frame.ref)) return
    const ref = this.refs.get(frame.ref)
    const a = ref && this.d.clock.now() - ref.at <= REF_TTL_MS ? this.apps.get(ref.socketId) : undefined
    // A read's refusal (media.fetch) is the asker's alone: it must never touch a stored frame that shares the id.
    if (ref?.volatile) {
      if (a?.authed) a.conn.send(JSON.stringify(raw))
      return
    }
    this.rollbackRejectedResolve(frame)
    const wasNativeTap =
      (this.d.store.getEventByFrameId(frame.ref) as { type?: string } | null)?.type === NATIVE_ACT_TYPE
    if (a?.authed) return void a.conn.send(JSON.stringify(raw))
    // A schedule error is never stored or turned into a thread message: nobody asked for it any more.
    if (ref?.volatile || this.d.store.seen(`sf:${frame.ref}`) !== undefined) return
    const ev = this.d.store.getEventByFrameId(frame.ref)
    const threadId = ref?.threadId ?? ev?._thread ?? this.cfg().default_thread
    const message: MessageT = {
      id: newId('m'),
      thread_id: threadId,
      author: 'system',
      kind: 'text',
      text: `An action was rejected (${frame.code}): ${frame.message}`,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(this.d.clock.now()).toISOString(),
    }
    const stamped = this.stampForApps(mkFrame(this.d.clock, 'message.stored', { client_msg_id: message.id, message }))
    this.fanOut(stamped)
    // The relay told the phone "ok" when it queued a notification tap. The Mac has now refused it, and the owner may be
    // away from the app: a row in the thread alone would leave them thinking it went through. Say so with a push.
    if (wasNativeTap) this.notify({ template: 'action_failed', thread_id: threadId })
  },
}
