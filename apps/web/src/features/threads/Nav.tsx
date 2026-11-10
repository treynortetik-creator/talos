// Navigation chrome: bottom bar on phones (Threads · Needs you · Settings), sidebar on tablet/desktop.

import { ownValue } from '@talos-app/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { threadChordLabel } from '../../lib/keymap.ts'
import { getShell } from '../../lib/native/shell.ts'
import { freshStatus, freshStatuses } from '../../lib/threadStatus.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import {
  IconBell,
  IconBook,
  IconClock,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTerminal,
  IconThreads,
} from '../../ui/icons.tsx'
import { Mascot } from '../../ui/Mascot.tsx'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'
import { useSchedulesDot, useSchedulesSync } from '../schedules/sync.ts'
import { ThreadManageList } from './manage/ThreadManageList.tsx'
import { onBeforeSidebarChange, setSidebarCollapsed, toggleSidebar, useSidebarCollapsed } from './sidebarPref.ts'
import { ThreadRowWithSettings } from './ThreadMoreButton.tsx'
import { ThreadSearchResults, ThreadTools, useThreadSearch } from './ThreadSearch.tsx'
import { useAgentName, useVisibleThreads } from './useThreads.ts'

/** Same rule as Home's "Needs you" tab: an expired or unverifiable card never shows in the badge. */
export function useNeedsYouCount(): number {
  return useAwaitingOwner().length
}

/** The `--danger` dot on the Schedules tab: scheduler stuck, a job failed in the last 24 h, or a job waiting with no session. */
function SchedulesDot() {
  if (!useSchedulesDot()) return null
  return (
    <span
      data-testid="schedules-dot"
      role="img"
      aria-label="Needs a look"
      className="absolute -top-0.5 -right-1 size-2.5 rounded-pill bg-danger shadow-[0_0_0_2px_var(--chrome)]"
    />
  )
}

/** Unread replies across every thread you can see: the badge on the Threads tab. An archived thread is not on any list, so it adds nothing. */
export function useUnreadTotal(): number {
  return useTalos((s) => {
    const archived = new Set(s.threads.filter((t) => t.archived).map((t) => t.id))
    return Object.entries(s.unread).reduce((a, [id, n]) => a + (n > 0 && !archived.has(id) ? n : 0), 0)
  })
}

export function BottomBar() {
  const needs = useNeedsYouCount()
  const unreadTotal = useUnreadTotal()
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      'relative flex min-h-[3.75rem] flex-1 flex-col items-center justify-center gap-1 pt-2.5 pb-1.5 text-xs transition-colors duration-[var(--dur-1)] ease-talos',
      // the terracotta tab indicator: a 3 px bar on the frieze's top edge, plus weight (never colour alone)
      "before:absolute before:inset-x-[22%] before:top-0 before:h-[3px] before:rounded-b-pill before:bg-accent before:opacity-0 before:content-['']",
      isActive ? 'font-semibold text-on-chrome before:opacity-100' : 'text-on-chrome-2',
    )
  return (
    <nav
      aria-label="Main"
      className="kb-hide frieze flex pb-[env(safe-area-inset-bottom)] shadow-[inset_0_4px_0_var(--chrome),inset_0_5.5px_0_var(--on-chrome)] md:hidden"
    >
      <NavLink to="/threads" className={item}>
        <span className="relative">
          <IconThreads />
          {unreadTotal > 0 && (
            <span
              data-testid="threads-tab-count"
              className="absolute -top-1.5 left-[calc(100%-0.5rem)] min-w-5 rounded-pill bg-accent px-1 text-center font-mono text-xs leading-5 text-on-accent shadow-[0_0_0_2px_var(--chrome)]"
              role="img"
              aria-label={`${unreadTotal} unread`}
            >
              {unreadTotal > 99 ? '99+' : unreadTotal}
            </span>
          )}
        </span>
        Threads
      </NavLink>
      <NavLink to="/" end className={item}>
        <span className="relative">
          <IconBell />
          {needs > 0 && (
            <span
              className="absolute -top-1.5 left-[calc(100%-0.5rem)] min-w-5 rounded-pill bg-accent px-1 text-center font-mono text-xs leading-5 text-on-accent shadow-[0_0_0_2px_var(--chrome)]"
              role="img"
              aria-label={`${needs} need you`}
            >
              {needs}
            </span>
          )}
        </span>
        Needs you
      </NavLink>
      <NavLink to="/schedules" className={item}>
        <span className="relative">
          <IconClock />
          <SchedulesDot />
        </span>
        Schedules
      </NavLink>
      <NavLink to="/settings" className={item}>
        <IconSettings />
        Settings
      </NavLink>
    </nav>
  )
}

