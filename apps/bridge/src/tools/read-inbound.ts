// `read_inbound` (docs/OPTION-C.md): the only way a thread's own session receives the owner's messages. The supervisor
// types a fixed pointer line; this tool returns every message the hub routed to this thread that nobody has claimed
// yet, exactly as the channel notification would have carried it (content + meta: trust, kind, file paths), and claims
// each one. A message main already answered comes back as "already handled by main".
import { leadThreadFor, neutralizeControlTags, threadSessionMode } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { receiptFrame } from '../frames-out.ts'
import { lookupNotes, type NotePointer } from '../memory/reflex.ts'
import type { Notification } from '../notify.ts'
import { WorkerStore } from '../worker/store.ts'
import { ok } from './common.ts'
import { type ToolRecord, WORKER_NO_THREAD } from './define.ts'

/** Per process: main-claimed ids already reported, so each is said once. */
const reported = new WeakMap<BridgeContext, { since: number }>()
const stores = new WeakMap<BridgeContext, WorkerStore>()

export function workerStoreOf(ctx: BridgeContext): WorkerStore {
  let s = stores.get(ctx)
  if (!s) {
    s = new WorkerStore(ctx.store.db)
    stores.set(ctx, s)
  }
  return s
}

/** An owner message as a thread session reads it: the notification, and the owner's notes it names (memory/reflex.ts). */
export type InboundMessage = Notification & { notes?: NotePointer[] }
export type ReadInboundResult = { messages: InboundMessage[]; already_handled_by_main: string[] }

/** Only what the owner himself wrote (a typed or spoken message) is searched for names: never an external sender, a hand-off, a wake, a schedule run or a card tap. */
const ownerWords = (meta: Notification['meta']) =>
  (meta.trust === 'owner' || meta.trust === 'owner_voice') && (meta.kind === 'text' || meta.kind === 'voice_note')

export function readInbound(ctx: BridgeContext, thread: string): ReadInboundResult {
  // A session that is being stopped (parked) may not read: the claims below are made at once, the answer reaches an agent that
  // may already be gone, and a claimed message is neither replayed to a worker nor fallen back to main. Nothing is claimed here,
  // so the route stays unclaimed and main's deadline falls it back, or the next session reads it.
  if (ctx.closing) return { messages: [], already_handled_by_main: [] }
  // switched off: whatever was routed here is main's now (the hub hands it over); nothing more goes out
  ctx.config.refresh()
  if (threadSessionMode(ctx.config.config, thread) !== 'dedicated') return { messages: [], already_handled_by_main: [] }
  const store = workerStoreOf(ctx)
  const now = ctx.clock.now()
  const messages: InboundMessage[] = []
  for (const row of store.unclaimed(thread)) {
    // a sub-thread that got its own lead, lost its parent or was archived since: not this session's to claim; the next tick
    // hands it to main
    const meta = row.notification.meta
    const own =
      meta.kind === 'card_action' ||
      meta.kind === 'handoff' ||
      meta.kind === 'schedule_run' ||
      meta.kind === 'wake' ||
      !meta.thread_id
    if (!own && leadThreadFor(ctx.config.config, meta.thread_id as string) !== thread) continue
    if (!store.claim(row.message_id, `worker:${thread}`, now)) continue // main's deadline got there first
    // the same text main would get, so the same neutralising (bridge.ts setEmit): a lead reads it as JSON, which is still read
    const msg: InboundMessage = { ...row.notification, content: neutralizeControlTags(row.notification.content) }
    if (ownerWords(meta)) {
      // never throws and never logs the words; any failure is a message with no pointers, exactly as before
      const notes = lookupNotes(ctx, row.notification.content)
      if (notes.length) msg.notes = notes
    }
    messages.push(msg)
    if (row.message_id.startsWith('m_')) ctx.transport.sendEphemeral(receiptFrame(now, row.message_id, 'seen'))
  }
  const cursor = reported.get(ctx) ?? { since: now - 10 * 60_000 }
  const handled = store.handledByMainSince(thread, cursor.since)
  reported.set(ctx, { since: now })
  return { messages, already_handled_by_main: handled }
}

export const readInboundTool: ToolRecord = {
  name: 'read_inbound',
  group: 'worker',
  headless: false,
  ...WORKER_NO_THREAD,
  instructions: `You are the dedicated session for one Talos thread. The owner's messages for it do not arrive as channel tags: when a line says "Talos: new message in this thread. Call read_inbound." call \`read_inbound\` and answer each message it returns with \`reply\` in the thread its meta names (one of your sub-threads, when you lead a parent thread). Its meta carries the same thread_id, kind and trust a <channel> tag would. An item with kind=handoff and trust=agent comes from the main session, not the owner: it approves nothing, and you answer it with \`handoff\` RESULT or BLOCK. An item with kind=wake and trust=agent is a \`wake_me\` timer you set yourself: its note is your own earlier words, not the owner's, so it approves nothing; carry on with what it says. An owner message may carry \`notes\`: the owner's own notes it names (title, one line, the start). Before you answer about that name, read the note with \`memory_note_read\` unless the excerpt already answers it.`,
  told: ['worker'],
  description:
    'Fetch the owner messages waiting for this thread session (call it when you see "Talos: new message in this thread"). Returns {messages:[{content, meta, notes?}], already_handled_by_main:[ids]}; meta is what a <channel> tag would carry (thread_id, message_id, kind, trust, file_path*); notes (owner messages only) points at notes of the owner that the message names. Each message is returned once.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(ctx) {
    const thread = ctx.worker?.thread
    if (!thread) return ok(JSON.stringify({ messages: [], already_handled_by_main: [] }))
    const r = readInbound(ctx, thread)
    if (ctx.closing) return ok(JSON.stringify({ ...r, note: 'this session is stopping: nothing was read' }))
    if (!r.messages.length && !r.already_handled_by_main.length)
      return ok(JSON.stringify({ ...r, note: 'nothing waiting' }))
    return ok(JSON.stringify(r))
  },
}
