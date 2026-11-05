// Stores kept events and routes them (spec 7.1 step 7-8): inbox.item to apps, a timeline Message for non-inbox threads,
// hook.event to the bridge, one push per batch for Priority items. During the quiet window events are collected only.

import type { NormalizedEventT } from '@talos-app/protocol'
import { isQuiet, newId, newUlid } from '@talos-app/protocol'
import { openEvent, sealEvent } from './event-seal.ts'
import type { HooksRuntime } from './types.ts'
import { DAY_MS, HOUR_MS } from './types.ts'

/** Inbox "Priority" tab = high + normal (spec 7.3); those are the events that earn a push. */
const PUSH_PRIORITIES = new Set(['high', 'normal'])

export function frame<T extends string>(rt: HooksRuntime, type: T, body: Record<string, unknown>) {
  return { v: 1 as const, id: newUlid(), ts: rt.iso(rt.now()), type, ...body }
}

export function quietNow(rt: HooksRuntime): boolean {
  const cfg = rt.services.agentConfig()
  if (!cfg) return false
  return isQuiet(new Date(rt.now()), cfg.quiet_window, cfg.timezone)
}

export function knownThreads(rt: HooksRuntime): Set<string> {
  const cfg = rt.services.agentConfig()
  return new Set(cfg ? cfg.threads.map((t) => t.id) : ['inbox'])
}

export function isPassthrough(rt: HooksRuntime, work: boolean): boolean {
  const cfg = rt.services.agentConfig()
  return work && (cfg?.work.retention ?? 'passthrough') === 'passthrough'
}

export type RouteInput = { event: NormalizedEventT; rawId: string | null }

/**
 * Step 1 of routing: persist the events (synchronous, no network). Call it inside the caller's transaction when the
 * stored events must commit together with other state (the worker does: dedup keys + events + inbound state).
 */
