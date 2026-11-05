// The Needs-you home (spec 8.2). Tabs, grouped rows, long-press menu, "What did I miss?" chip, "Ask {agent}" FAB.
import type { ThreadStatusT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { useMemo, useRef, useState } from 'react'
import type { NavigateFunction } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { shortAge } from '../../lib/format.ts'
import { cn } from '../../ui/cn.ts'
import { IconChat, IconClock, IconMore } from '../../ui/icons.tsx'
import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { Meander } from '../../ui/Meander.tsx'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { isAltered, resultOverdue } from '../cards/logic.ts'
import { NavScope } from '../cards/nav.tsx'
import { revealHidden, useNow } from '../cards/util.ts'
import type { HomeScreenProps } from '../contracts.ts'
import { HealthBanner } from '../health/HealthBanner.tsx'
import { snoozeUntil } from '../inbox/logic.ts'
import { offerUndo, UndoStrip } from '../inbox/undo.tsx'
import { buildHome, type HomeRow } from './groups.ts'
import { SetupCard } from './SetupCard.tsx'

const LONG_PRESS_MS = 500
const SNOOZE_MS = 60 * 60 * 1000
const SNOOZE_KEY = 'talos.home.snoozed'

/** Snoozes kept on this device, minus any that already ran out. A bad or missing store reads as none. */
export function loadSnoozed(nowMs: number): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      for (const [id, until] of Object.entries(raw)) if (typeof until === 'number' && until > nowMs) out.set(id, until)
  } catch {
    /* unreadable: start empty */
  }
  return out
}
export function saveSnoozed(map: ReadonlyMap<string, number>, nowMs: number): void {
  try {
    const live = Object.fromEntries([...map].filter(([, until]) => until > nowMs))
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(live))
  } catch {
    /* no storage: the snooze holds until he leaves the screen */
  }
}

const CAPS = 'text-xs font-semibold uppercase tracking-[var(--tracking-caps)]'

type Status = { word: string; tone: string }

function rowStatus(row: HomeRow, nowMs: number): Status {
  if (row.kind === 'card') {
    const { card } = row
    // Killed and revised read the same whether the Mac closed the card (done) or an older Mac left it resolved.
    const action = card.resolution?.action
    if ((card.state === 'done' || card.state === 'resolved') && (action === 'kill' || action === 'revise'))
      return { word: action === 'kill' ? 'Killed' : 'Revised', tone: 'text-text-2' }
    switch (card.state) {
      case 'pending':
        if (isAltered(card)) return { word: "Can't verify", tone: 'text-danger' }
        return { word: 'Needs you', tone: 'rounded-pill bg-accent px-1.5 text-on-accent' }
      case 'resolved':
        if (resultOverdue(card, nowMs)) return { word: 'No result', tone: 'text-accent-text' }
        return { word: 'Working', tone: 'text-accent-text' }
      case 'failed':
        return { word: 'Failed', tone: 'text-danger' }
      case 'expired':
        return { word: 'Expired', tone: 'text-text-2' }
      case 'superseded':
        return { word: 'Replaced', tone: 'text-text-2' }
      default:
        return { word: 'Done', tone: 'text-ok' }
    }
  }
  if (row.kind === 'snoozed') return { word: 'Snoozed', tone: 'text-text-2' }
  const st: ThreadStatusT['state'] | undefined = row.status?.state
  if (st === 'working') return { word: 'Working', tone: 'text-accent-text' }
  if (st === 'queued') return { word: 'Queued', tone: 'text-text-2' }
  if (st === 'on_call') return { word: 'On a call', tone: 'text-info' }
  return { word: 'Ready', tone: 'text-ok' }
}

