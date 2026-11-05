// Inbox Done view and Restore (audit D35). Kept out of the client on purpose: `socketClient.ts` belongs to another package, so
// the done list is fetched here with the same `createHttp` the push code uses, and fake mode reads it from the store.
import { type InboxItemT, routes } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import { createHttp, type Http } from '../../lib/http.ts'

export const UNDO_MS = 6000
/** After a restore, how long and how often to ask the relay whether it has applied the change. */
export const RESTORE_POLL_MS = 400
export const RESTORE_POLL_TRIES = 10

const defaultHttp = createHttp()
const isFake = () => import.meta.env.VITE_FAKE === '1'

/**
 * `GET /api/inbox?state=done`. In fake mode there is no relay: the store's own done items are the list. The relay answers
 * the 200 newest by when each EVENT arrived (there is no done-at column), not by when it was finished, and says so with
 * `truncated`; the Done view tells him the list was cut.
 */
export async function fetchDone(
  client: TalosClient,
  http: Http = defaultHttp,
): Promise<{ items: InboxItemT[]; truncated: boolean }> {
  if (isFake()) return { items: client.store.getState().inbox.filter((i) => i.state === 'done'), truncated: false }
  const res = routes.inboxList.res.parse(await http.get(`${routes.inboxList.path}?state=done`))
  return { items: res.items, truncated: res.truncated === true }
}
export const fetchDoneItems = async (client: TalosClient, http?: Http): Promise<InboxItemT[]> =>
  (await fetchDone(client, http)).items

const tabOf = (i: InboxItemT) => (i.priority === 'low' ? 'other' : 'priority')

/**
 * Brings a finished (or just-snoozed) item back as `read`, or as `new` when Undo is putting back an item that was unread. The relay already allows done -> read and clears the snooze time.
 *
 * Two traps this exists for. The socket's `inbox.update` only maps items already in `ClientState.inbox`, and a list refresh
 * drops done items, so by the time Restore is tapped the item may be gone from the store and the relay's answer would change
 * nothing on screen. So the item is put back in the store first. And a refetch straight away can read the relay before it has
 * applied the change (updateInbox does not wait) and drop the item again, so the list is refetched only once the Done view no
 * longer holds it. Offline, the change stays queued and the item stays on screen until the relay catches up.
 */
export async function restoreInboxItem(
  client: TalosClient,
  item: InboxItemT,
  opts: { http?: Http; pollMs?: number; tries?: number; to?: 'new' | 'read' | 'snoozed' } = {},
): Promise<void> {
  const to = opts.to ?? 'read'
  const { snooze_until: _wake, ...rest } = item
  const back: InboxItemT = to === 'snoozed' ? { ...item, state: to } : { ...rest, state: to }
  client.store.setState((s) => ({
    inbox: s.inbox.some((i) => i.id === item.id) ? s.inbox : [back, ...s.inbox],
  }))
  await client.updateInbox(
    item.id,
    to === 'snoozed' && item.snooze_until
      ? { state: to, snoozeUntil: item.snooze_until }
      : { state: to as 'new' | 'read' },
  )
  if (isFake()) return
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (let n = 0; n < (opts.tries ?? RESTORE_POLL_TRIES); n++) {
    await wait(opts.pollMs ?? RESTORE_POLL_MS)
    try {
      const still = (await fetchDoneItems(client, opts.http)).some((i) => i.id === item.id)
      if (!still) {
        await client.api.inbox(tabOf(item))
        return
      }
    } catch {
      // The relay is unreachable: the queued change is sent on reconnect and the item above stays on screen.
      return
    }
  }
}

/** What Undo puts back: the state the item had before the change (unread stays unread, a snooze still pending returns). */
export function undoTarget(item: InboxItemT, nowMs = Date.now()): 'new' | 'read' | 'snoozed' {
  if (item.state === 'new') return 'new'
  if (item.state === 'snoozed' && item.snooze_until && Date.parse(item.snooze_until) > nowMs) return 'snoozed'
  return 'read'
}
