// `/search` (docs/V2-FEATURES.md V3.3): a debounced box, filters, hits with a match badge, "Building the index" notice,
// and, with the Mac offline, a substring search over the messages cached on this device.
import type { SearchFiltersT, SearchHitT } from '@talos-app/protocol'
import { MATCH_IN_LABEL } from '@talos-app/protocol'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { clockTime, dayLabel } from '../../lib/format.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { IconClose, IconSearch } from '../../ui/icons.tsx'
import { Button, Input } from '../../ui/index.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { HitRow } from './HitRow.tsx'
import {
  clearRecent,
  DEBOUNCE_MS,
  filtersFor,
  loadRecent,
  MIN_CHARS,
  pushRecent,
  RANGE_LABEL,
  searchCached,
  type TimeRange,
} from './logic.ts'

type Sort = 'relevance' | 'newest'
type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; offline: boolean }
  | { kind: 'error'; message: string }

const select =
  'min-h-11 rounded-pill border border-line bg-surface px-3 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

function errorText(e: unknown): string {
  if (e instanceof TalosClientError) {
    if (e.code === 'rate_limited') return 'Too many searches at once. Give it a few seconds.'
    if (e.code === 'search_unavailable') return e.message || 'Search is not ready on your Mac yet.'
    if (e.code === 'bad_query') return 'That search is not valid. Try different words.'
    if (e.code === 'sig_invalid' || e.code === 'device_not_pinned') return 'Your Mac has not confirmed this device yet.'
    if (e.message) return e.message
  }
  return 'Search failed. Try again.'
}

