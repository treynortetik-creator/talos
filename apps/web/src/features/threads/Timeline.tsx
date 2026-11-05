import type { AttachmentRefT, CardT, InboxItemT, MessageT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { dayLabel } from '../../lib/format.ts'
import { editingInside } from '../../lib/keyboardViewport.ts'
import { RowErrorBoundary } from '../../ui/ErrorBoundary.tsx'
import { IconArrowDown } from '../../ui/icons.tsx'
import { Button } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { needsOwnerNow, placedAt } from '../cards/logic.ts'
import { useNow } from '../cards/util.ts'
import { ImageViewer, useVoiceOrder, VoiceOrderContext } from './Attachments.tsx'
import {
  isNearBottom,
  jumpLabel,
  keepPlace,
  NEAR_TOP_PX,
  newArrivals,
  type Seen,
  SHORT_THREAD_ROWS,
  seenOf,
  unreadMarker,
} from './jumpToLatest.ts'
import { MessageView, TimelineCard } from './MessageView.tsx'
import { useAgentName } from './useThreads.ts'

type Row = { key: string; at: string; message?: MessageT; card?: CardT }

const EMPTY: MessageT[] = []

export type { Row as TimelineRow }

/**
 * Messages plus any card of this thread that has no card message of its own, in order. Pure, so a test can drive it.
 */
export function orderTimelineRows(messages: MessageT[], cards: CardT[], nowMs: number = Date.now()): Row[] {
  const withMessage = new Set(messages.filter((m) => m.kind === 'card' && m.card_id).map((m) => m.card_id))
  // Messages order by the relay's seq only (one clock). Rows with no seq yet (optimistic or queued local items) go after
  // the last stored row; the client's own time orders only those. A card is the exception. Only a card that still needs
  // the owner (pending, not expired) stays at the bottom, where it cannot be missed. Every other card (killed, revised,
  // approved and waiting on the agent, finished, failed, expired, replaced) is past: it takes its place among the stored
  // rows by the time the owner acted on it, or by its creation time when they never did. Its row time is that same time,
  // so the day divider agrees with where it sits.
  const stored: Row[] = []
  const local: Row[] = []
  const past: Row[] = []
  const byId = new Map(cards.map((c) => [c.id, c]))
  const waiting = (c: CardT | undefined) => c !== undefined && needsOwnerNow(c, nowMs)
  for (const m of messages) {
    const c = m.kind === 'card' && m.card_id ? byId.get(m.card_id) : undefined
    if (m.seq !== undefined) stored.push({ key: m.id, at: m.created_at, message: m })
    else if (m.kind === 'card' && m.card_id && !waiting(c))
      past.push({ key: m.id, at: c ? placedAt(c) : m.created_at, message: m })
    else local.push({ key: m.id, at: m.created_at, message: m })
  }
  for (const c of cards) {
    if (withMessage.has(c.id)) continue
    if (waiting(c)) local.push({ key: c.id, at: c.created_at, card: c })
    else past.push({ key: c.id, at: placedAt(c), card: c })
  }
  stored.sort((a, b) => (a.message?.seq ?? 0) - (b.message?.seq ?? 0))
  local.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) // stable: ties keep insertion order
  past.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const merged: Row[] = []
  let i = 0
  for (const r of stored) {
    while (i < past.length && Date.parse((past[i] as Row).at) < Date.parse(r.at)) merged.push(past[i++] as Row)
    merged.push(r)
  }
  const out = [...merged, ...past.slice(i)]
  // A card kept at the bottom may have been created long before the newest message. Its row time is what the day heading
  // reads, so it never goes earlier than the row above it: no "Yesterday" heading after "Today".
  let floor = out.length > 0 ? Date.parse((out[out.length - 1] as Row).at) : Number.NEGATIVE_INFINITY
  for (const r of local) {
    const t = Date.parse(r.at)
    if (t < floor && (r.card || r.message?.kind === 'card')) out.push({ ...r, at: new Date(floor).toISOString() })
    else {
      out.push(r)
      floor = Math.max(floor, t)
    }
  }
  return out
}

