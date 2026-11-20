// The Run button under a shell code block in an agent message. A tap sends the owner's own signed message (`intent: 'run'`
// and the script in one fence) and the Mac decides whether it counts (docs/SECURITY.md, "Run button"). Here:
//   - no button on a Mac that does not list `run/1`, on a block with hidden characters, one that never closes, one that is
//     not drawn as its source, or one over the length limit;
//   - one tap for a script of printable ASCII, any length up to the cap; a script with look-alike or other non-ASCII
//     characters asks a second time. That rule is on the bytes alone (protocol `isOneTapRunScript`): nothing here looks at
//     the screen;
//   - one tap, one message, and after a tap this screen shows what that tap did (sending, queued, sent, failed) from its own
//     state alone. Once that tap is no longer waiting to send, Run again offers a fresh tap (a new signed message, so a new
//     Run: owner, 2026-11-15). The Mac runs each tap once (a replay is consumed by its message id) and refuses a block over a
//     week old with a plain line.
import { RUN_FEATURE, RUN_PANE_FEATURE, type RUN_RESULT_REASONS, threadSessionMode } from '@talos-app/protocol'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NotSentError, useTalos, useTalosClient } from '../../lib/client.ts'
import { useConnectionMeta } from '../../lib/connectionMeta.ts'
import { getShell } from '../../lib/native/shell.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import { revealHidden } from '../cards/util.ts'
import { openPane } from '../panes/panesStore.ts'
import { shellPaneHere } from '../panes/TerminalSlot.tsx'
import { type RunBlock, runBlocks, runText } from './runBlock.ts'
import { useRunResults } from './runResults.ts'

/** Which message the blocks belong to. */
export type RunContext = { threadId: string; messageId: string }

/** `index` is the block's place among the message's code blocks (fenced and indented, in order), as `runBlocks` counts them. */
type Slot = { el: HTMLElement; icon: HTMLElement; block: RunBlock; index: number }

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
      // The icon sits in the block's top-right corner, in the pre but never in the code element (its text is the source the
      // check above compared); the status line and questions go under the block.
      const icon = document.createElement('div')
      icon.className = 'run-icon-slot'
      pre.append(icon)
      const el = document.createElement('div')
      pre.after(el)
      made.push({ el, icon, block: b, index: i })
    })
    setSlots(made)
    return () => {
      for (const s of made) {
        s.el.remove()
        s.icon.remove()
      }
      setSlots([])
    }
  }, [html, run?.messageId])
  return slots.map((s) => (
    <RunControl key={s.index} block={s.block} index={s.index} run={run as RunContext} slot={s.el} icon={s.icon} />
  ))
}

/** How long Run again takes no tap after the tap before it went: longer than a double click. */
export const RUN_AGAIN_SETTLE_MS = 1000
/** How long a pane Run's line waits for the Mac app's result before it points at the thread instead. */
export const RUN_RESULT_WAIT_MS = 30_000

/** Lowercase hex SHA-256 of the UTF-8 bytes: the only thing about the script that goes to the Mac app (run_witness). */
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

const NOT_CONNECTED = "Your Mac isn't connected; Run in Terminal needs it."
/** Plain words for why the Mac app did not run a pane Run. */
const REFUSED: Record<(typeof RUN_RESULT_REASONS)[number], string> = {
  no_witness: "the click wasn't confirmed",
  expired: 'it waited too long',
  not_started: "Terminal didn't start",
  pane_busy: 'Terminal is busy',
  app_closed: 'Talos was closed',
  // the app's own script rules (control, bidi or zero-width characters, empty, no final newline, too long)
  bad_script: "Terminal refuses this script's characters or size",
}

