// Search inside the thread list (the sidebar and the phone menu): the row with the magnifier, + and the pencil turns into a
// search box, and the results take the place of the threads until Escape or the cross puts the list back.
import type { SearchHitT } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { clockTime, dayLabel } from '../../lib/format.ts'
import { cn } from '../../ui/cn.ts'
import { IconClose, IconPencil, IconSearch } from '../../ui/icons.tsx'
import { MIN_CHARS, segments } from '../search/logic.ts'
import { useSearchHits } from '../search/useSearchHits.ts'
import { NewThread } from './ThreadSettings.tsx'
import { useAgentName } from './useThreads.ts'

export type ThreadSearch = {
  searching: boolean
  query: string
  setQuery: (q: string) => void
  start: () => void
  stop: () => void
}

export function useThreadSearch(): ThreadSearch {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  // stable: an effect that lists them (the sidebar folding) must not rerun on every keystroke
  const start = useCallback(() => setSearching(true), [])
  const stop = useCallback(() => {
    setSearching(false)
    setQuery('')
  }, [])
  return { searching, query, setQuery, start, stop }
}

const tool =
  'grid min-h-11 min-w-11 place-items-center rounded-button text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome'

/** Search, new and edit on one line; while searching, the box and its cross instead. */
export function ThreadTools({
  search,
  editing,
  onEditing,
  onCreated,
  onSearchStart,
}: {
  search: ThreadSearch
  editing: boolean
  onEditing: (v: boolean) => void
  onCreated?: (id: string) => void
  /** Runs first when the magnifier is pressed (the folded rail unfolds itself). */
  onSearchStart?: () => void
}) {
  // closing the box removes it from under the focus: the magnifier that opened it takes the focus back
  const magnifier = useRef<HTMLButtonElement>(null)
  const wasSearching = useRef(false)
  useEffect(() => {
    if (wasSearching.current && !search.searching) magnifier.current?.focus()
    wasSearching.current = search.searching
  }, [search.searching])
  if (search.searching)
    return (
      <div className="flex items-center gap-1">
        <label data-thread-search="" className="relative min-w-0 flex-1">
          <IconSearch
            width={16}
            height={16}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-on-chrome-2"
          />
          <input
            type="search"
            aria-label="Search all threads"
            placeholder="Search all threads"
            // the owner just pressed the magnifier to type: the box takes focus as it appears
            // biome-ignore lint/a11y/noAutofocus: see above
            autoFocus
            maxLength={200}
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              search.stop()
            }}
            className="min-h-11 w-full appearance-none rounded-button border border-chrome-line bg-transparent pr-2 pl-9 [&::-webkit-search-cancel-button]:hidden text-sm text-on-chrome placeholder:text-on-chrome-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          />
        </label>
        <button type="button" aria-label="Close search" onClick={search.stop} className={tool}>
          <IconClose width={18} height={18} />
        </button>
      </div>
    )
  return (
    <div className="flex items-center justify-end gap-0.5">
      <button
        ref={magnifier}
        type="button"
        aria-label="Search threads"
        title="Search all threads"
        data-testid="search-threads"
        onClick={() => {
          onSearchStart?.()
          search.start()
        }}
        className={tool}
      >
        <IconSearch width={18} height={18} />
      </button>
      <NewThread compact tone="chrome" {...(onCreated ? { onCreated } : {})} />
      <button
        type="button"
        aria-pressed={editing}
        aria-label={editing ? 'Done managing threads' : 'Manage threads'}
        title={editing ? 'Done' : 'Reorder, rename, icons and colors'}
        data-testid="edit-threads"
        onClick={() => onEditing(!editing)}
        className={cn(
          'grid min-h-11 min-w-11 place-items-center rounded-button px-2 text-sm',
          editing
            ? 'font-semibold text-chrome-accent-text hover:bg-chrome-hover'
            : 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome',
        )}
      >
        {editing ? 'Done' : <IconPencil width={18} height={18} />}
      </button>
    </div>
  )
}

/** The hits for what was typed, in the place of the thread list. `onPick` runs when one is opened. */
export function ThreadSearchResults({ query, onPick }: { query: string; onPick: () => void }) {
  const state = useSearchHits(query)
  const nav = useNavigate()
  const agent = useAgentName()
  const names = useTalos((s) => s.threads)
  const who = (h: SearchHitT) =>
    h.heartbeat
      ? 'Heartbeat'
      : h.via === 'share'
        ? 'Shared'
        : h.author === 'owner'
          ? 'You'
          : h.author === 'agent'
            ? agent
            : 'Talos'
  const note = (text: string, role: 'status' | 'alert' = 'status') => (
    <p role={role} className="m-0 px-2 py-2 text-xs text-on-chrome-2">
      {text}
    </p>
  )
  return (
    <div data-testid="thread-search-results" className="flex flex-col gap-1 pt-1">
      {state.kind === 'idle' && note(`Type at least ${MIN_CHARS} letters. Esc puts the thread list back.`)}
      {state.kind === 'loading' && note('Searching…')}
      {state.kind === 'error' && note(state.message, 'alert')}
      {state.kind === 'done' && state.hits.length === 0 && note(`Nothing found for “${query.trim()}”.`)}
      {state.kind === 'done' && state.hits.length > 0 && (
        <>
          <p
            role="status"
            className="m-0 px-2 pt-1 text-xs font-semibold tracking-[var(--tracking-caps)] text-on-chrome-2 uppercase"
          >
            {state.total >= 1000 ? 'Over 1,000 results' : `${state.total} ${state.total === 1 ? 'result' : 'results'}`}
            {state.offline ? ' · on this device' : ''}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {state.hits.map((h) => (
              <li key={h.message_id}>
                <button
                  type="button"
                  data-testid="hit-row"
                  onClick={() => {
                    onPick()
                    nav(`/t/${h.thread_id}?m=${h.message_id}`)
                  }}
                  className="flex min-h-11 w-full flex-col gap-0.5 rounded-button px-3 py-2 text-left text-on-chrome hover:bg-chrome-hover"
                >
                  <span className="truncate text-xs font-semibold">
                    {names.find((t) => t.id === h.thread_id)?.name ?? h.thread_id} · {who(h)} · {dayLabel(h.created_at)}{' '}
                    {clockTime(h.created_at)}
                  </span>
                  <span className="text-sm text-on-chrome-2 [overflow-wrap:anywhere]">
                    {segments(h.snippet, h.marks).map((s, i) =>
                      s.mark ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered
                        <mark key={i} className="rounded-sm bg-accent/25 px-0.5 text-on-chrome">
                          {s.text}
                        </mark>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered
                        <span key={i}>{s.text}</span>
                      ),
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {/* one page of results only: the full search has the filters and the rest */}
          <Link
            to={`/search?q=${encodeURIComponent(query.trim())}`}
            onClick={onPick}
            className="flex min-h-11 items-center rounded-button px-3 text-sm text-on-chrome-2 underline hover:bg-chrome-hover hover:text-on-chrome"
          >
            See all results
          </Link>
        </>
      )}
    </div>
  )
}