/** Key of the oldest stored message row: it changes on every page of older messages, even when a card stays first. */
export const oldestStoredKey = (rows: Row[]): string | undefined => rows.find((r) => r.message?.seq !== undefined)?.key

/** The thread's rows: its messages plus its cards, ordered by `orderTimelineRows`. */
export function useTimelineRows(threadId: string): { rows: Row[]; messages: MessageT[]; cards: CardT[] } {
  const messages = useTalos((s) => ownValue(s.messages, threadId)) ?? EMPTY
  const allCards = useTalos((s) => s.cards)
  const cards = useMemo(() => allCards.filter((c) => c.thread_id === threadId), [allCards, threadId])
  // A pending card passes its expiry with no frame to say so: the signature changes when one does, so the rows re-sort.
  const now = useNow()
  const lapsed = cards.map((c) => (c.state === 'pending' && Date.parse(c.expires_at) <= now ? 1 : 0)).join('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lapsed` stands for `now`, which would re-sort every tick
  const rows = useMemo(() => orderTimelineRows(messages, cards, now), [messages, cards, lapsed])
  return { rows, messages, cards }
}

export function Timeline({
  threadId,
  highlightCard,
  onOpenItem,
  scrollRef,
}: {
  threadId: string
  highlightCard?: string | undefined
  onOpenItem: (i: InboxItemT) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const client = useTalosClient()
  const agent = useAgentName()
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const inbox = useTalos((s) => s.inbox)
  // The Inbox (a system thread) shares its screen with the event list, so its empty copy differs. Its conversation below
  // is real history like any thread's: only the empty copy knows the difference.
  const system = useTalos((s) => s.threads.find((t) => t.id === threadId)?.kind === 'system')
  const { rows, messages, cards } = useTimelineRows(threadId)
  const order = useVoiceOrder(messages)
  const [viewer, setViewer] = useState<AttachmentRefT | null>(null)
  // Whether the Mac may hold earlier messages. True until a successful answer says otherwise: a device that has
  // never loaded this thread knows nothing, so "nothing here" must never be assumed.
  const [hasMore, setHasMore] = useState(true)
  const [older, setOlder] = useState<'idle' | 'loading' | 'mac_offline' | 'failed'>('idle')
  // Counts finished loads. An answer that lands in the same frame as the ask leaves `older` where it was, and the next
  // page must still be considered.
  const [loads, setLoads] = useState(0)
  // Rows to hold the owner's place when older ones are prepended: scroll geometry from just before the load.
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const autoTried = useRef<string | null>(null)
  const loading = useRef(false)
  // Why the last scroll-back failed when the Mac said so itself (clock off, update the app), shown until the next try.
  const [olderError, setOlderError] = useState<string | null>(null)
  const stick = useRef(true)
  const viewerOpen = useRef(false)
  viewerOpen.current = viewer !== null
  // Jump-to-latest: shown while scrolled away from the end; counts what arrived meanwhile.
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(0)
  const seen = useRef<Seen | null>(null)
  const live = useRef<HTMLDivElement>(null)

  // Mark read while the thread is open and visible.
  const lastSeq = messages.reduce((n, m) => Math.max(n, m.seq ?? 0), 0)
  // The Inbox thread also holds webhook items (shown in the list above its conversation). They count as unread on the relay
  // but are not messages, so a read mark that stopped at the last message would leave them unread there for good, and the
  // app icon would keep their number. Opening the Inbox is seeing them: its mark goes up to the newest frame this device has.
  const inboxSeq = useTalos((s) => (threadId === 'inbox' ? s.lastSeq : 0))
  const unreadHere = useTalos((s) => ownValue(s.unread, threadId) ?? 0)
  const readUptoHere = useTalos((s) => ownValue(s.readUpto, threadId))
  const readySeq = useTalos((s) => s.readySeq)
  const connection = useTalos((s) => s.connection)
  const devicePinned = useTalos((s) => s.devicePinned)
  // A cached snapshot never decides what was unread: on a cold launch the counts are from when the app last ran, and only
  // the first `ready` says what they are now. A warm app already had one.
  const settledNow = readySeq !== undefined || connection === 'online'
  // What was unread when the thread opened (the count and the relay's read mark), frozen once settled: reading clears the
  // live count at once, and the "New messages" line must not move as replies arrive.
  const [opened, setOpened] = useState({
    thread: threadId,
    settled: settledNow,
    unread: unreadHere,
    readUpto: readUptoHere,
  })
  // The line, once it can be placed. It stays on the message it first named, however many replies land after it.
  const [pin, setPin] = useState<{ thread: string; key: string | null }>({ thread: threadId, key: null })
  // Stored rows seen last render. Fewer now means the relay wiped the window under an open thread (`catchup.reset`).
  const storedCount = rows.filter((r) => r.message?.seq !== undefined).length
  const [prevStored, setPrevStored] = useState(storedCount)
  // Bumped when the open starts over, so the refs below start over with it.
  const [generation, setGeneration] = useState(0)
  const restart = (settled: boolean) => {
    setOpened({ thread: threadId, settled, unread: unreadHere, readUpto: readUptoHere })
    setPin({ thread: threadId, key: null })
    setHasMore(true)
    setOlder('idle')
    setGeneration((g) => g + 1)
  }
  if (opened.thread !== threadId) {
    restart(settledNow)
    setPrevStored(storedCount)
  } else if (storedCount < prevStored) {
    // Rows were wiped: whatever "no more" and "nothing unread" said was about rows that are gone. Ask again.
    restart(settledNow)
    setPrevStored(storedCount)
  } else if (storedCount !== prevStored) {
    setPrevStored(storedCount)
  } else if (!opened.settled) {
    if (settledNow || opened.unread !== unreadHere || opened.readUpto !== readUptoHere)
      setOpened({ thread: threadId, settled: settledNow, unread: unreadHere, readUpto: readUptoHere })
  }
  const marker = useMemo(
    () =>
      opened.settled
        ? unreadMarker(
            rows.map((r) => ({ key: r.key, author: r.message?.author, via: r.message?.via, seq: r.message?.seq })),
            opened.unread,
            opened.readUpto,
            hasMore,
          )
        : { key: null, needMore: false },
    [rows, opened, hasMore],
  )
  if (pin.thread === threadId && pin.key === null && marker.key !== null) setPin({ thread: threadId, key: marker.key })
  const unreadKey = pin.thread === threadId ? pin.key : null
  // Unread messages that are not loaded yet: page back until the line can be placed, within reason.
  const autoPages = useRef(0)
  const pageCap = Math.min(10, Math.ceil(opened.unread / SHORT_THREAD_ROWS) + 1)
  const paging = hasMore && marker.needMore && autoPages.current < pageCap
  useEffect(() => {
    const mark = () => {
      if (document.hidden) return
      // Nothing on screen yet while the Mac may hold unread messages: they have not been seen, so they stay unread. This
      // sits here, not around the first call, so a tab switch cannot clear them either.
      const shown = lastSeq > 0 || messages.length > 0 || !hasMore
      if (!shown || paging) return
      client.markThreadRead(threadId, Math.max(lastSeq, inboxSeq) || client.store.getState().lastSeq)
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [client, threadId, lastSeq, inboxSeq, hasMore, messages.length, paging])

  // Older rows were prepended: keep the owner on the message they were reading, not at the top of the new page.
  // A decided card older than the loaded window can be the first row and stay it through a prepend, so the first stored
  // message is watched too: its key changes with every page.
  const firstStoredKey = oldestStoredKey(rows)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the first row changes
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchor.current
    if (!el || !a || stick.current) return
    const top = keepPlace(a, el.scrollHeight)
    if (top !== a.top) {
      el.scrollTop = top
      anchor.current = null
    }
  }, [rows[0]?.key, firstStoredKey, scrollRef])

  // Keep the bottom in view unless the owner scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every new row
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !stick.current) return
    // A card field is being edited: a new row must not scroll it away. Leave the owner where they are and offer Jump.
    if (editingInside(el)) {
      stick.current = false
      setAway(true)
      return
    }
    el.scrollTop = el.scrollHeight
  }, [rows.length, scrollRef])

  // Rows that arrive while the owner is scrolled away are counted on the jump button.
  useLayoutEffect(() => {
    const view = rows.map((r) => ({ key: r.key, author: r.message?.author, seq: r.message?.seq, at: Date.parse(r.at) }))
    if (!stick.current) {
      const n = newArrivals(seen.current, view)
      if (n > 0) setFresh((c) => c + n)
    }
    seen.current = seenOf(view)
  }, [rows])

  // The box above grows or the keyboard opens: the scroller shrinks. Stay on the last message if that is where we were.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      // A card field being edited inside the scroller: the keyboard must not scroll it away.
      if (stick.current) {
        if (!editingInside(el)) el.scrollTop = el.scrollHeight
      } else if (isNearBottom(el)) {
        // The scroller grew (keyboard closed) until the thread fits: no scroll event follows, so settle it here.
        stick.current = true
        setAway(false)
        setFresh(0)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef])

  // Open on the first unread message, once per thread, instead of the bottom.
  const openedAt = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the open starts over with `generation`
  useEffect(() => {
    openedAt.current = null
    autoTried.current = null
    autoPages.current = 0
  }, [generation, threadId])
  // The open has been decided without a line (nothing unread, or the pages ran out): later pages must not move the owner.
  const decided =
    opened.settled && !paging && marker.key === null && unreadKey === null && (rows.length > 0 || !hasMore)
  if (decided) openedAt.current = threadId
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the marker first exists
  useLayoutEffect(() => {
    if (!unreadKey || highlightCard || openedAt.current === threadId) return
    const el = document.getElementById('unread-marker')
    const box = scrollRef.current
    if (!el) return
    openedAt.current = threadId
    stick.current = false
    el.scrollIntoView?.({ block: 'start' })
    // Everything fits, or the line is already at the end: nowhere to jump to, so keep following the bottom.
    if (box && isNearBottom(box)) {
      stick.current = true
      setAway(false)
    } else setAway(true)
  }, [unreadKey, threadId])

  // Deep link: scroll to and highlight a card for 1.2 s (re-run when rows arrive so the card exists).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows.length retriggers the lookup
  useEffect(() => {
    if (!highlightCard) return
    const el = document.getElementById(`card-${highlightCard}`)
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    el.classList.add('highlight-pulse')
    const t = setTimeout(() => el.classList.remove('highlight-pulse'), 1200)
    return () => clearTimeout(t)
  }, [highlightCard, rows.length])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stick.current = isNearBottom(el)
    setAway(!stick.current)
    if (stick.current) setFresh(0)
    // Near the top with more behind it: fetch the next page before the owner hits the wall.
    if (el.scrollTop < NEAR_TOP_PX && hasMore && older === 'idle' && rows.length > 0) void loadOlder()
  }

  const jump = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    el.scrollTop = el.scrollHeight // instant: a smooth scroll would trip onScroll mid-way and drop the anchor
    setAway(false)
    setFresh(0)
    // Keyboard use: the button is about to unmount, so keep focus in the thread. A tap never took focus off the box
    // (onMouseDown below), and it must stay there or the on-screen keyboard closes.
    if (document.activeElement === e.currentTarget) el.focus({ preventScroll: true })
  }

  const loadOlder = async () => {
    if (loading.current) return
    loading.current = true
    // Every ask counts as the attempt for this link, so a press of the button is not retried at once as "new".
    autoTried.current = `${threadId}:${macOnline}:${readySeq ?? 0}:${devicePinned}`
    setOlder('loading')
    setOlderError(null)
    const el = scrollRef.current
    anchor.current = el && !stick.current ? { height: el.scrollHeight, top: el.scrollTop } : null
    // Read now, not from this render: the rows may have changed since (a wipe after `ready`).
    const held = ownValue(client.store.getState().messages, threadId) ?? []
    const firstSeq = held.reduce<number | undefined>(
      (n, m) => (m.seq === undefined ? n : n === undefined ? m.seq : Math.min(n, m.seq)),
      undefined,
    )
    try {
      const res = await client.loadHistory(threadId, firstSeq)
      if (res.stale) {
        // The page was cut from a window that is gone: ask again from what is held now.
        autoTried.current = null
        anchor.current = null
        setOlder('idle')
      } else if (res.unavailable === 'mac_offline') {
        // Says nothing about the history itself: keep the button, and try again when the Mac is back.
        setOlder('mac_offline')
        anchor.current = null
      } else {
        setHasMore(res.hasMore)
        setOlder('idle')
      }
    } catch (e) {
      anchor.current = null
      // The Mac's own refusal is shown as it is and the button stays as it was; anything else flips the button to
      // "Could not load. Try again": never reads as "no more".
      if (e instanceof TalosClientError && e.code !== 'internal' && e.code !== 'mac_offline' && e.message) {
        setOlder('idle')
        setOlderError(e.message)
      } else setOlder('failed')
    } finally {
      loading.current = false
      setLoads((n) => n + 1)
    }
  }

  // A thread that opens short (a new device, or one away so long its cache was wiped) loads its history by itself,
  // once per open, and again whenever the connection to the Mac changes after an offline answer. A long thread whose
  // history failed to load because the Mac was away retries the same way. The attempt is keyed on the whole link
  // (presence, the relay connection and the device pin): presence alone stays true across a reconnect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadOlder reads current rows through its closure on purpose
  useEffect(() => {
    if (!hasMore || older === 'loading' || older === 'failed' || loading.current) return
    const attempt = `${threadId}:${macOnline}:${readySeq ?? 0}:${devicePinned}`
    const short = storedCount < SHORT_THREAD_ROWS
    if ((short || older === 'mac_offline') && autoTried.current !== attempt) {
      autoTried.current = attempt
      void loadOlder()
    } else if (paging && older === 'idle') {
      autoPages.current += 1
      void loadOlder()
    }
  }, [threadId, macOnline, readySeq, devicePinned, hasMore, older, storedCount, paging, generation, loads])

  // Announce new agent replies politely.
  const lastAgent = [...messages].reverse().find((m) => m.author === 'agent')

  let prevDay = ''
  return (
    <VoiceOrderContext.Provider value={order}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollRegion
          label="Messages"
          ref={scrollRef}
          onScroll={onScroll}
          // An image with no size yet grows when it loads: keep following the bottom if that is where we are
          // (not while the image viewer is open: the page behind it stays put).
          onLoadCapture={() => {
            requestAnimationFrame(() => {
              const el = scrollRef.current
              if (!el || !stick.current || viewerOpen.current || editingInside(el)) return
              if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight
            })
          }}
          className="relative flex-1 overflow-y-auto overscroll-contain pt-2 pb-4"
          data-testid="timeline"
        >
          {hasMore && (
            <div className="flex justify-center py-2">
              <Button variant="ghost" onClick={loadOlder} disabled={older === 'loading'} data-testid="load-earlier">
                {older === 'loading'
                  ? 'Loading…'
                  : older === 'failed'
                    ? 'Could not load. Try again'
                    : messages.length === 0
                      ? 'Load messages'
                      : 'Load earlier messages'}
              </Button>
            </div>
          )}
          {olderError && (
            <p role="alert" data-testid="older-error" className="px-4 py-2 text-center text-sm text-text-2">
              {olderError}
            </p>
          )}
          {older === 'mac_offline' && (
            <p className="px-4 py-2 text-center text-sm text-text-2">
              Older messages live on your Mac. They'll load when it's back online.
            </p>
          )}
          {rows.length === 0 && !hasMore && (
            <div className={`flex flex-col items-center gap-4 px-6 text-center ${system ? 'py-8' : 'py-16'}`}>
              <Mascot state={macOnline ? 'pleased' : 'worried'} size={system ? 72 : 120} name={agent} />
              {system ? (
                <p data-testid="thread-empty-explainer" className="m-0 max-w-[30ch] text-text-2">
                  {inbox.length > 0
                    ? `Ask ${agent} about anything above: what came in, what matters and what to do next.`
                    : `Nothing has come in. Ask ${agent} what it is watching, or hold the mic to send a voice note.`}
                </p>
              ) : (
                <>
                  <p className="m-0 max-w-[30ch] text-text-2">
                    No messages yet. Say hi, or hold the mic to send a voice note.
                  </p>
                  <p data-testid="thread-empty-explainer" className="m-0 max-w-[40ch] text-sm text-text-2">
                    A thread is one topic. Messages here stay here, so {agent} can answer and file updates by subject.
                    To rename it, give it an icon and color, set notifications or archive it, open its settings: the ⋯
                    button at the top on a computer, or Open menu and then the pencil beside its name on a phone.
                  </p>
                </>
              )}
            </div>
          )}
          {rows.map((r) => {
            const day = dayLabel(r.at)
            const sep = day !== prevDay
            prevDay = day
            return (
              <Fragment key={r.key}>
                {sep && (
                  <div className="flex items-center gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
                    <span aria-hidden="true" className="h-px flex-1 bg-line" />
                    {day}
                    <span aria-hidden="true" className="h-px flex-1 bg-line" />
                  </div>
                )}
                {r.key === unreadKey && (
                  <div
                    id="unread-marker"
                    data-testid="unread-marker"
                    className="flex items-center gap-3 px-4 py-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2"
                  >
                    <span aria-hidden="true" className="h-px flex-1 bg-accent" />
                    New messages
                    <span aria-hidden="true" className="h-px flex-1 bg-accent" />
                  </div>
                )}
                <RowErrorBoundary>
                  {r.message ? (
                    <MessageView
                      message={r.message}
                      cards={cards}
                      inbox={inbox}
                      onOpenImage={setViewer}
                      onOpenItem={onOpenItem}
                    />
                  ) : r.card ? (
                    <TimelineCard card={r.card} threadName={threadId} />
                  ) : null}
                </RowErrorBoundary>
              </Fragment>
            )
          })}
          <div ref={live} className="sr-only" aria-live="polite" role="log">
            {lastAgent?.text ? `${agent}: ${lastAgent.text.slice(0, 200)}` : ''}
          </div>
        </ScrollRegion>
        {away && rows.length > 0 && (
          <button
            type="button"
            data-testid="jump-to-latest"
            aria-label={jumpLabel(fresh)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={jump}
            className="absolute right-3 bottom-3 inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-pill border border-line bg-surface px-3 text-sm font-medium text-text shadow-[0_2px_8px_rgb(0_0_0/0.25)] focus-visible:outline-2 focus-visible:outline-focus"
          >
            <IconArrowDown width={18} height={18} />
            {fresh > 0 && (
              <span
                data-testid="jump-count"
                className="grid min-w-5 place-items-center rounded-pill bg-accent px-1.5 text-xs font-semibold tabular-nums text-on-accent"
              >
                {fresh > 99 ? '99+' : fresh}
              </span>
            )}
          </button>
        )}
      </div>
      <ImageViewer att={viewer} onClose={() => setViewer(null)} />
    </VoiceOrderContext.Provider>
  )
}
