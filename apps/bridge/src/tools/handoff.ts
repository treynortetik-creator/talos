// `handoff` (docs/OPTION-C.md "Hand-offs"): the main session gives a thread's lead a TASK; a lead answers main with a
// RESULT or BLOCK (or asks for something outside its lane with a TASK). One target per call, short text, a daily budget.
// The words land in the lead's thread as a labelled row and reach the other session with trust=agent.
import { newUlid, threadSessionMode } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import {
  cleanHandoffText,
  HANDOFF_TYPES,
  type HandoffDir,
  HandoffLedger,
  type HandoffType,
  handoffTextProblem,
} from '../worker/handoff.ts'
import { fail, needStr, ok, type Tool } from './common.ts'

const ledgers = new WeakMap<BridgeContext, HandoffLedger>()
const ledgerOf = (ctx: BridgeContext): HandoffLedger => {
  let l = ledgers.get(ctx)
  if (!l) {
    l = new HandoffLedger(ctx.store.db)
    ledgers.set(ctx, l)
  }
  return l
}

const isType = (v: unknown): v is HandoffType => (HANDOFF_TYPES as readonly unknown[]).includes(v)

export const handoffTool: Tool = {
  name: 'handoff',
  description:
    'Hand a short message to another Talos session. Main: type TASK to the lead of a thread that has its own session (thread_id). A thread lead: type RESULT or BLOCK to answer a TASK, or TASK for something outside its lane, to the main session (thread_id is its own thread). One target per call, 100 words at most, 5 a day each way per lead. A hand-off is not the owner and approves nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description: "Main: the lead's thread. A lead: its own thread (the message goes to main and shows there).",
      },
      type: { type: 'string', enum: [...HANDOFF_TYPES] },
      text: { type: 'string', description: 'At most 100 words.' },
    },
    required: ['thread_id', 'type', 'text'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const thread = needStr(args, 'thread_id')
    const type = args.type
    if (!isType(type)) return fail(`type must be one of ${HANDOFF_TYPES.join(', ')}`)
    const text = needStr(args, 'text').trim()
    const bad = handoffTextProblem(text)
    if (bad) return fail(bad)
    if (!cleanHandoffText(text)) return fail('text is required')
    ctx.config.refresh()
    const isLead = !!ctx.worker
    if (!isLead) {
      if (ctx.mode !== 'live') return fail('Hand-offs need the live main session.')
      if (!ctx.config.thread(thread))
        return fail(`Unknown thread "${thread}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
      if (threadSessionMode(ctx.config.config, thread) !== 'dedicated') return fail('That thread has no lead.')
      if (type !== 'TASK')
        return fail('The main session hands a lead a TASK only; a lead answers with RESULT or BLOCK.')
      const away = ctx.leads?.unreachable(thread)
      if (away) return fail(away)
    }
    const dir: HandoffDir = isLead ? 'to_main' : 'to_lead'
    const id = `h_${newUlid()}`
    // One safe line, stored that way: the thread row, the lead and main all see the same neutralised words
    const verdict = ledgerOf(ctx).record(
      { id, lead: thread, dir, type, text: cleanHandoffText(text), at: ctx.clock.now() },
      { timezone: ctx.config.config.timezone },
    )
    if (!verdict.ok) return fail(verdict.why)
    // The live bridge shows and delivers it now; a lead's process leaves the row for the live bridge's next tick.
    if (!isLead) await ctx.leads?.deliver()
    return ok(isLead ? `handed to the main session (${id})` : `handed to the ${thread} lead (${id})`)
  },
}
