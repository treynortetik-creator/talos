// The live permission card (docs/CLAUDE-CODE.md C3.2, C3.9). Claude Code asked to run a tool; the bridge turned the request into
// this card. One tap (owner, 2026-11-21: "If I click Approve, it's approved"): the card in the thread shows what Claude wants in
// one plain line, with Deny and Allow on its face. "Details" opens a full-screen sheet with the whole call for anyone who wants
// to read it; Allow there is enabled at once. Nothing is gated on scrolling or zoom, and a push or /card/:id only scrolls to the
// card and arms it. Allow exists only when the card is exactly what the bridge composed and nothing cuts or hides a part of the
// call (permissionCardAllowsPrimary, the same function the bridge re-checks). Hidden and direction-changing characters are shown
// as visible markers. Deny is always there. What Claude wants to run is ALWAYS on the card's face (the start of the call and its
// "Ends with:" line), never inside a disclosure: the explanation is an extra sentence, never a stand-in for the call, and Allow
// does not wait for it. Only the whole body is behind Details. No Always allow here. A third button, "Allow ... for the rest of this session", shows only on a card the hook raised
// when Claude Code offered a plain rule that has content (`session_allow`, checked again here); it signs the same Allow with `session`.
// Everything is plain text. There is no Edit and no revise.
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  type CardT,
  cardExpiryMs,
  cleanDenyNote,
  cleanSessionRules,
  EXPLAIN_FAILED_TEXT,
  type ExplainShown,
  explainChip,
  explainShown,
  PERMISSION_ASKED_WHY_TEXT,
  PERMISSION_DENY_NOTE_MAX,
  PERMISSION_MAYBE_ANSWERED,
  PERMISSION_MAYBE_ANSWERED_MS,
  PERMISSION_TOO_LONG_BODY,
  permissionCallTail,
  permissionCardAllowsPrimary,
  type SessionRuleT,
  sessionAllowWords,
} from '@talos-app/protocol'
import { type ReactNode, type Ref, useEffect, useState } from 'react'
import { enterApproval } from '../../lib/approvalOpen.ts'
import { cn } from '../../ui/cn.ts'
import { IconAlert } from '../../ui/icons.tsx'
import { Button } from '../../ui/index.ts'
import { Textarea } from '../../ui/textarea.tsx'
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
  /** Opened from a push or /card/:id: the card is scrolled to and armed (CardView), the sheet stays shut. */
  highlighted?: boolean | undefined
  hash: string
  now: number
  busy: boolean
  error: string | null
  timeZone: string
  onAllow: () => void
  /** Allow, and the same kind of call for the rest of this session (signed `session`). Offered only on a card with a clean `session_allow`. */
  onAllowSession?: (() => void) | undefined
  onDeny: () => void
  /** Deny with the owner's cleaned words (undefined: nothing left to say, a plain Deny). Offered only on a card with `deny_note`. */
  onDenyWithNote?: ((note: string | undefined) => void) | undefined
}

/** The placeholder an older bridge put in a too-long card's body (before 2026-11-13). */
const LEGACY_TOO_LONG_BODY = 'This call is too long to show here whole. Approve or deny it at the Mac.'

