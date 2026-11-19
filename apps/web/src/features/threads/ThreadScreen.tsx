import { type InboxItemT, MsgId } from '@talos-app/protocol'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { useThreadStatus } from '../../lib/threadStatus.ts'
import { IconBack } from '../../ui/icons.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { FirstRunCard } from '../agent-config/FirstRun.tsx'
import { SETUP_THREAD_ID } from '../agent-config/setupThread.ts'
import { BugCornerButton, BugHeaderButton } from '../bugreport/BugButton.tsx'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'
import { Composer } from '../composer/Composer.tsx'
import { DropZone } from '../composer/DropZone.tsx'
import { UndoStrip } from '../inbox/undo.tsx'
import { PaneToolbar } from '../panes/Panes.tsx'
import { PHONE_QUERY } from '../phone/PhoneChrome.tsx'
import { PhoneHeader } from '../phone/PhoneHeader.tsx'
import { usePhonePanel } from '../phone/phoneStore.ts'
import { CallBar, ContextView, InboxScreen } from '../registry.ts'
import { useMediaQuery } from '../settings/useMedia.ts'
import { SessionPill } from '../thread-sessions/SessionStatus.tsx'
import { rowShowsSession, useSessionWords } from '../thread-sessions/useSessionWords.ts'
import { useIsOnCall } from '../voice/controller.ts'
import { ArchivedBanner } from './ArchivedBanner.tsx'
import { Banners } from './Banners.tsx'
import { ItemSheet } from './ItemSheet.tsx'
import { NeedsYouChip } from './NeedsYouChip.tsx'
import { StatusWord } from './StatusPill.tsx'
import { ThreadSettings } from './ThreadSettings.tsx'
import { Timeline } from './Timeline.tsx'
import { useAgentName } from './useThreads.ts'
import { useThreadState, WorkingRow } from './WorkingRow.tsx'

/** Narrower than this, the header's pane buttons move into the thread menu. */
const HEADER_ROOM_PX = 704

export function ThreadScreen({ highlightCard }: { highlightCard?: string }) {
  const { thread: threadId = '' } = useParams()
  const [params] = useSearchParams()
  const m = params.get('m')
  if (m && MsgId.safeParse(m).success) {
    return (
      <Suspense fallback={null}>
        <ContextView key={`${threadId}:${m}`} threadId={threadId} messageId={m} />
      </Suspense>
    )
  }
  return <ThreadView key={threadId} threadId={threadId} highlightCard={highlightCard} />
}

