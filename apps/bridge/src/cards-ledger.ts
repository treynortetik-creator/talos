// The Mac is the card authority (spec 4.5). The ledger holds the binding the agent created; `card.resolve` is checked
// against it in a fixed order, and only then does the agent hear about it. The hash binds what the owner saw to what the
// agent is told; it cannot force the agent's later tool calls to match, which is what approved/<id>.json is for.
import {
  applyCardEdits,
  bindingFrom,
  type CardActionT,
  type CardBinding,
  type CardT,
  checkEditAllowed,
  type ErrorCodeT,
  editedHash,
  isBridgeHandledCardKind,
  payloadHash,
} from '@talos-app/protocol'
import type { HistoryStore } from './history-store.ts'

export const MAX_RESOLVE_AGE_MS = 10 * 60_000

export type LedgerRow = {
  id: string
  thread_id: string
  binding: CardBinding
  payload_hash: string
  state: CardT['state']
  origin: string
  risk: string
  created_at: string
  expires_at: string
  resolved_at: string | null
  resolution: ResolutionRecord | null
  /** Who minted the card. Only `bridge` rows (schedule cards) are applied by the bridge itself (S3.4); `agent` is the default. */
  actor: CardActor
}

export type CardActor = 'agent' | 'bridge'

export type ResolutionRecord = {
  action: CardActionT
  at: string
  edited: boolean
  payload_hash: string
  note?: string
  /** The Mac's own clock when it took the decision; `at` is the owner's signed tap. */
  taken_at?: string
  /** Which device took the decision, for cards that say so (dialog cards). */
  by?: string
}

type RawRow = Omit<LedgerRow, 'binding' | 'resolution' | 'actor'> & {
  binding_json: string
  resolution_json: string | null
  actor: string
}

const toRow = (r: RawRow): LedgerRow => ({
  id: r.id,
  thread_id: r.thread_id,
  binding: JSON.parse(r.binding_json) as CardBinding,
  payload_hash: r.payload_hash,
  state: r.state,
  origin: r.origin,
  risk: r.risk,
  created_at: r.created_at,
  expires_at: r.expires_at,
  resolved_at: r.resolved_at,
  resolution: r.resolution_json ? (JSON.parse(r.resolution_json) as ResolutionRecord) : null,
  actor: r.actor === 'bridge' ? 'bridge' : 'agent',
})

export type ResolveInput = {
  card_id: string
  action: 'primary' | 'kill' | 'revise'
  payload_hash: string
  edited?: { fields: Array<{ key: string; value: string }>; body?: string } | undefined
  edited_hash?: string | undefined
  note?: string | undefined
  /** Frame timestamp (ISO, signed by the owner device). */
  ts: string
}

export type ResolveOutcome =
  | {
      ok: true
      row: LedgerRow
      approved: CardBinding
      approvedHash: string
      edited: boolean
      resolution: ResolutionRecord
    }
  | {
      ok: false
      code: Extract<ErrorCodeT, 'card_not_pending' | 'card_expired' | 'card_hash_mismatch' | 'card_edit_forbidden'>
      reason: string
      row?: LedgerRow
      /** The card just became `expired` because of this attempt; the caller notifies the agent and the app. */
      newlyExpired?: boolean
    }

const TELLING_PREFIX = 'card_telling:'

export class CardLedger {
  constructor(private readonly store: HistoryStore) {}

  /**
   * Decisions whose hand-over to the agent started and has not returned. The marker is written in the same transaction as
   * `resolved` and holds the id of the frame that made the decision. One still here at startup means the process stopped
   * mid-write.
   */
  interrupted(): Array<{ cardId: string; frameId: string }> {
    const rows = this.store.db
      .query('SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key')
      .all(`${TELLING_PREFIX}%`) as Array<{ key: string; value: string }>
    return rows.map((r) => ({ cardId: r.key.slice(TELLING_PREFIX.length), frameId: r.value }))
  }

  /** The hand-over returned (or does not apply): clear the marker. */
  settled(id: string) {
    this.store.kvDelete(`${TELLING_PREFIX}${id}`)
  }

  create(card: CardT, actor: CardActor = 'agent'): LedgerRow {
    const binding = bindingFrom(card)
    const hash = payloadHash(binding)
    if (hash !== card.payload_hash) throw new Error('card payload_hash does not match its binding')
    this.store.db
      .query(
        'INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        card.id,
        card.thread_id,
        JSON.stringify(binding),
        hash,
        'pending',
        card.origin,
        card.risk,
        card.created_at,
        card.expires_at,
        actor,
      )
    this.recordRow(card)
    return this.get(card.id) as LedgerRow
  }

