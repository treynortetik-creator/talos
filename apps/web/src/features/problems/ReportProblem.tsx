// "Report a problem" (docs/ERRORS.md): what the owner was doing, an optional screenshot, and a preview of EXACTLY what will
// be sent. It lives in Settings -> Health and on the crash screen (where the crash is attached). The preview is built from
// the same report object that is sent, so it cannot drift from it.
import { newUlid, PROBLEM_LIMITS, type ProblemT } from '@talos-app/protocol'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { useStorage } from '../../lib/storageContext.tsx'
import { Button, Textarea } from '../../ui/index.ts'
import { ownerReport } from './capture.ts'
import { ProblemController as Controller, type ProblemController, problems } from './controller.ts'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

type Shot = { name: string; type: string; bytes: ArrayBuffer }
type Outcome =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'saved'; why: 'offline' | 'rate' | 'auth' | 'server' }
  | { kind: 'failed'; text: string }

/** The installed reporter, or (a page that never installed one: tests, the fake build) a private one over the same storage. */
function useController(): ProblemController {
  const client = useTalosClient()
  const storage = useStorage()
  return useMemo(() => problems() ?? new Controller({ storage, client }), [client, storage])
}

/** What gets sent, in words. Every line comes from the report object itself. */
export function previewLines(p: ProblemT, shot: Shot | null): string[] {
  return [
    `App version: ${p.versions.app ?? 'unknown'}${p.versions.shell ? ` (shell ${p.versions.shell})` : ''}`,
    `Protocol: ${p.versions.protocol ?? 'unknown'}`,
    `Device: ${p.device.replace('_', ' ')}`,
    `Screens visited: ${p.routes.length ? p.routes.join(' > ') : 'none recorded'}`,
    ...(p.kind === 'owner' && p.name !== 'Report' ? [`Error: ${p.name}: ${p.message || '(no message)'}`] : []),
    ...(p.frames.length
      ? [
          `Where in the code: ${p.frames.length} stack line${p.frames.length === 1 ? '' : 's'} (names and positions only)`,
        ]
      : []),
    `Your note: ${p.steps?.trim() ? p.steps : '(none)'}`,
    `Screenshot: ${shot ? `${shot.name} (${Math.max(1, Math.round(shot.bytes.byteLength / 1024))} KB)` : 'none'}`,
    p.truncated ? 'Some parts were shortened to fit.' : '',
  ].filter(Boolean)
}

