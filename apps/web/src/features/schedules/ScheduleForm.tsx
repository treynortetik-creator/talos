// The create / edit form (docs/SCHEDULES.md S5.4). Edit sends only the fields the owner touched; "Review change" sends
// `schedule.patch`, which writes nothing: the bridge answers with an approval card shown in place through CardView.
import { EDIT_LIMITS, ScheduleChange, type ScheduleDetailT, type ScheduleT } from '@talos-app/protocol'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconBack } from '../../ui/icons.tsx'
import { Button, Input, Textarea } from '../../ui/index.ts'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { PROMPT_CAP_BYTES } from './constants.ts'
import {
  blankForm,
  draftFromForm,
  type FormState,
  fieldOfPath,
  formFromSchedule,
  slug,
  touchedSet,
  utf8Len,
  WEEKDAYS,
  type WhenKind,
} from './logic.ts'
import { ProposalCard, proposeError } from './Proposal.tsx'
import { CAPS, FIELD, Field } from './shared.tsx'

const KINDS: Array<{ id: WhenKind; label: string }> = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'days', label: 'Some days' },
  { id: 'monthdays', label: 'Days of the month' },
  { id: 'once', label: 'Once' },
]
const DAY_LABEL: Record<(typeof WEEKDAYS)[number], string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

/** The same rule Chronos applies to an allowed_tools entry (TOOL_RE in third_party/chronos/lib/chronoslib.py). */
const TOOL_ENTRY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,80}(\([^,\n]{1,180}\))?$/

type Props =
  | { mode: 'create'; schedule?: undefined; detail?: undefined; onCancel?: () => void; onDone?: () => void }
  | { mode: 'edit'; schedule: ScheduleT; detail: ScheduleDetailT; onCancel: () => void; onDone: () => void }

