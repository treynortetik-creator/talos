// Linked agents, relay side (P2): the peer inbox. A `peer` connection is a hooks connection that ONLY the Mac's signed route
// (`POST /bridge/peers`, bridge-peers.ts) can make, marked in its `extra`. A message that passes the signature, the body check, the
// id check, the dedupe and the daily cap becomes ONE durable `peer.message` frame for the Mac and nothing else: it does not enter
// the generic pipeline (no event row, no 280-character summary, no inbox card, no push, no digest), and its raw body is not kept.
//
// This is handled in ingest.ts before the generic path (`handlePeerDelivery` is called from there) and not as an
// integrations module: the module interface can only return events for the pipeline, and the whole point is that the text
// must not become one. The module in packages/integrations/src/peer stays an inert catalog entry.
import {
  PEER_DAILY_CAP_DEFAULT,
  PEER_DAILY_CAP_MAX,
  PEER_MAX,
  type PeerMessageT,
  PeerName,
  parsePeerMessage,
} from '@talos-app/protocol'
import { frame } from './route.ts'
import { addDelivery, dedupFirstSeen, deleteConn, listConns } from './store.ts'
import { type ConnRow, DAY_MS, DEDUP_TTL_MS, type HooksRuntime } from './types.ts'

/** The `extra` marker only `POST /bridge/peers` writes. The app API refuses to make, change or read a `peer` row. */
export const PEER_MARK = 'v1'

export type HookResponse = { status: number; contentType: string; body: string }
const json = (status: number, body: unknown): HookResponse => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

/** The row's daily cap, or null when the row is not a peer inbox this code made (any other `peer` row is refused like an unknown one). */
export function peerCap(c: ConnRow): number | null {
  if (c.integration !== 'peer' || c.extra.peer !== PEER_MARK) return null
  if (!PeerName.safeParse(c.name).success) return null
  const cap = Number(c.extra.daily_cap)
  return Number.isInteger(cap) && cap >= 1 && cap <= PEER_DAILY_CAP_MAX ? cap : null
}

export const isPeerInbox = (c: ConnRow): boolean => peerCap(c) !== null

const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS

/** Messages accepted on this connection since 00:00 UTC. */
export function receivedToday(rt: HooksRuntime, connId: string): number {
  return (
    rt.services.db
      .prepare("select count(*) as n from hooks_deliveries where conn_id = ? and reason = 'peer_ok' and at >= ?")
      .get(connId, utcDayStart(rt.now())) as { n: number }
  ).n
}

// ---- setup (the Mac's routes) ------------------------------------------------------------------------------------------

/** A peer message is 8 KB of text plus its JSON: anything over this is not one, and is refused before it is read in full. */
export const PEER_BODY_MAX_BYTES = 16 * 1024

export const peerConns = (rt: HooksRuntime): ConnRow[] => listConns(rt).filter(isPeerInbox)

export type NewPeer = { name: string; dailyCap: number }

export function peerByName(rt: HooksRuntime, name: string): ConnRow | null {
  return peerConns(rt).find((c) => c.name === name) ?? null
}

export const peerLimit = (rt: HooksRuntime): boolean => peerConns(rt).length >= PEER_MAX

/** Removes every `peer` row of that name (also a stray one with no marker): the sender gets 404 at once. True when one existed. */
export function removePeer(rt: HooksRuntime, name: string): boolean {
  const rows = listConns(rt).filter((c) => c.integration === 'peer' && c.name === name)
  for (const c of rows) deletePeerConn(rt, c.id)
  return rows.length > 0
}

/**
 * Deletes a peer connection AND every `peer.message` of it still queued for the Mac (outbox row and sealed event), in one
 * transaction: a revoked peer's words are not delivered later. Both revoke paths (the Mac's route, the app's DELETE) use it.
 */
export function deletePeerConn(rt: HooksRuntime, connId: string): void {
  const { db, bus } = rt.services
  db.transaction(() => {
    const ids = (
      db.prepare('select frame_id from hooks_peer_frames where conn_id = ?').all(connId) as Array<{ frame_id: string }>
    ).map((r) => r.frame_id)
    bus.dropBridgeFrames(ids, 'peer.message') // core's own function: the outbox rows and events, and the apps' queue count
    db.prepare('delete from hooks_peer_frames where conn_id = ?').run(connId)
    deleteConn(rt, connId)
  })()
}

/** Side-table rows whose frame is gone (consumed, expired): nothing to purge for them any more. */
export function purgePeerFrames(rt: HooksRuntime): void {
  const { db, bus } = rt.services
  const all = (db.prepare('select frame_id from hooks_peer_frames').all() as Array<{ frame_id: string }>).map(
    (r) => r.frame_id,
  )
  const stored = bus.storedFrameIds(all)
  for (const id of all) if (!stored.has(id)) db.prepare('delete from hooks_peer_frames where frame_id = ?').run(id)
}

