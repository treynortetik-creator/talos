// Inbox list and state (spec 7.3): Priority = high + normal, Other = low; `inbox.update` from the app or the agent;
// snoozed items wake up on their own.
import type { FrameOf, InboxItemT } from '@talos-app/protocol'
import { frame, stripInternal } from './route.ts'
import { type EventRow, eventOf, type HooksRuntime } from './types.ts'

const LIST_LIMIT = 200

export function itemOf(rt: HooksRuntime, row: EventRow): InboxItemT {
  const e = stripInternal(eventOf(rt, row))
  return {
    ...e,
    priority: row.priority,
    state: row.state,
    ...(row.snooze_until ? { snooze_until: row.snooze_until } : {}),
    ...(row.agent_summary ? { agent_summary: row.agent_summary } : {}),
    ...(row.card_id ? { card_id: row.card_id } : {}),
  }
}

/** `state: 'done'` is the Done view: finished items of either tab, newest first. Everything else excludes done. */
export function listInbox(rt: HooksRuntime, tab: 'priority' | 'other', state?: 'done') {
  const { db } = rt.services
  const prio = tab === 'priority' ? "priority in ('high', 'normal')" : "priority = 'low'"
  const rows = (
    state === 'done'
      ? db.prepare("select * from hooks_events where state = 'done' order by ts desc, event_id desc limit ?")
      : db.prepare(
          `select * from hooks_events where state != 'done' and ${prio} order by ts desc, event_id desc limit ?`,
        )
  ).all(LIST_LIMIT + 1) as EventRow[]
  let unreadable = 0
  const count = (where: string) =>
    (db.prepare(`select count(*) as n from hooks_events where state != 'done' and ${where}`).get() as { n: number }).n
  return {
    items: rows.slice(0, LIST_LIMIT).flatMap((row) => {
      try {
        return [itemOf(rt, row)]
      } catch (err) {
        // One item that no longer opens is reported and left out; the rest of the inbox still loads.
        unreadable++
        rt.services.log.error(
          { event: row.event_id, err: err instanceof Error ? err.name : 'error' },
          'inbox item unreadable; left out',
        )
        return []
      }
    }),
    counts: { priority: count("priority in ('high', 'normal')"), other: count("priority = 'low'") },
    ...(rows.length > LIST_LIMIT ? { truncated: true } : {}),
    ...(unreadable > 0 ? { unreadable } : {}),
  }
}

type Who = 'app' | 'bridge'

/** Applies an `inbox.update` and tells every app. The app may change state, snooze and priority; the agent also the summary and card. */
export async function applyInboxUpdate(rt: HooksRuntime, f: FrameOf<'inbox.update'>, who: Who): Promise<boolean> {
  const { db, bus } = rt.services
  const row = db.prepare('select * from hooks_events where event_id = ?').get(f.event_id) as EventRow | undefined
  if (!row) return false
  const sets: string[] = []
  const args: unknown[] = []
  const out: Record<string, unknown> = { event_id: f.event_id }
  if (f.state) {
    if (f.state === 'snoozed') {
      const until = f.snooze_until ? Date.parse(f.snooze_until) : Number.NaN
      if (Number.isNaN(until) || until <= rt.now()) return false // a snooze needs a future wake-up time
      sets.push('state = ?', 'snooze_until = ?')
      args.push('snoozed', f.snooze_until)
      out.state = 'snoozed'
      out.snooze_until = f.snooze_until
    } else {
      sets.push('state = ?', 'snooze_until = ?')
      args.push(f.state, null)
      out.state = f.state
    }
  }
  if (f.priority) {
    sets.push('priority = ?')
    args.push(f.priority)
    out.priority = f.priority
  }
  if (who === 'bridge') {
    if (f.agent_summary !== undefined) {
      sets.push('agent_summary = ?')
      args.push(f.agent_summary)
      out.agent_summary = f.agent_summary
    }
    if (f.card_id) {
      sets.push('card_id = ?')
      args.push(f.card_id)
      out.card_id = f.card_id
    }
  }
  if (sets.length === 0) return false
  db.prepare(`update hooks_events set ${sets.join(', ')} where event_id = ?`).run(...args, f.event_id)
  await bus.toApps(frame(rt, 'inbox.update', out), { durable: true })
  return true
}

/** Snoozed items whose time has come become `new` again. */
export async function wakeSnoozed(rt: HooksRuntime): Promise<number> {
  const { db, bus } = rt.services
  const due = db.prepare("select event_id, snooze_until from hooks_events where state = 'snoozed'").all() as Array<{
    event_id: string
    snooze_until: string | null
  }>
  let n = 0
  for (const r of due) {
    if (r.snooze_until && Date.parse(r.snooze_until) > rt.now()) continue
    db.prepare("update hooks_events set state = 'new', snooze_until = null where event_id = ?").run(r.event_id)
    await bus.toApps(frame(rt, 'inbox.update', { event_id: r.event_id, state: 'new' }), { durable: true })
    n++
  }
  return n
}