  /**
   * A `kind:'card'` history row for the card, so search finds it by its title and summary (the `card` column,
   * docs/V2-FEATURES.md V3.1). Only what the card shows as its heading: never fields, body, payload or attachments.
   * Permission cards are skipped: their text is Claude Code's tool input (MCP-Apps M4.8). Best effort: a history write
   * that fails must not fail the card.
   */
  private recordRow(card: CardT) {
    if (card.kind === 'permission') return
    this.writeCardRow(card)
  }

  private writeCardRow(c: {
    id: string
    thread_id: string
    title: string
    summary?: string | undefined
    created_at: string
  }) {
    try {
      this.store.addMessage({
        // Derived from the card id, so writing the row twice (a retry, a backfill racing a create) is one row, not two.
        id: `m_${c.id.slice(2)}`,
        thread_id: c.thread_id,
        author: 'agent', // a schedule card's words are the agent's proposal: never a `system` row
        kind: 'card',
        text: [c.title, c.summary].filter(Boolean).join('\n'),
        format: 'plain',
        attachments: [],
        card_id: c.id,
        via: 'app',
        created_at: c.created_at,
      })
      return true
    } catch {
      // the card itself is stored; it is only missing from search and from other devices' history
      return false
    }
  }

  /**
   * Writes the history row for every ledger card that has none (not permission cards). Cards raised before the row
   * existed, or whose best-effort write failed, never got one; this heals them for search and for the Mac's own history.
   * It writes a bridge-only row (no relay seq): it does not push a frame, and the relay never holds it, so it does not by
   * itself put the card on another device (those learn of a card from `card.create` / `card.update`).
   * `since` is the history cutoff (an ISO time): a card older than it is left alone, so a short TALOS_APP_HISTORY_DAYS
   * does not have every restart write back the text the prune just removed. Idempotent: a card with its row is left alone.
   */
  backfillRows(since?: string): number {
    // Permission cards are excluded in SQL: they never have a row, and the thread scan below would run for each one.
    const missing = this.store.db
      .query(
        `SELECT binding_json FROM cards c WHERE json_extract(c.binding_json, '$.kind') != 'permission'
         AND (? IS NULL OR c.created_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = 'm_' || substr(c.id, 3))
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = c.thread_id AND json_extract(m.json, '$.card_id') = c.id)`,
      )
      .all(since ?? null, since ?? null) as Array<{ binding_json: string }>
    let n = 0
    for (const r of missing) {
      const b = JSON.parse(r.binding_json) as CardBinding
      const row = this.get(b.id)
      if (!row || b.kind === 'permission') continue
      if (
        this.writeCardRow({
          id: b.id,
          thread_id: b.thread_id,
          title: b.title,
          summary: b.summary,
          created_at: row.created_at,
        })
      )
        n++
    }
    return n
  }

  get(id: string): LedgerRow | undefined {
    const r = this.store.db.query('SELECT * FROM cards WHERE id = ?').get(id) as RawRow | null
    return r ? toRow(r) : undefined
  }

  list(state?: CardT['state']): LedgerRow[] {
    const rows = (
      state
        ? this.store.db.query('SELECT * FROM cards WHERE state = ? ORDER BY created_at').all(state)
        : this.store.db.query('SELECT * FROM cards ORDER BY created_at').all()
    ) as RawRow[]
    return rows.map(toRow)
  }

  /** Atomic transition `from` -> `to`. False when the card was not in `from` (someone else won the race). */
  private transition(
    id: string,
    from: CardT['state'],
    to: CardT['state'],
    resolvedAt?: string,
    resolution?: ResolutionRecord,
  ): boolean {
    const r = this.store.db
      .query(
        'UPDATE cards SET state = ?, resolved_at = COALESCE(?, resolved_at), resolution_json = COALESCE(?, resolution_json) WHERE id = ? AND state = ?',
      )
      .run(to, resolvedAt ?? null, resolution ? JSON.stringify(resolution) : null, id, from)
    return r.changes === 1
  }

  /** pending -> expired. Returns true only for the call that made the change. */
  expire(id: string): boolean {
    return this.transition(id, 'pending', 'expired')
  }

  supersede(id: string): boolean {
    return this.transition(id, 'pending', 'superseded')
  }

  /** resolved -> done | failed after the agent acted (`card_result`). */
  finish(id: string, ok: boolean): boolean {
    return this.transition(id, 'resolved', ok ? 'done' : 'failed')
  }

  /**
   * resolved -> done for a card the owner killed or sent back for changes. Nothing runs for those, so no `card_result`
   * ever follows and the card would stay `resolved` for good. True when this call closed it. An approved card (primary)
   * is never touched: it is owed its result.
   */
  closeDecided(id: string): boolean {
    const r = this.store.db
      .query(
        `UPDATE cards SET state = 'done' WHERE state = 'resolved' AND id = ?
         AND json_extract(resolution_json, '$.action') IN ('kill', 'revise', 'expired')`,
      )
      .run(id)
    return r.changes === 1
  }

