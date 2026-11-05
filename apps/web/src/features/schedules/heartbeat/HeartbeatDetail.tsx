// What a heartbeat job's detail page adds above the ordinary body (docs/HEARTBEAT.md "In the app"): today's checks, the
// sources exactly as configured with their last result, the mute list, and the Test run / Turn on pair. Every change leaves
// the app as a `schedule.patch` and is shown as the bridge's approval card in a ProposalSheet; nothing here writes directly.
import { dateOfRunKey, type HeartbeatMuteT, type ScheduleDetailT, type ScheduleT } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { useTalos, useTalosClient } from '../../../lib/client.ts'
import { cn } from '../../../ui/cn.ts'
import { Button, Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../../../ui/index.ts'
import { dayKey, runKeyLabel } from '../logic.ts'
import { ProposalSheet } from '../Proposal.tsx'
import { CAPS, FIELD, Field, TONE, useSchedTime } from '../shared.tsx'
import {
  argvWords,
  classWords,
  envWords,
  heartbeatView,
  KIND_WORDS,
  MUTE_LENGTHS,
  metaWithMutes,
  newMute,
  outcomeOfRun,
  parseReportSources,
  quoteWord,
  type ReportSource,
  rowOutcome,
  type SourceConfig,
} from './logic.ts'
import { TestSheet } from './TestSheet.tsx'
import { useHeartbeatTest } from './testStore.ts'
import { useRestoreFocus } from './useRestoreFocus.ts'

export function HeartbeatStatus({ s, pausedAll }: { s: ScheduleT; pausedAll: boolean }) {
  const o = rowOutcome(s, pausedAll)
  return (
    <span
      className={cn('text-sm font-medium', TONE[o.tone])}
      data-testid="heartbeat-detail-outcome"
      data-outcome={o.key}
    >
      {o.word}
    </span>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-t border-line px-4 py-3" aria-label={title}>
      <h2 className={cn(CAPS, 'm-0 text-text-2')}>{title}</h2>
      {children}
    </section>
  )
}

function SourceBlock({
  src,
  last,
  reportState,
}: {
  src: SourceConfig
  last: ReportSource | undefined
  reportState: string
}) {
  return (
    <li className="space-y-0.5 py-2 text-sm" data-testid={`hb-source-${src.id}`}>
      <p className="m-0 font-medium">
        {KIND_WORDS[src.kind]} <span className="font-mono text-xs">{src.id}</span>
        {src.enabled ? '' : ' (off)'}
      </p>
      <p className="m-0 text-text-2">
        Kind: {src.kind} · Class: {classWords(src)} · Gives up after {src.timeout_s} s
      </p>
      {src.kind === 'github' ? <p className="m-0 text-text-2">Repos: {src.args.repos.join(', ')}</p> : null}
      {src.kind === 'command' ? (
        <div className="space-y-0.5 text-text-2" data-testid={`hb-argv-${src.id}`}>
          <p className="m-0 break-all font-mono text-xs">Runs: {argvWords(src.args.argv).join(' ')}</p>
          {src.args.cwd !== undefined ? (
            <p className="m-0 break-all font-mono text-xs">In: {quoteWord(src.args.cwd)}</p>
          ) : null}
          {src.args.env && Object.keys(src.args.env).length > 0 ? (
            <p className="m-0 break-all font-mono text-xs">With: {envWords(src.args.env)}</p>
          ) : null}
        </div>
      ) : null}
      {src.enabled ? (
        <p className="m-0" data-testid={`hb-last-${src.id}`}>
          {last ? (
            <span className={last.ok ? (last.unreadable ? TONE.warn : TONE.ok) : TONE.danger}>
              <span aria-hidden="true">{last.ok ? (last.unreadable ? '!' : '✓') : '✕'}</span>{' '}
              {last.ok ? 'Last check ok' : 'Last check failed'}
              <span className="text-text-2">
                {' '}
                · {(last.ms / 1000).toFixed(1)} s{last.unreadable ? ` · ${last.unreadable} couldn't be read` : ''}
              </span>
            </span>
          ) : (
            <span className="text-text-2">
              {reportState === 'loading'
                ? 'Loading the last result…'
                : reportState === 'error'
                  ? "Couldn't load the last result."
                  : 'No result for this source yet.'}
            </span>
          )}
        </p>
      ) : null}
    </li>
  )
}

export function HeartbeatDetailBody({
  s,
  detail,
  canWrite,
}: {
  s: ScheduleT
  detail: ScheduleDetailT
  canWrite: boolean
}) {
  const client = useTalosClient()
  const snap = useTalos((st) => st.schedules.snapshot)
  const defaultThread = useTalos((st) => st.config?.default_thread ?? 'general')
  const t = useSchedTime(snap?.health ?? null)
  const view = heartbeatView(s)
  const hash = view?.kind === 'config' ? view.hash : null
  const test = useHeartbeatTest(hash)
  const [testOpen, setTestOpen] = useState(false)
  const [muteOpen, setMuteOpen] = useState(false)
  const [propose, setPropose] = useState<null | {
    title: string
    change: Parameters<typeof ProposalSheet>[0]['change']
  }>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [report, setReport] = useState<{ state: 'none' | 'loading' | 'ready' | 'error'; text: string | null }>({
    state: 'none',
    text: null,
  })

  // The last run's report holds the per-source lines. A failed load is shown as a failed load, never as "no result".
  const runId = s.last_run?.has_report ? (s.last_run.run_id ?? null) : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only when the last run changes
  useEffect(() => {
    if (!runId || !t.macOnline) return
    let live = true
    setReport({ state: 'loading', text: null })
    client.schedules
      .getSchedule(s.id, runId)
      .then((r) => live && setReport({ state: 'ready', text: r.report }))
      .catch(() => live && setReport({ state: 'error', text: null }))
    return () => {
      live = false
    }
  }, [client, s.id, runId, t.macOnline])

  if (!view) return null
  if (view.kind === 'problem')
    return (
      <Block title="Heartbeat">
        <p role="alert" className="m-0 text-sm text-danger" data-testid="hb-problem">
          This heartbeat can't be read: {view.problem} Edit it at the Mac.
        </p>
      </Block>
    )

  const { config } = view
  const lastBySource = new Map(parseReportSources(report.text).map((r) => [r.id, r]))
  const today = dayKey(t.now, snap?.health.tz ?? 'UTC')
  const todays = detail.runs
    .filter((r) => dateOfRunKey(r.ds) === today)
    .slice()
    .reverse()
  const canEdit = canWrite && view.exact
  const gateOpen = Boolean(hash) && test.passed(config, t.now)
  const mutes = config.mutes

  const removeMute = (m: HeartbeatMuteT) => {
    const keep = mutes.filter((x) => x !== m)
    const next = metaWithMutes(s, keep)
    if (!next.ok) return setNotice(next.problem)
    setPropose({
      title: 'Remove mute',
      change: { op: 'update', id: s.id, base_etag: s.etag, set: { meta: next.meta as never } },
    })
  }

  return (
    <>
      {view.skipped > 0 ? (
        <p role="status" className="m-4 text-sm text-warn" data-testid="hb-skipped">
          {view.skipped} {view.skipped === 1 ? 'source is' : 'sources are'} from a newer Talos and not shown. Update the
          app before changing this heartbeat.
        </p>
      ) : null}

      <Block title="Today">
        {todays.length === 0 ? (
          <p className="m-0 text-sm text-text-2">No checks yet today.</p>
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0 text-sm" aria-label="Today's checks">
            {todays.map((r) => {
              const o = outcomeOfRun(r)
              return (
                <li key={r.run_id ?? r.ds}>
                  <span className="font-mono text-xs">{runKeyLabel(r.ds).slice(-5)}</span>{' '}
                  <span className={TONE[o.tone]}>{o.word}</span>
                </li>
              )
            })}
          </ul>
        )}
        {detail.next_runs[0] ? <p className="m-0 text-sm text-text-2">Next: {t.when(detail.next_runs[0])}</p> : null}
      </Block>

      <Block title="Sources">
        <ul className="m-0 list-none divide-y divide-line p-0" aria-label="Sources">
          {config.sources.map((src) => (
            <SourceBlock
              key={src.id}
              src={src}
              last={lastBySource.get(src.id)}
              reportState={runId ? report.state : 'none'}
            />
          ))}
        </ul>
        <p className="m-0 text-sm text-text-2">
          Mode:{' '}
          {config.mode === 'shadow'
            ? 'shadow (records and reports, never wakes the agent)'
            : 'live (may wake the agent)'}{' '}
          · At most {config.wake_cap_per_day} wakes a day
        </p>
      </Block>

      <Block title="Muted">
        {mutes.length === 0 ? (
          <p className="m-0 text-sm text-text-2" data-testid="hb-no-mutes">
            Nothing is muted.
          </p>
        ) : (
          <ul className="m-0 list-none divide-y divide-line p-0" aria-label="Muted">
            {mutes.map((m) => (
              <li key={`${m.source}|${m.key ?? ''}|${m.until}`} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 break-words">
                  {m.source} · {m.key === undefined ? 'the whole source' : m.key}
                  <span className="block text-text-2">until {t.when(m.until)}</span>
                </span>
                <Button
                  variant="outline"
                  disabled={!canEdit}
                  onClick={() => removeMute(m)}
                  aria-label={`Remove mute ${m.key ?? m.source}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" disabled={!canEdit} onClick={() => setMuteOpen(true)}>
          Add a mute
        </Button>
        {!view.exact ? (
          <p className="m-0 text-sm text-text-2">Mutes can't be changed here until this heartbeat is fully readable.</p>
        ) : null}
      </Block>

      <Block title="Test and turn on">
        <p className="m-0 text-sm text-text-2" data-testid="hb-gate-note">
          {!s.enabled
            ? gateOpen
              ? 'The test passed for these exact settings.'
              : 'Turn on needs a passing test of these exact settings.'
            : 'Running. Test it any time.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!canWrite || !hash} onClick={() => setTestOpen(true)}>
            Test run
          </Button>
          {!s.enabled && s.editable ? (
            <Button
              disabled={!canWrite || !gateOpen}
              onClick={() =>
                setPropose({
                  title: `Turn on ${s.name}`,
                  change: { op: 'update', id: s.id, base_etag: s.etag, set: { enabled: true } },
                })
              }
            >
              Turn on
            </Button>
          ) : null}
        </div>
        {notice ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {notice}
          </p>
        ) : null}
      </Block>

      {testOpen && hash ? (
        <TestSheet
          config={config}
          hash={hash}
          onClose={() => setTestOpen(false)}
          turnOnLabel={s.enabled ? 'Already on' : 'Turn on'}
          onTurnOn={() => {
            setTestOpen(false)
            if (!s.enabled)
              setPropose({
                title: `Turn on ${s.name}`,
                change: { op: 'update', id: s.id, base_etag: s.etag, set: { enabled: true } },
              })
          }}
        />
      ) : null}
      {muteOpen ? (
        <MuteSheet
          sources={config.sources.map((x) => x.id)}
          onClose={() => setMuteOpen(false)}
          onAdd={(m) => {
            const next = metaWithMutes(s, [...mutes, m])
            if (!next.ok) return next.problem
            setMuteOpen(false)
            setPropose({
              title: 'Mute',
              change: { op: 'update', id: s.id, base_etag: s.etag, set: { meta: next.meta as never } },
            })
            return null
          }}
          nowMs={t.now}
        />
      ) : null}
      {propose ? (
        <ProposalSheet
          title={propose.title}
          change={propose.change}
          threadId={s.thread_id ?? defaultThread}
          onClose={() => setPropose(null)}
        />
      ) : null}
    </>
  )
}

function MuteSheet({
  sources,
  onClose,
  onAdd,
  nowMs,
}: {
  sources: string[]
  onClose: () => void
  /** Returns a problem in words, or null when it went on to a card. */
  onAdd: (m: HeartbeatMuteT) => string | null
  nowMs: number
}) {
  const restore = useRestoreFocus()
  const [source, setSource] = useState(sources[0] ?? '')
  const [key, setKey] = useState('')
  const [len, setLen] = useState<string>('7')
  const [err, setErr] = useState<string | null>(null)
  const whole = key.trim() === ''
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="hb-mute-desc" data-testid="hb-mute-sheet" {...restore}>
        <SheetTitle className="font-display text-lg font-semibold">Mute</SheetTitle>
        <SheetDescription id="hb-mute-desc" className="mt-1 text-sm text-text-2">
          Quiets one thing for a while. You approve it on a card first.
        </SheetDescription>
        <form
          className="mt-3 space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            const days = MUTE_LENGTHS.find((l) => l.id === len)?.days ?? 7
            setErr(onAdd(newMute(source, key, days, nowMs)))
          }}
        >
          <Field label="Source">
            {(a) => (
              <select {...a} className={FIELD} value={source} onChange={(e) => setSource(e.target.value)}>
                {sources.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Item key" hint="Leave blank to mute the whole source.">
            {(a) => (
              <input {...a} className={FIELD} value={key} maxLength={200} onChange={(e) => setKey(e.target.value)} />
            )}
          </Field>
          <Field label="For">
            {(a) => (
              <select {...a} className={FIELD} value={len} onChange={(e) => setLen(e.target.value)}>
                {MUTE_LENGTHS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {whole ? (
            <p className="m-0 text-sm text-warn" data-testid="hb-mute-whole">
              This mutes everything from {source}. The card will ask for extra care.
            </p>
          ) : null}
          {err ? (
            <p role="alert" className="m-0 text-sm text-danger">
              {err}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit">Review on a card</Button>
            <SheetClose className="min-h-11 px-3 text-sm text-text-2 underline">Cancel</SheetClose>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
