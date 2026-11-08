// Persistence for the relay core: the replay buffer (events), the bridge outbox, seen ids, cards, thread and status
// rows, message meta (receipts, transcripts), read cursors, media rows, push subscriptions and small state.
// Everything that can carry content is encrypted with the CryptoService (AAD = table:id).
import { createHash, randomBytes } from 'node:crypto'
import {
  type AgentConfigT,
  type ApnsEnvT,
  AppCsp,
  type AppCspT,
  type CardT,
  NATIVE_ACT_TYPE,
  ownValue,
  type ThreadStatusT,
  type ThreadT,
} from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import type { Clock, CryptoService } from '../services.ts'
import { openJson, sealJson } from './crypto.ts'

export type Audience = 'app' | 'bridge' | 'both'
export type StoredFrame = Record<string, unknown> & {
  type: string
  id: string
  relay: { seq: number; received_at: string }
}
export type OutboxRow = {
  frame_id: string
  seq: number
  type: string
  consumable: number
  delivered: number
  attempts: number
  next_try_at: number
  created_at: number
  expires_at: number
}
export type MediaRow = {
  media_id: string
  mime: string
  name: string
  size: number
  sha256: string
  kind: string
  origin: 'app' | 'bridge'
  duration_ms: number | null
  evicted: number
  created_at: number
  /** The approved CSP of an MCP app page (AP2); null for every other file, and for a stored value that no longer parses. */
  app_csp: AppCspT | null
}
export type PushDevice = { deviceId: string; token: string; env: ApnsEnvT }
export type NativeGrantRow = { deviceId: string; encPub: string; actPub: string; grantJson: string; exp: number }
export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } }

/** How long a media row flagged evicted stays (so the app can still rehydrate it from the Mac). */
const EVICTED_MEDIA_ROW_MS = 90 * 86_400_000

/**
 * Owner frames that wait for the Mac (D38): everything stored for both sides, and the owner's own content that is
 * bridge-only: a share, and a Reply or Approve tapped on a notification (`native.act`).
 */
const OWNER_FRAME_SQL = "(e.audience = 'both' or (e.audience = 'bridge' and o.type in ('share.item', 'native.act')))"

const WORK_FRAME_SQL = "'hook.event', 'hook.digest'"

export class Store {
  constructor(
    readonly db: Database.Database,
    private crypto: CryptoService,
    private clock: Clock,
  ) {}

  // ---- events (the replay buffer) ------------------------------------------------------------------------------

