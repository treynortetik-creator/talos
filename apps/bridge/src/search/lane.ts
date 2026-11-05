// Not wired: no agent tool searches history today, so a lead's search is not held to its own thread by anything running.
// This is the filter for a future search tool made on a worker's behalf: wrap its SearchService with it.
import type { SearchService } from '../v2-seams.ts'

export function laneSearch(svc: SearchService, thread: string): SearchService {
  return {
    get available() {
      return svc.available
    },
    async query(f) {
      // Whatever thread ids were asked for, the lane replaces them; hits outside it are dropped as a second check.
      const r = await svc.query({ ...f, filters: { ...f.filters, thread_ids: [thread] } })
      return { ...r, hits: r.hits.filter((h) => h.thread_id === thread) }
    },
    ...(svc.history
      ? {
          history(f) {
            if (f.thread_id !== thread) return { messages: [], hasMore: false, hasNewer: false }
            const r = svc.history?.(f) ?? null
            return r && { ...r, messages: r.messages.filter((m) => m.thread_id === thread) }
          },
        }
      : {}),
  }
}
