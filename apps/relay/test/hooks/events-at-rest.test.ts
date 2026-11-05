// The relay reads inbox and webhook events whether a row holds plain text (event_json) or a sealed event (event_enc), and
// one row that no longer opens degrades only itself. Writing sealed rows is tested in events-sealed-at-rest.test.ts.
import { HookDigestFrame, newId } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { sealEvent } from '../../src/hooks/event-seal.ts'
import { listInbox } from '../../src/hooks/inbox.ts'
import { storeEvents } from '../../src/hooks/route.ts'
import { framesOf, type Loose, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

function sample(title: string, id = newId('e'), over: Loose = {}): Loose {
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
    ...over,
  }
}

/** A row the way a sealing build writes it: empty event_json, the event in event_enc. */
function sealedRow(s: ReturnType<typeof setup>, title: string, id = newId('e'), over: Loose = {}) {
  s.f.db
    .prepare(
      `insert into hooks_events (event_id, conn_id, integration, thread, priority, work, ts, event_json, event_enc, collected, passthrough, created_at)
       values (?, 'cn_AAAAAAAAAAAAAAAAAAAAAA', 'generic', 'inbox', 'normal', 0, ?, '', ?, ?, 0, ?)`,
    )
    .run(
      id,
      new Date().toISOString(),
      sealEvent(s.f.services, sample(title, id, over) as never),
      over.collected ? 1 : 0,
      s.f.clock.now(),
    )
  return id
}

describe('sealed rows are read', () => {
  it('a sealed row shows in the inbox and reaches the apps and the Mac', async () => {
    const s = setup()
    sealedRow(s, 'sealed one')
    expect(listInbox(s.rt, 'priority').items.map((i) => i.title)).toEqual(['sealed one'])
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event').map((f) => (f as Loose).event.title)).toEqual(['sealed one'])
    expect(framesOf(s.f.bus.toAppsLog, 'inbox.item').map((f) => (f as Loose).item.title)).toEqual(['sealed one'])
  })

  it('a sealed row collected in the quiet window goes out in the digest', async () => {
    const s = setup()
    sealedRow(s, 'overnight one', undefined, { collected: true })
    await s.tick()
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')[0] as Loose
    expect(digest.events.map((e: Loose) => e.title)).toEqual(['overnight one'])
  })

  it('plain and sealed rows list together', () => {
    const s = setup()
    storeEvents(s.rt, [{ event: sample('plain') as never, rawId: null }])
    sealedRow(s, 'sealed')
    expect(
      listInbox(s.rt, 'priority')
        .items.map((i) => i.title)
        .sort(),
    ).toEqual(['plain', 'sealed'])
  })
})

describe('one row that no longer opens', () => {
  it('a sealed event cannot be copied onto another event id', () => {
    const s = setup()
    const id = sealedRow(s, 'first')
    const row = s.f.db.prepare('select * from hooks_events where event_id = ?').get(id) as Loose
    s.f.db
      .prepare(
        `insert into hooks_events (event_id, conn_id, integration, thread, priority, work, ts, event_json, event_enc, collected, passthrough, created_at)
         values ('e_other', 'cn_AAAAAAAAAAAAAAAAAAAAAA', 'generic', 'inbox', 'normal', 0, ?, '', ?, 0, 0, 0)`,
      )
      .run(row.ts, row.event_enc)
    expect(listInbox(s.rt, 'priority').items.map((i) => i.title)).toEqual(['first'])
  })

  it('is reported and skipped while the inbox, the delivery and the digest of the other rows carry on', async () => {
    const s = setup()
    const bad = sealedRow(s, 'bad one')
    sealedRow(s, 'good one')
    const badNight = sealedRow(s, 'bad night', undefined, { collected: true })
    sealedRow(s, 'good night', undefined, { collected: true })
    s.f.db.prepare("update hooks_events set event_enc = x'0001' where event_id in (?, ?)").run(bad, badNight)
    expect(
      listInbox(s.rt, 'priority')
        .items.map((i) => i.title)
        .sort(),
    ).toEqual(['good night', 'good one'])
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event').map((f) => (f as Loose).event.title)).toEqual(['good one'])
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')[0] as Loose
    expect(digest.events.map((e: Loose) => e.title)).toEqual(['good night', '1 item could not be read'])
    // the per-thread counts are of what the digest carries: the row that would not open is not counted as a generic event
    expect(digest.threads).toEqual([{ thread_id: 'inbox', counts: { generic: 1 } }])
  })

  it('several rows that will not open make one plural note that takes its place from the first of them, and counts only what opened', async () => {
    const s = setup()
    const first = sealedRow(s, 'first bad', undefined, { collected: true })
    const second = sealedRow(s, 'second bad', undefined, { collected: true })
    sealedRow(s, 'good night', undefined, { collected: true })
    s.f.db.prepare("update hooks_events set thread = 'work', integration = 'slack' where event_id = ?").run(second)
    s.f.db.prepare("update hooks_events set event_enc = x'0001' where event_id in (?, ?)").run(first, second)
    await s.tick()
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')[0] as Loose
    const note = digest.events.find((e: Loose) => e.title.endsWith('could not be read')) as Loose
    expect(note).toMatchObject({
      title: '2 items could not be read',
      summary: expect.stringContaining('are not listed here'),
      thread: 'inbox', // the first row that failed, not the last
      source: 'generic',
    })
    expect(digest.threads).toEqual([{ thread_id: 'inbox', counts: { generic: 1 } }])
  })

  it('the inbox list says how many rows it left out, and says nothing when every row opens', () => {
    const s = setup()
    const bad = sealedRow(s, 'bad one')
    sealedRow(s, 'good one')
    const badOther = sealedRow(s, 'bad other')
    s.f.db.prepare("update hooks_events set priority = 'low' where event_id = ?").run(badOther)
    expect('unreadable' in listInbox(s.rt, 'priority')).toBe(false)
    s.f.db.prepare("update hooks_events set event_enc = x'0001' where event_id in (?, ?)").run(bad, badOther)
    const list = listInbox(s.rt, 'priority')
    expect(list.items.map((i) => i.title)).toEqual(['good one'])
    expect(list.unreadable).toBe(1)
    expect(listInbox(s.rt, 'other').unreadable).toBe(1)
  })

  it('a digest whose rows all fail to open still tells the Mac', async () => {
    const s = setup()
    const bad = sealedRow(s, 'bad night', undefined, { collected: true })
    s.f.db.prepare("update hooks_events set event_enc = x'0001' where event_id = ?").run(bad)
    await s.tick()
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')[0] as Loose
    expect(digest.events.map((e: Loose) => e.title)).toEqual(['1 item could not be read'])
  })

  it('the unreadable note fits inside the 200-event cap of a full digest', async () => {
    const s = setup()
    for (let i = 0; i < 205; i++) sealedRow(s, `night ${i}`, undefined, { collected: true, actor: { name: 'A' } })
    const bad = sealedRow(s, 'bad night', undefined, { collected: true })
    s.f.db.prepare("update hooks_events set event_enc = x'0001' where event_id = ?").run(bad)
    await s.tick()
    const digest = framesOf(s.f.bus.toBridgeLog, 'hook.digest')[0] as Loose
    expect(digest.events.length).toBeLessThanOrEqual(200)
    expect(digest.events.map((e: Loose) => e.title)).toContain('1 item could not be read')
    const parsed = HookDigestFrame.safeParse(digest)
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 2))).toBe(true)
  })
})
