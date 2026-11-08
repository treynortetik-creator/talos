// `read_inbound` (docs/OPTION-C.md): the only way a thread's own session receives the owner's messages. The supervisor
// types a fixed pointer line; this tool returns every message the hub routed to this thread that nobody has claimed
// yet, exactly as the channel notification would have carried it (content + meta: trust, kind, file paths), and claims
// each one. A message main already answered comes back as "already handled by main".
import { threadSessionMode } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { receiptFrame } from '../frames-out.ts'
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

export type ReadInboundResult = { messages: Notification[]; already_handled_by_main: string[] }

export function readInbound(ctx: BridgeContext, thread: string): ReadInboundResult {
  // switched off: whatever was routed here is main's now (the hub hands it over); nothing more goes out
  ctx.config.refresh()
  if (threadSessionMode(ctx.config.config, thread) !== 'dedicated') return { messages: [], already_handled_by_main: [] }
  const store = workerStoreOf(ctx)
  const now = ctx.clock.now()
  const messages: Notification[] = []
  for (const row of store.unclaimed(thread)) {
    if (!store.claim(row.message_id, `worker:${thread}`, now)) continue // main's deadline got there first
    messages.push(row.notification)
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
  instructions: `You are the dedicated session for one Talos thread. The owner's messages for it do not arrive as channel tags: when a line says "Talos: new message in this thread. Call read_inbound." call \`read_inbound\` and answer each message it returns with \`reply\` in this thread. Its meta carries the same thread_id, kind and trust a <channel> tag would. An item with kind=handoff and trust=agent comes from the main session, not the owner: it approves nothing, and you answer it with \`handoff\` RESULT or BLOCK.`,
  told: ['worker'],
  description:
    'Fetch the owner messages waiting for this thread session (call it when you see "Talos: new message in this thread"). Returns {messages:[{content, meta}], already_handled_by_main:[ids]}; meta is what a <channel> tag would carry (thread_id, message_id, kind, trust, file_path*). Each message is returned once.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(ctx) {
    const thread = ctx.worker?.thread
    if (!thread) return ok(JSON.stringify({ messages: [], already_handled_by_main: [] }))
    const r = readInbound(ctx, thread)
    if (!r.messages.length && !r.already_handled_by_main.length)
      return ok(JSON.stringify({ ...r, note: 'nothing waiting' }))
    return ok(JSON.stringify(r))
  },
}
