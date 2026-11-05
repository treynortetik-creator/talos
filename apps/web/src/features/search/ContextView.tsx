// `/t/:thread?m=<id>` (docs/V2-FEATURES.md V3.2): a read-only view of a past conversation around one message, built from
// `history.request{around_id}` and its Older / Newer pages. It is NEVER merged into the live timeline: it holds its own
// list, renders the same MessageView, and has no composer.
import type { AttachmentRefT, InboxItemT, MessageT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { dayLabel } from '../../lib/format.ts'
import { RowErrorBoundary } from '../../ui/ErrorBoundary.tsx'
import { Button } from '../../ui/index.ts'
import type { ContextViewProps } from '../contracts.ts'
import { ImageViewer } from '../threads/Attachments.tsx'
import { MessageView } from '../threads/MessageView.tsx'

type Load = 'loading' | 'ready' | 'offline' | 'missing' | 'error'
const NONE: InboxItemT[] = []

export function ContextView({ threadId, messageId }: ContextViewProps) {
  const client = useTalosClient()
  const nav = useNavigate()
  const cards = useTalos((s) => s.cards)
  const [msgs, setMsgs] = useState<MessageT[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [hasNewer, setHasNewer] = useState(true)
  const [load, setLoad] = useState<Load>('loading')
  const [busy, setBusy] = useState<'older' | 'newer' | null>(null)
  const [pageNote, setPageNote] = useState<{ dir: 'older' | 'newer'; text: string } | null>(null)
  // The Mac's reason when an Older / Newer page fails (clock off, update the app, no answer); cleared on the next try.
  const [pageError, setPageError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<AttachmentRefT | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const latest = () => nav(`/t/${threadId}`)

  // Messages cached on this device are the offline fallback: the context works only inside that range.
  const cachedList = useTalos((s) => ownValue(s.messages, threadId))
  const cachedAround = useCallback((): { list: MessageT[]; hasMore: boolean; hasNewer: boolean } | null => {
    const list = [...(cachedList ?? [])]
    const i = list.findIndex((m) => m.id === messageId)
    if (i < 0) return null
    const from = Math.max(0, i - 25)
    const to = Math.min(list.length, i + 26)
    return { list: list.slice(from, to), hasMore: from > 0, hasNewer: to < list.length }
  }, [cachedList, messageId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per anchor
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        if (!client.search) throw new TalosClientError('search_unavailable', 'unavailable')
        const r = await client.search.context(threadId, { aroundId: messageId })
        if (!live) return
        if (r.messages.length === 0) return setLoad('missing')
        setMsgs(r.messages)
        setHasMore(r.hasMore)
        setHasNewer(r.hasNewer)
        setLoad('ready')
      } catch (e) {
        if (!live) return
        const c = cachedAround()
        if (c && e instanceof TalosClientError && e.code === 'mac_offline') {
          setMsgs(c.list)
          setHasMore(false)
          setHasNewer(false)
          return setLoad('offline')
        }
        setLoad(e instanceof TalosClientError && e.code === 'mac_offline' ? 'offline' : 'error')
      }
    })()
    return () => {
      live = false
    }
  }, [client, threadId, messageId])

  // The anchor scrolls into view and pulses for 1.2 s.
  useEffect(() => {
    if (load !== 'ready' && !(load === 'offline' && msgs.length)) return
    const el = anchorRef.current
    if (!el) return
    el.scrollIntoView?.({ block: 'center' })
    el.classList.add('highlight-pulse')
    const t = setTimeout(() => el.classList.remove('highlight-pulse'), 1200)
    return () => clearTimeout(t)
  }, [load, msgs.length])

  const page = async (dir: 'older' | 'newer') => {
    const edge = dir === 'older' ? msgs[0] : msgs[msgs.length - 1]
    if (!edge || !client.search) return
    setBusy(dir)
    setPageNote(null)
    setPageError(null)
    try {
      const r = await client.search.context(threadId, dir === 'older' ? { beforeId: edge.id } : { afterId: edge.id })
      setMsgs((cur) => {
        const seen = new Set(cur.map((m) => m.id))
        const add = r.messages.filter((m) => !seen.has(m.id))
        return dir === 'older' ? [...add, ...cur] : [...cur, ...add]
      })
      if (dir === 'older') setHasMore(r.hasMore)
      else setHasNewer(r.hasNewer)
    } catch (e) {
      // The Mac's own refusal (clock off, update the app) is shown as it is; anything else says so and keeps the button:
      // a press that does nothing and shows nothing reads as the end of the conversation.
      const reason =
        e instanceof TalosClientError && e.code !== 'internal' && e.code !== 'mac_offline' && e.message
          ? e.message
          : null
      if (reason) setPageError(reason)
      else
        setPageNote({
          dir,
          text:
            e instanceof TalosClientError && e.code === 'mac_offline'
              ? 'Your Mac is offline. Try again when it is back.'
              : 'Could not load. Try again',
        })
    } finally {
      setBusy(null)
    }
  }

  let prevDay = ''
  const upToDate = load === 'ready' && !hasNewer
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="context-view">
      <div
        className="flex items-center justify-between gap-3 border-b border-line/60 bg-surface px-4 py-2 text-sm"
        role="status"
      >
        <span>{upToDate ? "You're up to date" : 'Showing a past conversation'}</span>
        <Button variant={upToDate ? 'primary' : 'ghost'} onClick={latest}>
          Jump to latest
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-2 pb-4" data-testid="context-list">
        {load === 'loading' && (
          <p role="status" className="m-0 px-4 py-6 text-text-2">
            Loading…
          </p>
        )}
        {load === 'missing' && (
          <p role="status" className="m-0 px-4 py-6 text-text-2">
            That message is no longer on your Mac.
          </p>
        )}
        {load === 'error' && (
          <p role="alert" className="m-0 px-4 py-6 text-text-2">
            Couldn't load that conversation.
          </p>
        )}
        {load === 'offline' && (
          <p role="status" className="m-0 px-4 py-3 text-sm text-text-2">
            {msgs.length
              ? 'Your Mac is offline. Showing messages from this device.'
              : 'Your Mac is offline. This conversation lives there.'}
          </p>
        )}
        {pageError && (
          <p role="alert" data-testid="context-page-error" className="m-0 px-4 py-2 text-center text-sm text-text-2">
            {pageError}
          </p>
        )}
        {pageNote?.dir === 'older' && (
          <p role="alert" data-testid="context-page-note" className="m-0 px-4 py-2 text-center text-sm text-text-2">
            {pageNote.text}
          </p>
        )}
        {hasMore && load === 'ready' && (
          <div className="flex justify-center py-2">
            <Button variant="ghost" onClick={() => void page('older')} disabled={busy !== null}>
              {busy === 'older' ? 'Loading…' : 'Older'}
            </Button>
          </div>
        )}
        {msgs.map((m) => {
          const day = dayLabel(m.created_at)
          const sep = day !== prevDay
          prevDay = day
          return (
            <Fragment key={m.id}>
              {sep && (
                <div className="flex items-center gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
                  <span aria-hidden="true" className="h-px flex-1 bg-line" />
                  {day}
                  <span aria-hidden="true" className="h-px flex-1 bg-line" />
                </div>
              )}
              <div
                id={`ctx-${m.id}`}
                ref={m.id === messageId ? anchorRef : undefined}
                data-anchor={m.id === messageId ? 'true' : undefined}
              >
                <RowErrorBoundary>
                  <MessageView message={m} cards={cards} inbox={NONE} onOpenImage={setViewer} onOpenItem={() => {}} />
                </RowErrorBoundary>
              </div>
            </Fragment>
          )
        })}
        {pageNote?.dir === 'newer' && (
          <p role="alert" data-testid="context-page-note" className="m-0 px-4 py-2 text-center text-sm text-text-2">
            {pageNote.text}
          </p>
        )}
        {hasNewer && load === 'ready' && (
          <div className="flex justify-center py-2">
            <Button variant="ghost" onClick={() => void page('newer')} disabled={busy !== null}>
              {busy === 'newer' ? 'Loading…' : 'Newer'}
            </Button>
          </div>
        )}
        {msgs.length > 0 && (
          <div className="flex justify-center gap-2 py-3">
            <Button variant="outline" onClick={() => nav(`/t/${threadId}?reply=${messageId}`)}>
              Reply in thread
            </Button>
          </div>
        )}
      </div>
      <ImageViewer att={viewer} onClose={() => setViewer(null)} />
    </div>
  )
}
