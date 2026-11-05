// `/schedules/:id` (docs/SCHEDULES.md S5.3): when, how it runs, what it does, recent runs, the hold banner, and the action
// bar. Run now confirms; Pause writes nothing; Edit, Delete and Turn on go through a card.
import type { ScheduleDetailT, ScheduleLastRunT, ScheduleT } from '@talos-app/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconAlert, IconBack, IconMore } from '../../ui/icons.tsx'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from '../../ui/index.ts'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { copyText } from '../cards/util.ts'
import { useMediaQuery } from '../settings/useMedia.ts'
import { useDetailPanel } from '../threads/DetailPanel.tsx'
import { useAgentName } from '../threads/useThreads.ts'
import { PROMPT_PREVIEW_LINES, RECENT_RUNS } from './constants.ts'
import { HeartbeatDetailBody, HeartbeatStatus } from './heartbeat/HeartbeatDetail.tsx'
import { isHeartbeat } from './heartbeat/logic.ts'
import { permissionWords, runKeyLabel, runNowAsk, runnerWords } from './logic.ts'
import { ProposalSheet } from './Proposal.tsx'
import { ScheduleForm } from './ScheduleForm.tsx'
import { SchedulesScreen, useTellAgent } from './SchedulesScreen.tsx'
import { CAPS, Notice, refusalWords, StatusText, useSchedTime } from './shared.tsx'

const RUN_WORD: Record<string, string> = {
  running: 'Running',
  ok: 'Ran',
  failed: 'Failed',
  timed_out: 'Timed out',
  launch_stalled: 'Stuck at launch',
  session_ended: 'Session ended',
  skipped: 'Skipped',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-t border-line px-4 py-3" aria-label={title}>
      <h2 className={cn(CAPS, 'm-0 text-text-2')}>{title}</h2>
      {children}
    </section>
  )
}