export function ScheduleForm(p: Props) {
  const client = useTalosClient()
  const nav = useNavigate()
  const threads = useTalos((s) => s.threads)
  const defaultThread = useTalos((s) => s.config?.default_thread ?? 'general')
  const snap = useTalos((s) => s.schedules.snapshot)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  // the form starts from the revision it was opened on and never silently re-bases
  const [original] = useState(() =>
    p.mode === 'edit' ? formFromSchedule(p.schedule, p.detail.prompt) : blankForm(null),
  )
  const [f, setF] = useState<FormState>(original)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [review, setReview] = useState<{ ref: string; thread: string } | null>(null)
  const up = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }))
  const bytes = utf8Len(f.prompt)
  const overCap = bytes > PROMPT_CAP_BYTES
  const readOnlyPrompt = p.mode === 'edit' && p.detail.prompt_truncated
  // a description the agent wrote can be longer than the form edits: it is shown, never cut
  const longDescription = p.mode === 'edit' && f.description.length > EDIT_LIMITS.description
  const cancel = () => (p.onCancel ? p.onCancel() : nav('/schedules'))

  const submit = async () => {
    setFormError(null)
    const errs: Record<string, string> = {}
    if (f.name.trim() === '') errs.name = 'Give the job a name.'
    if (f.prompt.trim() === '') errs.prompt = 'Say what the job should do.'
    if (overCap) errs.prompt = 'That is longer than 16 KiB.'
    const n = Number(f.catchup)
    if (!Number.isInteger(n) || n < 15 || n > 1440) errs.catchup = 'Between 15 and 1440 minutes.'
    // only a list the owner touched is checked: a job already on the Mac keeps its tools through a rename
    if (f.permissions === 'restricted' && (p.mode === 'create' || f.allowedTools !== original.allowedTools)) {
      const lines = f.allowedTools
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
      if (lines.length === 0) errs.tools = 'List at least one tool, or choose Full permissions.'
      else if (lines.some((l) => !TOOL_ENTRY_RE.test(l)))
        errs.tools =
          'A tool name starts with a letter and uses letters, digits, _ and -. A pattern goes in brackets after it, with no commas.'
    }
    if (f.kind === 'days' && f.days.length === 0) errs.when = 'Pick at least one day.'
    if (f.kind === 'once' && !f.onceDate) errs.when = 'Pick a date.'
    if (f.kind === 'monthdays' && !/^\s*\d+([\s,]+\d+)*\s*$/.test(f.monthdays))
      errs.when = 'List days 1 to 31, like 1, 15.'
    if (Object.keys(errs).length) return setErrors(errs)
    setErrors({})

    const taken = new Set(snap?.schedules.map((x) => x.id) ?? [])
    const thread = (p.mode === 'edit' ? p.schedule.thread_id : f.threadId) ?? defaultThread
    let change: ReturnType<typeof ScheduleChange.safeParse>
    if (p.mode === 'create') {
      const draft = draftFromForm(f, slug(f.name, taken))
      if (!draft) return setErrors({ when: 'Check the schedule.' })
      change = ScheduleChange.safeParse({ op: 'create', draft })
    } else {
      const set = touchedSet(original, f)
      if (Object.keys(set).length === 0) return setFormError('Nothing changed.')
      change = ScheduleChange.safeParse({ op: 'update', id: p.schedule.id, base_etag: p.schedule.etag, set })
    }
    if (!change.success) {
      const next: Record<string, string> = {}
      for (const i of change.error.issues) next[fieldOfPath(i.path.join('.'))] = i.message
      return setErrors(next)
    }
    setBusy(true)
    try {
      const { clientRef } = await client.schedules.proposeScheduleChange(change.data, thread)
      setReview({ ref: clientRef, thread })
    } catch (e) {
      const pe = proposeError(e)
      if (pe.clientRef) {
        // slow, not failed: keep watching for the card instead of reporting an error (a retry would draw a second card)
        setSlow(true)
        setReview({ ref: pe.clientRef, thread })
        return
      }
      setFormError(pe.message)
      const next: Record<string, string> = {}
      for (const fe of pe.fields) next[fieldOfPath(fe.path)] = fe.message
      setErrors(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="schedule-form">
      <div className="top-band">
        <header className="flex items-center gap-2 px-2 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <button
            type="button"
            aria-label="Back"
            onClick={cancel}
            className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
          >
            <IconBack />
          </button>
          <h1 className="m-0 flex-1 font-display text-xl font-semibold">
            {p.mode === 'create' ? 'New scheduled job' : `Edit ${p.schedule.name}`}
          </h1>
        </header>
      </div>
      <ScrollRegion label="Job form" className="min-h-0 flex-1 overflow-y-auto">
        {review ? (
          <div className="space-y-3 p-4">
            <p className="m-0 text-sm text-text-2">
              This is exactly what will be saved. Nothing is written until you approve.
            </p>
            <ProposalCard
              clientRef={review.ref}
              threadId={review.thread}
              slow={slow}
              onReviewAgain={() => setReview(null)}
              onDecided={() => {}}
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setReview(null)}>
                Back to the form
              </Button>
              <Button variant="ghost" onClick={() => (p.onDone ? p.onDone() : nav('/schedules'))}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4 p-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Field label="Name" error={errors.name}>
              {(a) => <Input {...a} value={f.name} maxLength={60} onChange={(e) => up('name', e.target.value)} />}
            </Field>

            <Field
              label="Description"
              error={errors.description}
              hint={
                longDescription
                  ? 'This description is longer than the app can edit. Edit it at the Mac.'
                  : 'Optional. A line about what the job is for.'
              }
            >
              {(a) => (
                <Textarea
                  {...a}
                  rows={2}
                  maxLength={EDIT_LIMITS.description}
                  value={f.description}
                  disabled={longDescription}
                  onChange={(e) => up('description', e.target.value)}
                />
              )}
            </Field>

            <fieldset className="m-0 space-y-2 border-0 p-0">
              <legend className={cn(CAPS, 'mb-1 text-text-2')}>When</legend>
              <div className="flex flex-wrap gap-2">
                {KINDS.map((k) => (
                  <label
                    key={k.id}
                    className={cn(
                      'inline-flex min-h-11 cursor-pointer items-center rounded-pill border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
                      f.kind === k.id
                        ? 'border-accent bg-accent font-semibold text-on-accent'
                        : 'border-line bg-surface text-text',
                    )}
                  >
                    <input
                      type="radio"
                      name="when-kind"
                      className="sr-only"
                      checked={f.kind === k.id}
                      onChange={() => up('kind', k.id)}
                    />
                    {k.label}
                  </label>
                ))}
              </div>
              {f.kind === 'days' ? (
                <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
                  <legend className="sr-only">Days</legend>
                  {WEEKDAYS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={f.days.includes(d)}
                      onClick={() => up('days', f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d])}
                      className={cn(
                        'min-h-11 min-w-11 rounded-button border px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                        f.days.includes(d)
                          ? 'border-accent bg-accent font-semibold text-on-accent'
                          : 'border-line bg-surface text-text',
                      )}
                    >
                      {DAY_LABEL[d]}
                    </button>
                  ))}
                </fieldset>
              ) : null}
              {f.kind === 'monthdays' ? (
                <Field label="Days of the month" hint="Like 1, 15" error={errors.when}>
                  {(a) => (
                    <Input
                      {...a}
                      value={f.monthdays}
                      onChange={(e) => up('monthdays', e.target.value)}
                      inputMode="numeric"
                    />
                  )}
                </Field>
              ) : null}
              {f.kind === 'once' ? (
                <Field label="Date" error={errors.when}>
                  {(a) => (
                    <Input {...a} type="date" value={f.onceDate} onChange={(e) => up('onceDate', e.target.value)} />
                  )}
                </Field>
              ) : null}
              <Field label="Time">
                {(a) => <Input {...a} type="time" value={f.time} onChange={(e) => up('time', e.target.value)} />}
              </Field>
              {f.kind === 'days' && errors.when ? (
                <p role="alert" className="text-sm text-danger">
                  {errors.when}
                </p>
              ) : null}
            </fieldset>

            <Field
              label="What to do"
              error={errors.prompt}
              hint={readOnlyPrompt ? 'Prompt is longer than the app can edit. Edit it at the Mac.' : undefined}
            >
              {(a) => (
                <>
                  <Textarea
                    {...a}
                    rows={8}
                    value={f.prompt}
                    disabled={readOnlyPrompt}
                    onChange={(e) => up('prompt', e.target.value)}
                  />
                  <p
                    className={cn('m-0 font-mono text-xs', overCap ? 'text-danger' : 'text-text-2')}
                    data-testid="byte-counter"
                  >
                    {bytes.toLocaleString('en-US')} / {PROMPT_CAP_BYTES.toLocaleString('en-US')} bytes
                  </p>
                </>
              )}
            </Field>

            <Field label="Posts to">
              {(a) => (
                <select
                  {...a}
                  className={FIELD}
                  value={f.threadId ?? ''}
                  onChange={(e) => up('threadId', e.target.value === '' ? null : e.target.value)}
                >
                  <option value="">The default thread</option>
                  {threads
                    .filter((t) => !t.archived)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>

            <fieldset className="m-0 space-y-2 border-0 p-0">
              <legend className={cn(CAPS, 'mb-1 text-text-2')}>Runs in</legend>
              <div className="flex flex-col gap-2">
                {(
                  [
                    ['session', 'In my live session'],
                    ['headless', 'In the background (no session needed)'],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className="flex min-h-11 items-center gap-2 text-md">
                    <input type="radio" name="runner" checked={f.runner === id} onChange={() => up('runner', id)} />
                    {label}
                  </label>
                ))}
              </div>
              {f.runner === 'headless' ? (
                <p className="m-0 text-sm text-text-2" data-testid="background-note">
                  Runs without your session, with no one watching. macOS can block background runs after Claude Code
                  updates.
                </p>
              ) : null}
            </fieldset>

            <fieldset className="m-0 space-y-2 border-0 p-0">
              <legend className={cn(CAPS, 'mb-1 text-text-2')}>Permissions</legend>
              <div className="flex flex-col gap-2">
                {(
                  [
                    ['full', 'Full permissions'],
                    ['restricted', 'Only the tools I list'],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className="flex min-h-11 items-center gap-2 text-md">
                    <input
                      type="radio"
                      name="permissions"
                      checked={f.permissions === id}
                      onChange={() => up('permissions', id)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {f.permissions === 'restricted' ? (
                <Field
                  label="Allowed tools"
                  hint="One per line, like Read or Grep. The job can use exactly these. A tool like Bash or Edit can change things on your Mac."
                  error={errors.tools}
                >
                  {(a) => (
                    <Textarea
                      {...a}
                      rows={3}
                      value={f.allowedTools}
                      onChange={(e) => up('allowedTools', e.target.value)}
                    />
                  )}
                </Field>
              ) : (
                <p className="m-0 text-sm text-text-2">
                  Runs unattended with full permissions: it can do anything you can on this Mac.
                </p>
              )}
            </fieldset>

            <Field
              label="Tell me"
              hint="This only decides whether Chronos sends its own outside notification. A failed or missed run always shows in the app."
            >
              {(a) => (
                <select
                  {...a}
                  className={FIELD}
                  value={f.notify}
                  onChange={(e) => up('notify', e.target.value as FormState['notify'])}
                >
                  <option value="failure">When it fails</option>
                  <option value="always">Every time it runs</option>
                  <option value="never">Never</option>
                </select>
              )}
            </Field>

            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm text-accent-text underline">Advanced</summary>
              <div className="space-y-4 pt-2">
                <Field
                  label="Catch-up minutes"
                  hint="How late it may still run if your agent was away"
                  error={errors.catchup}
                >
                  {(a) => (
                    <Input
                      {...a}
                      inputMode="numeric"
                      value={f.catchup}
                      onChange={(e) => up('catchup', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Model" hint="Leave empty for the default">
                  {(a) => <Input {...a} value={f.model} maxLength={80} onChange={(e) => up('model', e.target.value)} />}
                </Field>
              </div>
            </details>

            {formError ? (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            ) : null}
            <div className="flex gap-2 pb-4">
              <Button type="submit" disabled={busy || !macOnline}>
                Review change
              </Button>
              <Button type="button" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </ScrollRegion>
    </div>
  )
}

export function NewScheduleScreen() {
  return <ScheduleForm mode="create" />
}