export function Sidebar() {
  useSchedulesSync()
  const agent = useAgentName()
  const threads = useVisibleThreads()
  const needs = useNeedsYouCount()
  const unread = useTalos((s) => s.unread)
  const statuses = useTalos((s) => s.statuses)
  const working = useTalos((s) => freshStatuses(s.statuses, Date.now()).some((x) => x.state === 'working'))
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const memoryFeature = useFeature('memory/1')
  const collapsed = useSidebarCollapsed()
  const search = useThreadSearch()
  const [editingRaw, setEditing] = useState(false)
  // Managing threads needs the full panel; folding it away ends the mode.
  const editing = editingRaw && !collapsed
  const nav = useNavigate()
  const inbox = useTalos((s) => s.threads.find((t) => t.id === 'inbox'))
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex min-h-11 items-center rounded-button text-sm transition-colors duration-[var(--dur-1)] ease-talos',
      collapsed ? 'relative justify-center px-0' : 'gap-3 px-2.5',
      isActive ? 'bg-chrome-active font-semibold text-on-chrome' : 'text-on-chrome-2 hover:bg-chrome-hover',
    )
  // Expanded: a pill at the row's end. Folded: the same pill pinned to the icon's corner, so unread and Needs you stay in sight.
  const count = (n: number, label: string) => (
    <span
      data-testid="sidebar-count"
      className={cn(
        'min-w-5 rounded-pill bg-accent px-1.5 text-center font-mono text-xs leading-5 text-on-accent',
        collapsed ? 'absolute top-0.5 right-1 shadow-[0_0_0_2px_var(--chrome)]' : 'ml-auto',
      )}
      role="img"
      aria-label={label}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
  /** The row's words: shown beside the icon, read aloud but not drawn on the rail. */
  const text = (label: string) => (collapsed ? <span className="sr-only">{label}</span> : label)
  const tip = (label: string) => (collapsed ? { title: label } : {})
  // Folding by any route (button, chord, another tab) ends manage mode, so unfolding does not bring it back.
  const stopSearch = search.stop
  useEffect(() => {
    if (collapsed) {
      setEditing(false)
      stopSearch()
    }
  }, [collapsed, stopSearch])
  // Folding removes rows. If focus was on one of them it would drop to the page body: put it on the toggle instead.
  const asideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const focusWasInside = useRef(false)
  useEffect(
    () =>
      onBeforeSidebarChange(() => {
        focusWasInside.current = !!asideRef.current?.contains(document.activeElement)
      }),
    [],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per fold or unfold
  useLayoutEffect(() => {
    if (focusWasInside.current && !asideRef.current?.contains(document.activeElement)) toggleRef.current?.focus()
    focusWasInside.current = false
  }, [collapsed])
  return (
    <aside
      ref={asideRef}
      className={cn(
        'frieze hidden shrink-0 flex-col shadow-[inset_-3px_0_0_var(--chrome),inset_-4.5px_0_0_var(--on-chrome)] md:flex',
        collapsed ? 'w-[4.25rem]' : 'w-60',
      )}
      aria-label="Sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className={cn('flex items-center pt-5 pb-4', collapsed ? 'flex-col gap-3 pr-1.5 pl-0' : 'gap-3 px-4')}>
        <Mascot
          state={!macOnline ? 'worried' : working ? 'working' : 'pleased'}
          size={36}
          name={agent}
          animate={working}
        />
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate font-display text-xl font-semibold tracking-wide">{agent}</span>
        )}
        <button
          ref={toggleRef}
          type="button"
          data-testid="sidebar-toggle"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="sidebar-nav"
          aria-keyshortcuts="Control+\ Meta+\"
          title={collapsed ? 'Expand sidebar (Ctrl or Cmd + \\)' : 'Collapse sidebar (Ctrl or Cmd + \\)'}
          onClick={toggleSidebar}
          className="grid min-h-11 min-w-11 place-items-center rounded-button text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome"
        >
          <IconSidebar width={20} height={20} />
        </button>
      </div>
      <nav
        id="sidebar-nav"
        aria-label="Primary"
        className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto', collapsed ? 'pr-2.5 pl-1' : 'px-2 pr-3')}
      >
        <NavLink to="/" end className={link} {...tip('Needs you')}>
          <span className="grid size-7 place-items-center">
            <IconBell width={20} height={20} />
          </span>
          {text('Needs you')}
          {needs > 0 && count(needs, `${needs} need you`)}
        </NavLink>
        <div className="mx-2 mt-2 border-t border-chrome-line pt-2">
          {collapsed ? (
            // the folded rail has room for one thing: the magnifier unfolds the sidebar and opens the search box in it
            <button
              type="button"
              aria-label="Search threads"
              title="Search threads"
              data-testid="search-threads"
              onClick={() => {
                setSidebarCollapsed(false)
                search.start()
              }}
              className="grid min-h-11 w-full place-items-center rounded-button text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome"
            >
              <IconSearch width={20} height={20} />
            </button>
          ) : (
            <ThreadTools search={search} editing={editing} onEditing={setEditing} onCreated={(id) => nav(`/t/${id}`)} />
          )}
        </div>
        {search.searching && !collapsed && <ThreadSearchResults query={search.query} onPick={search.stop} />}
        {editing && !search.searching && <ThreadManageList tone="chrome" />}
        {!editing &&
          !search.searching &&
          threads
            .filter((t) => t.id !== 'inbox')
            .map((t, i) => {
              const row = (
                <NavLink
                  key={t.id}
                  to={`/t/${t.id}`}
                  className={(st) => cn(link(st), !collapsed && 'pr-14')}
                  {...tip(t.name)}
                >
                  <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={28} framed />
                  <span className={collapsed ? 'sr-only' : 'truncate'}>{t.name}</span>
                  {freshStatus(ownValue(statuses, t.id), Date.now())?.state === 'working' && (
                    <span className="sr-only">working</span>
                  )}
                  {(ownValue(unread, t.id) ?? 0) > 0 &&
                    count(ownValue(unread, t.id) ?? 0, `${ownValue(unread, t.id)} unread`)}
                  {threadChordLabel(i + 1, false) && <span className="sr-only">{threadChordLabel(i + 1, false)}</span>}
                </NavLink>
              )
              // the folded rail shows icons only: no room for a "...", and the pencil is not there either
              return collapsed ? (
                row
              ) : (
                <ThreadRowWithSettings key={t.id} thread={t} tone="chrome">
                  {row}
                </ThreadRowWithSettings>
              )
            })}
        {!search.searching &&
          (() => {
            const row = (
              <NavLink to="/t/inbox" className={(st) => cn(link(st), !collapsed && inbox && 'pr-14')} {...tip('Inbox')}>
                <ThreadIcon id="inbox" icon={inbox?.icon} color={inbox?.color} size={28} framed />
                {text('Inbox')}
                {(unread.inbox ?? 0) > 0 && count(unread.inbox ?? 0, `${unread.inbox} unread`)}
              </NavLink>
            )
            // no thread in the synced config yet (or the rail is folded): nothing to open settings for
            return collapsed || !inbox ? (
              row
            ) : (
              <ThreadRowWithSettings thread={inbox} tone="chrome">
                {row}
              </ThreadRowWithSettings>
            )
          })()}
        {!search.searching && (
          <NavLink to="/schedules" className={link} {...tip('Schedules')}>
            <span className="relative grid size-7 place-items-center">
              <IconClock width={20} height={20} />
              <SchedulesDot />
            </span>
            {text('Schedules')}
          </NavLink>
        )}
      </nav>
      <div className={cn('border-t border-chrome-line p-2', collapsed ? 'pr-2.5 pl-1' : 'pr-3')}>
        {memoryFeature !== 'off' && (
          <NavLink to="/memory" className={link} {...tip('Memory')}>
            <span className="grid size-7 place-items-center">
              <IconBook width={20} height={20} />
            </span>
            {text('Memory')}
          </NavLink>
        )}
        {/* The agent's terminal is a native view of the Mac app: there is no such screen in a browser or on the phone. */}
        {getShell() && (
          <NavLink to="/terminal" className={link} {...tip('Terminal')}>
            <span className="grid size-7 place-items-center">
              <IconTerminal width={20} height={20} />
            </span>
            {text('Terminal')}
          </NavLink>
        )}
        <NavLink to="/settings" className={link} {...tip('Settings')}>
          <span className="grid size-7 place-items-center">
            <IconSettings width={20} height={20} />
          </span>
          {text('Settings')}
        </NavLink>
      </div>
    </aside>
  )
}