export function PermissionCardLive(props: Props) {
  const { card, header, titleId, rootRef, pulse, hash, now, busy, error, timeZone, onDeny } = props
  const allowable = permissionCardAllowsPrimary(card)
  const [open, setOpen] = useState(false)
  const summary = card.fields.find((f) => f.key === 'summary')
  const maybeAnswered = now - Date.parse(card.created_at) >= PERMISSION_MAYBE_ANSWERED_MS
  const reason = card.warning ?? (allowable ? null : "This card can't approve the call.")
  const body = card.body ?? ''
  // an older bridge's too-long card carries a placeholder sentence, not the call: never shown as if it were the call
  const showable = body !== '' && body !== PERMISSION_TOO_LONG_BODY && body !== LEGACY_TOO_LONG_BODY
  const preview = [...body].length > PREVIEW_CHARS ? `${[...body].slice(0, PREVIEW_CHARS).join('')}…` : body
  const shown = explainShown(card.explain, card.created_at, now)
  const mismatch = shown.kind === 'ready' && shown.explain.mismatch
  const sessionWords = sessionWordsOf(card, allowable, mismatch, props.onAllowSession)
  const call = (
    <>
      <p className="mt-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">The call</p>
      {allowable ? (
        // the compact card: the start of the call; the whole of it is behind Details
        <div className="mt-1 rounded-button bg-surface-2 p-2 font-mono text-sm text-text">
          <span
            data-testid="permission-preview"
            className="block whitespace-pre-wrap [overflow-wrap:anywhere] break-all"
          >
            {revealHidden(preview)}
          </span>
        </div>
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
      data-talos-protected=""
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
      {call}
      {summary && !allowable ? <SummaryBlock label={summary.label} value={summary.value} /> : null}
      {reason ? (
        <p role="status" className="mt-3 flex items-start gap-1.5 text-sm text-warn">
          <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
          {revealHidden(reason)}
        </p>
      ) : null}
      <AskedWhy card={card} />
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
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(true)} data-testid="permission-open">
              Details
            </Button>
            <Button
              variant={mismatch ? 'outline' : 'primary'}
              className="ml-auto"
              disabled={busy}
              onClick={props.onAllow}
              data-card-primary=""
            >
              {mismatch ? 'Allow anyway' : card.primary_label}
            </Button>
          </>
        ) : null}
      </div>
      {sessionWords && props.onAllowSession ? (
        <SessionButton words={sessionWords} busy={busy} onClick={props.onAllowSession} />
      ) : null}
      {card.deny_note && props.onDenyWithNote ? <DenyNote busy={busy} onSend={props.onDenyWithNote} /> : null}
      <p className="mt-2 font-mono text-xs text-text-2" data-testid="card-expiry">
        Expires {formatClock(new Date(cardExpiryMs(card)).toISOString(), timeZone)} if untouched
      </p>
      {open && allowable ? (
        <ApprovalSheet {...props} summaryValue={summary?.value} onClose={() => setOpen(false)} />
      ) : null}
    </article>
  )
}

/** One muted line on why Claude Code asked, only when the bridge proved the reason (`asked_why`); nothing when it is not known. */
function AskedWhy({ card }: { card: CardT }) {
  const text = card.asked_why ? PERMISSION_ASKED_WHY_TEXT[card.asked_why] : undefined
  if (!text) return null
  return (
    <p data-testid="permission-asked-why" className="mt-2 text-sm text-text-2">
      {text}
    </p>
  )
}

/**
 * "Deny with a note": a small link under the buttons (plain Deny stays one tap). It opens a box for a few words, which go to the agent
 * in the hook's deny answer so it learns what to do instead. Only on a card the hook raised (`deny_note`): a channel-relay verdict has
 * no room for words. The box holds at most PERMISSION_DENY_NOTE_MAX characters; what is sent is the cleaned text, or a plain Deny
 * when nothing is left.
 */
