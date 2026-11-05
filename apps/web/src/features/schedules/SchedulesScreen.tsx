// `/schedules` (docs/SCHEDULES.md S5.2): grouped job rows with a pause switch, the health banner, the offline cache and
// every empty state. Times and plain words are Chronos's own; this file only lays them out.
import { SCHEDULES_FEATURE_V2, type ScheduleT } from '@talos-app/protocol'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconPlus } from '../../ui/icons.tsx'
import { Button, Sheet, SheetClose, SheetContent, SheetTitle, Switch } from '../../ui/index.ts'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { prefillComposer } from '../composer/composerStore.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { EmptyState } from './Empty.tsx'
import { HealthBanner, OfflineBanner } from './Health.tsx'
import { HeartbeatSection } from './heartbeat/HeartbeatRow.tsx'
import { isHeartbeat } from './heartbeat/logic.ts'
import { emptyKind, groupSchedules, pickBanner, type RowStatus } from './logic.ts'
import { ProposalSheet } from './Proposal.tsx'
import { CAPS, Notice, refusalWords, StatusText, useSchedTime } from './shared.tsx'
import { refreshSchedules } from './sync.ts'

export function useTellAgent() {
  const nav = useNavigate()
  const threadDefault = useTalos((s) => s.config?.default_thread ?? 'general')
  return (text: string, threadId?: string | null) => {
    const t = threadId ?? threadDefault
    prefillComposer(t, text)
    nav(`/t/${t}`)
  }
}