  /** Stamps `frame` with the next seq, stores it encrypted and returns the stamped frame (a copy). */
  appendEvent(args: {
    frame: Record<string, unknown>
    audience: Audience
    threadId?: string | undefined
    countsUnread?: boolean
  }): StoredFrame {
    const now = this.clock.now()
    const frameId = String(args.frame.id)
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          "insert into core_events (frame_id, type, thread_id, audience, counts_unread, body, created_at) values (?, ?, ?, ?, ?, x'00', ?)",
        )
        .run(frameId, String(args.frame.type), args.threadId ?? null, args.audience, args.countsUnread ? 1 : 0, now)
      const seq = Number(info.lastInsertRowid)
      const stamped = { ...args.frame, relay: { seq, received_at: new Date(now).toISOString() } } as StoredFrame
      this.db
        .prepare('update core_events set body = ? where seq = ?')
        .run(sealJson(this.crypto, stamped, `core_events:${frameId}`), seq)
      return stamped
    })
    return tx()
  }

  private openEvent(row: { frame_id: string; body: Buffer }): StoredFrame {
    return openJson<StoredFrame>(this.crypto, row.body, `core_events:${row.frame_id}`)
  }

  getEventBySeq(seq: number): StoredFrame | null {
    const row = this.db.prepare('select frame_id, body from core_events where seq = ?').get(seq) as
      | { frame_id: string; body: Buffer }
      | undefined
    return row ? this.openEvent(row) : null
  }

  getEventByFrameId(frameId: string): (StoredFrame & { _thread: string | null }) | null {
    const row = this.db.prepare('select frame_id, body, thread_id from core_events where frame_id = ?').get(frameId) as
      | { frame_id: string; body: Buffer; thread_id: string | null }
      | undefined
    return row ? { ...this.openEvent(row), _thread: row.thread_id } : null
  }

  /** App-visible frames with seq > since, ascending. */
  appEventsAfter(since: number, limit: number): StoredFrame[] {
    const rows = this.db
      .prepare(
        "select frame_id, body from core_events where seq > ? and audience in ('app', 'both') order by seq limit ?",
      )
      .all(since, limit) as Array<{ frame_id: string; body: Buffer }>
    return rows.map((r) => this.openEvent(r))
  }

  countAppEventsAfter(since: number): number {
    return (
      this.db
        .prepare("select count(*) n from core_events where seq > ? and audience in ('app', 'both')")
        .get(since) as {
        n: number
      }
    ).n
  }

  maxSeq(): number {
    return (
      (
        this.db.prepare('select coalesce(max(seq), 0) m from sqlite_sequence where name = ?').get('core_events') as
          | { m: number }
          | undefined
      )?.m ?? 0
    )
  }

  /** Lowest seq the buffer still holds, or null when nothing was ever pruned. */
  floor(): number | null {
    const v = this.getState('floor')
    return v === null ? null : Number(v)
  }

  /** Events of a thread that form chat history, newest first. */
  threadEvents(threadId: string, beforeSeq: number | null, limit: number): StoredFrame[] {
    const rows = this.db
      .prepare(
        `select frame_id, body from core_events
         where thread_id = ? and seq < ? and type in ('message', 'voice_note', 'reply', 'message.stored')
         order by seq desc limit ?`,
      )
      .all(threadId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as Array<{ frame_id: string; body: Buffer }>
    return rows.map((r) => this.openEvent(r))
  }

  unreadByThread(): Record<string, number> {
    const rows = this.db
      .prepare(
        `select e.thread_id t, count(*) n from core_events e
         left join core_read r on r.thread_id = e.thread_id
         where e.counts_unread = 1 and e.seq > coalesce(r.up_to_seq, 0) and e.thread_id is not null
         group by e.thread_id`,
      )
      .all() as Array<{ t: string; n: number }>
    const out: Record<string, number> = Object.fromEntries(rows.map((r) => [r.t, r.n]))
    // A thread the owner marked unread whose counting rows have all left the buffer still reads as one unread.
    for (const t of this.manualUnread()) out[t] = Math.max(ownValue(out, t) ?? 0, 1)
    return out
  }

  /** Threads the owner marked unread by hand (D36). Cleared by the next `thread.read`. */
  manualUnread(): string[] {
    const rows = this.db.prepare("select key from core_state where key like 'manual_unread:%'").all() as Array<{
      key: string
    }>
    return rows.map((r) => r.key.slice('manual_unread:'.length))
  }

  /**
   * Mark unread (D36). `setRead` only ever rises, so this is the one place the read mark goes DOWN: to just under the
   * thread's newest counting row, so exactly that row reads as unread. When no counting row is left (they aged out of the
   * 7-day buffer) there is nothing to put the mark under, so a manual flag stands in for it: the thread reads as one
   * unread until the next `thread.read`. Returns the new mark (absent for the flag case) and the thread's unread count.
   */
  markUnread(threadId: string): { up_to_seq?: number; count: number } {
    const tx = this.db.transaction(() => {
      const last = this.db
        .prepare('select max(seq) m from core_events where thread_id = ? and counts_unread = 1')
        .get(threadId) as { m: number | null }
      if (last.m === null) {
        this.setState(`manual_unread:${threadId}`, '1')
        return { count: Math.max(ownValue(this.unreadByThread(), threadId) ?? 0, 1) }
      }
      this.db.prepare('delete from core_state where key = ?').run(`manual_unread:${threadId}`)
      const mark = last.m - 1
      this.db
        .prepare(
          'insert into core_read (thread_id, up_to_seq) values (?, ?) on conflict(thread_id) do update set up_to_seq = excluded.up_to_seq',
        )
        .run(threadId, mark)
      return { up_to_seq: mark, count: ownValue(this.unreadByThread(), threadId) ?? 1 }
    })
    return tx()
  }

  /** Each thread's read mark (the highest `thread.read` up_to_seq seen). */
  readByThread(): Record<string, number> {
    const rows = this.db.prepare('select thread_id t, up_to_seq n from core_read').all() as Array<{
      t: string
      n: number
    }>
    return Object.fromEntries(rows.map((r) => [r.t, r.n]))
  }

  lastEventAtByThread(): Record<string, number> {
    const rows = this.db
      .prepare(
        "select thread_id t, max(created_at) at from core_events where thread_id is not null and audience in ('app','both') group by thread_id",
      )
      .all() as Array<{ t: string; at: number }>
    return Object.fromEntries(rows.map((r) => [r.t, r.at]))
  }

  // ---- seen ids -------------------------------------------------------------------------------------------------

  seen(key: string): number | undefined {
    const r = this.db.prepare('select seq from core_dedup where key = ?').get(key) as { seq: number } | undefined
    return r?.seq
  }
  remember(key: string, seq: number): void {
    this.db
      .prepare('insert or replace into core_dedup (key, seq, created_at) values (?, ?, ?)')
      .run(key, seq, this.clock.now())
  }

  /** A seq-less seen id (schedule frames are never stored, so there is no seq to remember). 0 is not a real seq. */
  rememberSeen(key: string): void {
    this.remember(key, 0)
  }
  /** When a seen id was written (ms), for "once per 24 h" rules. */
  seenAt(key: string): number | undefined {
    const r = this.db.prepare('select created_at from core_dedup where key = ?').get(key) as
      | { created_at: number }
      | undefined
    return r?.created_at
  }

  // ---- bridge outbox ----------------------------------------------------------------------------------------------

  enqueueOutbox(args: { frameId: string; seq: number; type: string; consumable: boolean; ttlMs: number }): void {
    const now = this.clock.now()
    this.db
      .prepare(
        'insert or replace into core_outbox (frame_id, seq, type, consumable, delivered, attempts, next_try_at, created_at, expires_at) values (?, ?, ?, ?, 0, 0, ?, ?, ?)',
      )
      .run(args.frameId, args.seq, args.type, args.consumable ? 1 : 0, now + 5_000, now, now + args.ttlMs)
  }

  outboxRow(frameId: string): OutboxRow | undefined {
    return this.db.prepare('select * from core_outbox where frame_id = ?').get(frameId) as OutboxRow | undefined
  }

  /** Frames to (re)send on a bridge hello: everything not consumed, in seq order. */
  outboxAll(): Array<OutboxRow & { frame: StoredFrame }> {
    const rows = this.db
      .prepare(
        `select o.*, e.body, e.frame_id fid from core_outbox o join core_events e on e.seq = o.seq
         where o.expires_at > ? order by o.seq`,
      )
      .all(this.clock.now()) as Array<OutboxRow & { body: Buffer; fid: string }>
    return rows.map((r) => ({ ...r, frame: this.openEvent({ frame_id: r.fid, body: r.body }) }))
  }

  /** Not-yet-delivered frames whose retry time has come. */
  outboxDue(now: number): Array<OutboxRow & { frame: StoredFrame }> {
    const rows = this.db
      .prepare(
        `select o.*, e.body, e.frame_id fid from core_outbox o join core_events e on e.seq = o.seq
         where o.delivered = 0 and o.next_try_at <= ? and o.expires_at > ? order by o.seq`,
      )
      .all(now, now) as Array<OutboxRow & { body: Buffer; fid: string }>
    return rows.map((r) => ({ ...r, frame: this.openEvent({ frame_id: r.fid, body: r.body }) }))
  }

  /**
   * Owner frames (a message, a voice note, a card decision, a settings change) the Mac never took that the next sweep is
   * about to delete: the same test `sweep` applies. Short-lived frames (hooks, session control, device notices) are
   * `audience = 'bridge'` and never listed. The one bridge-audience frame that is the owner's own content is `share.item`
   * (a share he made, queued for the Mac for the full buffer); its message row already says Sent, so it is listed too.
   *
   * A row the Mac acked `delivered` but never `consumed` (it took the frame, then died before pushing it into Claude) stays
   * in the outbox until the end of the buffer. It is listed only when `withTaken` is true, which the caller sets once the
   * bridge is known to ack in two stages: a bridge that only ever says `delivered` has handled such a frame already.
   */
  undeliveredOwnerDue(
    bufferMs: number,
    withTaken = false,
  ): Array<{ frame_id: string; type: string; thread_id: string | null; body: StoredFrame; taken: boolean }> {
    const now = this.clock.now()
    const rows = this.db
      .prepare(
        `select o.frame_id, o.type, o.delivered, e.thread_id, e.body from core_outbox o join core_events e on e.seq = o.seq
         where (o.delivered = 0 or ?) and ${OWNER_FRAME_SQL} and (o.expires_at <= ? or e.created_at < ?) order by o.seq`,
      )
      .all(withTaken ? 1 : 0, now, now - bufferMs) as Array<{
      frame_id: string
      type: string
      delivered: number
      thread_id: string | null
      body: Buffer
    }>
    const out: Array<{ frame_id: string; type: string; thread_id: string | null; body: StoredFrame; taken: boolean }> =
      []
    for (const r of rows) {
      // A row that no longer decrypts cannot be reported, and must not stop the sweep that deletes it.
      try {
        out.push({
          frame_id: r.frame_id,
          type: r.type,
          thread_id: r.thread_id,
          body: this.openEvent({ frame_id: r.frame_id, body: r.body }),
          taken: r.delivered === 1,
        })
      } catch {
        // skipped: store.sweep still removes it
      }
    }
    return out
  }

  /**
   * Created-at (ms) of the oldest owner frame still waiting for the Mac, or null. Drives the day-6 warning. `withTaken` is
   * the same switch as in `undeliveredOwnerDue`: also count a frame the Mac took but has not pushed into Claude. `skip`
   * leaves out frames that are not really waiting (a card decision whose card the Mac did decide).
   */
  oldestUndeliveredOwner(withTaken = false, skip?: (type: string, body: StoredFrame) => boolean): number | null {
    const rows = this.db
      .prepare(
        `select o.created_at, o.type, o.frame_id, e.body from core_outbox o join core_events e on e.seq = o.seq
         where (o.delivered = 0 or ?) and ${OWNER_FRAME_SQL} and o.expires_at > ? order by o.created_at`,
      )
      .all(withTaken ? 1 : 0, this.clock.now()) as Array<{
      created_at: number
      type: string
      frame_id: string
      body: Buffer
    }>
    for (const r of rows) {
      // `skip` names a frame that is not really waiting. A row that no longer opens still counts as waiting.
      try {
        if (skip?.(r.type, this.openEvent({ frame_id: r.frame_id, body: r.body }))) continue
      } catch {}
      return r.created_at
    }
    return null
  }

  touchOutbox(frameId: string, nextTryAt: number): void {
    this.db
      .prepare('update core_outbox set attempts = attempts + 1, next_try_at = ? where frame_id = ?')
      .run(nextTryAt, frameId)
  }
  markDelivered(frameId: string): void {
    this.db.prepare('update core_outbox set delivered = 1 where frame_id = ?').run(frameId)
  }
  dropOutbox(frameId: string): void {
    this.db.prepare('delete from core_outbox where frame_id = ?').run(frameId)
  }
  /**
   * Work-content frames (`hook.event`, `hook.digest`) carry a title, summary and sender, and only the Mac needs them. Once the
   * Mac has pushed one into Claude (`consumed`) nothing reads it again, so the relay does not keep its sealed copy for the
   * buffer: the outbox row is gone by then and no app catch-up lists a bridge-only frame.
   */
  dropWorkFrame(frameId: string): void {
    this.db.prepare(`delete from core_events where frame_id = ? and type in (${WORK_FRAME_SQL})`).run(frameId)
  }
  outboxDepth(): number {
    return (
      this.db
        .prepare("select count(*) n from core_outbox where expires_at > ? and type != 'problem.item'")
        .get(this.clock.now()) as { n: number }
    ).n
  }
  /** Replaces a stored frame's body (used when a hook.event is re-marked `backlog`). */
  rewriteEvent(frame: StoredFrame): void {
    this.db
      .prepare('update core_events set body = ? where seq = ?')
      .run(sealJson(this.crypto, frame, `core_events:${frame.id}`), frame.relay.seq)
  }

  // ---- cards ------------------------------------------------------------------------------------------------------

  putCard(card: CardT): void {
    this.db
      .prepare(
        `insert into core_cards (card_id, thread_id, state, risk, payload_hash, expires_at, card, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(card_id) do update set thread_id = excluded.thread_id, state = excluded.state, risk = excluded.risk,
           payload_hash = excluded.payload_hash, expires_at = excluded.expires_at, card = excluded.card`,
      )
      .run(
        card.id,
        card.thread_id,
        card.state,
        card.risk,
        card.payload_hash,
        Date.parse(card.expires_at),
        sealJson(this.crypto, card, `core_cards:${card.id}`),
        this.clock.now(),
      )
  }
  getCard(id: string): CardT | null {
    const r = this.db.prepare('select card from core_cards where card_id = ?').get(id) as { card: Buffer } | undefined
    return r ? openJson<CardT>(this.crypto, r.card, `core_cards:${id}`) : null
  }
  setCardState(id: string, patch: Partial<Pick<CardT, 'state' | 'resolution' | 'result' | 'explain'>>): CardT | null {
    const card = this.getCard(id)
    if (!card) return null
    const next = { ...card, ...patch } as CardT
    this.putCard(next)
    return next
  }
  openCards(now: number): CardT[] {
    const rows = this.db
      .prepare("select card_id id, card from core_cards where state = 'pending' and expires_at > ? order by created_at")
      .all(now) as Array<{ id: string; card: Buffer }>
    return rows.map((r) => openJson<CardT>(this.crypto, r.card, `core_cards:${r.id}`))
  }
  pendingCardsExpiringBy(ts: number): Array<{ id: string; expires_at: number }> {
    return this.db
      .prepare("select card_id id, expires_at from core_cards where state = 'pending' and expires_at <= ?")
      .all(ts) as Array<{ id: string; expires_at: number }>
  }
  allPendingCards(): Array<{ id: string; expires_at: number }> {
    return this.db.prepare("select card_id id, expires_at from core_cards where state = 'pending'").all() as Array<{
      id: string
      expires_at: number
    }>
  }

  // ---- threads, status, meta, read cursors ----------------------------------------------------------------------

  upsertThread(thread: ThreadT): void {
    this.db
      .prepare('insert or replace into core_threads (thread_id, thread, archived, updated_at) values (?, ?, ?, ?)')
      .run(
        thread.id,
        sealJson(this.crypto, thread, `core_threads:${thread.id}`),
        thread.archived ? 1 : 0,
        this.clock.now(),
      )
  }
  archiveThread(id: string): void {
    const t = this.listThreads().find((x) => x.id === id)
    if (t) this.upsertThread({ ...t, archived: true })
  }
  listThreads(): ThreadT[] {
    const rows = this.db.prepare('select thread_id id, thread from core_threads').all() as Array<{
      id: string
      thread: Buffer
    }>
    return rows.map((r) => openJson<ThreadT>(this.crypto, r.thread, `core_threads:${r.id}`))
  }

  setStatus(s: ThreadStatusT, derived = false): void {
    this.db
      .prepare('insert or replace into core_status (thread_id, state, label, since, derived) values (?, ?, ?, ?, ?)')
      .run(
        s.thread_id,
        s.state,
        s.label ? sealJson(this.crypto, s.label, `core_status:${s.thread_id}`) : null,
        Date.parse(s.since),
        derived ? 1 : 0,
      )
  }
  getStatus(threadId: string): (ThreadStatusT & { derived: boolean }) | null {
    const r = this.db.prepare('select * from core_status where thread_id = ?').get(threadId) as
      | { thread_id: string; state: ThreadStatusT['state']; label: Buffer | null; since: number; derived: number }
      | undefined
    return r ? this.rowStatus(r) : null
  }
  allStatuses(): ThreadStatusT[] {
    const rows = this.db.prepare('select * from core_status').all() as Array<{
      thread_id: string
      state: ThreadStatusT['state']
      label: Buffer | null
      since: number
      derived: number
    }>
    return rows.map((r) => {
      const { derived: _d, ...s } = this.rowStatus(r)
      return s
    })
  }
  private rowStatus(r: {
    thread_id: string
    state: ThreadStatusT['state']
    label: Buffer | null
    since: number
    derived: number
  }) {
    return {
      thread_id: r.thread_id,
      state: r.state,
      ...(r.label ? { label: openJson<string>(this.crypto, r.label, `core_status:${r.thread_id}`) } : {}),
      since: new Date(r.since).toISOString(),
      derived: Boolean(r.derived),
    }
  }

  setReceipt(messageId: string, receipt: 'delivered' | 'seen' | 'not_delivered', threadId?: string): void {
    this.db
      .prepare(
        `insert into core_message_meta (message_id, thread_id, receipt, updated_at) values (?, ?, ?, ?)
         on conflict(message_id) do update set receipt = excluded.receipt, updated_at = excluded.updated_at,
           thread_id = coalesce(core_message_meta.thread_id, excluded.thread_id)`,
      )
      .run(messageId, threadId ?? null, receipt, this.clock.now())
  }
  setTranscript(messageId: string, transcript: { text: string; engine: string; status: string }): void {
    this.db
      .prepare(
        `insert into core_message_meta (message_id, transcript, updated_at) values (?, ?, ?)
         on conflict(message_id) do update set transcript = excluded.transcript, updated_at = excluded.updated_at`,
      )
      .run(messageId, sealJson(this.crypto, transcript, `core_message_meta:${messageId}`), this.clock.now())
  }
  getMeta(messageId: string): {
    receipt?: 'delivered' | 'seen' | 'not_delivered'
    transcript?: { text: string; engine: string; status: 'pending' | 'done' | 'failed' }
  } {
    const r = this.db
      .prepare('select receipt, transcript from core_message_meta where message_id = ?')
      .get(messageId) as
      | { receipt: 'delivered' | 'seen' | 'not_delivered' | null; transcript: Buffer | null }
      | undefined
    if (!r) return {}
    return {
      ...(r.receipt ? { receipt: r.receipt } : {}),
      ...(r.transcript ? { transcript: openJson(this.crypto, r.transcript, `core_message_meta:${messageId}`) } : {}),
    }
  }

  setRead(threadId: string, upToSeq: number): void {
    this.db.prepare('delete from core_state where key = ?').run(`manual_unread:${threadId}`)
    this.db
      .prepare(
        'insert into core_read (thread_id, up_to_seq) values (?, ?) on conflict(thread_id) do update set up_to_seq = max(up_to_seq, excluded.up_to_seq)',
      )
      .run(threadId, upToSeq)
  }

  /** Messages the relay gave up on (D38): sent on `ready`, so a device that was away still learns. */
  notDelivered(): string[] {
    const rows = this.db
      .prepare(
        "select message_id from core_message_meta where receipt = 'not_delivered' order by updated_at desc limit 200",
      )
      .all() as Array<{ message_id: string }>
    return rows.map((r) => r.message_id)
  }

  // ---- state ------------------------------------------------------------------------------------------------------

  getState(key: string): string | null {
    const r = this.db.prepare('select value from core_state where key = ?').get(key) as { value: Buffer } | undefined
    return r ? r.value.toString('utf8') : null
  }
  setState(key: string, value: string): void {
    this.db.prepare('insert or replace into core_state (key, value) values (?, ?)').run(key, Buffer.from(value))
  }
  deleteState(key: string): void {
    this.db.prepare('delete from core_state where key = ?').run(key)
  }
  /** Every state key that starts with `prefix` (a plain prefix, not a LIKE pattern). */
  stateKeys(prefix: string): string[] {
    const rows = this.db
      .prepare('select key from core_state where substr(key, 1, ?) = ?')
      .all(prefix.length, prefix) as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  getConfig(): AgentConfigT | null {
    const r = this.db.prepare("select value from core_state where key = 'config'").get() as
      | { value: Buffer }
      | undefined
    return r ? openJson<AgentConfigT>(this.crypto, r.value, 'core_state:config') : null
  }
  setConfig(config: AgentConfigT): void {
    this.db
      .prepare("insert or replace into core_state (key, value) values ('config', ?)")
      .run(sealJson(this.crypto, config, 'core_state:config'))
  }

  // ---- media rows -------------------------------------------------------------------------------------------------

  putMediaRow(
    r: Omit<MediaRow, 'created_at' | 'evicted' | 'app_csp'> & { created_at?: number; app_csp?: AppCspT | null },
  ): void {
    this.db
      .prepare(
        'insert or replace into core_media (media_id, mime, name, size, sha256, kind, origin, duration_ms, evicted, created_at, app_csp) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(
        r.media_id,
        r.mime,
        sealJson(this.crypto, r.name, `core_media:${r.media_id}`),
        r.size,
        r.sha256,
        r.kind,
        r.origin,
        r.duration_ms,
        r.created_at ?? this.clock.now(),
        r.app_csp ? sealJson(this.crypto, r.app_csp, `core_media_csp:${r.media_id}`) : null,
      )
  }
  getMediaRow(id: string): MediaRow | undefined {
    const row = this.db.prepare('select * from core_media where media_id = ?').get(id) as
      | (Omit<MediaRow, 'name' | 'app_csp'> & { name: Buffer; app_csp: Buffer | null })
      | undefined
    if (!row) return undefined
    return {
      ...row,
      name: openJson<string>(this.crypto, row.name, `core_media:${id}`),
      app_csp: this.openAppCsp(id, row.app_csp),
    }
  }
  /** Fails closed: a value that will not open or no longer passes the strict schema reads as "not an app page". */
  private openAppCsp(id: string, blob: Buffer | null): AppCspT | null {
    if (!blob) return null
    try {
      const parsed = AppCsp.safeParse(openJson<unknown>(this.crypto, blob, `core_media_csp:${id}`))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  uploadedBytesSince(since: number): number {
    return (
      this.db
        .prepare("select coalesce(sum(size), 0) s from core_media where origin = 'app' and created_at >= ?")
        .get(since) as { s: number }
    ).s
  }
  totalMediaBytes(): number {
    return (this.db.prepare('select coalesce(sum(size), 0) s from core_media where evicted = 0').get() as { s: number })
      .s
  }

  // ---- push subscriptions -----------------------------------------------------------------------------------------

  /**
   * `deviceId` is the device whose session subscribed: revoking or signing out that device deletes the row. When a device
   * is named, the row is written only while that device is still pinned and not revoked, in the same statement, so a
   * revoke that lands while the request body was still arriving cannot leave a row behind. Returns false when refused.
   */
  putSub(sub: PushSub, deviceId: string | null = null): boolean {
    const sealed = sealJson(this.crypto, sub, `core_push_subs:${sub.endpoint}`)
    const at = this.clock.now()
    if (deviceId === null) {
      this.db
        .prepare('insert or replace into core_push_subs (endpoint, sub, created_at, device_id) values (?, ?, ?, null)')
        .run(sub.endpoint, sealed, at)
      return true
    }
    return (
      this.db
        .prepare(
          `insert or replace into core_push_subs (endpoint, sub, created_at, device_id)
           select ?, ?, ?, id from auth_devices where id = ? and pinned = 1 and revoked = 0`,
        )
        .run(sub.endpoint, sealed, at, deviceId).changes > 0
    )
  }
  deleteSub(endpoint: string): void {
    this.db.prepare('delete from core_push_subs where endpoint = ?').run(endpoint)
  }
  /**
   * Every readable subscription. A row that no longer decrypts is skipped and reported through `onUnreadable` (its
   * endpoint) so one bad row cannot stop the rest; without a callback it throws, as before. A row that belongs to a
   * device is listed only while that device is pinned and not revoked, so a declined browser gets no pushes.
   */
  listSubs(onUnreadable?: (endpoint: string) => void): PushSub[] {
    const rows = this.db
      .prepare(
        `select s.endpoint, s.sub from core_push_subs s left join auth_devices d on d.id = s.device_id
         where s.device_id is null or (d.pinned = 1 and d.revoked = 0) order by s.created_at`,
      )
      .all() as Array<{
      endpoint: string
      sub: Buffer
    }>
    const out: PushSub[] = []
    for (const r of rows) {
      try {
        out.push(openJson<PushSub>(this.crypto, r.sub, `core_push_subs:${r.endpoint}`))
      } catch (e) {
        if (!onUnreadable) throw e
        onUnreadable(r.endpoint)
      }
    }
    return out
  }

  // ---- native push devices (APNs) ---------------------------------------------------------------------------------

  /** Registers (or replaces) the device's APNs token. A device has one token; a token belongs to one device. */
  putPushDevice(d: { deviceId: string; token: string; env: ApnsEnvT }): void {
    const hash = createHash('sha256').update(d.token).digest('hex')
    this.db.transaction(() => {
      this.db.prepare('delete from core_push_devices where device_id = ? or token_hash = ?').run(d.deviceId, hash)
      this.db
        .prepare(
          'insert into core_push_devices (token_hash, device_id, env, sealed, created_at) values (?, ?, ?, ?, ?)',
        )
        .run(
          hash,
          d.deviceId,
          d.env,
          sealJson(this.crypto, { token: d.token }, `core_push_devices:${hash}`),
          this.clock.now(),
        )
    })()
  }
  deletePushDeviceByDevice(deviceId: string): void {
    this.db.prepare('delete from core_push_devices where device_id = ?').run(deviceId)
  }
  deletePushDeviceByToken(token: string): void {
    this.db
      .prepare('delete from core_push_devices where token_hash = ?')
      .run(createHash('sha256').update(token).digest('hex'))
  }
  hasPushDevice(deviceId: string): boolean {
    return Boolean(this.db.prepare('select 1 from core_push_devices where device_id = ?').get(deviceId))
  }
  /** True while the device is pinned, not revoked and still has a push token: asked again right before each send. */
  pushDeviceLive(deviceId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `select 1 from core_push_devices p join auth_devices d on d.id = p.device_id and d.pinned = 1 and d.revoked = 0
           where p.device_id = ?`,
        )
        .get(deviceId),
    )
  }
  // ---- rich notifications (core_native_grants, core_native_acts) ----------------------------------------------------

  putNativeGrant(g: NativeGrantRow): void {
    this.db
      .prepare(
        `insert into core_native_grants (device_id, enc_pub, act_pub, grant_json, exp, created_at) values (?, ?, ?, ?, ?, ?)
         on conflict(device_id) do update set enc_pub = excluded.enc_pub, act_pub = excluded.act_pub,
           grant_json = excluded.grant_json, exp = excluded.exp, created_at = excluded.created_at`,
      )
      .run(g.deviceId, g.encPub, g.actPub, g.grantJson, g.exp, this.clock.now())
  }
  deleteNativeGrant(deviceId: string): void {
    this.db.prepare('delete from core_native_grants where device_id = ?').run(deviceId)
  }
  /** The grant of a device the Mac still trusts, and only while it has not run out. */
  nativeGrant(deviceId: string): NativeGrantRow | null {
    const r = this.db
      .prepare(
        `select g.device_id, g.enc_pub, g.act_pub, g.grant_json, g.exp from core_native_grants g
         join auth_devices d on d.id = g.device_id and d.pinned = 1 and d.revoked = 0
         where g.device_id = ? and g.exp > ?`,
      )
      .get(deviceId, this.clock.now()) as
      | { device_id: string; enc_pub: string; act_pub: string; grant_json: string; exp: number }
      | undefined
    return r
      ? { deviceId: r.device_id, encPub: r.enc_pub, actPub: r.act_pub, grantJson: r.grant_json, exp: r.exp }
      : null
  }
  /**
   * Claims a native action id. `new` the first time; `same` for a retry of the same signed bytes; `conflict` for the same
   * id with different bytes. One statement decides it, so two requests at once cannot both be `new`.
   */
  claimNativeAct(deviceId: string, actId: string, bodyHash: string, ttlMs: number): 'new' | 'same' | 'conflict' {
    const now = this.clock.now()
    this.db.prepare('delete from core_native_acts where expires_at <= ?').run(now)
    const key = `${deviceId}:${actId}`
    const ins = this.db
      .prepare('insert or ignore into core_native_acts (act_key, body_hash, seq, expires_at) values (?, ?, 0, ?)')
      .run(key, bodyHash, now + ttlMs)
    if (ins.changes === 1) return 'new'
    const row = this.db.prepare('select body_hash from core_native_acts where act_key = ?').get(key) as
      | { body_hash: string }
      | undefined
    return row?.body_hash === bodyHash ? 'same' : 'conflict'
  }
  /**
   * Tokens of devices the Mac still trusts: a revoked or un-pinned device gets nothing. A row that no longer decrypts
   * throws, unless the caller passes `onUnreadable`: then that row is skipped and reported, so one bad row does not hide
   * the good devices (the caller must count it as a failed send).
   */
  listPushDevices(onUnreadable?: (deviceId: string) => void): PushDevice[] {
    const rows = this.db
      .prepare(
        `select p.token_hash, p.device_id, p.env, p.sealed from core_push_devices p
         join auth_devices d on d.id = p.device_id and d.pinned = 1 and d.revoked = 0
         order by p.created_at`,
      )
      .all() as Array<{ token_hash: string; device_id: string; env: ApnsEnvT; sealed: Buffer }>
    const out: PushDevice[] = []
    for (const r of rows) {
      try {
        out.push({
          deviceId: r.device_id,
          env: r.env,
          token: openJson<{ token: string }>(this.crypto, r.sealed, `core_push_devices:${r.token_hash}`).token,
        })
      } catch (e) {
        if (!onUnreadable) throw e
        onUnreadable(r.device_id)
      }
    }
    return out
  }

  /** The opaque reference for a thread (stable, minted on first use): what an APNs payload carries instead of the thread id. */
  pushRef(threadId: string): string {
    const have = this.db.prepare('select ref from core_push_refs where thread_id = ?').get(threadId) as
      | { ref: string }
      | undefined
    if (have) return have.ref
    const ref = `r_${randomBytes(12).toString('base64url')}`
    this.db
      .prepare('insert or ignore into core_push_refs (thread_id, ref, created_at) values (?, ?, ?)')
      .run(threadId, ref, this.clock.now())
    return (this.db.prepare('select ref from core_push_refs where thread_id = ?').get(threadId) as { ref: string }).ref
  }
  threadForPushRef(ref: string): string | null {
    const row = this.db.prepare('select thread_id from core_push_refs where ref = ?').get(ref) as
      | { thread_id: string }
      | undefined
    return row?.thread_id ?? null
  }

  // ---- retention --------------------------------------------------------------------------------------------------

  /**
   * Deletes everything older than the buffer window. Returns the media ids whose files must be removed. Seen ids live
   * 8 days (spec 3.4), at least as long as the buffer.
   */
  sweep(args: {
    bufferMs: number
    dedupMs: number
    /** The card an owner frame decides, if it decides one. A decided card is kept while such a frame is still queued. */
    decisionCard?: (type: string, body: StoredFrame) => string | undefined
  }): { mediaIds: string[]; events: number } {
    const now = this.clock.now()
    const cutoff = now - args.bufferMs
    const tx = this.db.transaction(() => {
      const ev = this.db.prepare('delete from core_events where created_at < ?').run(cutoff)
      if (ev.changes > 0) {
        const min = (this.db.prepare('select min(seq) m from core_events').get() as { m: number | null }).m
        this.setState('floor', String(min ?? this.maxSeq() + 1))
      }
      // A work frame the Mac never took within its own lifetime (an hour for pass-through) goes with its outbox row.
      this.db
        .prepare(
          `delete from core_events where type in (${WORK_FRAME_SQL}) and seq in (select seq from core_outbox where expires_at <= ?)`,
        )
        .run(now)
      this.db
        .prepare('delete from core_outbox where expires_at <= ? or seq not in (select seq from core_events)')
        .run(now)
      this.db.prepare('delete from core_dedup where created_at < ?').run(now - args.dedupMs)
      // The report of a lost card decision comes 7 days after the decision, which can be well after the card was made, and
      // it reads the card to see whether the Mac did decide it: so a card stays while a decision about it is still queued.
      const held = new Set<string>()
      if (args.decisionCard) {
        const queued = this.db
          .prepare(
            `select o.frame_id, o.type, e.body from core_outbox o join core_events e on e.seq = o.seq
             where o.type in ('card.resolve', ?) and ${OWNER_FRAME_SQL}`,
          )
          .all(NATIVE_ACT_TYPE) as Array<{ frame_id: string; type: string; body: Buffer }>
        for (const q of queued) {
          try {
            const id = args.decisionCard(q.type, this.openEvent({ frame_id: q.frame_id, body: q.body }))
            if (id) held.add(id)
          } catch {} // a row that no longer opens decides nothing here
        }
      }
      this.db
        .prepare(
          "delete from core_cards where state != 'pending' and created_at < ? and card_id not in (select value from json_each(?))",
        )
        .run(cutoff, JSON.stringify([...held]))
      this.db.prepare('delete from core_message_meta where updated_at < ?').run(cutoff)
      const old = this.db
        .prepare('select media_id from core_media where created_at < ? and evicted = 0')
        .all(cutoff) as Array<{
        media_id: string
      }>
      this.db.prepare('update core_media set evicted = 1 where created_at < ? and evicted = 0').run(cutoff)
      // An evicted row only exists so the app can ask the Mac for the bytes back; after 90 days it is just clutter.
      this.db.prepare('delete from core_media where evicted = 1 and created_at < ?').run(now - EVICTED_MEDIA_ROW_MS)
      return { mediaIds: old.map((m) => m.media_id), events: ev.changes }
    })
    return tx()
  }
}
