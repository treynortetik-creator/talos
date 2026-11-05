// V2 follow-ups (search card column). Real bridge with FakeRelay/FakeApp: the agent's own `card` tool mints the card, and
// the signed search query goes through the bridge's real search service.
import { afterEach, describe, expect, test } from 'bun:test'
import type { MessageT } from '@talos-app/protocol'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

describe('cards: a card that never got its history row is healed', () => {
  const mint = async (title: string, extra: Record<string, unknown> = {}) => {
    const res = await h!.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'generic',
      title,
      primary_label: 'Go',
      kill_label: 'Kill it',
      risk: 'low',
      origin: 'chat',
      ...extra,
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    return /(c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1] as string
  }
  const rows = (cardId: string) =>
    h!.bridge.ctx.store.db
      .query("SELECT json FROM messages WHERE json_extract(json, '$.card_id') = ?")
      .all(cardId)
      .map((r) => JSON.parse((r as { json: string }).json) as MessageT)

  test('a ledger card with no row (raised by an older bridge) gets one carrying the card time; a second run adds nothing', async () => {
    h = await startHarness()
    const stale = await mint('Old card from before the row existed')
    const fresh = await mint('Card that kept its row')
    h.bridge.ctx.store.db.query("DELETE FROM messages WHERE json_extract(json, '$.card_id') = ?").run(stale)
    expect(rows(stale)).toEqual([])
    expect(rows(fresh)).toHaveLength(1)

    expect(h.bridge.ctx.ledger.backfillRows()).toBe(1)
    const [row] = rows(stale)
    expect({ kind: row?.kind, thread: row?.thread_id, text: row?.text }).toEqual({
      kind: 'card',
      thread: 'general',
      text: 'Old card from before the row existed',
    })
    expect(row?.created_at).toBe(h.bridge.ctx.ledger.get(stale)?.created_at as string)
    expect(rows(fresh)).toHaveLength(1)

    expect(h.bridge.ctx.ledger.backfillRows()).toBe(0)
    expect(rows(stale)).toHaveLength(1)
  })

  test('a decided card is healed too, and a permission card is never given a row', async () => {
    h = await startHarness()
    const done = await mint('Already finished')
    h.bridge.ctx.ledger.expire(done)
    h.bridge.ctx.store.db.query("DELETE FROM messages WHERE json_extract(json, '$.card_id') = ?").run(done)
    const perm = await mint('Tool input must not be indexed')
    h.bridge.ctx.store.db.query("DELETE FROM messages WHERE json_extract(json, '$.card_id') = ?").run(perm)
    h.bridge.ctx.store.db
      .query("UPDATE cards SET binding_json = json_set(binding_json, '$.kind', 'permission') WHERE id = ?")
      .run(perm)
    expect(h.bridge.ctx.ledger.backfillRows()).toBe(1)
    expect(rows(done)).toHaveLength(1)
    expect(rows(perm)).toEqual([])
  })

  test('a card older than the history window is not written back (the prune just cut it); a newer one is', async () => {
    h = await startHarness()
    const old = await mint('Older than the window')
    const recent = await mint('Inside the window')
    for (const id of [old, recent])
      h.bridge.ctx.store.db.query("DELETE FROM messages WHERE json_extract(json, '$.card_id') = ?").run(id)
    h.bridge.ctx.store.db.query('UPDATE cards SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', old)
    h.bridge.ctx.store.db.query('UPDATE cards SET created_at = ? WHERE id = ?').run('2026-10-25T00:00:00.000Z', recent)
    expect(h.bridge.ctx.ledger.backfillRows('2026-10-01T00:00:00.000Z')).toBe(1)
    expect(rows(old)).toEqual([])
    expect(rows(recent)).toHaveLength(1)
    // a second run after the same cutoff adds nothing, and no cutoff means everything
    expect(h.bridge.ctx.ledger.backfillRows('2026-10-01T00:00:00.000Z')).toBe(0)
    expect(h.bridge.ctx.ledger.backfillRows()).toBe(1)
    expect(rows(old)).toHaveLength(1)
  })

  test('Bridge.start() heals a card inside the history window and leaves one the prune would cut (TALOS_APP_HISTORY_DAYS=7)', async () => {
    h = await startHarness({ startBridge: false, env: { TALOS_APP_HISTORY_DAYS: '7' } })
    const day = 24 * 3600_000
    const old = await mint('Twenty days old')
    const recent = await mint('Yesterday')
    const db = h.bridge.ctx.store.db
    for (const id of [old, recent]) db.query("DELETE FROM messages WHERE json_extract(json, '$.card_id') = ?").run(id)
    db.query('UPDATE cards SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * day).toISOString(), old)
    db.query('UPDATE cards SET created_at = ? WHERE id = ?').run(new Date(Date.now() - day).toISOString(), recent)
    h.bridge.start()
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    expect(rows(recent)).toHaveLength(1)
    expect(rows(old)).toEqual([])
  })
})
