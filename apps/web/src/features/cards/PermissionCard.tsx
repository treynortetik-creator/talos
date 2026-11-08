// The live permission card (docs/CLAUDE-CODE.md C3.2, C3.9). Claude Code asked to run a tool; the bridge turned the request into
// this card. The rule: an approval that can be seen in full can be approved from the phone, so Allow lives in a FULL-SCREEN
// APPROVAL SHEET that owns the screen and shows the whole call, and it unlocks once the end of the call has been scrolled to.
// In the thread the card is a compact summary with a tap target that opens the sheet (a push or /card/:id opens it at once).
// Allow exists only when the card is exactly what the bridge composed and nothing cuts or hides a part of the call
// (permissionCardAllowsPrimary, the same function the bridge re-checks). Hidden and direction-changing characters are shown as
// visible markers. Deny is always there. Everything is plain text. There is no Edit and no revise.
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  type CardT,
  EXPLAIN_FAILED_TEXT,
  type ExplainShown,
  explainChip,
  explainShown,
  PERMISSION_HIDDEN_WARNING,
  PERMISSION_MAYBE_ANSWERED,
  PERMISSION_MAYBE_ANSWERED_MS,
  PERMISSION_TOO_LONG_BODY,
  permissionCallTail,
  permissionCardAllowsPrimary,
} from '@talos-app/protocol'
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react'
import { enterApproval } from '../../lib/approvalOpen.ts'
import { cn } from '../../ui/cn.ts'
import { IconAlert } from '../../ui/icons.tsx'
import { Button } from '../../ui/index.ts'
import { useVisualViewport } from './useVisualViewport.ts'
import { formatClock, revealHidden } from './util.ts'

/** How much of the call the compact card in the thread shows; the sheet shows all of it. */
const PREVIEW_CHARS = 160

type Props = {
  card: CardT
  header: ReactNode
  titleId: string
  rootRef: Ref<HTMLElement>
  pulse: boolean
  /** Opened from a push or /card/:id: the sheet opens by itself. */
  highlighted?: boolean | undefined
  hash: string
  now: number
  busy: boolean
  error: string | null
  timeZone: string
  onAllow: () => void
  onDeny: () => void
}