function RunRow({
  r,
  onOpen,
  time,
}: {
  r: ScheduleLastRunT
  onOpen: (r: ScheduleLastRunT) => void
  time: (iso: string) => string
}) {
  const word = RUN_WORD[r.status] ?? r.status
  const bits = [
    r.started_at ? time(r.started_at) : runKeyLabel(r.ds),
    r.runner ? (r.runner === 'session' ? 'Session' : 'Background') : null,
    word,
    r.duration_s !== undefined ? `${r.duration_s} s` : null,
    r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(2)}` : null,
  ].filter(Boolean)
  return (
    <li className="py-1.5 text-sm">
      {r.has_report && r.run_id ? (
        <button
          type="button"
          className="min-h-11 w-full text-left underline-offset-2 hover:underline"
          onClick={() => onOpen(r)}
        >
          {bits.join(' · ')}
        </button>
      ) : (
        <span className="block min-h-6">{bits.join(' · ')}</span>
      )}
      {r.summary ? <span className="block text-text-2">{r.summary}</span> : null}
      {r.late_note ? <span className="block text-text-2">Late note: {r.late_note}</span> : null}
    </li>
  )
}

export function ScheduleDetailScreen() {
  const { id = '' } = useParams()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const row = useTalos((s) => s.schedules.snapshot?.schedules.find((x) => x.id === id))
  const snapLoaded = useTalos((s) => s.schedules.snapshot !== null)
  const status = useTalos((s) => s.schedules.status)
  if (!row) {
    if (snapLoaded || status === 'error') return <Navigate to="/schedules" replace />
    return (
      <p role="status" className="p-6 text-text-2">
        Loading…
      </p>
    )
  }
  if (desktop) return <DesktopDetail id={id} name={row.name} />
  return <Detail s={row} key={id} />
}

/** Desktop: the list stays and the job opens in the shell's right-hand detail panel (DetailPanelContext). */
function DesktopDetail({ id, name }: { id: string; name: string }) {
  const panel = useDetailPanel()
  useEffect(() => {
    // the shell empties the panel on every path change (a parent effect, after this one): open on the next tick
    const t = setTimeout(() => panel.open(<PanelDetail id={id} />, name), 0)
    return () => clearTimeout(t)
  }, [panel, id, name])
  return <SchedulesScreen />
}

function PanelDetail({ id }: { id: string }) {
  const row = useTalos((s) => s.schedules.snapshot?.schedules.find((x) => x.id === id))
  if (!row) return null
  return <Detail s={row} embedded />
}

function Detail({ s, embedded = false }: { s: ScheduleT; embedded?: boolean }) {
  const client = useTalosClient()
  const agent = useAgentName()
  const tell = useTellAgent()
  const snap = useTalos((st) => st.schedules.snapshot)
  const cached = useTalos((st) => st.schedules.details[s.id])
  const defaultThread = useTalos((st) => st.config?.default_thread ?? 'general')
  const threads = useTalos((st) => st.threads)
  const t = useSchedTime(snap?.health ?? null)
  const health = snap?.health ?? null
  const [notice, setNotice] = useState<string | null>(null)
  const [promptAll, setPromptAll] = useState(false)
  const [editing, setEditing] = useState(false)
  const [runAsk, setRunAsk] = useState(false)
  const [report, setReport] = useState<{ text: string | null; loading: boolean; error?: string } | null>(null)
  const [propose, setPropose] = useState<null | {
    title: string
    change: Parameters<typeof ProposalSheet>[0]['change']
  }>(null)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      await client.schedules.getSchedule(s.id, null)
    } catch (e) {
      setNotice(refusalWords(e))
    }
  }, [client, s.id])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch the detail when the row's revision moves
  useEffect(() => {
    if (t.macOnline) void load()
  }, [load, t.macOnline, s.etag, s.state_rev])

  const detail: ScheduleDetailT = cached ?? {
    schedule: s,
    prompt: s.prompt_preview,
    prompt_truncated: s.prompt_bytes > s.prompt_preview.length,
    guard: null,
    next_runs: s.next_run ? [s.next_run] : [],
    runs: s.last_run ? [s.last_run] : [],
  }
  const st = t.status(s)
  const off = !s.enabled || (health?.paused_all ?? false) || s.kind === 'command' || s.when.type === 'events'
  const thread = s.thread_id ? (threads.find((x) => x.id === s.thread_id)?.name ?? s.thread_id) : null
  const lines = detail.prompt.replace(/\n+$/, '').split('\n')
  const shownPrompt = promptAll ? lines : lines.slice(0, PROMPT_PREVIEW_LINES)
  const tooLong = detail.prompt_truncated
  const canWrite = t.macOnline
  const window = s.catchup_min >= 60 ? `${Math.round((s.catchup_min / 60) * 10) / 10} h` : `${s.catchup_min} min`

  const ask = useMemo(() => (health ? runNowAsk(s, health, t.now) : null), [s, health, t.now])
  const run = async (where: 'default' | 'session') => {
    setBusy(true)
    try {
      await client.schedules.runScheduleNow(s.id, { again: ask?.again ?? false, where })
      setRunAsk(false)
      setNotice('Started.')
    } catch (e) {
      setRunAsk(false)
      setNotice(refusalWords(e))
    } finally {
      setBusy(false)
    }
  }
  const pause = async () => {
    setBusy(true)
    try {
      await client.schedules.controlSchedule(s.paused ? 'resume' : 'pause', s.id)
    } catch (e) {
      setNotice(refusalWords(e))
    } finally {
      setBusy(false)
    }
  }
  const openReport = async (r: ScheduleLastRunT) => {
    if (!r.run_id) return
    setReport({ text: null, loading: true })
    try {
      const out = await client.schedules.getSchedule(s.id, r.run_id)
      setReport({ text: out.report ?? 'No report was saved for this run.', loading: false })
    } catch (e) {
      setReport({ text: null, loading: false, error: refusalWords(e) })
    }
  }

  if (editing)
    return (
      <ScheduleForm
        mode="edit"
        schedule={s}
        detail={detail}
        onCancel={() => setEditing(false)}
        onDone={() => {
          setEditing(false)
          void load()
        }}
      />
    )

  return (
    <div className={cn('flex min-h-0 flex-col', embedded ? '-mx-4 -mt-2' : 'h-full')} data-testid="schedule-detail">
      <div className={embedded ? undefined : 'top-band'}>
        <header
          className={cn(
            'flex items-center gap-2',
            embedded ? 'justify-end px-2' : 'px-2 pt-[max(1rem,env(safe-area-inset-top))] pb-3',
          )}
        >
          {embedded ? null : (
            <>
              <Link
                to="/schedules"
                aria-label="Back to Schedules"
                className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
              >
                <IconBack />
              </Link>
              <h1 className="m-0 min-w-0 flex-1 truncate font-display text-xl font-semibold">{s.name}</h1>
            </>
          )}
          <Popover open={menu} onOpenChange={setMenu}>
            <PopoverTrigger asChild>
              <Button variant="ghost" aria-label="More">
                <IconMore />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-1">
              <button
                type="button"
                className="flex min-h-11 w-full items-center rounded-button px-3 text-left text-sm hover:bg-surface-2"
                onClick={async () => {
                  setMenu(false)
                  setNotice((await copyText(s.id)) ? 'Copied the id.' : "Couldn't copy.")
                }}
              >
                Copy id
              </button>
              <button
                type="button"
                disabled={!canWrite || !s.editable}
                className="flex min-h-11 w-full items-center rounded-button px-3 text-left text-sm text-danger hover:bg-surface-2 disabled:opacity-50"
                onClick={() => {
                  setMenu(false)
                  setPropose({ title: `Delete ${s.name}`, change: { op: 'delete', id: s.id, base_etag: s.etag } })
                }}
              >
                Delete
              </button>
            </PopoverContent>
          </Popover>
        </header>
        {embedded ? null : <Meander />}
      </div>
      {/* outside .top-band: on a phone that band re-themes the text tokens but not --ok/--warn/--danger */}
      <div className="px-4 py-2" data-testid="detail-status">
        {isHeartbeat(s) ? (
          // a heartbeat's status is how its last CHECK went ("Couldn't check github"), not whether the run process finished
          <HeartbeatStatus s={s} pausedAll={health?.paused_all ?? false} />
        ) : (
          <StatusText
            st={off && !s.enabled ? { glyph: '', word: 'Off', time: null, tone: 'muted', running: false } : st}
          />
        )}
      </div>

      <ScrollRegion label="Job details" className={cn('min-h-0 flex-1', embedded ? '' : 'overflow-y-auto')}>
        {s.today === 'held' || s.changed_outside ? (
          <div
            role="status"
            data-testid="hold-banner"
            className="m-4 space-y-2 rounded-card border border-warn p-3 text-sm"
          >
            <p className="flex items-start gap-1.5">
              <IconAlert width={16} height={16} className="mt-0.5 shrink-0 text-warn" />
              This job's instructions were changed outside the app. It won't run until you review the change.
            </p>
            <Button
              variant="outline"
              disabled={!canWrite}
              onClick={() =>
                setPropose({
                  title: 'Review outside change',
                  change: { op: 'adopt', id: s.id, content_hash: s.content_hash },
                })
              }
            >
              Review change
            </Button>
          </div>
        ) : null}

        {isHeartbeat(s) ? <HeartbeatDetailBody s={s} detail={detail} canWrite={canWrite} /> : null}

        <Section title="When">
          <p className="m-0 text-md">{s.when_text}</p>
          {detail.next_runs.length > 0 ? (
            <ul className="m-0 list-none space-y-0.5 p-0 text-sm text-text-2" aria-label="Next runs">
              {detail.next_runs.map((n) => (
                <li key={n}>Next: {t.when(n)}</li>
              ))}
            </ul>
          ) : null}
          <p className="m-0 text-sm text-text-2">Still runs if your agent is back within {window}.</p>
        </Section>

        <Section title="How it runs">
          <p className="m-0 text-md">{runnerWords(s.runner)}</p>
          <p className="m-0 flex items-start gap-1.5 text-md">
            {s.permissions === 'full' && s.runner === 'headless' ? (
              <IconAlert width={16} height={16} className="mt-1 shrink-0 text-warn" />
            ) : null}
            {permissionWords(s)}
          </p>
          <p className="m-0 text-sm text-text-2">
            {[s.model ? `Model: ${s.model}` : null, `Posts to ${thread ?? 'the default thread'}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </Section>

        <Section title="What it does">
          {s.kind === 'command' ? (
            <p className="m-0 text-sm text-text-2">This job runs a command. Edit it at the Mac.</p>
          ) : (
            <>
              <pre
                data-testid="prompt"
                className="m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-button bg-surface-2 p-2 font-mono text-sm"
              >
                {shownPrompt.join('\n')}
              </pre>
              {lines.length > PROMPT_PREVIEW_LINES ? (
                <button
                  type="button"
                  className="min-h-11 text-sm text-accent-text underline"
                  onClick={() => setPromptAll((v) => !v)}
                >
                  {promptAll ? 'Show less' : 'Show all'}
                </button>
              ) : null}
              {tooLong ? <p className="m-0 text-sm text-text-2">Prompt is longer than the app can edit.</p> : null}
            </>
          )}
          {detail.guard ? (
            <>
              <h3 className="m-0 mt-2 text-sm font-medium">Standing rules (edited on the Mac)</h3>
              <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-button bg-surface-2 p-2 font-mono text-sm">
                {detail.guard}
              </pre>
            </>
          ) : null}
        </Section>

        <Section title="Recent runs">
          {detail.runs.length === 0 ? (
            <p className="m-0 text-sm text-text-2">Nothing has run yet.</p>
          ) : (
            <ul className="m-0 list-none divide-y divide-line p-0" aria-label="Recent runs">
              {detail.runs.slice(0, RECENT_RUNS).map((r) => (
                <RunRow key={r.run_id ?? `${r.ds}-${r.status}`} r={r} onOpen={openReport} time={t.time} />
              ))}
            </ul>
          )}
        </Section>
      </ScrollRegion>

      <div className="shrink-0 border-t border-line bg-surface p-3" data-testid="action-bar">
        <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-2">
          <Button disabled={!canWrite || busy || s.today === 'held' || off} onClick={() => setRunAsk(true)}>
            Run now
          </Button>
          {!off ? (
            <Button variant="outline" disabled={!canWrite || busy || s.today === 'held'} onClick={pause}>
              {s.paused ? 'Resume' : 'Pause'}
            </Button>
          ) : null}
          {/* a heartbeat's Turn on lives in its own section, behind the test */}
          {!s.enabled && s.editable && !isHeartbeat(s) ? (
            <Button
              variant="outline"
              disabled={!canWrite}
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
          {s.editable ? (
            <Button variant="outline" disabled={!canWrite} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : (
            <span className="text-sm text-text-2" data-testid="read-only-reason">
              {s.read_only_reason ?? 'Edit it at the Mac.'}
            </span>
          )}
          <Button variant="ghost" onClick={() => tell(`About the scheduled job "${s.name}": `, s.thread_id)}>
            Ask {agent}
          </Button>
        </div>
      </div>

      <Sheet open={runAsk} onOpenChange={setRunAsk}>
        <SheetContent aria-describedby={undefined} data-testid="run-now-sheet">
          <SheetTitle className="font-display text-lg font-semibold">Run now</SheetTitle>
          <div className="mt-2 space-y-1.5 text-md">
            {ask?.lines.map((l) => (
              <p key={l} className="m-0">
                {l}
              </p>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy || !canWrite} onClick={() => run('default')}>
              {ask?.again ? 'Run again' : 'Run now'}
            </Button>
            {ask?.offerSession ? (
              <Button variant="outline" disabled={busy || !canWrite} onClick={() => run('session')}>
                Run in your session instead
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setRunAsk(false)}>
              Cancel
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={report !== null} onOpenChange={(o) => !o && setReport(null)}>
        <SheetContent aria-describedby={undefined} data-testid="report-sheet">
          <SheetTitle className="font-display text-lg font-semibold">Run report</SheetTitle>
          {report?.loading ? (
            <p role="status" className="mt-2 text-sm text-text-2">
              Loading…
            </p>
          ) : report?.error ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {report.error}
            </p>
          ) : (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">
              {report?.text}
            </pre>
          )}
          <SheetClose className="mt-3 min-h-11 text-sm text-text-2 underline">Close</SheetClose>
        </SheetContent>
      </Sheet>

      {propose ? (
        <ProposalSheet
          title={propose.title}
          change={propose.change}
          threadId={s.thread_id ?? defaultThread}
          onClose={() => {
            setPropose(null)
            void load()
          }}
        />
      ) : null}
      <Notice text={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
