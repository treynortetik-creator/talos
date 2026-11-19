// Pieces of the bug reporter that the desktop and phone layouts share.
import { BUG_REPORT_LIMITS } from '@talos-app/protocol'
import { useRef, useState } from 'react'
import { cn } from '../../ui/cn.ts'
import { Button, Textarea } from '../../ui/index.ts'
import { Annotator } from './Annotator.tsx'
import { pictureFromFile } from './capture.ts'
import { BUG_TEXT } from './text.ts'
import type { AttachKey, Reporter } from './useReporter.ts'

/** "What went wrong?": required, so Send without it says so under the field. */
export function WentWrong({ r, rows, className }: { r: Reporter; rows: number; className?: string }) {
  const err = `${r.ids.w}-err`
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={r.ids.w} className="text-sm font-semibold">
        {BUG_TEXT.wentWrong}
      </label>
      <Textarea
        id={r.ids.w}
        rows={rows}
        value={r.wentWrong}
        maxLength={BUG_REPORT_LIMITS.whatChars}
        onChange={(e) => r.setWentWrong(e.target.value)}
        aria-required="true"
        aria-invalid={r.missing || undefined}
        aria-describedby={r.missing ? err : undefined}
        placeholder={BUG_TEXT.wentWrongHint}
        className={cn('resize-none', className)}
      />
      {r.missing ? (
        <p id={err} role="alert" className="text-sm text-danger">
          {BUG_TEXT.required}
        </p>
      ) : null}
    </div>
  )
}

/** The exact text that will be sent, in a region the keyboard can scroll. */
export function PreviewBox({ r }: { r: Reporter }) {
  if (!r.showPreview) return null
  return (
    <section
      aria-label={BUG_TEXT.previewTitle}
      data-testid="bug-preview"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus so the keyboard can scroll it
      tabIndex={0}
      className="max-h-60 overflow-auto rounded-card border border-line bg-surface-2 p-3"
    >
      <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs">{r.previewBody}</pre>
    </section>
  )
}

/** Sent or failed, said once and where the buttons are. */
export function SendStatus({ r }: { r: Reporter }) {
  if (r.phase.kind === 'sent')
    return (
      <p role="status" className="text-sm text-ok">
        {BUG_TEXT.sent}
      </p>
    )
  if (r.phase.kind === 'failed')
    return (
      <p role="alert" className="text-sm text-danger">
        {r.phase.text}
      </p>
    )
  return null
}

/** One tick box of what is attached. `touch` makes the row finger-sized (phone). */
export function CheckRow({
  r,
  k,
  label,
  disabled,
  touch,
}: {
  r: Reporter
  k: AttachKey
  label: string
  disabled?: boolean
  touch?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2.5 text-sm text-text',
        touch ? 'min-h-11' : 'min-h-8',
        disabled && 'opacity-50', // the whole row dims, so the checkbox opts out of the field rule (theme/app.css)
      )}
    >
      <input
        type="checkbox"
        checked={r.attach[k]}
        disabled={disabled}
        onChange={() => r.toggle(k)}
        className="size-[18px] shrink-0 accent-[var(--accent)] disabled:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      {label}
    </label>
  )
}

/** Every sentence the phone's line under the picture can show (it is as tall as the longest of them). */
const CAPTURE_LINES = [BUG_TEXT.capturing, BUG_TEXT.drawHint, BUG_TEXT.captureUnsupported, BUG_TEXT.captureFailed]

/**
 * The picture to mark up: "Getting the screen…" while it is taken (the sheet never waits for it), then the capture, or a line
 * saying why there is none. Add a picture takes one from the photo library or a file; pasting an image anywhere in the sheet
 * does the same (BugReporter).
 */
export function PicturePane({ r, fit }: { r: Reporter; fit?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [unreadable, setUnreadable] = useState(false)
  const pick = async (file: File | undefined) => {
    if (!file) return
    const c = await pictureFromFile(file)
    setUnreadable(c === null)
    if (c) r.setPicture(c)
  }
  return (
    <>
      {r.capture ? (
        <Annotator
          base={r.capture.canvas}
          captured={r.capture.ok}
          marks={r.marks}
          setMarks={r.setMarks}
          tool={r.tool}
          ink={r.ink}
          fit={fit}
        />
      ) : (
        // the size the picture will have, so nothing below it moves when it lands (a tap meant for Preview stays on Preview); on a
        // phone its words are in the line below, said once
        <div
          role={fit ? undefined : 'status'}
          aria-hidden={fit ? true : undefined}
          data-testid="bug-capturing"
          style={{ aspectRatio: `${Math.max(1, innerWidth)} / ${Math.max(1, innerHeight)}` }}
          className={cn(
            'flex items-center justify-center rounded-card bg-surface-2 text-sm text-text-2',
            fit ? 'mx-auto h-[min(330px,40dvh)] max-w-full' : 'w-full',
          )}
        >
          {fit ? null : BUG_TEXT.capturing}
        </div>
      )}
      {fit ? (
        // On a phone the line under the picture is always there and only its words change: "Getting the screen…", then why there
        // is no picture, or what to do with the one there is. Every sentence it can show sits in the same grid cell, unseen, so
        // the line is as tall as the longest of them at this width, whichever is showing. When it came and went, a late give-up
        // or an iPhone's "can't take a picture" pushed Preview and the rest down 52 px under a finger on its way (2026-11-19).
        <div data-testid="bug-capture-line" className="grid text-sm text-text-2">
          {CAPTURE_LINES.map((t) => (
            <span key={t} aria-hidden className="invisible col-start-1 row-start-1">
              {t}
            </span>
          ))}
          <p role="status" className="col-start-1 row-start-1">
            {!r.capture
              ? BUG_TEXT.capturing
              : r.capture.ok
                ? BUG_TEXT.drawHint
                : r.capture.unsupported
                  ? BUG_TEXT.captureUnsupported
                  : BUG_TEXT.captureFailed}
          </p>
        </div>
      ) : r.capture && !r.capture.ok ? (
        <p className="text-sm text-text-2">
          {r.capture.unsupported ? BUG_TEXT.captureUnsupported : BUG_TEXT.captureFailed}
        </p>
      ) : null}
      {unreadable ? (
        <p role="alert" className="text-sm text-danger">
          {BUG_TEXT.pictureUnreadable}
        </p>
      ) : null}
      <div>
        <Button variant="outline" className="min-h-11" onClick={() => input.current?.click()}>
          {r.capture?.ok ? BUG_TEXT.replacePicture : BUG_TEXT.addPicture}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          data-testid="bug-picture-input"
          onChange={(e) => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
    </>
  )
}
