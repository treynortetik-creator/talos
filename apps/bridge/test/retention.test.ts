// Bounded growth (CODEREVIEW #34, bridge part): history rows, bridge.log and TTS audio age out.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HistoryStore, MESSAGE_RETENTION_MS } from '../src/history-store.ts'
import { createLogger, LOG_MAX_BYTES } from '../src/log.ts'
import { pruneTtsFiles, TTS_KEEP_MS } from '../src/tts.ts'
import { tempHome } from './helpers.ts'

const DAY = 24 * 3600_000

describe('retention', () => {
  test('pruneOld drops old messages, and finished cards; keeps pending cards, fresh rows and the outbox', () => {
    const home = tempHome()
    const s = new HistoryStore(join(home, 'h.sqlite'))
    const now = Date.now()
    const msg = (id: string, ageMs: number) =>
      s.db
        .query('INSERT INTO messages (id, thread_id, created_at, author, json) VALUES (?, ?, ?, ?, ?)')
        .run(id, 't', new Date(now - ageMs).toISOString(), 'owner', '{}')
    msg('old', MESSAGE_RETENTION_MS + DAY)
    msg('new', DAY)
    const card = (id: string, state: string, ageMs: number) =>
      s.db
        .query(
          'INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, 't', '{}', 'h', state, 'o', 'r', new Date(now - ageMs).toISOString(), 'x')
    card('c-old-done', 'approved', 40 * DAY)
    card('c-old-pending', 'pending', 40 * DAY)
    card('c-new-done', 'approved', DAY)
    s.outboxAdd('o-old', 'reply', '{}', now - 2 * DAY) // flushOutbox owns this one (it tells the agent)
    expect(s.pruneOld(now)).toEqual({ messages: 1, cards: 1 })
    expect((s.db.query('SELECT id FROM messages').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['new'])
    expect((s.db.query('SELECT id FROM cards ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)).toEqual([
      'c-new-done',
      'c-old-pending',
    ])
    expect(s.outboxList().map((r) => r.id)).toEqual(['o-old'])
    s.close()
  })

  test('bridge.log rotates to bridge.log.1 past the cap', () => {
    const home = tempHome()
    const file = join(home, 'bridge.log')
    writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES + 10))
    const log = createLogger(home, 'info')
    log.info('after rotation')
    expect(statSync(join(home, 'bridge.log.1')).size).toBeGreaterThan(LOG_MAX_BYTES)
    expect(statSync(file).size).toBeLessThan(1000)
  })

  test('old TTS audio is swept; other media and fresh audio stay', () => {
    const dir = tempHome()
    const old = new Date(Date.now() - TTS_KEEP_MS - DAY)
    for (const f of ['tts-a.mp3', 'tts-b.m4a', 'keep.txt']) writeFileSync(join(dir, f), 'x')
    utimesSync(join(dir, 'tts-a.mp3'), old, old)
    utimesSync(join(dir, 'keep.txt'), old, old)
    expect(pruneTtsFiles(dir, Date.now())).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['keep.txt', 'tts-b.m4a'])
    expect(existsSync(join(dir, 'tts-a.mp3'))).toBe(false)
  })
})
