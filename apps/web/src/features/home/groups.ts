// Pure grouping for the Needs-you home (spec 8.2). Kept free of React so the order and counts are unit-testable.
import type { CardT, InboxItemT, ThreadStatusT, ThreadT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import type { ClientState } from '../../lib/client.ts'
import { freshStatus, STALE_STATUS_MS } from '../../lib/threadStatus.ts'
import { awaitsOwner, isAltered, takenAt } from '../cards/logic.ts'

export type HomeRow =
  | { kind: 'card'; id: string; card: CardT; thread: ThreadT | undefined; at: string }
  | { kind: 'thread'; id: string; thread: ThreadT; status: ThreadStatusT | undefined; unread: number; at: string }
  | { kind: 'snoozed'; id: string; item: InboxItemT; at: string }

export type HomeGroupId = 'flagged' | 'needs_you' | 'ready' | 'working' | 'done_today'
export type HomeGroup = { id: HomeGroupId; title: string; rows: HomeRow[] }

export type HomeModel = {
  groups: HomeGroup[]
  /** Pending, unexpired cards, minus locally snoozed ones: the badge number. */
  needsYouCount: number
  /** "Up next" tab: queued threads and snoozed inbox items. */
  upNext: HomeRow[]
}

export { STALE_STATUS_MS }

type Input = Pick<ClientState, 'cards' | 'threads' | 'statuses' | 'unread' | 'inbox'>

/** Calendar-day key in `timeZone`; "today" means the same key as `nowMs`. */
function dayKey(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date(ms))
  }
}

export function buildHome(
  s: Input,
  o: { nowMs: number; timeZone: string; localSnoozed: ReadonlyMap<string, number> },
): HomeModel {
  const thread = (id: string) => s.threads.find((t) => t.id === id)
  const snoozed = (id: string) => (o.localSnoozed.get(id) ?? 0) > o.nowMs
  // working/queued only count while fresh; an old row reads as idle here (D17)
  const statusOf = (id: string) => freshStatus(ownValue(s.statuses, id), o.nowMs)
  const stateOf = (id: string): ThreadStatusT['state'] | undefined => statusOf(id)?.state

  // A card whose hash doesn't match what the owner would see is never an ordinary "Needs you" row and never counts.
  const flagged: HomeRow[] = s.cards
    .filter((c) => c.state === 'pending' && isAltered(c))
    .map((card) => ({ kind: 'card', id: card.id, card, thread: thread(card.thread_id), at: card.created_at }))

  const pending = s.cards
    .filter((c) => awaitsOwner(c, o.nowMs) && !snoozed(c.id))
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))
  const needs: HomeRow[] = pending.map((card) => ({
    kind: 'card',
    id: card.id,
    card,
    thread: thread(card.thread_id),
    at: card.created_at,
  }))

  const pendingThreads = new Set(pending.map((c) => c.thread_id))
  // Ready for review: the agent has said something, nothing is running and nothing is waiting on a card.
  const ready: HomeRow[] = s.threads
    .filter((t) => !t.archived && t.kind !== 'system')
    .filter((t) => (ownValue(s.unread, t.id) ?? 0) > 0 && !pendingThreads.has(t.id))
    .filter((t) => {
      const st = stateOf(t.id)
      return (st === undefined || st === 'idle') && !snoozed(t.id)
    })
    .map((t) => ({
      kind: 'thread',
      id: t.id,
      thread: t,
      status: statusOf(t.id),
      unread: ownValue(s.unread, t.id) ?? 0,
      at: statusOf(t.id)?.since ?? t.created_at,
    }))

  const working: HomeRow[] = s.threads
    .filter((t) => stateOf(t.id) === 'working')
    .map((t) => ({
      kind: 'thread',
      id: t.id,
      thread: t,
      status: statusOf(t.id),
      unread: ownValue(s.unread, t.id) ?? 0,
      at: statusOf(t.id)?.since ?? t.created_at,
    }))

  const today = dayKey(o.nowMs, o.timeZone)
  const done: HomeRow[] = s.cards
    .filter((c) => c.state !== 'pending')
    .map((card) => ({ card, at: card.result?.at ?? takenAt(card) ?? card.created_at }))
    .filter(({ at }) => dayKey(Date.parse(at), o.timeZone) === today)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map(({ card, at }) => ({ kind: 'card', id: card.id, card, thread: thread(card.thread_id), at }))

  const upNext: HomeRow[] = [
    ...s.threads
      .filter((t) => stateOf(t.id) === 'queued')
      .map(
        (t): HomeRow => ({
          kind: 'thread',
          id: t.id,
          thread: t,
          status: statusOf(t.id),
          unread: ownValue(s.unread, t.id) ?? 0,
          at: statusOf(t.id)?.since ?? t.created_at,
        }),
      ),
    ...s.inbox
      .filter((i) => i.state === 'snoozed')
      .map((item): HomeRow => ({ kind: 'snoozed', id: item.id, item, at: item.snooze_until ?? item.ts })),
    ...s.cards
      .filter((c) => c.state === 'pending' && !isAltered(c) && snoozed(c.id))
      .map(
        (card): HomeRow => ({ kind: 'card', id: card.id, card, thread: thread(card.thread_id), at: card.created_at }),
      ),
  ]

  return {
    needsYouCount: needs.length,
    upNext,
    groups: [
      ...(flagged.length > 0 ? [{ id: 'flagged' as const, title: "Can't verify", rows: flagged }] : []),
      { id: 'needs_you', title: 'Needs you', rows: needs },
      { id: 'ready', title: 'Ready for review', rows: ready },
      { id: 'working', title: 'Working', rows: working },
      { id: 'done_today', title: 'Done today', rows: done },
    ],
  }
}
