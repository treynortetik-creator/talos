// A thread session's status as the owner sees it (the mock the owner approved, 2026-11-13): a dot and a short line on the thread list
// row, and a sheet with the whole sentence, what to do at the Mac, and the way to a pending request. Words: words.ts.
import { useState } from 'react'
import { Link } from 'react-router'
import { cn } from '../../ui/cn.ts'
import { IconClose } from '../../ui/icons.tsx'
import { type DotShape, StatusDot } from '../../ui/StatusDot.tsx'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../../ui/sheet.tsx'
import type { SessionTone, SessionWords } from './words.ts'

/** Colour and mark per tone: never colour alone (the mark differs too). */
export const SESSION_TONE: Record<SessionTone, { cls: string; shape: DotShape; word: string }> = {
  needs: { cls: 'text-warn', shape: 'solid', word: 'Needs you' },
  working: { cls: 'text-accent-text', shape: 'half', word: 'Working' },
  long: { cls: 'text-warn', shape: 'half', word: 'Working' },
  idle: { cls: 'text-text-2', shape: 'ring', word: 'Idle' },
  parked: { cls: 'text-text-2', shape: 'quarter', word: 'Parked' },
  failed: { cls: 'text-danger', shape: 'solid', word: 'Stopped' },
  offline: { cls: 'text-text-2', shape: 'ring', word: 'Offline' },
  none: { cls: 'text-text-2', shape: 'ring', word: 'Idle' },
}

/** The row's second line: the mark and the short words, one line, cut with an ellipsis when it must be. */
export function SessionLine({ words, className }: { words: SessionWords; className?: string }) {
  const t = SESSION_TONE[words.tone]
  return (
    <span
      data-testid="session-line"
      data-tone={words.tone}
      className={cn('flex min-w-0 items-center gap-1.5 text-sm', t.cls, className)}
    >
      <StatusDot shape={t.shape} size={8} />
      <span className="truncate">{words.short}</span>
    </span>
  )
}

/** The same marks on the black chrome (the phone header): the page's own text colours are too dark there. */
const ON_CHROME: Record<SessionTone, string> = {
  needs: 'text-warn', // .frieze lifts --warn itself
  working: 'text-chrome-accent-text',
  long: 'text-warn',
  idle: 'text-on-chrome-2',
  parked: 'text-on-chrome-2',
  failed: 'text-[var(--figure-danger)]',
  offline: 'text-on-chrome-2',
  none: 'text-on-chrome-2',
}

/** The sheet: what the session is doing, since when, what to do, and the request when one waits. */
function SessionSheet({
  words,
  cardHref,
  side,
}: {
  words: SessionWords
  cardHref?: string | undefined
  side: 'bottom' | 'right'
}) {
  const t = SESSION_TONE[words.tone]
  return (
    <SheetContent side={side} className="pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div data-testid="session-sheet" className="text-text">
        <div className="flex items-start gap-2">
          <SheetTitle className="m-0 flex-1 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
            This thread's session
          </SheetTitle>
          <SheetClose className="-mt-2 -mr-2 grid size-11 shrink-0 place-items-center rounded-pill hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus">
            <IconClose width={18} height={18} />
            <span className="sr-only">Close</span>
          </SheetClose>
        </div>
        <p className={cn('mt-1 mb-0 flex items-center gap-2 text-base font-medium', t.cls)}>
          <StatusDot shape={t.shape} size={10} />
          {words.short}
        </p>
        <SheetDescription className="mt-2 mb-0 text-sm">{words.long}</SheetDescription>
        {words.step && (
          <p className="mt-3 mb-0 rounded-button bg-surface-2 p-2 text-sm">
            <span className="font-semibold">To go on: </span>
            {words.step}
          </p>
        )}
        {words.openCard && cardHref && (
          <Link
            to={cardHref}
            data-testid="session-open-request"
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-button bg-accent px-4 font-medium text-on-accent focus-visible:outline-2 focus-visible:outline-focus"
          >
            Open the request
          </Link>
        )}
      </div>
    </SheetContent>
  )
}

/**
 * The header's session pill: the word and mark (the mark alone on the narrowest phones); a tap opens the sheet. `onChrome` for
 * the phone's black header. A polite live region says the short words when they change, as the old status dot did.
 */
export function SessionPill({
  words,
  cardHref,
  onChrome = false,
}: {
  words: SessionWords
  cardHref: string | undefined
  onChrome?: boolean
}) {
  const [open, setOpen] = useState(false)
  const t = SESSION_TONE[words.tone]
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* the phone header has no other live text; the desktop header's own live region already says `short` */}
      {onChrome && (
        <span aria-live="polite" className="sr-only" data-testid="session-live">
          {words.short}
        </span>
      )}
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="phone-session-pill"
          aria-label={`${t.word}: ${words.short}. Details`}
          className={cn(
            'relative inline-flex min-h-8 shrink-0 items-center gap-1 rounded-pill border border-current px-2 text-xs',
            // a 44 px target around the slim pill
            'before:absolute before:-inset-y-1.5 before:-inset-x-1 before:content-[""]',
            'focus-visible:outline-2 focus-visible:outline-focus',
            onChrome ? ON_CHROME[words.tone] : t.cls,
          )}
        >
          <StatusDot shape={t.shape} size={8} />
          <span className="max-[379px]:sr-only">{t.word}</span>
        </button>
      </SheetTrigger>
      <SessionSheet words={words} cardHref={cardHref} side={onChrome ? 'bottom' : 'right'} />
    </Sheet>
  )
}