export function storeEvents(rt: HooksRuntime, inputs: RouteInput[]): number {
  if (inputs.length === 0) return 0
  const { db } = rt.services
  const quiet = quietNow(rt)
  const threads = knownThreads(rt)
  const insert = db.prepare(
    `insert into hooks_events (event_id, conn_id, integration, thread, priority, work, ts, event_json, event_enc, raw_id, collected, passthrough, created_at)
     values (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
  )
  const now = rt.now()
  let last: NormalizedEventT | undefined
  for (const { event, rawId } of inputs) {
    // A thread that disappeared from the config since the connection was made falls back to the inbox.
    const e: NormalizedEventT = {
      ...event,
      thread: threads.has(event.thread) ? event.thread : 'inbox',
      raw_ref: event.id,
    }
    insert.run(
      e.id,
      e.connection,
      e.source,
      e.thread,
      e.priority,
      e.work ? 1 : 0,
      e.ts,
      sealEvent(rt.services, e),
      rawId,
      quiet ? 1 : 0,
      isPassthrough(rt, e.work) ? 1 : 0,
      now,
    )
    last = e
  }
  if (last) db.prepare('update hooks_connections set last_event_at = ? where id = ?').run(now, last.connection)
  return inputs.length
}

const delivering = new WeakMap<HooksRuntime, Promise<unknown>>()

/**
 * Step 2 of routing, a durable pass: everything stored and not yet sent is tried in row order, and each row is stamped
 * only AFTER its send resolved. A crash or a failed send leaves the row unstamped, so the next pass (every drain and
 * tick) tries it again; a row that fails is skipped, not waited for, and nothing that was confirmed to a sender is lost.
 * The apps' copy is stored once per event whatever fails after it (a seen id is written with the frame), and the Mac's
 * copy keeps its frame id, so a retry is the same frame.
 * Returns the thread to push for (one push per pass, only for Priority events that went out live).
 */
export function deliverPending(rt: HooksRuntime): Promise<{ pushThread: string | null }> {
  const run = Promise.resolve(delivering.get(rt))
    .catch(() => undefined)
    .then(() => deliverPass(rt))
  delivering.set(rt, run)
  return run
}

type PendingRow = {
  event_id: string
  event_json: string
  event_enc: Buffer | null
  thread: string
  priority: string
  work: number
  passthrough: number
  collected: number
  apps_sent_at: number | null
  sent_at: number | null
  delivered_at: number | null
  bridge_frame_id: string | null
}

async function deliverPass(rt: HooksRuntime): Promise<{ pushThread: string | null }> {
  const { db, bus, env, log } = rt.services
  const rows = db
    .prepare(
      `select event_id, event_json, event_enc, thread, priority, work, passthrough, collected, apps_sent_at, sent_at, delivered_at, bridge_frame_id
       from hooks_events where apps_sent_at is null or (collected = 0 and sent_at is null) order by rowid limit 500`,
    )
    .all() as PendingRow[]
  let pushThread: string | null = null
  for (const r of rows) {
    let e: NormalizedEventT
    try {
      e = openEvent(rt.services, r)
    } catch (err) {
      // One row that no longer opens must not hold back the ones behind it. It is reported, and it stays in the table.
      log.error({ event: r.event_id, err: err instanceof Error ? err.name : 'error' }, 'hook event unreadable; skipped')
      continue
    }
    try {
      if (r.apps_sent_at === null) {
        await bus.toApps(frame(rt, 'inbox.item', { item: { ...stripInternal(e), state: 'new' } }), {
          durable: true,
          once: `hi:${r.event_id}`,
        })
        if (e.thread !== 'inbox') {
          const message = {
            id: newId('m'),
            thread_id: e.thread,
            author: 'hook' as const,
            kind: 'event' as const,
            text: e.title,
            format: 'plain' as const,
            attachments: [],
            event_id: e.id,
            via: 'hook' as const,
            created_at: rt.iso(rt.now()),
          }
          await bus.toApps(frame(rt, 'message.stored', { client_msg_id: message.id, message }), {
            durable: true,
            once: `hm:${r.event_id}`,
          })
        }
        db.prepare('update hooks_events set apps_sent_at = ? where event_id = ?').run(rt.now(), r.event_id)
      }
      if (r.collected === 0 && r.sent_at === null) {
        // The Mac may have acked this frame already (the stamp below failed after the send): then only the stamp is left.
        if (r.delivered_at === null) {
          const f = { ...frame(rt, 'hook.event', { event: e, delivery: 'live' }) }
          if (r.bridge_frame_id)
            f.id = r.bridge_frame_id // a retry re-sends the same frame id; the hub recognises a frame it already stored
          else db.prepare('update hooks_events set bridge_frame_id = ? where event_id = ?').run(f.id, r.event_id) // before sending: the ack may race us
          await bus.toBridge(f, {
            durable: true,
            resume: true,
            ttl_s: r.passthrough ? HOUR_MS / 1000 : env.BUFFER_DAYS * (DAY_MS / 1000),
          })
        }
        db.prepare('update hooks_events set sent_at = ? where event_id = ?').run(rt.now(), r.event_id)
        // Delivered means the Mac ACKED it (index.ts marks it then), not that we wrote it to a socket that may be dead.
        if (!pushThread && PUSH_PRIORITIES.has(r.priority)) pushThread = r.thread
      }
    } catch (err) {
      log.warn(
        { event: r.event_id, err: err instanceof Error ? err.name : 'error' },
        'hook delivery failed; will retry',
      )
      // No break: one row that cannot be sent must not hold back the ones behind it. It is tried again on the next pass.
    }
  }
  return { pushThread }
}

/** Store, then send. The poller's system items use this; the worker uses the two halves around its own transaction. */
export async function routeEvents(
  rt: HooksRuntime,
  inputs: RouteInput[],
  opts: { deferPush?: boolean } = {},
): Promise<{ pushThread: string | null }> {
  if (inputs.length === 0) return { pushThread: null }
  rt.services.db.transaction(() => storeEvents(rt, inputs))()
  const { pushThread } = await deliverPending(rt)
  if (pushThread && !opts.deferPush) await notifyNewItems(rt, pushThread)
  return { pushThread }
}

/** INFERENCE / protocol request: there is no inbox template yet; `reply` reads "New reply in <thread>". */
export async function notifyNewItems(rt: HooksRuntime, thread: string): Promise<void> {
  await rt.services.push.notify({ template: 'reply', thread_id: thread })
}

export function stripInternal(e: NormalizedEventT): Omit<NormalizedEventT, 'dedup_key' | 'raw_ref'> {
  const { dedup_key: _d, raw_ref: _r, ...rest } = e
  return rest
}

/** The Mac has the frame: stamp every event it carried; passthrough rows lose their raw payload once all are delivered. */
export function markDelivered(rt: HooksRuntime, frameId: string): void {
  const { db } = rt.services
  const rows = db
    .prepare(
      'select event_id, raw_id, passthrough, created_at from hooks_events where bridge_frame_id = ? and delivered_at is null',
    )
    .all(frameId) as Array<{ event_id: string; raw_id: string | null; passthrough: number; created_at: number }>
  if (rows.length === 0) return
  db.prepare('update hooks_events set delivered_at = ? where bridge_frame_id = ? and delivered_at is null').run(
    rt.now(),
    frameId,
  )
  for (const r of rows) {
    if (!r.passthrough) continue
    if (r.raw_id) wipeRawIfDone(rt, r.raw_id)
    // Work passthrough content must not stay on the relay once the Mac has it (spec 7.5): drop the row and app copies.
    rt.services.db.prepare('delete from hooks_events where event_id = ?').run(r.event_id)
    dropAppCopies(rt, r.event_id, r.created_at)
  }
}

/**
 * The same event also went to the apps as an `inbox.item` (and a `message.stored` line in its thread), which the relay
 * keeps in its replay buffer for BUFFER_DAYS. Passthrough content must leave that buffer too.
 */
export function dropAppCopies(rt: HooksRuntime, eventId: string, sinceMs: number): void {
  const { db, crypto } = rt.services
  const rows = db
    .prepare(
      "select seq, frame_id, body from core_events where type in ('inbox.item', 'message.stored') and created_at >= ?",
    )
    .all(sinceMs - 1000) as Array<{ seq: number; frame_id: string; body: Buffer }>
  for (const row of rows) {
    try {
      const f = JSON.parse(new TextDecoder().decode(crypto.decrypt(row.body, `core_events:${row.frame_id}`))) as {
        item?: { id?: string }
        message?: { event_id?: string }
      }
      if (f.item?.id === eventId || f.message?.event_id === eventId)
        db.prepare('delete from core_events where seq = ?').run(row.seq)
    } catch {
      // an unreadable row is not ours to judge
    }
  }
}

export function wipeRawIfDone(rt: HooksRuntime, rawId: string): void {
  const { db } = rt.services
  const open = db
    .prepare('select 1 from hooks_events where raw_id = ? and passthrough = 1 and delivered_at is null limit 1')
    .get(rawId)
  const retained = db.prepare('select 1 from hooks_events where raw_id = ? and passthrough = 0 limit 1').get(rawId)
  if (!open && !retained) db.prepare("update hooks_inbound set raw_enc = x'', state = 'wiped' where id = ?").run(rawId)
}
