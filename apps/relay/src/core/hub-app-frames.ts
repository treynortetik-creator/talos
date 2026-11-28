// The built-in handling of each app frame type, after hub-app-conn.ts has parsed it and checked the session and pairing.
// Handlers of the Hub class (hub.ts), which forwards to them. Chat, card, config and history frames go on to their own
// families (hub-chat.ts and the rest); the owner-device check each signed frame needs is `ownerDeviceOk` in hub.ts.
import type { Frame } from '@talos-app/protocol'
import type { AppRouter } from './apps.ts'
import type { EphemeralRouter } from './ephemeral.ts'
import type { CardsCtx } from './hub-cards.ts'
import { cardsFrames } from './hub-cards.ts'
import type { ChatCtx } from './hub-chat.ts'
import { chatFrames } from './hub-chat.ts'
import type { ConfigCtx } from './hub-config.ts'
import { configFrames } from './hub-config.ts'
import { errName } from './hub-helpers.ts'
import type { HistoryCtx } from './hub-history.ts'
import { historyFrames } from './hub-history.ts'
import type { AppConn, AppHandler, HubDeps } from './hub-types.ts'
import { FrameRejected } from './hub-types.ts'
import { isScheduleOwnerType, type ScheduleRouter } from './schedules.ts'
import type { StoredFrame } from './store.ts'
import type { TermRouter } from './term.ts'
import { mkFrame } from './util.ts'

/** What the app-frame switch uses of Hub, and nothing else. Hub builds it in its constructor. */
export type AppFramesCtx = {
  d: HubDeps
  appHandlers: Map<string, AppHandler[]>
  chatCtx: ChatCtx
  cardsCtx: CardsCtx
  configCtx: ConfigCtx
  historyCtx: HistoryCtx
  schedules: ScheduleRouter
  ephemeral: EphemeralRouter
  term: TermRouter
  appRouter: AppRouter
  sendApp(a: AppConn, frame: Record<string, unknown>): void
  appError(a: AppConn, code: string, message: string, ref?: unknown): void
  fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void
  ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean
  runAppHandlers(
    a: AppConn,
    frame: Frame,
    raw: Record<string, unknown>,
    strict?: boolean,
  ): Promise<boolean | FrameRejected>
  history(a: AppConn, frame: Frame & { type: 'history.request' }, raw: Record<string, unknown>): void
  sendCatchup(a: AppConn, since: number): void
}