function Row({ s, onNotice }: { s: ScheduleT; onNotice: (t: string) => void }) {
  const client = useTalosClient()
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
          ? 'Off'
          : s.kind === 'command'
            ? 'Command · read-only'
            : s.when.type === 'events'
              ? 'On events · read-only'
              : 'Paused',
        time: null,
        tone: 'muted',
        running: false,
      }
    : t.status(s)
  const canPause = !off && s.today !== 'held' && t.macOnline
  const eventsOnly = s.when.type === 'events'
  const sub = [
    // an event-only row already says "On events" in its status word
    eventsOnly ? null : s.when_text,
    !off && s.next_run ? `next ${t.when(s.next_run)}` : null,
    !off && (s.today === 'waiting' || s.today === 'running') && s.window_ends ? `until ${t.time(s.window_ends)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
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
  return (
    <li className="flex min-h-16 items-center gap-3 px-4 py-2" data-testid={`schedule-row-${s.id}`}>
      <Link
        to={`/schedules/${s.id}`}
        className="min-w-0 flex-1 rounded-button py-1 transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="block truncate text-[1.0625rem] font-medium">{s.name}</span>
        <span className="block" data-testid="row-status">
          <StatusText st={st} />
        </span>
        <span className="line-clamp-2 text-sm text-text-2">{sub}</span>
      </Link>
      {off && s.kind !== 'command' && (!s.enabled || eventsOnly) ? (
        <Switch
          aria-label={`Turn on ${s.name}`}
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
          aria-label={`${s.name} runs on schedule`}
          checked={!s.paused}
          disabled={busy}
          onCheckedChange={() => void toggle()}
        />
      ) : null}
    </li>
  )
}

const GROUP_LABEL = { today: 'Today', later: 'Later', off: 'Off' } as const

export function SchedulesScreen() {
  const client = useTalosClient()
  const agent = useAgentName()
  const tell = useTellAgent()
  const nav = useNavigate()
  const slice = useTalos((s) => s.schedules)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const t = useSchedTime(slice.snapshot?.health ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [pauseAskOpen, setPauseAskOpen] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const snap = slice.snapshot
  // Pause all: shown while some job is on and nothing is paused already (Resume all is the health banner's button)
  const canPauseAll = Boolean(snap && !snap.health.paused_all && snap.schedules.some((r) => r.enabled && !r.paused))
  const pauseAll = async () => {
    setPauseBusy(true)
    try {
      await client.schedules.controlSchedule('pause_all', null)
      setPauseAskOpen(false)
      void refreshSchedules(client)
    } catch (e) {
      setPauseAskOpen(false)
      setNotice(refusalWords(e))
    } finally {
      setPauseBusy(false)
    }
  }

  // the heartbeat is pinned above the groups, never inside them
  const hbRows = useMemo(() => snap?.schedules.filter(isHeartbeat) ?? [], [snap])
  const groups = useMemo(
    () => (snap ? groupSchedules({ ...snap, schedules: snap.schedules.filter((x) => !isHeartbeat(x)) }, t.now) : null),
    [snap, t.now],
  )
  // "Heartbeat" in [+ New]: only when none exists and the Mac reports several-times-a-day jobs (schedules/2)
  const features = useTalos((s) => s.presence.features)
  const canNewHeartbeat = hbRows.length === 0 && (features ?? []).includes(SCHEDULES_FEATURE_V2)
  const banner = snap ? pickBanner(snap) : null
  const kind = emptyKind(snap, slice.error)
  const fullPage = kind !== null && kind !== 'no_jobs' && kind !== 'unreadable' ? kind : null

  // pull to refresh: a downward drag from the very top of the list
  const pull = useRef<number | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const loading = !snap && macOnline && kind === null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="schedules-screen">
      <div className="top-band">
        <header className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <h1 className="m-0 flex-1 font-display text-2xl font-semibold">Schedules</h1>
          {canPauseAll ? (
            <Button variant="outline" onClick={() => setPauseAskOpen(true)} disabled={!macOnline}>
              Pause all
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setNewOpen(true)} disabled={!macOnline}>
            <IconPlus width={18} height={18} /> New
          </Button>
        </header>
        <Meander />
      </div>
      {!macOnline ? <OfflineBanner asOf={snap ? t.time(snap.as_of) : null} /> : null}
      {macOnline && banner && !fullPage ? <HealthBanner banner={banner} onNotice={setNotice} /> : null}
      <ScrollRegion
        label="Scheduled jobs"
        className="min-h-0 flex-1 overflow-y-auto pb-8"
        ref={scroller}
        onTouchStart={(e) => {
          pull.current = scroller.current && scroller.current.scrollTop <= 0 ? (e.touches[0]?.clientY ?? null) : null
        }}
        onTouchEnd={(e) => {
          const y0 = pull.current
          pull.current = null
          if (y0 !== null && (e.changedTouches[0]?.clientY ?? 0) - y0 > 80) void refreshSchedules(client)
        }}
      >
        {fullPage ? (
          <EmptyState kind={fullPage} agent={agent} snapshot={snap} onTell={() => tell('Set up a scheduled job: ')} />
        ) : loading ? (
          <p role="status" className="p-6 text-center text-text-2">
            Loading…
          </p>
        ) : !snap ? (
          <EmptyState kind="mac_offline" agent={agent} snapshot={null} onTell={() => {}} />
        ) : kind ? (
          <EmptyState kind={kind} agent={agent} snapshot={snap} onTell={() => tell('Set up a scheduled job: ')} />
        ) : (
          groups && (
            <>
              <HeartbeatSection rows={hbRows} onNotice={setNotice} />
              {(['today', 'later', 'off'] as const).map((g) =>
                groups[g].length === 0 ? null : (
                  <section key={g} data-group={g} aria-labelledby={`sg-${g}`}>
                    <h2 id={`sg-${g}`} className={cn(CAPS, 'px-4 pt-4 pb-1 text-text-2')}>
                      {GROUP_LABEL[g]}
                    </h2>
                    <ul className="m-0 list-none divide-y divide-line p-0">
                      {groups[g].map((s) => (
                        <Row key={s.id} s={s} onNotice={setNotice} />
                      ))}
                    </ul>
                  </section>
                ),
              )}
            </>
          )
        )}
        {snap && !fullPage
          ? // no banner for `truncated` (pickBanner), so say it under the list, or the missing jobs go unmentioned (S2.4)
            snap.health.issues
              .filter((i) => i.code === 'truncated')
              .map((i) => (
                <p
                  key={i.code}
                  role="status"
                  className="px-4 pt-3 text-sm text-text-2"
                  data-testid="schedules-truncated"
                >
                  {i.text}
                </p>
              ))
          : null}
        {snap && snap.unreadable.length > 0 && !fullPage ? (
          <section aria-labelledby="sg-unreadable">
            <h2 id="sg-unreadable" className={cn(CAPS, 'px-4 pt-4 pb-1 text-text-2')}>
              Can't be read
            </h2>
            <ul className="m-0 list-none divide-y divide-line p-0">
              {snap.unreadable.map((u) => (
                <li key={u.id} className="px-4 py-2 text-sm">
                  <span className="font-medium">{u.id}</span>
                  <span className="block text-text-2">{u.unreadable} Edit it at the Mac.</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </ScrollRegion>
      <Notice text={notice} onClose={() => setNotice(null)} />
      <Sheet open={pauseAskOpen} onOpenChange={setPauseAskOpen}>
        <SheetContent aria-describedby="pause-all-desc" data-testid="pause-all-sheet">
          <SheetTitle className="font-display text-lg font-semibold">Pause every job?</SheetTitle>
          <p id="pause-all-desc" className="mt-1 text-sm text-text-2">
            No scheduled job runs until you resume them. Each job keeps its own settings. Resume all is on the banner
            that appears.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <Button disabled={pauseBusy || !macOnline} onClick={() => void pauseAll()}>
              Pause all jobs
            </Button>
            <SheetClose className="min-h-11 text-sm text-text-2 underline">Cancel</SheetClose>
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={newOpen} onOpenChange={setNewOpen}>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle className="font-display text-lg font-semibold">New scheduled job</SheetTitle>
          <div className="mt-3 flex flex-col gap-2">
            <Button
              onClick={() => {
                setNewOpen(false)
                tell('Set up a scheduled job: ')
              }}
            >
              Tell {agent}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setNewOpen(false)
                nav('/schedules/new')
              }}
            >
              Fill in a form
            </Button>
            {canNewHeartbeat ? (
              <Button
                variant="outline"
                onClick={() => {
                  setNewOpen(false)
                  nav('/schedules/heartbeat/new')
                }}
              >
                Heartbeat
              </Button>
            ) : null}
          </div>
          <SheetClose className="mt-3 min-h-11 text-sm text-text-2 underline">Cancel</SheetClose>
        </SheetContent>
      </Sheet>
    </div>
  )
}
