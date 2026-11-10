// The organized Schedules list (docs/SCHEDULES.md S5.2): the next job with its countdown, the filter chips and search, and one
// collapsible group per thread of one-line job rows. Times and plain words are Chronos's own; this file only lays them out.
import type { ScheduleSnapshotT, ScheduleT } from '@talos-app/protocol'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconBack } from '../../ui/icons.tsx'
import { Switch } from '../../ui/index.ts'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { useNow } from '../cards/util.ts'
import { COPY, fill } from './constants.ts'
import {
  countdownText,
  type JobFilter,
  jobRunnerText,
  nextJob,
  ONEOFF_GROUP,
  type OrgGroup,
  type RowStatus,
  RUNNER_WORDS,
  type Runner,
} from './logic.ts'
import { ProposalSheet } from './Proposal.tsx'
import { CAPS, refusalWords, TONE, useSchedTime } from './shared.tsx'

function Row({
  s,
  runner,
  threadName,
  onNotice,
}: {
  s: ScheduleT
  runner: Runner
  /** The thread group the job is listed under (for a one-off, the thread it came from). */
  threadName: string
  onNotice: (t: string) => void
}) {
  const client = useTalosClient()
  const nav = useNavigate()
  const snap = useTalos((st) => st.schedules.snapshot)
  const t = useSchedTime(snap?.health ?? null)
  const defaultThread = useTalos((st2) => st2.config?.default_thread ?? 'general')
  const [busy, setBusy] = useState(false)
  const paused = snap?.health.paused_all ?? false
  const off = !s.enabled || paused || s.kind === 'command' || s.when.type === 'events'
  const st: RowStatus = off
    ? {
        glyph: '',
        word: !s.enabled
          ? COPY.statusOff
          : s.kind === 'command'
            ? COPY.statusCommand
            : s.when.type === 'events'
              ? COPY.statusEvents
              : COPY.statusPaused,
        time: null,
        tone: 'muted',
        running: false,
      }
    : t.status(s)
  const canPause = !off && s.today !== 'held' && t.macOnline
  const eventsOnly = s.when.type === 'events'
  const [turnOn, setTurnOn] = useState(false)

  const toggle = async () => {
    setBusy(true)
    try {
      await client.schedules.controlSchedule(s.paused ? 'resume' : 'pause', s.id)
    } catch (e) {
      onNotice(refusalWords(e))
    } finally {
      setBusy(false)
    }
  }
  // the status is a dot with its word beside it for a screen reader; the colour is never the only signal
  const dot = st.running ? 'half' : st.tone === 'muted' ? 'ring' : 'solid'
  const canEdit = s.editable && t.macOnline
  const editWhy = !t.macOnline ? COPY.editOffline : (s.read_only_reason ?? COPY.editWhy)
  // who runs the job, in words: shown when it differs from what its group says, read out always
  const who = jobRunnerText(s, runner, threadName)
  const normal = jobRunnerText({ runner: 'session', kind: 'claude', permissions: 'full' }, runner, threadName).text
  const differs = who.text !== normal
  return (
    <li className="flex min-h-11 items-center gap-2 px-4" data-testid={`schedule-row-${s.id}`}>
      <Link
        to={`/schedules/${s.id}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-button transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-medium">{s.name}</span>
            {eventsOnly ? null : <span className="text-sm text-text-2"> · {s.when_text}</span>}
          </span>
          <span
            data-testid="row-runner"
            data-runner={who.own ? runner : 'main'}
            className={differs ? 'block truncate text-xs text-text-2' : 'sr-only'}
          >
            {who.text}
          </span>
        </span>
        <span data-testid="row-status" className={cn('inline-flex shrink-0 items-center gap-1', TONE[st.tone])}>
          <StatusDot shape={dot} />
          <span data-testid="row-glyph" aria-hidden="true" className="text-xs">
            {st.glyph}
          </span>
          <span className="sr-only">{[st.word, st.time].filter(Boolean).join(' ')}</span>
        </span>
      </Link>
      <button
        type="button"
        aria-label={fill(COPY.editJob, { name: s.name })}
        aria-describedby={canEdit ? undefined : `ew-${s.id}`}
        disabled={!canEdit}
        onClick={() => nav(`/schedules/${s.id}?edit=1`)}
        className="min-h-11 shrink-0 rounded-button px-2 text-sm text-text-2 underline underline-offset-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
      >
        {COPY.edit}
      </button>
      {canEdit ? null : (
        <span id={`ew-${s.id}`} className="sr-only">
          {editWhy}
        </span>
      )}
      {off && s.kind !== 'command' && (!s.enabled || eventsOnly) ? (
        <Switch
          aria-label={fill(COPY.switchOn, { name: s.name })}
          checked={false}
          disabled={!t.macOnline}
          onCheckedChange={() => setTurnOn(true)}
        />
      ) : null}
      {turnOn ? (
        <ProposalSheet
          title={`Turn on ${s.name}`}
          threadId={s.thread_id ?? defaultThread}
          change={{ op: 'update', id: s.id, base_etag: s.etag, set: { enabled: true } }}
          onClose={() => setTurnOn(false)}
        />
      ) : null}
      {canPause ? (
        <Switch
          aria-label={fill(COPY.switchRuns, { name: s.name })}
          checked={!s.paused}
          disabled={busy}
          onCheckedChange={() => void toggle()}
        />
      ) : null}
    </li>
  )
}

/** The one job that runs next, and how long until it does (the clock ticks every second). */
export function NextUp({ rows, health }: { rows: ScheduleT[]; health: ScheduleSnapshotT['health'] }) {
  const now = useNow(1000)
  const t = useSchedTime(health)
  const s = nextJob(rows, health, now)
  if (!s?.next_run) return null
  return (
    <section aria-label={COPY.nextUp} data-testid="next-up" className="px-4 pt-4">
      <Link
        to={`/schedules/${s.id}`}
        className="flex min-h-11 flex-wrap items-baseline gap-x-3 rounded-card border border-line bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className={cn(CAPS, 'text-text-2')}>{COPY.nextUp}</span>
        <span className="min-w-0 truncate font-medium">{s.name}</span>
        <span className="text-sm text-text-2">{t.when(s.next_run)}</span>
        <span data-testid="next-up-countdown" className="ml-auto font-mono text-sm tabular-nums text-accent-text">
          {countdownText(s.next_run, now)}
        </span>
      </Link>
    </section>
  )
}

const CHIPS: Array<{ id: JobFilter; label: string }> = [
  { id: 'failed', label: COPY.chipFailed },
  { id: 'paused', label: COPY.chipPaused },
  { id: 'oneoff', label: COPY.chipOneOff },
]

/** The Failed / Paused / One-off chips, and the search box once there are more jobs than SEARCH_AFTER. */
export function FilterBar({
  filters,
  onFilters,
  query,
  onQuery,
  search,
}: {
  filters: ReadonlySet<JobFilter>
  onFilters: (f: ReadonlySet<JobFilter>) => void
  query: string
  onQuery: (q: string) => void
  search: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">{COPY.filters}</legend>
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={filters.has(c.id)}
            onClick={() => {
              const n = new Set(filters)
              if (!n.delete(c.id)) n.add(c.id)
              onFilters(n)
            }}
            className={cn(
              'inline-flex min-h-11 items-center rounded-pill border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              filters.has(c.id)
                ? 'border-accent bg-accent font-semibold text-on-accent'
                : 'border-line bg-surface text-text',
            )}
          >
            {c.label}
          </button>
        ))}
      </fieldset>
      {search ? (
        <input
          type="search"
          aria-label={COPY.search}
          placeholder={COPY.search}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-button border border-line bg-surface px-3 text-md text-text placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      ) : null}
    </div>
  )
}

/** One group: a header that opens and shuts it (name, red dot, count, next run, who runs it) and, when open, its job rows. */
export function GroupSection({
  g,
  open,
  onOpen,
  when,
  onNotice,
}: {
  g: OrgGroup
  open: boolean
  onOpen: (on: boolean) => void
  when: (iso: string) => string
  onNotice: (t: string) => void
}) {
  const tk = g.key === ONEOFF_GROUP ? 'oneoff' : g.key
  return (
    <section
      data-group={tk}
      data-runner={g.runner ?? undefined}
      aria-labelledby={`sg-${tk}`}
      aria-describedby={g.runner ? `sr-${tk}` : undefined}
      data-testid={`thread-group-${tk}`}
    >
      <h2 className="m-0 px-2 pt-2">
        <button
          type="button"
          data-testid={`group-toggle-${tk}`}
          aria-expanded={open}
          aria-controls={`sl-${tk}`}
          onClick={() => onOpen(!open)}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-button px-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          <IconBack
            width={16}
            height={16}
            aria-hidden="true"
            className={cn('shrink-0 text-text-2 transition-transform', open ? '-rotate-90' : 'rotate-180')}
          />
          <span id={`sg-${tk}`} className={cn(CAPS, 'text-text-2')} data-testid="group-name">
            {g.name}
          </span>
          {g.failed ? (
            <span data-testid="group-failed" className="inline-flex items-center text-danger">
              <StatusDot shape="solid" size={8} />
              <span aria-hidden="true" className="ml-0.5 text-xs">
                ✕
              </span>
              <span className="sr-only">{COPY.groupFailed}</span>
            </span>
          ) : null}
          <span className="text-sm text-text-2" data-testid="group-count">
            {g.count === 1 ? COPY.jobOne : fill(COPY.jobMany, { n: String(g.count) })}
          </span>
          {g.next ? (
            <span className="text-sm text-text-2" data-testid="group-next">
              {fill(COPY.nextRun, { when: when(g.next) })}
            </span>
          ) : null}
          {g.runner ? (
            <span
              id={`sr-${tk}`}
              className={cn('text-sm', g.runner === 'main' ? 'text-text-2' : 'text-accent-text')}
              data-testid="group-runner"
              data-runner={g.runner}
            >
              {RUNNER_WORDS[g.runner]}
            </span>
          ) : null}
        </button>
      </h2>
      <ul id={`sl-${tk}`} hidden={!open} className="m-0 list-none divide-y divide-line p-0">
        {open
          ? g.rows.map((r) => (
              <Row
                key={r.id}
                s={r}
                runner={g.from?.[r.id]?.runner ?? g.runner ?? 'main'}
                threadName={g.from?.[r.id]?.name ?? g.name}
                onNotice={onNotice}
              />
            ))
          : null}
      </ul>
    </section>
  )
}
