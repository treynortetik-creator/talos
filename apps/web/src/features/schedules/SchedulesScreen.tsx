// `/schedules` (docs/SCHEDULES.md S5.2): grouped job rows with a pause switch, the health banner, the offline cache and
// every empty state. Times and plain words are Chronos's own; this file only lays them out.
import { SCHEDULES_FEATURE_V2, threadSessionMode } from '@talos-app/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconPlus } from '../../ui/icons.tsx'
import { Button, Sheet, SheetClose, SheetContent, SheetTitle } from '../../ui/index.ts'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { prefillComposer } from '../composer/composerStore.ts'
import { useThreadSessionsSupported, useWorkersStatus } from '../thread-sessions/store.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { COPY, SEARCH_AFTER } from './constants.ts'
import { EmptyState } from './Empty.tsx'
import { FilterBar, GroupSection, NextUp } from './GroupList.tsx'
import { HealthBanner, OfflineBanner } from './Health.tsx'
import { HeartbeatSection } from './heartbeat/HeartbeatRow.tsx'
import { isHeartbeat } from './heartbeat/logic.ts'
import { emptyKind, groupByThread, type JobFilter, organize, pickBanner, runnerOf } from './logic.ts'
import { CAPS, Notice, refusalWords, useSchedTime } from './shared.tsx'
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
/** What the owner set on the list (groups opened or shut, chips, search), per app session: see SchedulesScreen. */
type View = { openBy: Record<string, boolean>; filters: ReadonlySet<JobFilter>; query: string }
const SESSION = new WeakMap<object, View>()

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
  // What the owner set on the list: which groups are open (a group not in openBy opens by itself only while something needs the
  // owner), the chips and the search. Kept while the app is open, so a job's details (a page of their own on a phone, the
  // screen remounting on desktop) and back find the list as it was; a new launch starts fresh. Not a setting, never saved.
  const [view, setViewState] = useState<View>(
    () => SESSION.get(client) ?? { openBy: {}, filters: new Set(), query: '' },
  )
  const setView = (f: (v: View) => View) =>
    setViewState((v) => {
      const next = f(v)
      SESSION.set(client, next)
      return next
    })
  const { openBy, filters, query } = view
  const setOpen = (key: string, on: boolean) => setView((v) => ({ ...v, openBy: { ...v.openBy, [key]: on } }))
  const setFilters = (f: ReadonlySet<JobFilter>) => setView((v) => ({ ...v, filters: f }))
  const setQuery = (q: string) => setView((v) => ({ ...v, query: q }))
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
  // grouped by the thread a job runs in: Main first, then each thread, each saying who runs its jobs
  const config = useTalos((s) => s.config)
  const threads = useTalos((s) => s.threads)
  const workers = useWorkersStatus()
  const sessionsSupported = useThreadSessionsSupported(workers)
  const groups = useMemo(
    () =>
      snap
        ? groupByThread({ ...snap, schedules: snap.schedules.filter((x) => !isHeartbeat(x)) }, t.now, {
            threads,
            defaultThread: config?.default_thread ?? 'general',
            runner: (id) =>
              id === null
                ? 'main'
                : runnerOf({
                    dedicated: config ? threadSessionMode(config, id) === 'dedicated' : false,
                    supported: sessionsSupported,
                    worker: workers?.threads.find((w) => w.thread_id === id),
                  }),
          })
        : null,
    [snap, t.now, threads, config, workers, sessionsSupported],
  )
  const listed = useMemo(() => snap?.schedules.filter((x) => !isHeartbeat(x)) ?? [], [snap])
  const filtering = filters.size > 0 || query.trim() !== ''
  const shown = useMemo(
    () => (groups && snap ? organize(groups, { nowMs: t.now, health: snap.health, filters, query }) : null),
    [groups, snap, t.now, filters, query],
  )
  // A group that opened itself stays open: once it has (and the thread list is known, so no job sits in Main only for want of it), record it, so pausing the failed job (or its failure clearing) does not
  // shut it under the owner's finger. A group the owner shut stays shut; its red dot is the signal of a new failure.
  const toRecord =
    !filtering && threads.length > 0 ? (shown ?? []).filter((g) => g.autoOpen && openBy[g.key] === undefined) : []
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a group newly opens itself
  useEffect(() => {
    if (toRecord.length > 0)
      setView((v) => ({ ...v, openBy: { ...v.openBy, ...Object.fromEntries(toRecord.map((g) => [g.key, true])) } }))
  }, [toRecord.map((g) => g.key).join('|')])
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
              {snap && !filtering ? <NextUp rows={listed} health={snap.health} /> : null}
              <HeartbeatSection rows={hbRows} onNotice={setNotice} />
              {listed.length > 0 ? (
                <FilterBar
                  filters={filters}
                  onFilters={setFilters}
                  query={query}
                  onQuery={setQuery}
                  search={listed.length > SEARCH_AFTER || query !== ''}
                />
              ) : null}
              {filtering && shown?.length === 0 ? (
                <p role="status" data-testid="filter-empty" className="px-4 pt-4 text-sm text-text-2">
                  {COPY.filterEmpty}
                </p>
              ) : null}
              {shown?.map((g) => (
                <GroupSection
                  key={g.key}
                  g={g}
                  open={filtering || (openBy[g.key] ?? g.autoOpen)}
                  onOpen={(on: boolean) => setOpen(g.key, on)}
                  when={t.when}
                  onNotice={setNotice}
                />
              ))}
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