function rowReason(row: HomeRow): string {
  if (row.kind === 'card') {
    const { card } = row
    if (card.state === 'pending' && isAltered(card)) return 'Altered in transit. Do not approve.'
    if (card.state === 'pending')
      return revealHidden(card.summary ?? card.destination[0]?.value ?? `${card.primary_label}?`)
    return revealHidden(card.result?.text ?? card.summary ?? card.title)
  }
  if (row.kind === 'snoozed') return row.item.agent_summary ?? row.item.summary
  if (row.status?.label) return row.status.label
  if (row.unread > 0) return `${row.unread} new`
  const st = row.status?.state
  return st === 'working' ? 'Working…' : st === 'queued' ? 'Waiting its turn' : st === 'on_call' ? 'On a call' : 'Idle'
}

function rowTitle(row: HomeRow): string {
  if (row.kind === 'card') return revealHidden(row.card.title)
  if (row.kind === 'snoozed') return row.item.title
  return row.thread.name
}

function RowIcon({ row }: { row: HomeRow }) {
  if (row.kind === 'snoozed')
    return (
      <span aria-hidden className="grid size-9 shrink-0 place-items-center text-text-2">
        <IconClock />
      </span>
    )
  const id = row.kind === 'card' ? (row.thread?.id ?? row.card.thread_id) : row.thread.id
  const t = row.thread
  return <ThreadIcon id={id} icon={t?.icon} color={t?.color} size={36} />
}

/** "Good morning" in the owner's time zone. */
function greeting(nowMs: number, timeZone: string): string {
  let h = 12
  try {
    h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(nowMs))
  } catch {
    h = new Date(nowMs).getHours()
  }
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
function dateLine(nowMs: number, timeZone: string): string {
  const o: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }
  try {
    return new Intl.DateTimeFormat('en-GB', { ...o, timeZone }).format(nowMs)
  } catch {
    return new Intl.DateTimeFormat('en-GB', o).format(nowMs)
  }
}

export function HomeScreen(_props: HomeScreenProps) {
  return <NavScope>{(navigate) => <HomeScreenInner navigate={navigate} />}</NavScope>
}