  /**
   * The ordered checks of spec 4.5: exists, pending, not expired, frame not older than 10 min, hash equal, edits allowed
   * and hashed right. (The owner signature was verified on the raw frame before this runs.) On success the card is set
   * `resolved` atomically, so a second resolve cannot also pass.
   */
  resolve(
    input: ResolveInput,
    nowMs: number,
    opts: { ageAtMs?: number; frameId?: string; by?: string } = {},
  ): ResolveOutcome {
    const row = this.get(input.card_id)
    if (!row) return { ok: false, code: 'card_not_pending', reason: 'unknown_card' }
    if (row.state === 'expired') return { ok: false, code: 'card_expired', reason: 'expired', row }
    if (row.state !== 'pending') return { ok: false, code: 'card_not_pending', reason: `state_${row.state}`, row }
    if (nowMs >= Date.parse(row.expires_at)) {
      const newlyExpired = this.expire(row.id)
      return { ok: false, code: 'card_expired', reason: 'expired', row: this.get(row.id) as LedgerRow, newlyExpired }
    }
    // The 10-minute rule judges how long the frame waited. A notification Approve passes the moment the relay took the tap
    // (`ageAtMs`), so a tap queued for a sleeping Mac still runs; the card's own expiry above is always judged at `nowMs`.
    if ((opts.ageAtMs ?? nowMs) - Date.parse(input.ts) > MAX_RESOLVE_AGE_MS) {
      const newlyExpired = this.expire(row.id)
      return {
        ok: false,
        code: 'card_expired',
        reason: 'mac_offline_too_long',
        row: this.get(row.id) as LedgerRow,
        newlyExpired,
      }
    }
    if (input.payload_hash !== row.payload_hash)
      return { ok: false, code: 'card_hash_mismatch', reason: 'hash_mismatch', row }
    // The binding hashes allow_revise: the Mac enforces it even if an app sends REVISE anyway.
    if (input.action === 'revise' && !row.binding.allow_revise)
      return { ok: false, code: 'card_edit_forbidden', reason: 'revise_not_allowed', row }
    let approved = row.binding
    let approvedHash = row.payload_hash
    let edited = false
    if (input.edited) {
      if (input.action !== 'primary')
        return { ok: false, code: 'card_edit_forbidden', reason: 'edits_only_with_primary', row }
      const allowed = checkEditAllowed(row.binding, input.edited)
      if (!allowed.ok) return { ok: false, code: 'card_edit_forbidden', reason: allowed.reason, row }
      const expected = editedHash(row.binding, input.edited)
      if (input.edited_hash !== expected)
        return { ok: false, code: 'card_edit_forbidden', reason: 'edited_hash_mismatch', row }
      approved = applyCardEdits(row.binding, input.edited)
      approvedHash = expected
      edited = true
    } else if (input.edited_hash !== undefined) {
      return { ok: false, code: 'card_edit_forbidden', reason: 'edited_hash_without_edits', row }
    }
    // The decision is dated at the owner's signed tap, so a tap queued for a sleeping Mac lands in its own day, not the day
    // the Mac woke. The time is the sender's, so it is held between the card's creation and now (a bad value cannot put a
    // card in the future or before it existed); one that cannot be read falls back to now.
    const tapMs = Date.parse(input.ts)
    const createdMs = Date.parse(row.created_at)
    const atMs = Number.isFinite(tapMs)
      ? Math.min(Math.max(tapMs, Number.isFinite(createdMs) ? createdMs : tapMs), nowMs)
      : nowMs
    const at = new Date(atMs).toISOString()
    const resolution: ResolutionRecord = {
      action: input.action,
      at,
      edited,
      payload_hash: approvedHash,
      ...(input.note ? { note: input.note } : {}),
      taken_at: new Date(nowMs).toISOString(),
      ...(opts.by ? { by: opts.by } : {}),
    }
    const tells = row.actor === 'agent' && !isBridgeHandledCardKind(row.binding.kind)
    const won = this.store.db.transaction(() => {
      if (!this.transition(row.id, 'pending', 'resolved', resolution.taken_at, resolution)) return false
      if (tells) this.store.kvSet(`${TELLING_PREFIX}${row.id}`, opts.frameId ?? '')
      return true
    })()
    if (!won) return { ok: false, code: 'card_not_pending', reason: 'lost_race', row: this.get(row.id) as LedgerRow }
    return { ok: true, row: this.get(row.id) as LedgerRow, approved, approvedHash, edited, resolution }
  }
}