function DenyNote({ busy, onSend }: { busy: boolean; onSend: (note: string | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  if (!open)
    return (
      <div className="mt-2">
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(true)}>
          Deny with a note
        </Button>
      </div>
    )
  return (
    <div className="mt-2" data-testid="deny-note">
      <Textarea
        aria-label="Note for Claude"
        placeholder="Tell Claude what to do instead (optional)"
        className="min-h-16 text-sm"
        value={text}
        disabled={busy}
        onChange={(e) => setText([...e.target.value].slice(0, PERMISSION_DENY_NOTE_MAX).join(''))} // by code points: maxLength counts UTF-16 units and would stop 300 emoji at 150
      />
      <p data-testid="deny-note-count" className="mt-1 text-right font-mono text-xs text-text-2">
        {[...text].length}/{PERMISSION_DENY_NOTE_MAX}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button variant="danger" disabled={busy} onClick={() => onSend(cleanDenyNote(text))}>
          Send deny
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
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

// A call Claude gave no description for (empty, or only spaces) says so, never a bare heading. The protocol already shows a
// line break or tab as a mark (⏎ ⇥) and an invisible character as [U+XXXX], so any other value has something to show.
const NO_DESCRIPTION_TEXT = 'No description given'
/**
 * The words of the third button, or null when there is none. The rules are Claude Code's own text, so they are checked again here
 * (the same checks as the hook and the bridge), and each must be for the tool this card is about: a rule that is not exactly what
 * the card is for, or has any hidden character, shows no button.
 */
function sessionWordsOf(card: CardT, canAllow: boolean, mismatch: boolean, onAllowSession: unknown): string | null {
  if (!onAllowSession || !canAllow || mismatch) return null
  const rules = sessionRulesShown(card)
  return rules ? sessionAllowWords(rules) : null
}

/** The rules the third button shows, checked again here and each for this card's own tool; null when there is none to show. The owner signs the hash of exactly these. */
export function sessionRulesShown(card: CardT): SessionRuleT[] | null {
  const rules = cleanSessionRules(card.session_allow?.rules)
  const tool = (card.payload as { tool_name?: unknown } | null | undefined)?.tool_name
  return rules && typeof tool === 'string' && rules.every((r) => r.tool === tool) ? rules : null
}

function SessionButton({ words, busy, onClick }: { words: string; busy: boolean; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      className="mt-2 h-auto w-full whitespace-normal py-2 text-left [overflow-wrap:anywhere]"
      disabled={busy}
      onClick={onClick}
      data-card-session=""
    >
      {revealHidden(words)}
    </Button>
  )
}

function SummaryBlock({ label, value }: { label: string; value: string }) {
  const blank = /^ *$/.test(value)
  return (
    <div data-testid="permission-summary" className="mt-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">{label}</p>
      {blank ? (
        <p className="mt-1 italic text-text-2">{NO_DESCRIPTION_TEXT}</p>
      ) : (
        <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] break-all text-text">{revealHidden(value)}</p>
      )}
    </div>
  )
}

function TailLine({ body }: { body: string }) {
  return (
    <p data-testid="permission-tail" className="mt-1 [overflow-wrap:anywhere] break-all font-mono text-xs text-text-2">
      <span className="font-sans font-semibold uppercase tracking-[var(--tracking-caps)]">Ends with:</span>{' '}
      {revealHidden(permissionCallTail(body))}
    </p>
  )
}

/**
 * The full-screen approval sheet, the optional "Details" view. position: fixed, sized from the visual viewport (a keyboard or a pan
 * cannot move it off the screen), above everything, with every other floating thing suppressed while it is open
 * (lib/approvalOpen.ts). The whole call is in its own scroll area with the tail pinned under it. Allow is enabled at once.
 */
function ApprovalSheet({
  card,
  titleId,
  busy,
  error,
  onAllow,
  onAllowSession,
  onDeny,
  onDenyWithNote,
  onClose,
  summaryValue,
  now,
}: Props & { summaryValue: string | undefined; onClose: () => void }) {
  const shown = explainShown(card.explain, card.created_at, now)
  const mismatch = shown.kind === 'ready' && shown.explain.mismatch
  const sessionWords = sessionWordsOf(card, true, mismatch, onAllowSession)
  const vv = useVisualViewport()
  const body = card.body ?? ''
  useEffect(() => enterApproval(), [])
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid="approval-sheet"
          data-talos-protected=""
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
            data-testid="approval-scroll"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
            tabIndex={0}
            aria-label="The whole call"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]"
          >
            {card.warning ? (
              // what is not shown (or an older Claude Code), where Allow is tapped: a note, never a refusal
              <p data-testid="approval-note" role="status" className="mb-2 flex items-start gap-1.5 text-sm text-warn">
                <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
                {revealHidden(card.warning)}
              </p>
            ) : null}
            <AskedWhy card={card} />
            <ExplainBlock shown={shown} />
            <p className="mt-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">The call</p>
            <pre
              data-testid="permission-call"
              className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] break-all rounded-button bg-surface-2 p-2 font-mono text-sm text-text"
            >
              {revealHidden(body)}
            </pre>
            {summaryValue !== undefined ? <SummaryBlock label="Claude's summary" value={summaryValue} /> : null}
          </section>
          <div className="border-t border-line pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
            <TailLine body={body} />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
            {card.deny_note && onDenyWithNote ? <DenyNote busy={busy} onSend={onDenyWithNote} /> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant={mismatch ? 'primary' : 'danger'} disabled={busy} onClick={onDeny}>
                {card.kill_label}
              </Button>
              <Button variant={mismatch ? 'outline' : 'primary'} className="ml-auto" disabled={busy} onClick={onAllow}>
                {mismatch ? 'Allow anyway' : card.primary_label}
              </Button>
            </div>
            {sessionWords && onAllowSession ? (
              <SessionButton words={sessionWords} busy={busy} onClick={onAllowSession} />
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
