import { type InboxItemT, MsgId } from '@talos-app/protocol'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useThreadStatus } from '../../lib/threadStatus.ts'
import { IconBack } from '../../ui/icons.tsx'
import { Mascot } from '../../ui/Mascot.tsx'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { AgentsChip } from '../agents/AgentsChip.tsx'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'
import { Composer } from '../composer/Composer.tsx'
import { DropZone } from '../composer/DropZone.tsx'
import { UndoStrip } from '../inbox/undo.tsx'
import { PHONE_QUERY } from '../phone/PhoneChrome.tsx'
import { PhoneHeader } from '../phone/PhoneHeader.tsx'
import { usePhonePanel } from '../phone/phoneStore.ts'
import { CallBar, ContextView, InboxScreen } from '../registry.ts'
import { SessionTrigger } from '../session/SessionTrigger.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { useIsOnCall } from '../voice/controller.ts'
import { ArchivedBanner } from './ArchivedBanner.tsx'
import { Banners } from './Banners.tsx'
import { ItemSheet } from './ItemSheet.tsx'
import { StatusWord } from './StatusPill.tsx'
import { ThreadSettings } from './ThreadSettings.tsx'
import { ThreadTabs } from './ThreadTabs.tsx'
import { Timeline } from './Timeline.tsx'
import { useDescription } from './threadMeta.ts'
import { useAgentName } from './useThreads.ts'
import { useThreadState, WorkingRow } from './WorkingRow.tsx'

function ThreadPurpose({ threadId, topic }: { threadId: string; topic?: string | undefined }) {
  const local = useDescription(threadId)
  const desc = topic || local
  if (!desc) return null
  return (
    <p data-testid="thread-purpose" className="m-0 border-b border-line/60 px-4 py-2 text-sm text-text-2">
      {desc}
    </p>
  )
}

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
  const callActive = useIsOnCall(threadId)
  const pending = useAwaitingOwner(threadId)
  const [item, setItem] = useState<InboxItemT | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const phone = useMediaQuery(PHONE_QUERY)
  // the phone menu and session panel follow the thread on screen, whichever route (/t/:id, /card/:id) put it there
  const setPhoneThread = usePhonePanel((s) => s.setThread)
  useEffect(() => {
    setPhoneThread(threadId)
    return () => setPhoneThread(null)
  }, [threadId, setPhoneThread])

  if (threads.length > 0 && !thread) return <Navigate to="/threads" replace />
  if (!thread)
    return (
      <div className="flex-1">
        <Banners />
      </div>
    )
  const isInbox = thread.id === 'inbox'
  // Nothing emits an `on_call` thread status, so the call controller's own phase is the real signal.
  const onCall = callActive || status?.state === 'on_call'

  return (
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
          <header className="kb-hide-short flex items-center gap-1 px-2 pt-[env(safe-area-inset-top)]">
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
              <div className="min-w-0">
                <h1 className="m-0 truncate font-display text-xl font-semibold leading-tight">{thread.name}</h1>
                {/* Wraps instead of colliding: on a narrow phone the word and the "5 tasks" chip do not fit on one line. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                  <div aria-live="polite" className="flex max-w-full items-center">
                    <StatusWord state={state} />
                    {status?.label ? (
                      <span className="ml-2 min-w-0 truncate text-xs text-text-2">{status.label}</span>
                    ) : null}
                  </div>
                  <AgentsChip threadId={thread.id} variant="inline" />
                </div>
              </div>
            </div>
            <AgentsChip threadId={thread.id} variant="header" />
            <SessionTrigger threadId={thread.id}>
              <Mascot
                state={state === 'working' ? 'working' : state === 'on_call' ? 'listening' : 'pleased'}
                size={36}
                name={agent}
                decorative
                animate={false}
              />
            </SessionTrigger>
            <ThreadSettings thread={thread} />
          </header>
          <Meander />
          {/* Compact while the keyboard is up (keyboardViewport.ts, app.css): the box and the latest messages need the room. */}
          <div className="kb-hide">
            <ThreadPurpose threadId={thread.id} topic={thread.topic} />
            <ThreadTabs />
          </div>
        </>
      )}
      <div className="kb-hide-banner kb-hide-short-landscape">
        <Banners />
      </div>
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
      {pending.length > 0 && !isInbox && (
        <button
          type="button"
          onClick={() =>
            document.getElementById(`card-${pending[0]?.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
          className="kb-hide-banner kb-hide-short-landscape mx-3 mb-2 inline-flex min-h-11 items-center gap-2 self-start rounded-pill border border-line bg-surface px-3.5 text-sm font-medium text-text"
        >
          <StatusDot shape="solid" className="text-warn" />
          {pending.length} needs you
        </button>
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
}
