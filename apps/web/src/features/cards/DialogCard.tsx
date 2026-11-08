// The needs-you card for a Claude Code dialog in a thread session (docs/OPTION-C.md "Needs-you prompts"). The card mirrors the
// dialog: one real button per option, in the order the screen shows them, and a tap is the whole approval (no Face ID). The Mac
// presses the key. This file draws every state of the card (waiting, pressing, answered, nothing pressed, closed, expired).
// The folder, the server and every label come from a repository, so they are plain text with hidden characters shown
// (`dialogVisibleText`: the marker brackets are marked too, so a label cannot print a marker of its own), never markdown and
// never HTML. The bridge writes its sentences with the same function, so they arrive already marked.
import {
  type CardT,
  DIALOG_FOOTNOTE,
  DIALOG_NOTHING_PRESSED_TITLE,
  DIALOG_PRESSING_TEXT,
  dialogOf,
  dialogVisibleText,
} from '@talos-app/protocol'
import type { ReactNode, Ref } from 'react'
import { cn } from '../../ui/cn.ts'
import { Button } from '../../ui/index.ts'
import { isExpiredNow } from './logic.ts'
import { formatClock, revealHidden } from './util.ts'

export type DialogCardProps = {
  card: CardT
  header: ReactNode
  titleId: string
  rootRef: Ref<HTMLElement>
  pulse: boolean
  hash: string
  now: number
  busy: boolean
  error: string | null
  timeZone: string
  /** The rendered hash no longer matches the card the Mac signed. */
  altered: boolean
  /** A tap was sent from this device and the card has not changed yet. */
  decided: boolean
  /** The index of the pressed option, or null for the login card's one button. */
  onChoose: (choice: number | null) => void
}

const EXPIRED_TEXT = 'Expired. Nobody answered in time; the session is still waiting at the Mac.'

type Phase = 'waiting' | 'pressing' | 'answered' | 'nothing' | 'failed' | 'closed' | 'expired'

function phaseOf(card: CardT, expired: boolean, decided: boolean): Phase {
  if (card.state === 'expired' || card.resolution?.action === 'expired') return 'expired'
  if (card.state === 'pending') return expired ? 'expired' : decided ? 'pressing' : 'waiting'
  if (card.state === 'resolved') return 'pressing'
  if (card.state === 'superseded') return 'closed'
  if (card.result?.ok) return 'answered'
  return card.result?.ran === false ? 'nothing' : 'failed'
}

export function DialogCard({
  card,
  header,
  titleId,
  rootRef,
  pulse,
  hash,
  now,
  busy,
  error,
  timeZone,
  altered,
  decided,
  onChoose,
}: DialogCardProps) {
  const d = dialogOf(card)
  const phase = phaseOf(card, isExpiredNow(card, now), decided)
  const shell = (children: ReactNode, tone = 'border-warn') => (
    <article
      ref={rootRef}
      aria-labelledby={titleId}
      data-card-id={card.id}
      data-card-state={phase}
      data-card-kind="dialog"
      data-payload-hash={hash}
      className={cn('incised rounded-card border bg-surface p-4', tone, pulse && 'ring-2 ring-accent')}
    >
      {header}
      {children}
    </article>
  )
  if (altered)
    return shell(
      <>
        <h3 id={titleId} className="mt-1 text-lg font-medium text-text">
          {revealHidden(card.title)}
        </h3>
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          ⚠ This card was altered in transit. Don't answer it.
        </p>
      </>,
      'border-danger',
    )
  if (!d)
    return shell(
      <>
        <h3 id={titleId} className="mt-1 text-lg font-medium text-text">
          {revealHidden(card.title)}
        </h3>
        <p className="mt-2 text-sm text-text-2">This prompt can't be shown here. Answer it at the Mac.</p>
      </>,
    )

  const title = phase === 'nothing' ? DIALOG_NOTHING_PRESSED_TITLE : card.title
  const done = phase !== 'waiting' && phase !== 'pressing'
  const result = card.result?.text
  const by = card.resolution?.by
  const when = formatClock(card.result?.at ?? card.resolution?.at ?? '', timeZone)
  // what the card says under the title once it is no longer waiting
  const resultText = phase === 'expired' ? EXPIRED_TEXT : (result ?? '')

  return shell(
    <>
      <h3 id={titleId} className="mt-1 text-lg font-medium text-text">
        {revealHidden(title)}
      </h3>
      {d.subject !== null && phase !== 'nothing' ? (
        <p
          data-testid="dialog-subject"
          className="mt-2 rounded-button bg-surface-2 p-2 font-mono text-sm text-text [overflow-wrap:anywhere] break-all"
        >
          {dialogVisibleText(d.subject)}
        </p>
      ) : null}
      {phase === 'waiting' || phase === 'pressing' ? (
        <p data-testid="dialog-body" className="mt-2 text-sm text-text-2">
          {revealHidden(card.body ?? '')}
        </p>
      ) : null}
      {done && resultText ? (
        <p data-testid="dialog-result" className="mt-2 text-sm text-text [overflow-wrap:anywhere]">
          {revealHidden(resultText)}
        </p>
      ) : null}
      {phase === 'answered' ? (
        <p data-testid="dialog-meta" className="mt-1 font-mono text-xs text-text-2">
          {[
            by ? `Answered on ${dialogVisibleText(by)}` : 'Answered',
            when,
            d.dialog_kind === 'login' ? '' : 'the session is starting',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {phase === 'pressing' ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-text-2">
          {DIALOG_PRESSING_TEXT}
        </p>
      ) : null}
      {phase === 'waiting' ? (
        <>
          <fieldset
            data-testid="dialog-buttons"
            className="m-0 mt-3 flex min-w-0 flex-wrap items-stretch gap-2 border-0 p-0"
          >
            <legend className="sr-only">Choose an answer</legend>
            {d.dialog_kind === 'login' ? (
              <Button disabled={busy} onClick={() => onChoose(null)}>
                {dialogVisibleText(card.primary_label)}
              </Button>
            ) : (
              d.options.map((label, i) => (
                <Button
                  // the screen order is the identity: two options may read the same
                  // biome-ignore lint/suspicious/noArrayIndexKey: options are fixed for the life of the card
                  key={i}
                  variant="outline"
                  disabled={busy}
                  className="h-auto whitespace-normal py-2 text-left [overflow-wrap:anywhere]"
                  onClick={() => onChoose(i)}
                >
                  {dialogVisibleText(label)}
                </Button>
              ))
            )}
          </fieldset>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <p data-testid="dialog-footnote" className="mt-3 text-xs text-text-2">
            {DIALOG_FOOTNOTE}
          </p>
          <p className="mt-1 font-mono text-xs text-text-2" data-testid="card-expiry">
            Expires {formatClock(card.expires_at, timeZone)} if nobody answers
          </p>
        </>
      ) : null}
    </>,
    phase === 'waiting' || phase === 'pressing' ? 'border-warn' : 'border-line',
  )
}