export function PermissionCardLive(props: Props) {
  const { card, header, titleId, rootRef, pulse, highlighted, hash, now, busy, error, timeZone, onDeny } = props
  const allowable = permissionCardAllowsPrimary(card)
  const [open, setOpen] = useState(Boolean(highlighted) && allowable)
  const summary = card.fields.find((f) => f.key === 'summary')
  const maybeAnswered = now - Date.parse(card.created_at) >= PERMISSION_MAYBE_ANSWERED_MS
  const reason = card.warning ?? (allowable ? null : PERMISSION_HIDDEN_WARNING)
  const body = card.body ?? ''
  const showable = body !== '' && body !== PERMISSION_TOO_LONG_BODY
  const preview = [...body].length > PREVIEW_CHARS ? `${[...body].slice(0, PREVIEW_CHARS).join('')}…` : body
  const shown = explainShown(card.explain, card.created_at, now)
  const mismatch = shown.kind === 'ready' && shown.explain.mismatch
  // With an explanation the command sits behind "Show the command". It opens by itself when there is nothing to read instead
  // (the explainer failed) or when Allow is not on offer, so the reason is never behind a click. After that the element belongs
  // to the owner: React does not set `open`, so a re-render never fights a toggle.
  const commandRef = useRef<HTMLDetailsElement>(null)
  const commandForcedOpen = shown.kind === 'failed' || !allowable
  // biome-ignore lint/correctness/useExhaustiveDependencies: shown.kind decides whether the element exists
  useEffect(() => {
    if (commandForcedOpen && commandRef.current) commandRef.current.open = true
  }, [commandForcedOpen, shown.kind])
  const call = (
    <>
      <p className="mt-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">The call</p>
      {allowable ? (
        // the compact card: a start of the call and a way in. Allow is not here; it is in the sheet, behind the whole call.
        <button
          type="button"
          data-testid="permission-open"
          onClick={() => setOpen(true)}
          className="mt-1 block w-full rounded-button bg-surface-2 p-2 text-left font-mono text-sm text-text"
        >
          <span
            data-testid="permission-preview"
            className="block whitespace-pre-wrap [overflow-wrap:anywhere] break-all"
          >
            {revealHidden(preview)}
          </span>
          <span className="mt-1 block font-sans text-xs text-text-2 underline">Review the whole call and decide</span>
        </button>
      ) : (
        <pre
          data-testid="permission-call"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box must be reachable by keyboard
          tabIndex={0}
          className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] break-all rounded-button bg-surface-2 p-2 font-mono text-sm text-text"
        >
          {revealHidden(body)}
        </pre>
      )}
      {showable ? <TailLine body={body} /> : null}
    </>
  )
  return (
    <article
      ref={rootRef}
      aria-labelledby={titleId}
      data-card-id={card.id}
      data-card-state="pending"
      data-card-kind="permission"
      data-payload-hash={hash}
      className={cn(
        'incised rounded-card border border-warn bg-surface p-4 transition-shadow duration-[var(--dur-2)] ease-talos',
        pulse && 'ring-2 ring-accent',
      )}
    >
      {header}
      <h3 id={titleId} className="mt-1 text-lg font-medium text-text">
        {revealHidden(card.title)}
      </h3>
      <ExplainBlock shown={shown} />
      {shown.kind === 'none' ? (
        call
      ) : (
        <details ref={commandRef} data-testid="permission-command" className="mt-2">
          <summary className="cursor-pointer text-sm text-text-2 underline">Show the command</summary>
          {call}
        </details>
      )}
      {summary && !allowable ? (
        <div data-testid="permission-summary" className="mt-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">{summary.label}</p>
          <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] break-all text-text">
            {revealHidden(summary.value)}
          </p>
        </div>
      ) : null}
      {reason ? (
        <p role="status" className="mt-3 flex items-start gap-1.5 text-sm text-warn">
          <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
          {revealHidden(reason)}
        </p>
      ) : null}
      {maybeAnswered ? <p className="mt-2 text-sm text-text-2">{PERMISSION_MAYBE_ANSWERED}</p> : null}
      {error && !open ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant={mismatch ? 'primary' : 'danger'} disabled={busy} onClick={onDeny}>
          {card.kill_label}
        </Button>
        {allowable ? (
          <Button
            variant={mismatch ? 'outline' : 'primary'}
            className="ml-auto"
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            {mismatch ? 'Allow anyway' : 'Review to allow'}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 font-mono text-xs text-text-2" data-testid="card-expiry">
        Expires {formatClock(card.expires_at, timeZone)} if untouched
      </p>
      {open && allowable ? (
        <ApprovalSheet {...props} summaryValue={summary?.value} onClose={() => setOpen(false)} />
      ) : null}
    </article>
  )
}

/** The plain explanation: a line while it is coming, the failed text, or the chip and the sentence. Plain text only. */
function ExplainBlock({ shown }: { shown: ExplainShown }) {
  if (shown.kind === 'none') return null
  return (
    <div aria-live="polite" className="mt-2">
      {shown.kind === 'waiting' ? (
        <p data-testid="permission-explain-waiting" className="text-sm text-text-2">
          Reading the command…
        </p>
      ) : shown.kind === 'failed' ? (
        <p data-testid="permission-explain-failed" className="text-sm text-text-2">
          {EXPLAIN_FAILED_TEXT}
        </p>
      ) : (
        <div data-testid="permission-explain">
          <span
            data-testid="permission-explain-chip"
            className={cn(
              'inline-block rounded-full border px-2 py-0.5 text-xs font-semibold',
              shown.explain.mismatch ? 'border-warn text-warn' : 'border-line text-text-2',
            )}
          >
            {explainChip(shown.explain)}
          </span>
          <p
            data-testid="permission-explain-sentence"
            className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-text"
          >
            {revealHidden(shown.explain.sentence)}
          </p>
        </div>
      )}
    </div>
  )
}

function TailLine({ body, elRef }: { body: string; elRef?: Ref<HTMLParagraphElement> }) {
  return (
    <p
      ref={elRef}
      data-testid="permission-tail"
      className="mt-1 [overflow-wrap:anywhere] break-all font-mono text-xs text-text-2"
    >
      <span className="font-sans font-semibold uppercase tracking-[var(--tracking-caps)]">Ends with:</span>{' '}
      {revealHidden(permissionCallTail(body))}
    </p>
  )
}

/**
 * The full-screen approval sheet. position: fixed, sized from the visual viewport (a keyboard or a pan cannot move it off the
 * screen), above everything, with every other floating thing suppressed while it is open (lib/approvalOpen.ts). The call is shown
 * whole in its own scroll area, with the tail pinned under it. Allow stays disabled until the end of the call has been in view
 * (a sentinel after the last line, watched by an IntersectionObserver rooted in the scroll area; once seen it stays seen for as
 * long as this sheet is open and the body is the same) and while the page is pinch-zoomed. Deny is always enabled.
 */
function ApprovalSheet({
  card,
  titleId,
  busy,
  error,
  onAllow,
  onDeny,
  onClose,
  summaryValue,
  now,
}: Props & { summaryValue: string | undefined; onClose: () => void }) {
  const shown = explainShown(card.explain, card.created_at, now)
  const mismatch = shown.kind === 'ready' && shown.explain.mismatch
  // state, not refs: the dialog's content mounts in the portal one render after this component, so a ref is still empty here
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [endEl, setEndEl] = useState<HTMLDivElement | null>(null)
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null)
  const [tailEl, setTailEl] = useState<HTMLParagraphElement | null>(null)
  const [sideways, setSideways] = useState(true) // until measured
  const [seenBody, setSeenBody] = useState<string | null>(null)
  const vv = useVisualViewport()
  const body = card.body ?? ''
  const seen = seenBody === body
  const zoomed = vv.scale > 1.001
  useEffect(() => enterApproval(), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new body starts the reading again
  useEffect(() => {
    const root = scrollEl
    const end = endEl
    if (!root || !end || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeenBody(body)
      },
      { root, threshold: 1 },
    )
    io.observe(end)
    return () => io.disconnect()
  }, [body, scrollEl, endEl])
  // Belt and braces for the wrapping rule above: if the scroll area, the title or the tail still sticks out sideways (a run of
  // characters no wrapping rule can break), part of the call is off screen, so Allow stays off. Re-checked on every resize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new body or a new width is a reason to measure again
  useEffect(() => {
    const els = [scrollEl, titleEl, tailEl]
    if (els.some((e) => !e)) return
    const measure = () =>
      setSideways(els.some((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1))
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    for (const e of els) ro?.observe(e as HTMLElement)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [scrollEl, titleEl, tailEl, body, vv.width])
  const canAllow = seen && !zoomed && !sideways
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid="approval-sheet"
          aria-describedby={undefined}
          aria-labelledby={`${titleId}-sheet`}
          // fixed to the visual viewport, above every other layer
          style={{
            position: 'fixed',
            top: vv.top,
            left: vv.left,
            width: vv.width,
            height: vv.height,
            zIndex: 2147483000,
          }}
          className="flex flex-col bg-bg text-text focus-visible:outline-none"
        >
          <div className="flex items-start gap-2 border-b border-line py-3 pt-[max(0.75rem,env(safe-area-inset-top))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
            <DialogPrimitive.Title
              ref={setTitleEl}
              id={`${titleId}-sheet`}
              className="min-w-0 flex-1 [overflow-wrap:anywhere] break-all font-display text-lg font-semibold"
            >
              {revealHidden(card.title)}
            </DialogPrimitive.Title>
            <Button variant="ghost" onClick={onClose} data-testid="approval-close">
              Close
            </Button>
          </div>
          <section
            ref={setScrollEl}
            data-testid="approval-scroll"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
            tabIndex={0}
            aria-label="The whole call"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]"
          >
            <ExplainBlock shown={shown} />
            <p className="mt-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">The call</p>
            <pre
              data-testid="permission-call"
              className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] break-all rounded-button bg-surface-2 p-2 font-mono text-sm text-text"
            >
              {revealHidden(body)}
            </pre>
            {summaryValue !== undefined ? (
              <div data-testid="permission-summary" className="mt-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
                  Claude's summary
                </p>
                <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] break-all text-text">
                  {revealHidden(summaryValue)}
                </p>
              </div>
            ) : null}
            <div ref={setEndEl} data-testid="approval-end" aria-hidden className="h-px" />
          </section>
          <div className="border-t border-line pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
            <TailLine body={body} elRef={setTailEl} />
            {sideways ? (
              <p data-testid="approval-hint" className="mt-2 text-sm text-text-2">
                Part of this call runs off the side of the screen, so it can't be approved here; answer at the Mac.
              </p>
            ) : !seen ? (
              <p data-testid="approval-hint" className="mt-2 text-sm text-text-2">
                Scroll to the end of the call to enable Allow.
              </p>
            ) : zoomed ? (
              <p data-testid="approval-hint" className="mt-2 text-sm text-text-2">
                Zoom back out to enable Allow.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant={mismatch ? 'primary' : 'danger'} disabled={busy} onClick={onDeny}>
                {card.kill_label}
              </Button>
              <Button
                variant={mismatch ? 'outline' : 'primary'}
                className="ml-auto"
                disabled={busy || !canAllow}
                onClick={onAllow}
              >
                {mismatch ? 'Allow anyway' : card.primary_label}
                {card.risk === 'high' ? <span className="sr-only"> (asks you to confirm with Face ID)</span> : null}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
