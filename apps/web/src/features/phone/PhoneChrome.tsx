// Phone chrome mounted once in the shell: the left menu (every thread, inbox, schedules, memory, settings), the session
// drawer on the right, and the edge swipes that open them. Renders nothing at tablet width and up.

import { ownValue, type ThreadT } from '@talos-app/protocol'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { useThreadStatus } from '../../lib/threadStatus.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import { IconBell, IconBook, IconClock, IconClose, IconMic, IconSettings, IconThreads } from '../../ui/icons.tsx'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../ui/index.ts'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { useSchedulesDot } from '../schedules/sync.ts'
import { useMediaQuery } from '../settings/useMedia.ts'
import { ThreadEditor } from '../threads/manage/ThreadEditor.tsx'
import { ThreadManageList } from '../threads/manage/ThreadManageList.tsx'
import { useNeedsYouCount } from '../threads/Nav.tsx'
import { StatusWord } from '../threads/StatusPill.tsx'
import { ThreadRowWithSettings } from '../threads/ThreadMoreButton.tsx'
import { ThreadRowMenu } from '../threads/ThreadRowMenu.tsx'
import { ThreadSearchResults, ThreadTools, useThreadSearch } from '../threads/ThreadSearch.tsx'
import { useAgentName, useVisibleThreads } from '../threads/useThreads.ts'
import { attachEdgeSwipe } from './edgeSwipe.ts'
import { type PhonePanel, usePhonePanel } from './phoneStore.ts'
import './phone.css'

const SessionSheet = lazy(async () => ({ default: (await import('../session/SessionSheet.tsx')).SessionSheet }))

/** Focus goes back to whatever opened the panel; a swipe has no button, so the header's own button takes it. */
function returnFocus(which: Exclude<PhonePanel, null>) {
  return (e: Event) => {
    e.preventDefault()
    // Reopened during the exit animation: the new panel already owns focus, and pulling it back would dismiss it.
    if (usePhonePanel.getState().open) return
    document.querySelector<HTMLElement>(`[data-phone-opener="${which}"]`)?.focus()
  }
}

/** A panel still sliding out is mounted but closed; its late dismiss events must not close whatever is open now. */
function closeFrom(which: Exclude<PhonePanel, null>, o: boolean) {
  const { open, set } = usePhonePanel.getState()
  if (o) set(which)
  else if (open === which) set(null)
}

/** Radix finishes a touch tap by checking "was that outside?" on the next click. Tapping a header button to reopen a panel that
 *  is still sliding out must not count: the button is the way in, never an outside tap. */
export function keepOnOpenerTap(e: Event) {
  if ((e.target as Element | null)?.closest?.('[data-phone-opener]')) e.preventDefault()
}

/** Escape in the thread search box belongs to the box (it restores the list), not to the menu around it. */
function keepOnSearchEscape(e: KeyboardEvent) {
  if (document.activeElement?.closest('[data-thread-search]')) e.preventDefault()
}

export const PHONE_QUERY = '(max-width: 767px)'

