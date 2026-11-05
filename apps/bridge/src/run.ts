// The Run button, decided on the Mac. A tap is a signed `message` with `intent: 'run'` and `run_block`, the block it is for. The
// Mac accepts it only when every check below holds, and then (and only then) marks the block run and sets `run="tap"` on
// the note; the agent trusts that flag and nothing the text says. The Mac does not check that the script came from the
// agent: the owner's tap is what approves it. The answer to a refusal is a plain line in the thread for the owner to read;
// the app does not read it. ("Already tried", not "already ran": a hand-over that failed after the mark reached the agent as nothing.)
import {
  type Frame,
  parseRun,
  RUN_BLOCK_MAX_AGE_MS,
  RUN_MAX_AGE_MS,
  type RunBlockRefT,
  runBlockKey,
  runBlockMadeAt,
  threadSessionMode,
} from '@talos-app/protocol'
import type { BridgeContext } from './context.ts'
import { signedBeforeReset } from './history-recover.ts'

type MessageFrame = Extract<Frame, { type: 'message' }>

/** Said for a block over a week old, and for a message id whose time will not parse. */
const OLD_BLOCK = 'That script is over a week old. Ask me to post it again.'
const TRY_AGAIN = 'Ask your agent to post the script again if you still want it.'

/**
 * Does this Run count? Either the plain line for the owner (it does not), or the block it is for (it does). Pure reads:
 * nothing is written here.
 */
export function runCheck(ctx: BridgeContext, f: MessageFrame): { line: string } | { block: RunBlockRefT } {
  const no = (why: string, tail = TRY_AGAIN) => ({ line: `That Run was not run: ${why}.${tail ? ` ${tail}` : ''}` })
  // A thread with its own session (set to dedicated, whether or not its worker is running) takes no Run: it would have to be
  // handed to the main session or held for the worker, and a held one could arrive late. A re-post cannot run there either.
  if (threadSessionMode(ctx.config.config, f.thread_id) === 'dedicated')
    return no("this thread has its own session, so Run isn't available here", '')
  // the tap sends the text and the block it is for, and nothing else
  if (f.attachments.length || f.refs?.length || f.share_content || f.reply_to)
    return no('it did not have the shape of a Run (one block and nothing else)')
  const shape = parseRun(f.text)
  if (!shape.ok) return no('it did not have the shape of a Run (one block, nothing else, no hidden characters)')
  if (!f.run_block) return no('it does not say which block it is for')
  // The owner's first signing time (`original_ts` on a frame signed again), on this Mac's clock: a Run is for now.
  const signed = Math.min(Date.parse(f.ts), Date.parse(f.original_ts ?? f.ts))
  if (!Number.isFinite(signed) || ctx.clock.now() - signed > RUN_MAX_AGE_MS)
    return no('it was signed more than a day ago')
  // A history kept aside forgot what it had handed over, so a Run signed before then could run twice.
  if (signedBeforeReset(ctx.store, f.ts) || (f.original_ts && signedBeforeReset(ctx.store, f.original_ts)))
    return no('the Mac’s history was reset after you tapped it')
  // The block's own age, from its message id, on this Mac's clock, with no margin: the limit (7 days) sits a day inside the
  // 8 days the Mac remembers which blocks ran, so a block that is allowed here is always still remembered. A refusal marks nothing.
  const made = runBlockMadeAt(f.run_block)
  if (made === null || ctx.clock.now() - made > RUN_BLOCK_MAX_AGE_MS) return { line: OLD_BLOCK }
  // One block, one Run, whichever device or screen taps it. A post of the same script by the agent is a new block.
  if (ctx.store.hasSeen(runBlockKey(f.run_block)))
    return no('that block was already tried', 'Ask your agent to post the script again to run it again.')
  return { block: f.run_block }
}
