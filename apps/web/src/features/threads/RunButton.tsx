// The Run button under a shell code block in an agent message. A tap sends the owner's own signed message (`intent: 'run'`
// and the script in one fence) and the Mac decides whether it counts (docs/SECURITY.md, "Run button"). Here:
//   - no button on a Mac that does not list `run/1`, on a block with hidden characters, one that never closes, one that is
//     not drawn as its source, or one over the length limit;
//   - one tap only for a script of printable ASCII, at most 6 lines and 300 characters; anything else asks a second time.
//     That rule is on the bytes alone (protocol `isOneTapRunScript`): nothing here looks at the screen;
//   - one tap, one message, and after a tap this screen shows what that tap did (sending, queued, sent, failed) from its own
//     state alone, and no Run. Nothing is kept past the screen: after a reload, or on a context view of the same message,
//     the block shows Run again. That is fine, because the Mac is the guard: it allows each block one Run while its message
//     is under a week old (the frame names the block by the message id and the block's place in that message), and answers
//     a second tap, or a block over a week old, with a plain line.
import { RUN_FEATURE, threadSessionMode } from '@talos-app/protocol'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useConnectionMeta } from '../../lib/connectionMeta.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import { revealHidden } from '../cards/util.ts'
import { type RunBlock, runBlocks, runText } from './runBlock.ts'

/** Which message the blocks belong to. */
export type RunContext = { threadId: string; messageId: string }

/** `index` is the block's place among the message's code blocks (fenced and indented, in order), as `runBlocks` counts them. */
type Slot = { el: HTMLElement; block: RunBlock; index: number }

const BUTTON = 'min-h-11 rounded-button border border-line bg-surface px-4 text-sm font-semibold text-text'

/**
 * Finds the code blocks the message drew and gives each shell block a place for its Run control. Fails closed: if the
 * drawn blocks are not the parsed blocks one for one, nothing gets a button.
 */
export function useRunSlots(box: RefObject<HTMLElement | null>, html: string, text: string, run?: RunContext) {
  const [slots, setSlots] = useState<Slot[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: html is the trigger; text is what it was drawn from
  useEffect(() => {
    if (!run) return
    const pres = Array.from(box.current?.querySelectorAll('pre') ?? [])
    const blocks = runBlocks(text)
    if (pres.length !== blocks.length) return
    const made: Slot[] = []
    pres.forEach((pre, i) => {
      const block = blocks[i] as RunBlock
      if (!block.runnable && !block.blocked) return
      const code = pre.querySelector('code')
      let b = block
      if (block.hidden && code) code.textContent = revealHidden(block.script)
      else if (code?.textContent !== block.script)
        b = { ...block, runnable: false, blocked: "This block doesn't match its source, so Run is off." }
      // Nothing is cut off or scrolled away: the whole script wraps inside the block.
      pre.classList.add('run-block')
      const el = document.createElement('div')
      pre.after(el)
      made.push({ el, block: b, index: i })
    })
    setSlots(made)
    return () => {
      for (const s of made) s.el.remove()
      setSlots([])
    }
  }, [html, run?.messageId])
  return slots.map((s) => createPortal(<RunControl block={s.block} index={s.index} run={run as RunContext} />, s.el))
}

function RunControl({ block, index, run }: { block: RunBlock; index: number; run: RunContext }) {
  const client = useTalosClient()
  const feature = useFeature(RUN_FEATURE)
  const sentText = block.runnable ? runText(block.script, block.lang) : null
  const dedicated = useTalos((s) => (s.config ? threadSessionMode(s.config, run.threadId) === 'dedicated' : false))
  // This tap's own message, once there is one. Held here only: it is gone with the screen.
  const [sentId, setSentId] = useState<string | null>(null)
  const queued = useConnectionMeta((s) => sentId !== null && s.queuedIds.includes(sentId))
  const failed = useConnectionMeta((s) => (sentId !== null ? s.failed[sentId] : undefined))
  // The relay gave up on it (the same receipt the thread row turns into "did not reach your agent").
  const dropped = useTalos((s) =>
    sentId === null ? false : s.messages[run.threadId]?.find((m) => m.id === sentId)?.receipt === 'not_delivered',
  )
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'sent' | 'queued' | 'held_unpinned' | null>(null)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // The question opens with Cancel in focus: a key held down on the first tap must not carry through the second.
  useEffect(() => {
    if (asked) cancelRef.current?.focus()
  }, [asked])

  if (!block.runnable || sentText === null)
    return (
      <p data-testid="run-blocked" className="m-0 mb-2 text-xs text-text-2">
        {block.blocked}
      </p>
    )
  if (feature === 'off') return null // a Mac that does not list run/1 would take the words for plain text
  if (dedicated)
    return (
      <p data-testid="run-blocked" className="m-0 mb-2 text-xs text-text-2">
        This thread has its own session, so Run isn't available here.
      </p>
    )

  const send = async () => {
    if (inFlight.current) return // one message per tap, however fast the taps come (two can land before the screen redraws)
    inFlight.current = true
    setBusy(true)
    setAsked(false)
    setError(false)
    try {
      const r = await client.sendMessage({
        threadId: run.threadId,
        text: sentText,
        intent: 'run',
        runBlock: { message_id: run.messageId, index },
      })
      setSentId(r.clientMsgId)
      setResult(r.state)
    } catch {
      setError(true) // nothing was queued: the Run never left
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  let status: string | null = null
  if (busy) status = 'Sending…'
  else if (sentId !== null) {
    if (failed) status = "Didn't send. See your message below."
    else if (dropped && !queued)
      status = "This did not reach your Mac, and it's no longer waiting. See your message below."
    else if (result === 'held_unpinned') status = 'Queued. It sends once your Mac approves this device.'
    else if (queued || result === 'queued') status = 'Queued. It sends when you are back online.'
    else status = 'Sent to your Mac. The thread below says whether it ran or was refused.'
  }
  const showButton = !busy && !asked && sentId === null

  return (
    <div data-testid="run-control" className="mb-2 flex flex-col gap-1">
      {!block.oneTap && (
        <p data-testid="run-note" className="m-0 text-xs text-text-2">
          This script is longer than 6 lines or 300 characters, or has characters beyond plain ASCII (look-alike
          letters, special spaces, accents), so Run asks twice.
        </p>
      )}
      {status && (
        <p
          role="status"
          data-testid="run-status"
          className={cn('m-0 text-sm', failed || (dropped && !queued) ? 'text-danger' : 'text-text-2')}
        >
          {status}
        </p>
      )}
      {asked && (
        <fieldset
          aria-label="Confirm Run"
          className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
          onKeyDown={(e) => e.key === 'Escape' && setAsked(false)}
        >
          <span className="text-sm">Run it?</span>
          {/* Cancel first: it sits where the Run button was, so a second quick tap lands on Cancel, and Yes is beside it, never under it. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              ref={cancelRef}
              type="button"
              data-testid="run-cancel"
              className={BUTTON}
              onClick={() => setAsked(false)}
            >
              Cancel
            </button>
            <button type="button" data-testid="run-confirm" className={BUTTON} onClick={() => void send()}>
              Yes, run it
            </button>
          </div>
        </fieldset>
      )}
      {showButton && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="run-button"
            className={BUTTON}
            onClick={() => (block.oneTap ? void send() : setAsked(true))}
          >
            {error ? 'Try again' : 'Run'}
          </button>
          {error && (
            <span role="alert" className="text-sm text-danger">
              Couldn't send.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