export function PhoneChrome() {
  const phone = useMediaQuery(PHONE_QUERY)
  const { pathname } = useLocation()
  const threadId = usePhonePanel((s) => s.thread) ?? undefined
  const open = usePhonePanel((s) => s.open)
  const set = usePhonePanel((s) => s.set)
  const [sessionSeen, setSessionSeen] = useState(false)
  // The thread whose settings sheet is up. The sheet lives here, not in a menu row: archiving takes the row out of the list,
  // and the sheet (with its Restore) must outlive it.
  const [editing, setEditing] = useState<{ id: string; open: boolean } | null>(null)
  const thread = useTalosThread(threadId)
  const editThread = useTalosThread(editing?.id)
  // Settings -> Notifications links to /t/<id>?settings=1: on a phone this is where the thread sheet lives. Open it once
  // the thread is there, then drop the flag so Back or a refresh does not reopen it.
  const [params, setParams] = useSearchParams()
  const wantsSettings = params.get('settings') === '1'
  useEffect(() => {
    if (!phone || !wantsSettings || !thread) return
    setEditing({ id: thread.id, open: true })
    const next = new URLSearchParams(params)
    next.delete('settings')
    setParams(next, { replace: true })
  }, [phone, wantsSettings, thread, params, setParams])
  // A ref-shaped getter: focus goes back to the header button, unless a panel is open again by then (see returnFocus).
  const sessionOpener = useRef({
    get current(): HTMLElement | null {
      return usePhonePanel.getState().open ? null : document.querySelector<HTMLElement>('[data-phone-opener="session"]')
    },
  }).current as React.RefObject<HTMLElement | null>

  useEffect(() => {
    if (!phone) return
    return attachEdgeSwipe({
      // The driving screen is a full-screen layer of its own: nothing may open under it.
      enabled: () => !location.pathname.startsWith('/drive'),
      onOpen: (edge) => {
        if (edge === 'left') set('menu')
        else if (threadId) set('session')
      },
    })
  }, [phone, threadId, set])

  // Leaving the screen closes the panel; so does resizing up to a tablet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    const s = usePhonePanel.getState()
    if (s.open && s.path !== pathname) set(null)
  }, [pathname, set])
  useEffect(() => {
    if (!phone) set(null)
  }, [phone, set])
  useEffect(() => {
    if (open === 'session') setSessionSeen(true)
  }, [open])

  if (!phone) return null
  return (
    <>
      <Sheet open={open === 'menu'} onOpenChange={(o) => closeFrom('menu', o)}>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          data-testid="phone-menu"
          onCloseAutoFocus={returnFocus('menu')}
          onPointerDownOutside={keepOnOpenerTap}
          // Escape in the search box puts the thread list back; the menu itself stays
          onEscapeKeyDown={keepOnSearchEscape}
          className="frieze drawer-anim border-chrome-line bg-chrome p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-on-chrome"
        >
          <MenuBody onClose={() => set(null)} onEditThread={(t) => setEditing({ id: t.id, open: true })} />
        </SheetContent>
      </Sheet>
      {sessionSeen && threadId && (
        <Suspense fallback={null}>
          <SessionSheet
            open={open === 'session'}
            onOpenChange={(o) => closeFrom('session', o)}
            threadId={threadId}
            drawer
            status={<SessionStatus threadId={threadId} />}
            returnFocus={sessionOpener}
          />
        </Suspense>
      )}
      {editThread && (
        <ThreadEditor
          open={editing?.open ?? false}
          onOpenChange={(o) => setEditing((e) => (e ? { ...e, open: o } : e))}
          thread={editThread}
          // back on the ⋯ that opened it when the menu is still there; else (opened by a link) on the header's menu button
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            const row = document.querySelector<HTMLElement>(
              `[data-testid="phone-menu"] [data-testid="thread-more-${editThread.id}"]`,
            )
            ;(row ?? document.querySelector<HTMLElement>('[data-phone-opener="menu"]'))?.focus()
          }}
        />
      )}
    </>
  )
}

function useTalosThread(id: string | undefined) {
  return useTalos((s) => s.threads.find((t) => t.id === id))
}

/** The status the slim header only hints at with a dot: word, label and what it is waiting on. */
function SessionStatus({ threadId }: { threadId: string }) {
  const status = useThreadStatus(threadId)
  // the panel's own model row already says Idle; the thread status earns a line when it says more than that
  if (!status || (status.state === 'idle' && !status.label)) return null
  return (
    <p className="m-0 mb-3 flex items-center gap-2 text-sm text-text-2" data-testid="session-status">
      <StatusWord state={status?.state} />
      {status?.label ? <span className="truncate">{status.label}</span> : null}
    </p>
  )
}

