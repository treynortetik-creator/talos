// Search in one thread (the phone header's magnifier): a full-screen panel laid over the thread, with a real X. The thread
// stays mounted underneath, so closing puts you back exactly where you were reading. A hit opens its message in context
// (the app's one jump-to-message, `/t/:id?m=`); "Search all threads" widens the same query. Words match SearchScreen's.
import { MATCH_IN_LABEL } from '@talos-app/protocol'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { clockTime, dayLabel } from '../../lib/format.ts'
import { IconClose, IconSearch } from '../../ui/icons.tsx'
import { reactEscapeIntent, searchBoxKeys } from '../../ui/keys.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { HitRow } from './HitRow.tsx'
import { MIN_CHARS, SEARCH_WORDS } from './logic.ts'
import { useSearchHits } from './useSearchHits.ts'

const note = 'm-0 px-4 py-6 text-text-2'

export function ThreadSearchPanel({
  threadId,
  threadName,
  onClose,
}: {
  threadId: string
  threadName: string
  onClose: () => void
}) {
  const nav = useNavigate()
  const agent = useAgentName()
  const threads = useTalos((s) => s.threads)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const [text, setText] = useState('')
  const [all, setAll] = useState(false)
  const state = useSearchHits(text, { threadId: all ? '' : threadId, limit: 50 })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const q = text.trim()

  useEffect(() => inputRef.current?.focus(), [])

  // Escape is this panel's and goes no further: in the box it clears the text first and closes on an empty box (ui/keys.ts);
  // on a hit row it closes. A held, modified or input-method Esc closes nothing. Arrow keys walk between the box and the hits.
  const boxKeys = searchBoxKeys({ value: text, onClear: () => setText(''), onClose })
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // the box's own handler (on the input, below) has acted on its Esc and stopped it; what arrives here came from a row
      const intent = reactEscapeIntent(e, '')
      if (intent === 'ignore') return
      e.preventDefault()
      e.stopPropagation()
      if (intent === 'close') onClose()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-testid="hit-row"]') ?? [])
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (document.activeElement === inputRef.current) {
      if (e.key === 'ArrowDown' && rows[0]) {
        e.preventDefault()
        rows[0].focus()
      }
      return
    }
    if (at < 0) return
    e.preventDefault()
    if (e.key === 'ArrowUp' && at === 0) inputRef.current?.focus()
    else rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  const who = (h: { heartbeat?: true | undefined; via: string; author: string }) =>
    h.heartbeat
      ? 'Heartbeat'
      : h.via === 'share'
        ? 'Shared'
        : h.author === 'owner'
          ? 'You'
          : h.author === 'agent'
            ? agent
            : h.author === 'hook'
              ? 'Integration'
              : 'System'
  const nameOf = (id: string) => threads.find((t) => t.id === id)?.name ?? id

  let statusText = ''
  if (state.kind === 'loading') statusText = 'Searching…'
  else if (state.kind === 'done') {
    const count =
      state.hits.length === 0
        ? `Nothing found for “${q}”.`
        : state.total >= 1000
          ? 'Over 1,000 matches'
          : `${state.total} ${state.total === 1 ? 'match' : 'matches'}`
    statusText = state.offline
      ? `${count} ${macOnline ? 'Your Mac is catching up.' : 'Your Mac is offline.'} Showing matches from messages on this device.`
      : count
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search this thread"
      data-testid="thread-search"
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-40 flex min-h-0 flex-col bg-bg text-text"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line/60 px-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2">
        <label className="relative min-w-0 flex-1">
          <IconSearch
            width={18}
            height={18}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-2"
          />
          <input
            ref={inputRef}
            type="search"
            aria-label={all ? 'Search all threads' : 'Search this thread'}
            placeholder={all ? 'Search all threads…' : `Search ${threadName}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={boxKeys}
            maxLength={200}
            enterKeyHint="search"
            className="min-h-11 w-full appearance-none rounded-pill border border-line bg-surface pr-3 pl-10 text-base text-text [&::-webkit-search-cancel-button]:hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          />
        </label>
        <button
          type="button"
          aria-label="Close search"
          data-testid="thread-search-close"
          onClick={onClose}
          className="grid size-11 shrink-0 place-items-center rounded-pill text-text hover:bg-surface"
        >
          <IconClose width={20} height={20} />
        </button>
      </header>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/60 px-4 text-sm text-text-2">
        <span className="min-w-0 truncate">{all ? 'In all threads' : `In ${threadName}`}</span>
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="min-h-11 shrink-0 rounded-pill px-2 font-semibold text-text underline"
        >
          {all ? 'Search only this thread' : 'Search all threads'}
        </button>
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        data-testid="thread-search-results"
      >
        {/* ONE live region, always mounted: only its words change. A status node inserted along with its text is often not read. */}
        <p
          role="status"
          data-testid="thread-search-status"
          className={`m-0 px-4 text-text-2 empty:sr-only ${state.kind === 'done' && state.hits.length > 0 ? 'pt-3 text-xs' : 'pt-6'}`}
        >
          {statusText}
        </p>
        {state.kind === 'idle' && (
          <p className={`${note} text-sm`}>
            Type at least {MIN_CHARS} letters. {SEARCH_WORDS}
          </p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className={note}>
            {state.message}
          </p>
        )}
        {state.kind === 'done' && state.hits.length === 0 && (
          <p className="m-0 px-4 pt-1 pb-6 text-sm text-text-2" data-testid="thread-search-empty">
            {all ? 'Try fewer words.' : 'Try fewer words, or search all threads.'}
          </p>
        )}
        {state.kind === 'done' && state.hits.length > 0 && (
          <ul className="m-0 list-none p-0">
            {state.hits.map((h) => (
              <li key={h.message_id}>
                <HitRow
                  title={`${all ? `# ${nameOf(h.thread_id)} · ` : ''}${who(h)} · ${dayLabel(h.created_at)} ${clockTime(h.created_at)}`}
                  snippet={h.snippet}
                  marks={h.marks}
                  badge={h.via === 'share' && h.match_in === 'text' ? 'in shared content' : MATCH_IN_LABEL[h.match_in]}
                  {...(h.attachment?.name ? { file: h.attachment.name } : {})}
                  onOpen={() => nav(`/t/${h.thread_id}?m=${h.message_id}`)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