export const defaultCap = PEER_DAILY_CAP_DEFAULT

// ---- the inbox -------------------------------------------------------------------------------------------------------------

/** Carries "this id was already taken" out of the queue write's transaction, which it rolls back. */
class SeenAlready extends Error {}

const seenKey = (connId: string, deliveryKey: string): string => `d:${connId}:${deliveryKey}`

function alreadySeen(rt: HooksRuntime, key: string): boolean {
  return (
    rt.services.db
      .prepare('select 1 from hooks_dedup where key = ? and expires_at > ?')
      .get(key.slice(0, 400), rt.now()) !== undefined
  )
}

/**
 * A VERIFIED delivery to a peer inbox (the caller checked the signature and charged the rate buckets). Order: the body, the id
 * against the header, the dedupe, the daily cap, then the durable hand-off. Nothing is stored for a refusal, and the seen mark
 * and the count are written inside the queue write's own transaction, so a failed queue write leaves neither behind.
 */
export async function handlePeerDelivery(
  rt: HooksRuntime,
  conn: ConnRow,
  args: { body: Uint8Array; webhookId: string; deliveryKey: string },
): Promise<HookResponse> {
  const cap = peerCap(conn)
  if (cap === null) return json(404, { error: 'not_found' }) // the caller already treats this as unknown; belt and braces
  // A refusal writes at most one audit row a minute per connection and reason, so a sender in a loop cannot fill the table.
  const auditOnce = (status: number, reason: string): void => {
    const recent = rt.services.db
      .prepare('select 1 from hooks_deliveries where conn_id = ? and reason = ? and at >= ? limit 1')
      .get(conn.id, reason, rt.now() - 60_000)
    if (!recent) addDelivery(rt, conn.id, status, reason)
  }
  const refuse = (status: number, reason: string, error: string): HookResponse => {
    auditOnce(status, reason)
    return json(status, { error })
  }
  let parsed: ReturnType<typeof parsePeerMessage>
  try {
    // fatal: bytes that are not UTF-8 are a bad body, never silently turned into U+FFFD (the text must arrive byte for byte)
    parsed = parsePeerMessage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(args.body)))
  } catch {
    return refuse(400, 'bad_body', 'bad_body')
  }
  if (!parsed.success) return refuse(400, 'bad_body', 'bad_body')
  const msg: PeerMessageT = parsed.data
  if (msg.id !== args.webhookId) return refuse(400, 'id_mismatch', 'id_mismatch')

  const key = seenKey(conn.id, args.deliveryKey)
  if (alreadySeen(rt, key)) {
    auditOnce(200, 'duplicate')
    return json(200, { ok: true })
  }
  if (receivedToday(rt, conn.id) >= cap) {
    // One audit row a minute, so a sender that retries in a loop does not fill the table. Nothing is stored: not the id, not the text.
    auditOnce(429, 'daily_cap')
    return json(429, {
      error: 'daily_cap',
      retry_after_s: Math.ceil((utcDayStart(rt.now()) + DAY_MS - rt.now()) / 1000),
    })
  }

  const now = rt.now()
  const out = frame(rt, 'peer.message', {
    conn_id: conn.id,
    peer: conn.name, // the connection's configured name: the receiver's truth, whatever `msg.from` says
    msg,
    received_at: rt.iso(now),
  })
  try {
    await rt.services.bus.toBridge(out, {
      durable: true, // a sleeping Mac gets it on reconnect, acked once; same life as a hook frame
      ttl_s: rt.services.env.BUFFER_DAYS * (DAY_MS / 1000),
      alsoWrite: () => {
        if (!dedupFirstSeen(rt, key, DEDUP_TTL_MS)) throw new SeenAlready()
        rt.services.db.prepare('insert into hooks_peer_frames (frame_id, conn_id) values (?, ?)').run(out.id, conn.id)
        addDelivery(rt, conn.id, 200, 'peer_ok', { received: 1, kept: 1 })
        rt.services.db.prepare('update hooks_connections set last_event_at = ? where id = ?').run(now, conn.id)
      },
    })
  } catch (err) {
    if (err instanceof SeenAlready) {
      auditOnce(200, 'duplicate')
      return json(200, { ok: true })
    }
    rt.services.log.warn({ conn: conn.id, err: err instanceof Error ? err.name : 'error' }, 'peer message not queued')
    return json(503, { error: 'unavailable', retry_after_s: 30 }) // the sender retries; nothing was recorded
  }
  return json(200, { ok: true })
}
