// The search the thread list runs in place: the same backend and the same offline fallback as the /search screen, for every
// thread, best match first, one page. A debounced query in, hits and a status out.
import type { SearchHitT } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { DEBOUNCE_MS, filtersFor, MIN_CHARS, searchCached } from './logic.ts'

export type SearchHitsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; hits: SearchHitT[]; total: number; offline: boolean }
  | { kind: 'error'; message: string }

const PAGE = 20

export function useSearchHits(text: string): SearchHitsState {
  const client = useTalosClient()
  const feature = useFeature('search/1')
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const cached = useTalos((s) => s.messages)
  const [state, setState] = useState<SearchHitsState>({ kind: 'idle' })
  const gen = useRef(0)
  // the cached messages change as replies arrive; only a new query or a change of Mac starts a search
  const cachedRef = useRef(cached)
  cachedRef.current = cached
  const q = text.trim()
  const offline = !macOnline || feature === 'needs_mac'

  // biome-ignore lint/correctness/useExhaustiveDependencies: `client` and the refs are stable; only the query and the Mac start a search
  useEffect(() => {
    const mine = ++gen.current
    if (q.length < MIN_CHARS) {
      setState({ kind: 'idle' })
      return
    }
    setState({ kind: 'loading' })
    const filters = filtersFor({ threadId: '', from: 'any', hasFile: false, range: 'any' }, Date.now())
    const local = () => {
      const hits = searchCached(cachedRef.current, q, filters, 'relevance', PAGE)
      return { kind: 'done', hits, total: hits.length, offline: true } as const
    }
    const t = setTimeout(async () => {
      try {
        if (offline) return setState(local())
        if (!client.search) throw new TalosClientError('search_unavailable', 'Search is not available in this build.')
        const r = await client.search.search({ q, filters, sort: 'relevance', cursor: null, limit: PAGE })
        if (mine === gen.current) setState({ kind: 'done', hits: r.hits, total: r.totalEstimate, offline: false })
      } catch (e) {
        if (mine !== gen.current) return
        if (e instanceof TalosClientError && e.code === 'mac_offline') return setState(local())
        setState({
          kind: 'error',
          message: e instanceof TalosClientError && e.message ? e.message : 'Search failed. Try again.',
        })
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q, offline])

  return state
}
