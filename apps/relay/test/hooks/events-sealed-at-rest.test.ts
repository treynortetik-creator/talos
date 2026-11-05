// Inbox and webhook event text is encrypted at rest, and rows from before that stay readable and get sealed.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { sealLegacyEvents } from '../../src/hooks/event-seal.ts'
import { listInbox } from '../../src/hooks/inbox.ts'
import { storeEvents } from '../../src/hooks/route.ts'
import { runtimeFor } from '../../src/hooks/runtime.ts'
import { startTestRelay } from '../core/harness.ts'
import { framesOf, type Loose, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const MARK = 'ZXQ-hook-title-marker'

function sample(title: string, id = newId('e')): Loose {
  return {
    id,
    source: 'generic',
    connection: 'cn_AAAAAAAAAAAAAAAAAAAAAA',
    kind: 'generic.event',
    title,
    summary: `${title} summary`,
    ts: new Date().toISOString(),
    thread: 'inbox',
    work: false,
    priority: 'normal',
    dedup_key: `generic:${id}`,
  }
}

/** Writes a row the way a build from before sealing did. */
function legacyRow(s: ReturnType<typeof setup>, title: string, id = newId('e')) {
  s.f.db
    .prepare(
      `insert into hooks_events (event_id, conn_id, integration, thread, priority, work, ts, event_json, collected, passthrough, created_at)
       values (?, 'cn_AAAAAAAAAAAAAAAAAAAAAA', 'generic', 'inbox', 'normal', 0, ?, ?, 0, 0, ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify(sample(title, id)), s.f.clock.now())
  return id
}

describe('event text at rest', () => {
  it('a webhook title is in no column of the stored row, yet reaches the inbox, the apps and the Mac', async () => {
    const s = setup()
    const c = await s.create('generic')
    await s.send('generic', c.id, c.secret, { title: MARK }, { id: 'rest1' })
    await s.drain()
    const stored = JSON.stringify(s.events().map((r) => ({ ...r, event_enc: r.event_enc?.toString('latin1') })))
    expect(s.events()).toHaveLength(1)
    expect(stored).not.toContain(MARK)
    expect(Buffer.from(s.events()[0]?.event_enc).includes(MARK)).toBe(false)
    expect(s.eventBodies()[0]?.title).toBe(MARK)
    const inbox = [...listInbox(s.rt, 'priority').items, ...listInbox(s.rt, 'other').items]
    expect(inbox.map((i) => i.title)).toEqual([MARK])
    expect(JSON.stringify(framesOf(s.f.bus.toBridgeLog, 'hook.event'))).toContain(MARK)
  })

  it('the database file and its write-ahead log hold no readable event text', async () => {
    const relay = await startTestRelay()
    const rt = runtimeFor(relay.relay.services)
    relay.relay.services.db.transaction(() =>
      storeEvents(rt, [{ event: sample(`${MARK}-file`) as never, rawId: null }]),
    )()
    relay.runtime.store.db.pragma('wal_checkpoint(FULL)')
    const hits = readdirSync(relay.dir)
      .filter((f) => f.startsWith('relay.sqlite'))
      .filter((f) => readFileSync(join(relay.dir, f)).includes(MARK))
    await relay.stop()
    expect(hits).toEqual([])
  })
})

describe('rows from before sealing', () => {
  it('stay readable as they are, then get sealed and keep reading the same', () => {
    const s = setup()
    const id = legacyRow(s, `${MARK}-old`)
    expect(listInbox(s.rt, 'priority').items.map((i) => i.title)).toEqual([`${MARK}-old`])
    expect(sealLegacyEvents(s.f.services)).toBe(1)
    const [row] = s.events()
    expect(row).toMatchObject({ event_id: id, event_json: '' })
    expect(JSON.stringify(row)).not.toContain(MARK)
    expect(listInbox(s.rt, 'priority').items.map((i) => i.title)).toEqual([`${MARK}-old`])
    expect(sealLegacyEvents(s.f.services)).toBe(0) // nothing left to do, nothing re-sealed
  })

  it('turns on secure_delete before it rewrites a row, so SQLite overwrites the old text instead of freeing it', () => {
    const s = setup()
    legacyRow(s, `${MARK}-old`)
    const db = s.f.db
    const secureDelete = () => db.pragma('secure_delete', { simple: true })
    expect(secureDelete()).toBe(0) // off to begin with, so a 1 below is this function's doing
    // Read the setting at the moment each row is rewritten: reading it afterwards cannot tell "on before" from "on after".
    const atRewrite: unknown[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const st = prepare(sql)
      if (!sql.startsWith('update hooks_events set event_enc')) return st
      const run = st.run.bind(st)
      st.run = ((...args: unknown[]) => {
        atRewrite.push(secureDelete())
        return run(...args)
      }) as typeof st.run
      return st
    }) as typeof db.prepare
    expect(sealLegacyEvents(s.f.services)).toBe(1)
    expect(atRewrite).toEqual([1])
  })

  it('the tick seals a plain row an older build wrote after the deploy', async () => {
    const s = setup()
    legacyRow(s, 'late')
    await s.tick()
    expect(s.events()[0]?.event_json).toBe('')
    expect(s.eventBodies()[0]?.title).toBe('late')
  })
})

describe('a seal that fails', () => {
  it('is logged and does not stop the rest of the tick (delivery, sweep, purge)', async () => {
    const s = setup()
    legacyRow(s, 'late')
    // A row whose text cannot be sealed: the update trips a constraint.
    s.f.db.exec(
      "create trigger no_seal before update of event_enc on hooks_events begin select raise(abort, 'disk full'); end",
    )
    const errors: string[] = []
    const log = s.f.services.log
    const real = log.error.bind(log)
    log.error = ((o: unknown, msg?: string) => {
      errors.push(msg ?? '')
      real(o as never, msg as never)
    }) as typeof log.error
    // An old event past the retention window: the purge at the end of the tick must still remove it.
    const oldId = legacyRow(s, 'ancient')
    s.f.db.prepare('update hooks_events set created_at = 0 where event_id = ?').run(oldId)
    await s.tick()
    expect(errors).toContain('sealing stored hook events failed')
    expect(s.events().some((r) => r.event_id === oldId)).toBe(false)
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event').length).toBeGreaterThan(0)
  })
})