export function SearchScreen() {
  const client = useTalosClient()
  const nav = useNavigate()
  const agent = useAgentName()
  const feature = useFeature('search/1')
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const threads = useTalos((s) => s.threads)
  const cached = useTalos((s) => s.messages)
  // `?q=` and `?thread=` start a search from elsewhere (Home's "Search all messages", a thread's "Search this thread").
  const [params] = useSearchParams()
  const qParam = (params.get('q') ?? '').slice(0, 200)
  const threadParam = params.get('thread') ?? ''
  const [text, setText] = useState(qParam)
  const [threadId, setThreadId] = useState(threadParam)
  const [from, setFrom] = useState<SearchFiltersT['from']>('any')
  const [hasFile, setHasFile] = useState(false)
  const [range, setRange] = useState<TimeRange>('any')
  const [sort, setSort] = useState<Sort>('relevance')
  const [hits, setHits] = useState<SearchHitT[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [index, setIndex] = useState<'ready' | 'indexing' | 'dirty'>('ready')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [recent, setRecent] = useState<string[]>(() => loadRecent())
  const gen = useRef(0)
  // the filters of the search's first page: "Show more" reuses them, so `after` does not drift and the cursor stays valid
  const frozen = useRef<SearchFiltersT | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const q = text.trim()
  const ready = q.length >= MIN_CHARS
  const offline = !macOnline || feature === 'needs_mac'

  useEffect(() => inputRef.current?.focus(), [])
  // The address can change while this screen stays mounted (a second link into /search): follow it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new address resets the box and the thread filter
  useEffect(() => {
    setText(qParam)
    setThreadId(threadParam)
  }, [qParam, threadParam])
  // A thread id that is not one of his threads would filter on something the picker cannot show: drop it.
  useEffect(() => {
    if (threadId && threads.length > 0 && !threads.some((t) => t.id === threadId)) setThreadId('')
  }, [threadId, threads])

  const run = useCallback(
    async (more: boolean) => {
      const mine = ++gen.current
      const filters =
        more && frozen.current ? frozen.current : filtersFor({ threadId, from, hasFile, range }, Date.now())
      if (!more) frozen.current = filters
      setStatus({ kind: 'loading' })
      try {
        if (offline) {
          const rows = searchCached(cached, q, filters, sort)
          if (mine !== gen.current) return
          setHits(rows)
          setCursor(null)
          setTotal(rows.length)
          setStatus({ kind: 'done', offline: true })
          return
        }
        if (!client.search) throw new TalosClientError('search_unavailable', 'Search is not available in this build.')
        const r = await client.search.search({ q, filters, sort, cursor: more ? cursor : null, limit: 50 })
        if (mine !== gen.current) return
        setHits((prev) => (more ? [...prev, ...r.hits] : r.hits))
        setCursor(r.nextCursor)
        setTotal(r.totalEstimate)
        setIndex(r.index)
        setStatus({ kind: 'done', offline: false })
        if (!more) setRecent(pushRecent(q))
      } catch (e) {
        if (mine !== gen.current) return
        if (e instanceof TalosClientError && e.code === 'mac_offline') {
          const rows = searchCached(cached, q, filters, sort)
          setHits(rows)
          setCursor(null)
          setTotal(rows.length)
          setStatus({ kind: 'done', offline: true })
          return
        }
        setHits([])
        setStatus({ kind: 'error', message: errorText(e) })
      }
    },
    [client, cached, cursor, from, hasFile, offline, q, range, sort, threadId],
  )

  // 300 ms debounce; filters and sort re-run at once (they are choices, not typing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` changes with `cursor`/`cached`; only the inputs below start a search
  useEffect(() => {
    if (!ready) {
      gen.current++
      setHits([])
      setCursor(null)
      setStatus({ kind: 'idle' })
      return
    }
    const t = setTimeout(() => void run(false), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q, ready, threadId, from, hasFile, range, sort, offline])

  const threadName = useMemo(() => new Map(threads.map((t) => [t.id, t.name])), [threads])
  const who = (h: SearchHitT) =>
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

  return (
    <section
      className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col"
      data-testid="search-screen"
      aria-label="Search"
    >
      <header className="flex flex-col gap-2 border-b border-line/60 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" aria-label="Back" onClick={() => nav(-1)}>
            ←
          </Button>
          <div className="relative flex-1">
            <IconSearch
              width={18}
              height={18}
              aria-hidden="true"
              className="pointer-events-none absolute top-3.5 left-3 text-text-2"
            />
            <Input
              ref={inputRef}
              type="search"
              role="searchbox"
              aria-label="Search messages"
              placeholder="Search messages…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={200}
              className="pr-11 pl-9"
            />
            {text && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute top-0 right-0 inline-flex size-11 items-center justify-center text-text-2"
                onClick={() => {
                  setText('')
                  inputRef.current?.focus()
                }}
              >
                <IconClose width={18} height={18} />
              </button>
            )}
          </div>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and legend; this is a toolbar of filters */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <select aria-label="Thread" className={select} value={threadId} onChange={(e) => setThreadId(e.target.value)}>
            <option value="">All threads</option>
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            aria-label="From"
            className={select}
            value={from}
            onChange={(e) => setFrom(e.target.value as SearchFiltersT['from'])}
          >
            <option value="any">Anyone</option>
            <option value="owner">You</option>
            <option value="agent">{agent}</option>
          </select>
          <button
            type="button"
            aria-pressed={hasFile}
            onClick={() => setHasFile((v) => !v)}
            className={`${select} ${hasFile ? 'border-accent bg-accent/15 font-semibold' : ''}`}
          >
            Has file
          </button>
          <select
            aria-label="Time"
            className={select}
            value={range}
            onChange={(e) => setRange(e.target.value as TimeRange)}
          >
            {(Object.keys(RANGE_LABEL) as TimeRange[]).map((r) => (
              <option key={r} value={r}>
                {RANGE_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`${select} ml-auto`}
            aria-label={`Sorted by ${sort === 'relevance' ? 'best match' : 'newest'}. Switch.`}
            onClick={() => setSort((s) => (s === 'relevance' ? 'newest' : 'relevance'))}
          >
            {sort === 'relevance' ? 'Best match ⇅' : 'Newest ⇅'}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="search-results">
        {offline && status.kind !== 'done' && (
          <Note>Needs your Mac for full search. Messages on this device can still be searched.</Note>
        )}
        {status.kind === 'done' && status.offline && (
          <Note>
            {macOnline ? 'Your Mac is catching up.' : 'Your Mac is offline.'} Showing matches from messages on this
            device.
          </Note>
        )}
        {status.kind === 'done' && !status.offline && index !== 'ready' && (
          <Note testid="search-indexing">Building the search index on your Mac… some results may be missing.</Note>
        )}
        {status.kind === 'error' && (
          <p role="alert" className="m-0 px-4 py-6 text-text-2">
            {status.message}
          </p>
        )}
        {status.kind === 'idle' && (
          <div className="px-4 py-4">
            <p className="m-0 text-sm text-text-2">
              Type at least {MIN_CHARS} letters. Words match anywhere in a message, a voice note or a file name. Put
              "quotes" around a phrase and a - before a word to leave it out.
            </p>
            {recent.length > 0 && (
              <div className="mt-4 flex flex-col gap-1" data-testid="search-recent">
                <div className="flex items-center justify-between">
                  <h2 className="m-0 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
                    Recent
                  </h2>
                  <button
                    type="button"
                    className="min-h-11 px-2 text-sm text-text-2"
                    onClick={() => {
                      clearRecent()
                      setRecent([])
                    }}
                  >
                    Clear
                  </button>
                </div>
                {recent.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="min-h-11 rounded-button px-2 text-left text-sm hover:bg-surface"
                    onClick={() => setText(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {status.kind === 'loading' && hits.length === 0 && (
          <p role="status" className="m-0 px-4 py-6 text-text-2">
            Searching…
          </p>
        )}
        {status.kind === 'done' && hits.length === 0 && (
          <div role="status" className="m-0 px-4 py-6 text-text-2" data-testid="search-empty">
            <p className="m-0">Nothing found for “{q}”.</p>
            <p className="m-0 mt-1 text-sm" data-testid="search-empty-hint">
              Try fewer words, or set the filters back to All threads and Any time
            </p>
          </div>
        )}
        {hits.length > 0 && (
          <>
            <p className="m-0 px-4 pt-3 text-xs text-text-2" role="status">
              {total >= 1000 ? 'Over 1,000 matches' : `${total} ${total === 1 ? 'match' : 'matches'}`}
            </p>
            <ul className="m-0 list-none p-0">
              {hits.map((h) => (
                <li key={`${h.message_id}`}>
                  <HitRow
                    title={`# ${threadName.get(h.thread_id) ?? h.thread_id} · ${who(h)} · ${dayLabel(h.created_at)} ${clockTime(h.created_at)}`}
                    snippet={h.snippet}
                    marks={h.marks}
                    badge={
                      h.via === 'share' && h.match_in === 'text' ? 'in shared content' : MATCH_IN_LABEL[h.match_in]
                    }
                    {...(h.attachment?.name ? { file: h.attachment.name } : {})}
                    onOpen={() => nav(`/t/${h.thread_id}?m=${h.message_id}`)}
                  />
                </li>
              ))}
            </ul>
            {cursor && (
              <div className="flex justify-center py-3">
                <Button variant="outline" onClick={() => void run(true)} disabled={status.kind === 'loading'}>
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function Note({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <p
      role="status"
      data-testid={testid}
      className="m-0 border-b border-line/60 bg-surface px-4 py-2 text-sm text-text-2"
    >
      {children}
    </p>
  )
}