function MenuBody({ onClose, onEditThread }: { onClose: () => void; onEditThread: (t: ThreadT) => void }) {
  const agent = useAgentName()
  const threads = useVisibleThreads()
  const unread = useTalos((s) => s.unread)
  const search = useThreadSearch()
  const [managing, setManaging] = useState(false)
  const inbox = useTalos((s) => s.threads.find((t) => t.id === 'inbox'))
  const needs = useNeedsYouCount()
  const memory = useFeature('memory/1')
  const driving = useFeature('driving/1')
  const schedulesDot = useSchedulesDot()
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex min-h-11 items-center gap-3 rounded-button px-3 text-sm',
      isActive ? 'bg-chrome-active font-semibold text-on-chrome' : 'text-on-chrome-2 hover:bg-chrome-hover',
    )
  const count = (n: number, label: string) => (
    <span
      className="ml-auto min-w-5 rounded-pill bg-accent px-1.5 text-center font-mono text-xs leading-5 text-on-accent"
      role="img"
      aria-label={label}
    >
      {n}
    </span>
  )
  return (
    // the sheet scrolls as a whole: on a short landscape phone nothing collapses, the footer links simply sit below
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <SheetTitle className="m-0 font-display text-xl font-semibold tracking-wide">{agent}</SheetTitle>
        <SheetClose
          aria-label="Close menu"
          className="grid size-11 place-items-center rounded-pill hover:bg-chrome-hover"
        >
          <IconClose />
        </SheetClose>
      </div>
      <nav aria-label="Threads" className="flex flex-col gap-0.5 px-2">
        <ThreadTools search={search} editing={managing} onEditing={setManaging} />
        {search.searching && <ThreadSearchResults query={search.query} onPick={onClose} />}
        {managing && !search.searching && <ThreadManageList tone="chrome" moveButtons />}
        {!search.searching && (
          <>
            <NavLink to="/" end className={link} onClick={onClose}>
              <IconBell width={20} height={20} />
              Needs you
              {needs > 0 && count(needs, `${needs} need you`)}
            </NavLink>
            <NavLink to="/threads" className={link} onClick={onClose}>
              <IconThreads width={20} height={20} />
              All threads
            </NavLink>
            {!managing &&
              threads
                .filter((t) => t.id !== 'inbox')
                .map((t) => (
                  <ThreadRowWithSettings
                    key={t.id}
                    thread={t}
                    tone="chrome"
                    onOpenSettings={onEditThread}
                    wrap={(inner) => <ThreadRowMenu thread={t}>{inner}</ThreadRowMenu>}
                  >
                    <NavLink
                      to={`/t/${t.id}`}
                      className={(st) => cn(link(st), 'pr-14')}
                      onClick={onClose}
                      draggable={false}
                    >
                      <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={24} framed />
                      <span className="truncate">{t.name}</span>
                      {(ownValue(unread, t.id) ?? 0) > 0 &&
                        count(ownValue(unread, t.id) ?? 0, `${ownValue(unread, t.id)} unread`)}
                    </NavLink>
                  </ThreadRowWithSettings>
                ))}
            {(() => {
              const row = (
                <NavLink to="/t/inbox" className={(st) => cn(link(st), inbox && 'pr-14')} onClick={onClose}>
                  <ThreadIcon id="inbox" icon={inbox?.icon} color={inbox?.color} size={24} framed />
                  Inbox
                  {(unread.inbox ?? 0) > 0 && count(unread.inbox ?? 0, `${unread.inbox} unread`)}
                </NavLink>
              )
              return inbox ? (
                <ThreadRowWithSettings thread={inbox} tone="chrome" onOpenSettings={onEditThread}>
                  {row}
                </ThreadRowWithSettings>
              ) : (
                row
              )
            })()}
            {driving !== 'off' && (
              <NavLink to="/drive" className={link} onClick={onClose} data-testid="menu-driving">
                <IconMic width={20} height={20} />
                Driving screen
              </NavLink>
            )}
            <NavLink to="/schedules" className={link} onClick={onClose}>
              <span className="relative">
                <IconClock width={20} height={20} />
                {schedulesDot && (
                  <span
                    role="img"
                    aria-label="Needs a look"
                    className="absolute -top-0.5 -right-1 size-2.5 rounded-pill bg-danger"
                  />
                )}
              </span>
              Schedules
            </NavLink>
          </>
        )}
      </nav>
      <div className="mt-auto border-t border-chrome-line p-2">
        {memory !== 'off' && (
          <NavLink to="/memory" className={link} onClick={onClose}>
            <IconBook width={20} height={20} />
            Memory
          </NavLink>
        )}
        <NavLink to="/settings" className={link} onClick={onClose}>
          <IconSettings width={20} height={20} />
          Settings
        </NavLink>
      </div>
    </div>
  )
}