export function ThreadView({ threadId, highlightCard }: { threadId: string; highlightCard?: string | undefined }) {
  const nav = useNavigate()
  const agent = useAgentName()
  const threads = useTalos((s) => s.threads)
  const thread = threads.find((t) => t.id === threadId)
  const status = useThreadStatus(threadId)
  // CC-C3: the live mod knows better than the status frame when Claude is mid-turn, but only for this thread (D15).
  const state = useThreadState(threadId)
  // the thread's own session (Option C), when it has one: its words win over the agent's status line in the header
  const sessionWords = useSessionWords(threadId)
  // only when it has something to say: a plain idle session keeps the agent's own status (on a call, queued...)
  const session = rowShowsSession(sessionWords) ? sessionWords : null
  const firstCard = useAwaitingOwner(threadId).find((c) => c.kind === 'permission')
  const callActive = useIsOnCall(threadId)
  const [item, setItem] = useState<InboxItemT | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const phone = useMediaQuery(PHONE_QUERY)
  // a header too narrow to name its actions (the panes or the session panel took the room) keeps only the thread menu, which
  // then lists them (owner, 2026-11-15): measured on the header itself, since panes narrow it without the window changing
  const [headerEl, headerRef] = useState<HTMLElement | null>(null)
  const [cramped, setCramped] = useState(false)
  useEffect(() => {
    if (!headerEl || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCramped(headerEl.clientWidth < HEADER_ROOM_PX))
    ro.observe(headerEl)
    return () => ro.disconnect()
  }, [headerEl])
  // the phone menu and session panel follow the thread on screen, whichever route (/t/:id, /card/:id) put it there
  const setPhoneThread = usePhonePanel((s) => s.setThread)
  useEffect(() => {
    setPhoneThread(threadId)
    return () => setPhoneThread(null)
  }, [threadId, setPhoneThread])

  if (threads.length > 0 && !thread) return <Navigate to="/threads" replace />
  if (!thread)
    return (
      <div className="relative flex-1">
        <Banners />
        <BugCornerButton />
      </div>
    )
  const isInbox = thread.id === 'inbox'
  // Nothing emits an `on_call` thread status, so the call controller's own phase is the real signal.
  const onCall = callActive || status?.state === 'on_call'

  const chat = (
    <DropZone
      threadId={threadId}
      enabled={!onCall}
      className="flex h-full min-h-0 flex-col"
      data-testid="thread-screen"
    >
      {phone ? (
        <PhoneHeader thread={thread} state={state} statusLabel={status?.label} />
      ) : (
        <>
          {/* The right padding keeps the title and menu clear of the usage chip in the corner while this column is too narrow
              to have room for it beside the 760 px reading column. */}
          <header
            ref={headerRef}
            className="kb-hide-short flex items-center gap-1 pt-[env(safe-area-inset-top)] pr-32 pl-2 @min-[64rem]:pr-2"
          >
            <button
              type="button"
              aria-label="Back to threads"
              onClick={() => nav('/threads')}
              className="grid size-11 place-items-center rounded-pill md:hidden"
            >
              <IconBack />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 md:pl-2">
              <ThreadIcon id={thread.id} icon={thread.icon} color={thread.color} size={40} />
              <h1 className="m-0 min-w-0 truncate font-display text-xl font-semibold leading-tight">{thread.name}</h1>
              <div aria-live="polite" className="flex min-w-0 items-center gap-2">
                {session ? (
                  // the thread's own session says what it is doing; it wins over the agent's own status line
                  <>
                    <SessionPill words={session} cardHref={firstCard ? `/card/${firstCard.id}` : undefined} />
                    <span data-testid="header-session-short" className="min-w-0 truncate text-xs text-text-2">
                      {session.short}
                    </span>
                  </>
                ) : (
                  <>
                    <StatusWord state={state} pill />
                    {status?.label ? (
                      <span className="min-w-0 truncate text-xs text-text-2">{status.label}</span>
                    ) : null}
                  </>
                )}
              </div>
              <NeedsYouChip threadId={threadId} />
            </div>
            <BugHeaderButton />
            <PaneToolbar threadId={threadId} cramped={cramped} />
            <ThreadSettings thread={thread} paneRows={cramped} />
          </header>
        </>
      )}
      <div className="kb-hide-banner kb-hide-short-landscape">
        <Banners />
      </div>
      {thread.id === SETUP_THREAD_ID ? <FirstRunCard /> : null}
      {/* Gives way to the composer with the keyboard up on a short screen, like the banners above (app.css). */}
      {thread.archived ? (
        <div className="kb-hide-banner kb-hide-short-landscape">
          <ArchivedBanner thread={thread} />
        </div>
      ) : null}
      {isInbox ? (
        <>
          {/* Event cards on top (capped so the conversation always has room), the conversation below like any thread. */}
          <ScrollRegion
            label="Inbox"
            className="max-h-[45%] min-h-0 shrink-0 overflow-y-auto border-b border-line [&_[data-inbox-ask]]:hidden"
          >
            <Suspense fallback={null}>
              <InboxScreen />
            </Suspense>
          </ScrollRegion>
          <Timeline threadId={threadId} onOpenItem={setItem} scrollRef={scrollRef} />
        </>
      ) : (
        <Timeline threadId={threadId} highlightCard={highlightCard} onOpenItem={setItem} scrollRef={scrollRef} />
      )}
      {!onCall && <WorkingRow threadId={threadId} />}
      {onCall ? (
        <Suspense fallback={null}>
          <CallBar threadId={threadId} onEnd={() => {}} />
        </Suspense>
      ) : (
        <Composer threadId={threadId} placeholder={isInbox ? 'Ask about your inbox' : `Message ${agent}`} />
      )}
      <UndoStrip floating />
      <ItemSheet item={item} onClose={() => setItem(null)} />
    </DropZone>
  )
  return chat
}
