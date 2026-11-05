// D18: decides when a reply in another thread earns a jump banner. Pure over the client store so it can be driven by the
// real socket client in a test.

import { ownValue } from '@talos-app/protocol'
import type { ClientState } from '../../lib/client.ts'

/** A reply older than this is a replay (reconnect, catch-up), not news. */
export const FRESH_REPLY_MS = 120_000

export type Banner = { key: string; threadId: string; name: string; snippet: string }

type StoreLike = { getState(): ClientState; subscribe(fn: () => void): () => void }

/**
 * The unread count is the trigger: the socket client stores a reply first and bumps the count in a second write, so the
 * message alone is never proof of news. Once a count has risen, the newest agent message in that thread decides what the
 * banner says; a message that fired once never fires again. `onScreenThread` returns the thread the owner is looking at.
 */
export function watchForBanner(
  store: StoreLike,
  onScreenThread: (s: ClientState) => string | null,
  show: (b: Banner) => void,
  now: () => number = Date.now,
): () => void {
  const fired = new Set<string>()
  let prevUnread: Record<string, number> = { ...store.getState().unread }
  return store.subscribe(() => {
    const s = store.getState()
    let last: Banner | undefined
    for (const [tid, n] of Object.entries(s.unread)) {
      if (n <= (ownValue(prevUnread, tid) ?? 0)) continue
      const t = s.threads.find((x) => x.id === tid)
      // Push honors a thread's notify setting; the banner does too: only "all" interrupts
      if (!t || t.archived || t.notify !== 'all') continue
      if (tid === onScreenThread(s)) continue
      const m = [...(ownValue(s.messages, tid) ?? [])].reverse().find((x) => x.author === 'agent')
      if (!m || fired.has(m.id)) continue
      if (now() - Date.parse(m.created_at) > FRESH_REPLY_MS) continue
      fired.add(m.id)
      last = {
        key: m.id,
        threadId: tid,
        name: t.name,
        snippet: (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'New reply',
      }
    }
    prevUnread = { ...s.unread }
    if (last) show(last)
  })
}