function HomeScreenInner({ navigate }: { navigate: NavigateFunction }) {
  const client = useTalosClient()
  const now = useNow(30_000)
  const cards = useTalos((s) => s.cards)
  const threads = useTalos((s) => s.threads)
  const statuses = useTalos((s) => s.statuses)
  const unread = useTalos((s) => s.unread)
  const inbox = useTalos((s) => s.inbox)
  const catchup = useTalos((s) => s.catchup)
  const config = useTalos((s) => s.config)
  const agent = config?.agent.name ?? 'Talos'
  const timeZone = config?.timezone ?? 'UTC'
  const defaultThread = config?.default_thread ?? 'general'

  const [tab, setTab] = useState<'needs' | 'next'>('needs')
  const [query, setQuery] = useState('')
  const [localSnoozed, setLocalSnoozed] = useState<ReadonlyMap<string, number>>(() => loadSnoozed(Date.now()))
  const [menuFor, setMenuFor] = useState<HomeRow | null>(null)

  const model = useMemo(
    () => buildHome({ cards, threads, statuses, unread, inbox }, { nowMs: now, timeZone, localSnoozed }),
    [cards, threads, statuses, unread, inbox, now, timeZone, localSnoozed],
  )

  const q = query.trim().toLowerCase()
  const visible = (rows: HomeRow[]) =>
    q ? rows.filter((r) => `${rowTitle(r)} ${rowReason(r)}`.toLowerCase().includes(q)) : rows

  const missed =
    catchup !== null &&
    (catchup.open_cards > 0 ||
      catchup.threads.some((t) => t.unread > 0 || t.needs_you) ||
      Object.values(catchup.overnight?.counts ?? {}).some((n) => n > 0))

  const open = (row: HomeRow) => {
    if (row.kind === 'card') navigate(`/card/${row.card.id}`)
    else if (row.kind === 'thread') navigate(`/t/${row.thread.id}`)
    else navigate('/t/inbox')
  }

  const snooze = (row: HomeRow) => {
    const next = new Map(localSnoozed)
    if (row.kind === 'snoozed') {
      // An inbox item: the same time goes to the relay (it refuses a snooze without one) and to the local view.
      const until = snoozeUntil(new Date(now), timeZone, config?.quiet_window ?? null)
      next.set(row.id, until.getTime())
      void client.updateInbox(row.item.id, { state: 'snoozed', snoozeUntil: until.toISOString() })
      offerUndo(row.item, 'snoozed')
    } else next.set(row.id, now + SNOOZE_MS)
    saveSnoozed(next, now)
    setLocalSnoozed(next)
    setMenuFor(null)
  }
  const markDone = (row: HomeRow) => {
    if (row.kind === 'thread')
      client.markThreadRead(row.thread.id, ownValue(client.store.getState().messages, row.thread.id)?.at(-1)?.seq ?? 0)
    if (row.kind === 'snoozed') {
      void client.updateInbox(row.item.id, { state: 'done' })
      offerUndo(row.item, 'done')
    }
    setMenuFor(null)
  }

  const allEmpty = model.groups.every((g) => g.rows.length === 0)
  const noMatch = q !== '' && model.groups.every((g) => visible(g.rows).length === 0)
  const searchAll = (
    <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="home-no-match">
      <p className="m-0 text-text-2">Nothing here matches “{query.trim()}”.</p>
      <a
        href={`/search?q=${encodeURIComponent(query.trim())}`}
        className="inline-flex min-h-11 items-center text-accent-text underline"
        onClick={(e) => {
          e.preventDefault()
          navigate(`/search?q=${encodeURIComponent(query.trim())}`)
        }}
      >
        Search all messages
      </a>
    </div>
  )

  const macOnline = useTalos((s) => s.presence.bridge_online)
  const working = model.groups.some((g) => g.id === 'working' && g.rows.length > 0)
  const mood = !macOnline ? 'worried' : working ? 'working' : 'pleased'

  const list = (rows: HomeRow[]) => (
    <ul className="incised m-0 list-none divide-y divide-line overflow-hidden rounded-card bg-surface p-1">
      {rows.map((r) => (
        <HomeRowView key={r.id} row={r} nowMs={now} onOpen={() => open(r)} onMenu={() => setMenuFor(r)} />
      ))}
    </ul>
  )

  return (
    <section aria-label="Needs you" className="mx-auto flex w-full max-w-3xl flex-col pb-28">
      <div className="top-band">
        <header className="flex items-center gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          {allEmpty ? null : <Mascot state={mood} size={56} name={agent} />}
          <div className="min-w-0 flex-1">
            <h1 className="m-0 font-display text-xl font-semibold leading-tight sm:text-2xl">
              {greeting(now, timeZone)}
            </h1>
            <p className="m-0 text-sm text-text-2">{dateLine(now, timeZone)}</p>
          </div>
        </header>
        <Meander />
      </div>
      <HealthBanner />

      <div className="flex flex-col gap-3 px-4 pt-4">
        <SetupCard onSettings={() => navigate('/settings/notifications')} />
        <div className="flex items-center gap-2">
          <Input
            type="search"
            aria-label="Search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {missed ? (
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => {
                void client.sendMessage({
                  threadId: defaultThread,
                  text: 'What did I miss?',
                  intent: 'what_did_i_miss',
                })
                navigate(`/t/${defaultThread}`)
              }}
            >
              What did I miss?
            </Button>
          ) : null}
        </div>

        <UndoStrip floating />

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'needs' | 'next')}>
          <TabsList aria-label="Home" className="flex w-full">
            <TabsTrigger value="needs">Needs you ({model.needsYouCount})</TabsTrigger>
            <TabsTrigger value="next">Up next ({model.upNext.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="needs">
            {noMatch ? (
              searchAll
            ) : allEmpty ? (
              <div
                className="incised mt-5 flex flex-col items-center gap-3.5 rounded-card bg-surface px-6 py-8 text-center"
                data-testid="home-empty"
              >
                <Mascot state={mood === 'worried' ? 'worried' : 'pleased'} size={104} name={agent} />
                <p className="m-0 font-display text-xl font-semibold text-text">Nothing needs you right now.</p>
                <p className="m-0 max-w-[34ch] text-sm text-text-2">
                  When {agent} needs a yes, a look or an answer, it lands here first.
                </p>
                <Button onClick={() => navigate(`/t/${defaultThread}`)}>Talk to {agent}</Button>
              </div>
            ) : (
              model.groups.map((g) => {
                const rows = visible(g.rows)
                if (rows.length === 0) return null
                return (
                  <section key={g.id} aria-labelledby={`home-${g.id}`} data-group={g.id} className="mt-6">
                    <h2
                      id={`home-${g.id}`}
                      className="m-0 mb-2 flex items-baseline gap-2 font-display text-lg font-semibold text-text"
                    >
                      {g.title}{' '}
                      <span
                        data-testid={`count-${g.id}`}
                        className="rounded-pill bg-surface-2 px-2 font-sans text-xs font-semibold leading-5 text-text-2"
                      >
                        {g.rows.length}
                      </span>
                    </h2>
                    {list(rows)}
                  </section>
                )
              })
            )}
          </TabsContent>

          <TabsContent value="next">
            {visible(model.upNext).length === 0 && q !== '' ? (
              searchAll
            ) : visible(model.upNext).length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Mascot state="pleased" size={88} name={agent} decorative />
                <p className="m-0 text-text-2">Nothing is waiting in the wings.</p>
              </div>
            ) : (
              <div className="mt-4">{list(visible(model.upNext))}</div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Sheet open={menuFor !== null} onOpenChange={(o) => !o && setMenuFor(null)}>
        {menuFor ? (
          <SheetContent aria-describedby={undefined} className="space-y-1">
            <SheetTitle className="truncate text-sm text-text-2">Actions for {rowTitle(menuFor)}</SheetTitle>
            {menuFor.kind === 'card' && isAltered(menuFor.card) ? null : (
              <Button variant="outline" className="w-full" onClick={() => snooze(menuFor)}>
                Snooze
              </Button>
            )}
            {menuFor.kind !== 'card' ? (
              <Button variant="outline" className="w-full" onClick={() => markDone(menuFor)}>
                Mark done
              </Button>
            ) : null}
            <Button variant="ghost" className="w-full" onClick={() => setMenuFor(null)}>
              Close
            </Button>
          </SheetContent>
        ) : null}
      </Sheet>

      {allEmpty ? null : (
        <Button
          className="fixed right-4 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-10 min-h-12 rounded-pill pr-5 pl-4 shadow-[0_0_0_3px_var(--bg)] md:right-[max(1.5rem,calc((100vw-var(--sidebar-w)-760px)/2+1rem))] md:bottom-6"
          onClick={() => navigate(`/t/${defaultThread}`)}
        >
          <IconChat width={20} height={20} />
          Ask {agent}
        </Button>
      )}
    </section>
  )
}

function HomeRowView({
  row,
  nowMs,
  onOpen,
  onMenu,
}: {
  row: HomeRow
  nowMs: number
  onOpen: () => void
  onMenu: () => void
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const status = rowStatus(row, nowMs)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return (
    <li className="flex min-h-16 items-center">
      <button
        type="button"
        data-row-id={row.id}
        className={cn(
          'flex min-h-[4.25rem] min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-left select-none transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2',
        )}
        onPointerDown={() => {
          fired.current = false
          cancel()
          timer.current = setTimeout(() => {
            fired.current = true
            onMenu()
          }, LONG_PRESS_MS)
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu()
        }}
        onClick={() => {
          if (fired.current) {
            fired.current = false
            return
          }
          onOpen()
        }}
      >
        <RowIcon row={row} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-text">{rowTitle(row)}</span>
          <span className="block truncate text-sm text-text-2">{rowReason(row)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn(CAPS, status.tone)}>{status.word}</span>
          <span className="font-mono text-xs tabular-nums text-text-2">{shortAge(row.at, nowMs)}</span>
        </span>
      </button>
      <Button variant="ghost" aria-label={`More actions for ${rowTitle(row)}`} onClick={onMenu} className="text-text-2">
        <IconMore />
      </Button>
    </li>
  )
}
