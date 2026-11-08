// Owner frames the Mac never took: the report before the sweep deletes them, and the day-6 warning.
// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks (session, pairing,
// schema) are in hub-app-conn.ts and hub-app-frames.ts; some handlers here run their own device, seen-id, step-up
// or card-state checks, so read both when auditing trust.
import { type MessageT, NATIVE_ACT_TYPE, nativeReplyMessageId, newId } from '@talos-app/protocol'
import type { RichPushInput } from '../services.ts'
import type { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import type { Hub, HubDeps } from './hub.ts'
import type { StoredFrame } from './store.ts'
import { DAY_MS, mkFrame } from './util.ts'

/** What the undelivered handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type UndeliveredCtx = {
  d: HubDeps
  fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void
  stampForApps(frame: Record<string, unknown>): StoredFrame
  cfg(): NonNullable<ReturnType<Hub['agentConfig']>> | typeof DEFAULT_AGENT_CONFIG
  notify(intent: Parameters<HubDeps['push']['notify']>[0], rich?: RichPushInput): void
  clearQueuedTimer(msgId: string): void
  bridgeIsTwoStage(): boolean
  nativeApproveCard(body: unknown): string | undefined
  putCardBackToPending(cardId: string, reason: string): void
  decisionCard(type: string, f: Record<string, unknown>): string | undefined
  cardDecidedOnMac(type: string, f: Record<string, unknown>): boolean
}

export const undeliveredFrames = {
  /** The card an owner frame decides (a `card.resolve`, or an Approve tapped on a notification), if it decides one. */
  decisionCard(this: UndeliveredCtx, type: string, f: Record<string, unknown>): string | undefined {
    const id =
      type === 'card.resolve' ? f.card_id : type === NATIVE_ACT_TYPE ? this.nativeApproveCard(f.body) : undefined
    return typeof id === 'string' ? id : undefined
  },

  /** True for a card decision whose card the Mac did decide (its card.update carried the resolution): not lost. */
  cardDecidedOnMac(this: UndeliveredCtx, type: string, f: Record<string, unknown>): boolean {
    const cardId = this.decisionCard(type, f)
    if (!cardId) return false
    try {
      return Boolean(this.d.store.getCard(cardId)?.resolution)
    } catch {
      return false // a card row that no longer opens is undecided; it must not stop the reports after it
    }
  },

  /**
   * Owner frames the Mac has not passed to the agent (never taken, or taken and not confirmed), found just before the sweep
   * deletes them (the outbox row and the stored frame go together at the end of the buffer window). A message or voice
   * note gets a `not_delivered` receipt, kept in message meta so `ready` and history still carry it; a card decision or a
   * settings change has no row to put a receipt on, so it gets a plain system row, unless the Mac did decide that card.
   * Once per frame (`nd:` id), so a crash between the report and the sweep repeats nothing.
   */
  reportUndelivered(this: UndeliveredCtx): void {
    const store = this.d.store
    for (const row of store.undeliveredOwnerDue(this.d.env.BUFFER_DAYS * DAY_MS, this.bridgeIsTwoStage())) {
      if (store.seen(`nd:${row.frame_id}`) !== undefined) continue
      const f = row.body as Record<string, unknown>
      const nativeReply = row.type === NATIVE_ACT_TYPE && this.nativeApproveCard(f.body) === undefined
      if (row.type === 'message' || row.type === 'voice_note' || row.type === 'share.item' || nativeReply) {
        // a share's owner row (via 'share') was stored under the same id as the message inside the share.item frame
        const msgId =
          row.type === 'share.item'
            ? String((f.message as { id?: unknown } | undefined)?.id ?? '')
            : nativeReply
              ? nativeReplyMessageId(String(f.id ?? ''))
              : String(f.client_msg_id ?? '')
        if (!msgId) continue
        store.setReceipt(msgId, 'not_delivered', row.thread_id ?? undefined)
        this.clearQueuedTimer(msgId)
        this.fanOut(mkFrame(this.d.clock, 'receipt', { message_id: msgId, state: 'not_delivered' }))
      } else if (!this.cardDecidedOnMac(row.type, f)) {
        const approveId = row.type === NATIVE_ACT_TYPE ? this.nativeApproveCard(f.body) : undefined
        // A tap that never reached the Mac did nothing there: the card is still pending on the Mac, so it is here too.
        if (approveId) this.putCardBackToPending(approveId, 'resolve_rejected')
        const what =
          row.type === 'card.resolve' || approveId
            ? row.taken
              ? 'Your decision on a card reached your Mac but never got to your agent, and the relay has dropped it after 7 days. The card may need deciding again.'
              : 'Your decision on a card never reached your Mac, and the relay has dropped it after 7 days. The card may need deciding again.'
            : 'A settings change never reached your Mac, and the relay has dropped it after 7 days. Check Settings and make the change again.'
        const message: MessageT = {
          id: newId('m'),
          thread_id: row.thread_id ?? this.cfg().default_thread,
          author: 'system',
          kind: 'text',
          text: what,
          format: 'plain',
          attachments: [],
          via: 'app',
          created_at: new Date(this.d.clock.now()).toISOString(),
        }
        this.fanOut(this.stampForApps(mkFrame(this.d.clock, 'message.stored', { client_msg_id: message.id, message })))
      }
      store.remember(`nd:${row.frame_id}`, 0)
    }
  },

  /**
   * D38, day 6. One push per episode: from the first sweep that finds an owner frame six days old and still waiting for the
   * Mac, until none is waiting. The "already warned" flag lives in the store, so a relay restart repeats nothing.
   */
  warnDeadMac(this: UndeliveredCtx): void {
    const store = this.d.store
    const oldest = store.oldestUndeliveredOwner(this.bridgeIsTwoStage(), (type, body) =>
      this.cardDecidedOnMac(type, body as Record<string, unknown>),
    )
    if (oldest === null) {
      if (store.getState('dead_mac_warned') !== null) store.setState('dead_mac_warned', '')
      return
    }
    if (store.getState('dead_mac_warned') === '1') return
    if (this.d.clock.now() - oldest < (this.d.env.BUFFER_DAYS - 1) * DAY_MS) return
    store.setState('dead_mac_warned', '1')
    this.notify({ template: 'messages_waiting' })
  },
}
