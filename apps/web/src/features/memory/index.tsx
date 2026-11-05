// `/memory` (docs/V2-FEATURES.md V5.3): a read-only tree of the folders the owner chose at their Mac, a note view, and
// search over the notes. Where you are lives in the URL (?r=root&p=folder&n=note) so Back works. P0: no offline cache.
import type { MemoryEntryT, MemoryHitT, MemoryRootInfoT } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { shortAge } from '../../lib/format.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { IconBack, IconChevron, IconFile, IconSearch } from '../../ui/icons.tsx'
import { Button, Input } from '../../ui/index.ts'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import type { MemoryScreenProps } from '../contracts.ts'
import { HitRow } from '../search/HitRow.tsx'
import { useAgentName } from '../threads/useThreads.ts'
import { crumbs, errorWords, OFF_TEXT, parentOf } from './logic.ts'
import { NoteView } from './NoteView.tsx'

const row =
  'flex min-h-11 w-full items-center gap-3 border-b border-line/60 px-4 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus'

function IconFolder() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h6l2 2h10v11H3z" />
    </svg>
  )
}

type Listing = { roots: MemoryRootInfoT[] | null; entries: MemoryEntryT[]; next: string | null }

export function MemoryScreen(_props: MemoryScreenProps) {
  const client = useTalosClient()
  const mem = client.memory
  const state = useFeature('memory/1')
  const agent = useAgentName()
  const [sp, setSp] = useSearchParams()
  const r = sp.get('r')
  const p = sp.get('p') ?? ''
  const n = sp.get('n')

  const [roots, setRoots] = useState<MemoryRootInfoT[] | null>(null)
  const [list, setList] = useState<Listing>({ roots: null, entries: [], next: null })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<MemoryHitT[] | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const gen = useRef(0)
  const searchGen = useRef(0)

  const go = useCallback(
    (next: { r?: string | null; p?: string; n?: string | null }, replace = false) => {
      const out = new URLSearchParams()
      if (next.r) out.set('r', next.r)
      if (next.p) out.set('p', next.p)
      if (next.n) out.set('n', next.n)
      setSp(out, { replace })
    },
    [setSp],
  )

  const fail = useCallback((e: unknown) => setError(errorWords(e instanceof TalosClientError ? e.code : undefined)), [])

  // the roots (also the label for the breadcrumb)
  useEffect(() => {
    if (!mem || state !== 'on') return
    let live = true
    mem
      .tree(null, '', null)
      .then((t) => {
        if (!live) return
        setRoots(t.roots ?? [])
        // one root: go straight in
        if (!r && t.roots?.length === 1) go({ r: t.roots[0]?.id }, true)
      })
      .catch((e) => live && fail(e))
    return () => {
      live = false
    }
  }, [mem, state, r, go, fail])

  // a folder's first page
  useEffect(() => {
    if (!mem || state !== 'on' || !r || n) return
    const g = ++gen.current
    setLoading(true)
    setError(null)
    setList({ roots: null, entries: [], next: null })
    mem
      .tree(r, p, null)
      .then((t) => g === gen.current && setList({ roots: null, entries: t.entries, next: t.nextCursor }))
      .catch((e) => g === gen.current && fail(e))
      .finally(() => g === gen.current && setLoading(false))
  }, [mem, state, r, p, n, fail])

  const more = async () => {
    if (!mem || !r || !list.next || loading) return
    const g = gen.current
    setLoading(true)
    try {
      const t = await mem.tree(r, p, list.next)
      if (g === gen.current) setList((l) => ({ ...l, entries: [...l.entries, ...t.entries], next: t.nextCursor }))
    } catch (e) {
      if (g === gen.current) fail(e)
    } finally {
      setLoading(false)
    }
  }
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !list.next || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more())
    io.observe(el)
    return () => io.disconnect()
  })

  // search, typed
  useEffect(() => {
    if (!mem || state !== 'on') return
    const term = q.trim()
    if (term === '') {
      setHits(null)
      setSearchError(null)
      return
    }
    const g = ++searchGen.current
    const t = setTimeout(() => {
      mem
        .search(term, r ? [r] : [], null, 20)
        .then((res) => {
          if (g !== searchGen.current) return
          setHits(res.hits)
          setIndexing(res.index !== 'ready')
          setSearchError(null)
        })
        .catch(
          (e) =>
            g === searchGen.current && setSearchError(errorWords(e instanceof TalosClientError ? e.code : undefined)),
        )
    }, 250)
    return () => clearTimeout(t)
  }, [mem, state, q, r])

  const label = roots?.find((x) => x.id === r)?.label ?? r ?? ''

  let body: React.ReactNode
  if (state === 'off' || !mem)
    body = (
      <p className="m-0 p-4 text-text-2" data-testid="memory-unavailable">
        The memory browser isn't available on your Mac yet. Update Talos on your Mac.
      </p>
    )
  else if (state === 'needs_mac')
    body = (
      <p role="status" className="m-0 p-4 text-text-2" data-testid="memory-needs-mac">
        Needs your Mac
      </p>
    )
  else if (error === OFF_TEXT)
    body = (
      <div className="flex flex-col gap-2 p-4" data-testid="memory-off">
        <p className="m-0">{OFF_TEXT}</p>
      </div>
    )
  else if (q.trim() !== '')
    body = (
      <div data-testid="memory-results">
        {searchError && (
          <p role="alert" className="m-0 p-4 text-text-2">
            {searchError}
          </p>
        )}
        {indexing && (
          <p role="status" className="m-0 px-4 py-2 text-sm text-text-2">
            Still reading your notes. Results may be incomplete.
          </p>
        )}
        {hits?.length === 0 && !searchError && <p className="m-0 p-4 text-text-2">No notes match.</p>}
        <ul className="m-0 list-none p-0">
          {hits?.map((h) => (
            <li key={`${h.root_id}/${h.path}`}>
              <HitRow
                title={h.title}
                snippet={h.snippet}
                marks={h.marks}
                badge={h.path}
                onOpen={() => {
                  setQ('')
                  go({ r: h.root_id, p: parentOf(h.path), n: h.path })
                }}
              />
            </li>
          ))}
        </ul>
      </div>
    )
  else if (n && r)
    body = (
      <NoteView
        key={`${r}/${n}`}
        rootId={r}
        path={n}
        agent={agent}
        onOpen={(rr, pp) => go({ r: rr, p: parentOf(pp), n: pp })}
      />
    )
  else if (!r)
    body = error ? (
      <p role="status" className="m-0 p-4 text-text-2" data-testid="memory-error">
        {error}
      </p>
    ) : roots === null ? (
      <p role="status" className="m-0 p-4 text-text-2">
        Loading…
      </p>
    ) : roots.length === 0 ? (
      <p className="m-0 p-4 text-text-2">No folders are shared yet. At your Mac: talos-app memory init</p>
    ) : (
      <ul className="m-0 list-none p-0" data-testid="memory-roots">
        {roots.map((x) => (
          <li key={x.id}>
            <button type="button" className={row} onClick={() => go({ r: x.id })} data-testid={`memory-root-${x.id}`}>
              <IconFolder />
              <span className="min-w-0 flex-1 truncate font-medium">{x.label}</span>
              <span className="text-sm text-text-2">{x.files}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  else
    body = (
      <div>
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 px-4 py-2 text-sm text-text-2">
          {crumbs(r, label, p).map((c, i, all) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <IconChevron width={14} height={14} />}
              {i === all.length - 1 ? (
                <span aria-current="page" className="font-medium text-text">
                  {c.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="min-h-11 px-1 text-accent"
                  onClick={() => go({ r: c.root, p: c.path })}
                >
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        {error && (
          <p role="status" className="m-0 p-4 text-text-2" data-testid="memory-error">
            {error}
          </p>
        )}
        {!error && !loading && list.entries.length === 0 && <p className="m-0 p-4 text-text-2">Nothing here.</p>}
        <ul className="m-0 list-none p-0" data-testid="memory-list">
          {list.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className={row}
                data-testid={`memory-entry-${e.name}`}
                onClick={() => (e.type === 'dir' ? go({ r, p: e.path }) : go({ r, p: parentOf(e.path), n: e.path }))}
              >
                {e.type === 'dir' ? <IconFolder /> : <IconFile width={20} height={20} />}
                <span className="min-w-0 flex-1 truncate">{e.type === 'file' && e.title ? e.title : e.name}</span>
                {e.mtime && <span className="text-sm text-text-2">{shortAge(e.mtime)}</span>}
              </button>
            </li>
          ))}
        </ul>
        {list.next && (
          <div ref={sentinel} className="flex justify-center p-2">
            <Button variant="ghost" onClick={() => void more()} disabled={loading} data-testid="memory-load-more-list">
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    )

  const up = () => {
    if (n) go({ r, p: parentOf(n) })
    else if (p) go({ r, p: parentOf(p) })
    else if (roots && roots.length > 1) go({})
  }
  const canUp = Boolean(n || p || (r && roots && roots.length > 1))

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="memory-screen">
      <header className="flex flex-col gap-2 border-b border-line/60 p-4">
        <div className="flex items-center gap-2">
          {canUp && (
            <button
              type="button"
              aria-label="Back"
              className="flex min-h-11 min-w-11 items-center justify-center"
              onClick={up}
            >
              <IconBack />
            </button>
          )}
          <h1 className="m-0 font-display text-2xl font-semibold">Memory</h1>
        </div>
        {state === 'on' && error !== OFF_TEXT && (
          <div className="relative">
            <IconSearch
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-2"
              width={18}
              height={18}
            />
            <Input
              type="search"
              className="pl-10"
              placeholder="Search notes…"
              aria-label="Search notes"
              data-testid="memory-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        )}
      </header>
      <ScrollRegion label="Memory" className="min-h-0 flex-1 overflow-y-auto" data-testid="memory-scroll">
        {body}
      </ScrollRegion>
    </section>
  )
}
