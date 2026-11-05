// The socket SearchClient (docs/V2-FEATURES.md V3). `search.query` is a signed owner frame the relay forwards to the Mac;
// the answer is a `search.results` frame routed back by request_id, or `error{ref}` (mac_offline, bad_query,
// search_unavailable, rate_limited, sig_invalid). The relay sends no ack for these reads, so a call resolves on the answer
// frame and rejects on the error (the pending entry that `sendAndWait` leaves behind times out on its own).
// The context view's paging is `history.request` with `around_id` / `before_id` / `after_id`: the page comes back as
// `history.page`, and is NEVER merged into the live timeline (socketClient skips the upsert for these request ids).
import { type FrameOf, newUlid, SEARCH_FEATURE, SEARCH_LIMITS } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { SearchClient } from './v2Client.ts'

export type SocketSearchDeps = {
  /** Signs, sends and rejects on `error{ref}` (an ack, if one came, would resolve it). */
  sendAndWait(frame: Record<string, unknown>, timeoutMs: number): Promise<unknown>
  on(type: 'search.results', cb: (f: FrameOf<'search.results'>) => void): () => void
  /** Sends a signed `history.request` and resolves with its `history.page` (not merged into the timeline). */
  requestPage(frame: Record<string, unknown>, timeoutMs: number): Promise<FrameOf<'history.page'>>
  features(): string[] | undefined
  macOnline(): boolean
}

export function createSocketSearch(d: SocketSearchDeps): SearchClient {
  return {
    async search({ q, filters, sort, cursor, limit }) {
      if (!d.macOnline()) throw new TalosClientError('mac_offline', 'Your Mac is offline.')
      const f = d.features()
      if (f && !f.includes(SEARCH_FEATURE))
        throw new TalosClientError('search_unavailable', 'Update Talos on your Mac to search.')
      const request_id = newUlid()
      let off: () => void = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      const answer = new Promise<FrameOf<'search.results'>>((resolve, reject) => {
        off = d.on('search.results', (r) => {
          if (r.request_id === request_id) resolve(r)
        })
        timer = setTimeout(
          () => reject(new TalosClientError('internal', "Your Mac didn't answer.")),
          SEARCH_LIMITS.appTimeoutMs,
        )
      })
      // an error for this frame rejects here; if the answer won the race this later rejection is not an error
      const sent = d
        .sendAndWait({ type: 'search.query', request_id, q, filters, sort, cursor, limit }, SEARCH_LIMITS.appTimeoutMs)
        .then(() => new Promise<never>(() => {}))
      sent.catch(() => {})
      try {
        const r = await Promise.race([answer, sent])
        return {
          hits: r.hits,
          nextCursor: r.next_cursor,
          totalEstimate: r.total_estimate,
          index: r.index,
        }
      } catch (e) {
        if (e instanceof TalosClientError && e.message === 'The relay did not answer.')
          throw new TalosClientError('internal', "Your Mac didn't answer.")
        throw e
      } finally {
        off()
        if (timer) clearTimeout(timer)
      }
    },

    async context(threadId, args) {
      if (!d.macOnline()) throw new TalosClientError('mac_offline', 'Your Mac is offline.')
      const key = args.aroundId ? 'around_id' : args.beforeId ? 'before_id' : 'after_id'
      const id = args.aroundId ?? args.beforeId ?? args.afterId
      const page = await d.requestPage(
        { type: 'history.request', request_id: newUlid(), thread_id: threadId, [key]: id, limit: 50 },
        SEARCH_LIMITS.appTimeoutMs,
      )
      if (page.unavailable === 'mac_offline') throw new TalosClientError('mac_offline', 'Your Mac is offline.')
      return { messages: page.messages, hasMore: page.has_more, hasNewer: page.has_newer ?? false }
    },
  }
}