export function ReportProblem({
  error,
  startOpen = false,
  compact = false,
}: {
  /** The crash, when this sits on the crash screen. Only its type, scrubbed message and code positions are used. */
  error?: unknown
  startOpen?: boolean
  compact?: boolean
}) {
  const ctl = useController()
  const [open, setOpen] = useState(startOpen)
  const [steps, setSteps] = useState('')
  const [shot, setShot] = useState<Shot | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [status, setStatus] = useState<{ waiting: number; held: number; dropped: number }>({
    waiting: 0,
    held: 0,
    dropped: 0,
  })
  const id = useId()
  const [reportId, setReportId] = useState(newUlid)
  const area = useRef<HTMLTextAreaElement>(null)
  const done = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    let alive = true
    const read = () =>
      void ctl.status().then((s) => {
        if (alive) setStatus({ waiting: s.waiting, held: s.held, dropped: s.dropped })
      })
    read()
    const off = ctl.subscribe(read)
    return () => {
      alive = false
      off()
    }
  }, [ctl])

  // Opening the form puts the cursor in the note, so a keyboard user can type at once.
  useEffect(() => {
    if (open) area.current?.focus()
  }, [open])
  // A finished send moves focus to its message, so a screen reader hears the result.
  useEffect(() => {
    if (outcome.kind === 'sent' || outcome.kind === 'saved' || outcome.kind === 'failed') done.current?.focus()
  }, [outcome])

  // When the report was sent: set on the first try of a report and kept across a resend of that same report.
  const sentAt = useRef<{ id: string; at: string } | null>(null)

  const report = useMemo(() => ownerReport(steps, ctl.env(), error, reportId), [steps, error, ctl, reportId])

  const pick = async (file: File | undefined) => {
    setShotError(null)
    if (!file) return setShot(null)
    if (!IMAGE_TYPES.includes(file.type)) {
      setShot(null)
      return setShotError('That file is not a picture (PNG, JPEG, WebP or GIF).')
    }
    if (file.size > PROBLEM_LIMITS.screenshotBytes) {
      setShot(null)
      return setShotError(
        `That picture is over ${PROBLEM_LIMITS.screenshotBytes / 1024 / 1024} MB. Pick a smaller one.`,
      )
    }
    try {
      setShot({ name: file.name.slice(0, 80) || 'screenshot', type: file.type, bytes: await file.arrayBuffer() })
    } catch {
      setShotError("Couldn't read that picture.")
    }
  }

  const send = async () => {
    setOutcome({ kind: 'sending' })
    if (sentAt.current?.id !== report.id)
      sentAt.current = { id: report.id, at: new Date(ctl.env().now()).toISOString() }
    const stamped: ProblemT = { ...report, at: sentAt.current.at }
    const r = await ctl.submit(stamped, shot ?? undefined)
    if (r === null) return setOutcome({ kind: 'failed', text: "Couldn't save the report on this device." })
    if (r.rejectedIds.includes(report.id))
      return setOutcome({ kind: 'failed', text: 'The server refused this report, so it was not kept.' })
    // Sent or saved, the report now lives in the queue under its id. The form starts over with a new id, so a later report
    // is a new report and cannot replay or overwrite this one.
    setOutcome(r.stopped ? { kind: 'saved', why: r.stopped } : { kind: 'sent' })
    setReportId(newUlid())
    setSteps('')
    setShot(null)
  }

  const savedText = (o: Extract<Outcome, { kind: 'saved' }>) =>
    o.why === 'offline'
      ? "Saved on this device. It goes out by itself when you're back online."
      : o.why === 'rate'
        ? 'The server is limiting reports right now. This one is saved and goes out when Talos next connects.'
        : o.why === 'auth'
          ? 'Saved on this device. Sign in again and it goes out.'
          : "The server couldn't take it just now. It is saved and will be tried again."

  const note = (
    <div className="flex flex-col gap-1" data-testid="problem-status">
      {status.waiting > 0 && (
        <p className="m-0 text-sm text-text-2">
          {status.waiting} report{status.waiting === 1 ? ' is' : 's are'} waiting to be sent.
        </p>
      )}
      {status.dropped > 0 && (
        <p className="m-0 text-sm text-warn">
          {status.dropped} older report{status.dropped === 1 ? ' was' : 's were'} dropped to keep the waiting list
          short.
        </p>
      )}
      {status.held > 0 && (
        <p className="m-0 text-sm text-warn">
          {status.held} repeat report{status.held === 1 ? ' was' : 's were'} held back (the same problem is sent once
          every 10 minutes, and {PROBLEM_LIMITS.perSession} a session at most).
        </p>
      )}
    </div>
  )

  if (!open)
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button variant="outline" onClick={() => setOpen(true)} data-testid="report-problem-open">
            Report a problem
          </Button>
        </div>
        {outcome.kind === 'sent' && (
          <p ref={done} tabIndex={-1} role="status" className="m-0 text-sm text-text-2" data-testid="report-sent">
            Thanks. Your report was sent.
          </p>
        )}
        {note}
      </div>
    )

  return (
    <form
      aria-labelledby={`${id}-h`}
      data-testid="report-problem"
      className={compact ? 'flex flex-col gap-3 text-left' : 'incised flex flex-col gap-3 rounded-card bg-surface p-4'}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <h3 id={`${id}-h`} className="m-0 text-base font-medium">
        Report a problem
      </h3>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-steps`}>
        <span className="font-medium">What were you doing? (optional)</span>
        <Textarea
          id={`${id}-steps`}
          ref={area}
          value={steps}
          maxLength={PROBLEM_LIMITS.stepsChars}
          onChange={(e) => setSteps(e.target.value)}
          aria-describedby={`${id}-count`}
          placeholder="For example: I opened a thread and tapped Send."
        />
        <span id={`${id}-count`} className="text-xs text-text-2">
          {steps.length} / {PROBLEM_LIMITS.stepsChars}. Please don't paste private messages here.
        </span>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${id}-shot`} className="font-medium">
          Screenshot (optional, up to 5 MB)
        </label>
        <input
          id={`${id}-shot`}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          onChange={(e) => void pick(e.target.files?.[0])}
          className="min-h-11 text-sm file:mr-3 file:min-h-11 file:rounded-button file:border file:border-line file:bg-transparent file:px-4"
        />
        {shotError && (
          <p role="alert" className="m-0 text-sm font-medium text-danger" data-testid="report-shot-error">
            {shotError}
          </p>
        )}
        {shot && (
          <p className="m-0 text-xs text-text-2">A screenshot can show your messages. Check it before you send.</p>
        )}
      </div>
      <section aria-label="What will be sent" className="flex flex-col gap-1">
        <h4 className="m-0 text-sm font-medium">What will be sent</h4>
        <ul data-testid="report-preview" className="m-0 list-none p-0 text-sm text-text-2 [overflow-wrap:anywhere]">
          {previewLines(report, shot).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="m-0 text-xs text-text-2">Your messages and cards are never included.</p>
      </section>
      {outcome.kind === 'saved' && (
        <p ref={done} tabIndex={-1} role="status" className="m-0 text-sm text-text-2" data-testid="report-saved">
          {savedText(outcome)}
        </p>
      )}
      {outcome.kind === 'failed' && (
        <p
          ref={done}
          tabIndex={-1}
          role="alert"
          className="m-0 text-sm font-medium text-danger"
          data-testid="report-failed"
        >
          {outcome.text}
        </p>
      )}
      {outcome.kind === 'sent' && (
        <p ref={done} tabIndex={-1} role="status" className="m-0 text-sm text-text-2" data-testid="report-sent">
          Thanks. Your report was sent.
        </p>
      )}
      {note}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={outcome.kind === 'sending' || shotError !== null}>
          {outcome.kind === 'sending' ? 'Sending…' : 'Send report'}
        </Button>
        <Button variant="outline" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  )
}