export const appFrames = {
  async onAppFrameBuiltin(this: AppFramesCtx, a: AppConn, frame: Frame, raw: Record<string, unknown>): Promise<void> {
    const store = this.d.store
    switch (frame.type) {
      case 'ping':
        return this.sendApp(a, mkFrame(this.d.clock, 'pong', { nonce: frame.nonce }))
      case 'visibility':
        a.visible = frame.state === 'visible'
        a.activeAt = this.d.clock.now()
        return
      case 'message':
        return chatFrames.onOwnerMessage.call(this.chatCtx, a, frame, raw)
      case 'card.resolve':
        return cardsFrames.onCardResolve.call(this.cardsCtx, a, frame, raw)
      case 'config.patch':
        return configFrames.onConfigPatch.call(this.configCtx, a, frame, raw)
      case 'agent.recover':
        return configFrames.onAgentRecover.call(this.configCtx, a, frame, raw)
      case 'undo.request':
        return configFrames.onUndoRequest.call(this.configCtx, a, frame, raw)
      case 'plugin.add.request':
        return configFrames.onPluginAddRequest.call(this.configCtx, a, frame, raw)
      case 'inbox.update': {
        // The inbox row itself is written by the hooks module's handler. That write runs first and the ack follows it, so an
        // app is never told "done" for a change that was not saved; a failed write leaves no seen id and the retry is a
        // first attempt. The event and its seen id are one transaction, like an owner message.
        const dup = store.seen(`of:${frame.id}`)
        if (dup !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: dup }))
        const handled = await this.runAppHandlers(a, frame, raw, true)
        if (handled instanceof FrameRejected) return this.appError(a, handled.code, handled.message, frame.id)
        if (!handled) {
          this.appError(a, 'internal', 'The relay could not save that. Nothing changed; try again.', frame.id)
          return
        }
        let stamped: StoredFrame
        try {
          stamped = store.db.transaction((): StoredFrame => {
            const s = store.appendEvent({ frame: raw, audience: 'app', threadId: undefined })
            store.remember(`of:${frame.id}`, s.relay.seq)
            return s
          })()
        } catch (e) {
          this.d.log.error({ err: errName(e), type: frame.type }, 'inbox frame not stored')
          this.appError(a, 'internal', 'The relay could not save that. Nothing changed; try again.', frame.id)
          return
        }
        this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: stamped.relay.seq }))
        this.fanOut(stamped, undefined, a.id)
        return
      }
      case 'schedules.list':
      case 'schedule.get':
      case 'schedule.patch':
      case 'schedule.run_now':
      case 'schedule.control':
      case 'heartbeat.test': {
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        if (!isScheduleOwnerType(frame.type)) return
        return this.schedules.onOwnerFrame(a.id, frame as never, raw)
      }
      case 'thread.read':
        store.setRead(frame.thread_id, frame.up_to_seq)
        return this.fanOut(raw, undefined, a.id)
      case 'thread.unread': {
        // The read mark only rises, so this is the one frame that lowers it (store.markUnread). EVERY device, the sender
        // included, gets the relay's answer: the sender cannot work out the new mark or count by itself.
        const r = store.markUnread(frame.thread_id)
        return this.fanOut(
          mkFrame(this.d.clock, 'thread.unread', {
            thread_id: frame.thread_id,
            ...(r.up_to_seq !== undefined ? { up_to_seq: r.up_to_seq } : {}),
            count: r.count,
          }),
        )
      }
      case 'catchup.request':
        return this.sendCatchup(a, frame.since_seq)
      case 'history.request':
        return this.history(a, frame, raw)
      case 'media.fetch':
        return historyFrames.onMediaFetch.call(this.historyCtx, a, frame, raw)
      // docs/V2-FEATURES.md V1.3: signed reads, never stored, routed back to this socket only
      case 'search.query':
      case 'memory.tree':
      case 'memory.read':
      case 'memory.search':
      // the 3D graph of the notes (frames-memory-graph.ts): from the Mac, never stored here
      case 'memory.graph':
      case 'speak.request':
      case 'fs.list':
      case 'files.list':
      case 'files.read':
      case 'bug.context':
      // the thread's AGENTS.md (frames-agents-md.ts): the save too goes to the Mac and back, never stored or replayed
      case 'agents_md.read':
      case 'agents_md.write':
      // an upload into a thread's folder (frames-files-put.ts): the file itself went up the media path already
      case 'files.put':
      // the files sent in Talos (frames-files-sent.ts): a list from the Mac's history, never stored here
      case 'files.sent':
      // which folders Memory's Notes show (frames-memory-roots.ts): the list and the save go to the Mac and back, never stored
      case 'memory.folders':
      case 'memory.roots_set':
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        return this.ephemeral.onRequest(a.id, frame, raw)
      // MCP Apps (spec M3.4): signed, never stored or replayed, answered to this socket only
      case 'app.request':
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        return this.appRouter.onRequest(a.id, frame, raw)
      // The remote terminal's view (core/term.ts): an open, resume or close is signed by the device, and its credit is not; none is
      // stored, queued or replayed, and what the Mac sends back goes to the one socket that opened the view
      case 'term.open':
      case 'term.resume':
      case 'term.close':
        if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
        return this.term.onApp(a.id, frame.device_id, frame, raw)
      case 'term.ack':
        return this.term.onAck(a.id, frame, raw)
      case 'pong':
      case 'error':
      case 'hello':
        return
      default:
        return
    }
  },
}