function RunControl({
  block,
  index,
  run,
  slot,
  icon,
}: {
  block: RunBlock
  index: number
  run: RunContext
  slot: HTMLElement
  icon: HTMLElement
}) {
  const client = useTalosClient()
  const feature = useFeature(RUN_FEATURE)
  // Pane mode needs both ends: a Mac that LISTS run-pane/1 (a Mac that is only briefly away still lists it, so the button does
  // not change under the owner), and this page inside the Mac app with its Terminal pane.
  const paneFeature = useFeature(RUN_PANE_FEATURE)
  const pane = paneFeature !== 'off' && shellPaneHere()
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
  // A tap made while the socket was down (or before the Mac pinned this device) gets 'queued' or 'held_unpinned' back, and a
  // later flush sends it; the tap's own result never changes after that. The row's receipt is the proof it went out: the
  // client stamps it when the relay acks the message (then delivered, seen). A discarded or removed row has none, so a
  // deleted Run never reads as sent. Once seen it is kept for this tap: the row can go later (deleted, a catch-up reset), and
  // a Run that went out must never read as removed and offer to run again.
  const receiptNow = useTalos((s) => {
    if (sentId === null) return false
    const r = s.messages[run.threadId]?.find((m) => m.id === sentId)?.receipt
    return r === 'sent' || r === 'delivered' || r === 'seen'
  })
  const [wentOutFor, setWentOutFor] = useState<string | null>(null)
  useEffect(() => {
    if (receiptNow && sentId !== null) setWentOutFor(sentId)
  }, [receiptNow, sentId])
  const wentOut = receiptNow || (sentId !== null && wentOutFor === sentId)
  const online = useTalos((s) => s.connection === 'online')
  // This tap's own row is gone (the owner deleted it after it failed). A sent Run's row may go too (deleting it changes
  // nothing here); only a tap that never went out reads it as removed.
  const rowHere = useTalos((s) => sentId !== null && s.messages[run.threadId]?.some((m) => m.id === sentId) === true)
  const [sawRow, setSawRow] = useState<string | null>(null)
  useEffect(() => {
    if (rowHere && sentId !== null) setSawRow(sentId)
  }, [rowHere, sentId])
  const rowGone = sentId !== null && sawRow === sentId && !rowHere
  // Removed means the owner deleted it after it failed: a failed message is not sent, and Delete is only offered on a failed
  // row. So it counts only when this tap was seen failed and then left with no retry in between (a retry puts it back in the
  // queue and clears this). A row lost any other way (a catch-up reset, an ack racing the row) never reads as removed.
  const [sawFailed, setSawFailed] = useState<string | null>(null)
  useEffect(() => {
    if (sentId === null) return
    if (failed) setSawFailed(sentId)
    else if (queued) setSawFailed(null)
  }, [failed, queued, sentId])
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'sent' | 'queued' | 'held_unpinned' | null>(null)
  const [error, setError] = useState(false)
  // The Mac app did not take the click witness: the Mac refuses an unwitnessed pane Run, so nothing ran.
  const [unwitnessed, setUnwitnessed] = useState(false)
  // A pane Run is never queued: with the Mac or the connection away the tap sends nothing.
  const [notConnected, setNotConnected] = useState(false)
  // What the Mac app said became of this tap's pane Run (by its message id).
  const macResult = useRunResults((st) => (sentId === null ? undefined : st.byId[sentId]))
  // A pane Run the bridge refuses itself (too old, a reset history) never reaches the app, so no result comes: after
  // RUN_RESULT_WAIT_MS the line stops waiting and points at the thread, where the bridge's refusal is.
  const [noAnswerFor, setNoAnswerFor] = useState<string | null>(null)
  useEffect(() => {
    if (sentId === null || macResult) return
    const t = setTimeout(() => setNoAnswerFor(sentId), RUN_RESULT_WAIT_MS)
    return () => clearTimeout(t)
  }, [sentId, macResult])
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Run again takes the place where Run was: for a moment it takes no tap, so the second click of a double click lands on
  // nothing instead of running the script twice (no prompt: it is simply not ready for that moment)
  // which tap has settled: Run again for a newer tap is not ready from its very first render
  const [settledFor, setSettledFor] = useState<string | null>(null)
  useEffect(() => {
    if (sentId === null) return
    const t = setTimeout(() => setSettledFor(sentId), RUN_AGAIN_SETTLE_MS)
    return () => clearTimeout(t)
  }, [sentId])
  const settled = sentId === null || settledFor === sentId

  // The question opens with Cancel in focus: a key held down on the first tap must not carry through the second.
  useEffect(() => {
    if (asked) cancelRef.current?.focus()
  }, [asked])

  const under = (node: React.ReactNode) => createPortal(node, slot)
  if (!block.runnable || sentText === null)
    return under(
      <p data-testid="run-blocked" className="m-0 mb-2 text-xs text-text-2">
        {block.blocked}
      </p>,
    )
  if (feature === 'off') return null // a Mac that does not list run/1 would take the words for plain text
  // A thread with its own session takes no agent Run; a pane Run involves no agent, so the Mac accepts it there.
  if (dedicated && !pane)
    return under(
      <p data-testid="run-blocked" className="m-0 mb-2 text-xs text-text-2">
        This thread has its own agent, so Run isn't available here.
      </p>,
    )

  const send = async () => {
    if (pane && paneFeature !== 'on') {
      setAsked(false)
      setNotConnected(true) // the Mac is away: nothing is sent, nothing opens
      return
    }
    if (inFlight.current) return // one message per tap, however fast the taps come (two can land before the screen redraws)
    inFlight.current = true
    setBusy(true)
    setAsked(false)
    setError(false)
    setUnwitnessed(false)
    setNotConnected(false)
    try {
      let hash = ''
      if (pane) {
        openPane(run.threadId, 'terminal') // layout only: the pane opens beside the thread
        hash = await sha256Hex(block.script) // before the send, so the witness follows it with nothing in between
      }
      const r = await client.sendMessage({
        threadId: run.threadId,
        text: sentText,
        intent: 'run',
        runBlock: { message_id: run.messageId, index },
        ...(pane ? { runWhere: 'pane' as const, requireLive: true } : {}),
      })
      if (pane && r.state !== 'sent') {
        // Refused up front when it can be (requireLive); this is the race after that. It cannot be called back from here, but
        // with no witness the Mac app refuses it if it ever goes out.
        setNotConnected(true)
        return
      }
      setSentId(r.clientMsgId)
      setResult(r.state)
      if (pane) {
        const ok = getShell()?.bridge.send({
          type: 'run_witness',
          thread_id: run.threadId,
          client_msg_id: r.clientMsgId,
          script_sha256: hash,
        })
        if (!ok) setUnwitnessed(true)
      }
    } catch (e) {
      if (pane && e instanceof NotSentError) setNotConnected(true)
      else setError(true) // nothing was queued: the Run never left
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  const outNow = result !== null && result !== 'sent' && wentOut
  const shown = outNow ? 'sent' : result
  const removed =
    rowGone &&
    sawFailed === sentId &&
    !wentOut &&
    (shown === 'queued' || shown === 'held_unpinned') &&
    !failed &&
    !queued
  let status: string | null = null
  if (busy) status = 'Sending…'
  else if (notConnected) status = NOT_CONNECTED
  else if (sentId !== null) {
    if (unwitnessed) status = "Couldn't confirm the click in Talos; nothing ran."
    else if (failed) status = "Didn't send. See your message below."
    else if (dropped && !queued) status = "Didn't reach your Mac. See your message below."
    else if (removed) status = 'Removed. Nothing was sent.'
    else if (shown === 'held_unpinned') status = 'Queued · sends once your Mac approves this device'
    // The socket can't send: it waits to be back online. Written to a live socket but not yet acked by the relay: it is on
    // its way, not delivered ("Sending…"). Acked: Sent.
    else if ((queued || shown === 'queued') && !online) status = "Queued · sends when you're back online"
    else if (queued || shown === 'queued') status = 'Sending…'
    else if (!pane) status = 'Sent · the agent runs it'
    else if (macResult?.ok)
      status = 'Ran in Terminal' // a reason beside ok is ignored: ok means it went in
    else if (macResult) status = `Didn't run in Terminal${macResult.reason ? ` (${REFUSED[macResult.reason]})` : ''}`
    else if (noAnswerFor === sentId) status = 'No answer from Terminal; see the thread.'
    else status = 'Sent · waiting for Terminal'
  }
  // A fresh tap once this one has left (or failed); never while it still waits to send, so two Runs never pile up offline.
  const waiting = sentId !== null && !failed && !removed && (queued || shown === 'held_unpinned')
  const showButton = !busy && !asked && !waiting

  const label = pane ? 'Run in Terminal' : 'Run'
  const bad = unwitnessed || failed || (dropped && !queued) || (pane && macResult?.ok === false)

  return (
    <>
      {showButton &&
        createPortal(
          <button
            type="button"
            data-testid="run-button"
            aria-label={sentId !== null && !error ? 'Run again' : label}
            title={sentId !== null && !error ? 'Run again' : label}
            className="grid h-11 w-11 place-items-center rounded-button border border-line bg-surface text-text disabled:opacity-50"
            disabled={!settled}
            onClick={() => (block.oneTap ? void send() : setAsked(true))}
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
              <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
            </svg>
          </button>,
          icon,
        )}
      {under(
        <div data-testid="run-control" className="mb-2 flex flex-col gap-1">
          {!block.oneTap && (
            <p data-testid="run-note" className="m-0 text-xs text-text-2">
              This script has characters beyond plain ASCII (look-alike letters, special spaces, accents), so Run asks
              twice.
            </p>
          )}
          {status && (
            <p
              role="status"
              data-testid="run-status"
              className={cn('m-0 text-xs', bad ? 'text-danger' : 'text-text-2')}
            >
              {status}
            </p>
          )}
          {error && !busy && (
            <p role="alert" className="m-0 text-xs text-danger">
              Couldn't send.
            </p>
          )}
          {asked && (
            <fieldset
              aria-label="Confirm Run"
              className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
              onKeyDown={(e) => e.key === 'Escape' && setAsked(false)}
            >
              <span className="text-sm">Run it?</span>
              {/* Cancel first: a second quick tap on the icon's place lands on Cancel, and Yes is beside it, never under it. */}
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
        </div>,
      )}
    </>
  )
}
