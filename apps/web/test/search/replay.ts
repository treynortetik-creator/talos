// A SearchClient built from the captures: the REAL socket search code (createSocketSearch) with the relay and Mac replaced
// by the captured frames the real bridge sent. A query finds the captured step with the same q, sort, filters and cursor.
import { type FrameOf, newUlid } from '@talos-app/protocol'
import { TalosClientError } from '../../src/lib/client.ts'
import { createSocketSearch } from '../../src/lib/socketSearch.ts'
import type { SearchClient } from '../../src/lib/v2Client.ts'
import { SCENARIOS, type Step } from './captured.ts'

const J = JSON.stringify
export type Replay = SearchClient & {
  /** Every request the UI made, in order. */
  readonly asked: Array<Record<string, unknown>>
  offline: boolean
  /** Look in this capture first (e.g. `07-indexing`, which answers the same query as `01-relevance` while behind). */
  prefer: string | null
}

export function replayClient(): Replay {
  const listeners = new Set<(f: FrameOf<'search.results'>) => void>()
  const asked: Array<Record<string, unknown>> = []
  const state = { offline: false, prefer: null as string | null }
  const allSteps = (): Step[] => {
    const names = Object.keys(SCENARIOS).sort((a, b) =>
      a === state.prefer ? -1 : b === state.prefer ? 1 : a < b ? -1 : 1,
    )
    return names.flatMap((n) => SCENARIOS[n]?.steps ?? [])
  }
  const stepFor = (type: 'search.query' | 'history.request', req: Record<string, unknown>): Step | undefined =>
    allSteps().find((s) => {
      const r = s.request
      if (type === 'search.query')
        return (
          s.sent_by_bridge[0]?.type !== 'history.page' &&
          r.q === req.q &&
          r.sort === req.sort &&
          J(r.filters) === J(req.filters) &&
          (r.cursor ?? null) === (req.cursor ?? null)
        )
      return (
        s.sent_by_bridge[0]?.type === 'history.page' &&
        r.thread_id === req.thread_id &&
        r.around_id === req.around_id &&
        r.before_id === req.before_id &&
        r.after_id === req.after_id
      )
    })
  const core = createSocketSearch({
    async sendAndWait(frame) {
      asked.push(frame)
      const s = stepFor('search.query', frame)
      await new Promise((r) => setTimeout(r, 5))
      const out = s?.sent_by_bridge[0]
      if (!out) return new Promise(() => {}) // the Mac never answers (the UI's own timeout applies)
      if (out.type === 'error') throw new TalosClientError(out.code as never, String(out.message ?? ''))
      for (const cb of listeners) cb({ ...(out as FrameOf<'search.results'>), request_id: String(frame.request_id) })
      return new Promise(() => {})
    },
    on: (_t, cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    async requestPage(frame) {
      asked.push(frame)
      const s = stepFor('history.request', frame)
      await new Promise((r) => setTimeout(r, 5))
      const out = s?.sent_by_bridge[0] as FrameOf<'history.page'> | undefined
      if (!out)
        return {
          type: 'history.page',
          request_id: newUlid(),
          thread_id: String(frame.thread_id),
          messages: [],
          has_more: false,
        } as never
      return { ...out, request_id: String(frame.request_id) }
    },
    features: () => ['search/1'],
    macOnline: () => !state.offline,
  })
  return Object.defineProperties(core, {
    asked: { value: asked },
    offline: {
      get: () => state.offline,
      set: (v: boolean) => {
        state.offline = v
      },
    },
    prefer: {
      get: () => state.prefer,
      set: (v: string | null) => {
        state.prefer = v
      },
    },
  }) as Replay
}
