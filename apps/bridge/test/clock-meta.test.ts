import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ChannelMeta, CONFIG_PROPOSE_FEATURE, type MessageT, newId, runText } from '@talos-app/protocol'
import { clockMeta, humanGap, localTime, systemZone } from '../src/clock-meta.ts'
import { HistoryStore } from '../src/history-store.ts'
import { agentInstructions, INSTRUCTIONS, selfMapBlock } from '../src/instructions.ts'
import { fixture, type Harness, startHarness, tempHome } from './helpers.ts'

describe('localTime', () => {
  test('a zone without daylight saving keeps one offset all year (Honolulu)', () => {
    expect(localTime('2026-07-04T19:30:15.000Z', 'Pacific/Honolulu')).toBe('2026-07-04T09:30:15-10:00')
    expect(localTime('2026-01-04T19:30:15.000Z', 'Pacific/Honolulu')).toBe('2026-01-04T09:30:15-10:00')
  })
  test('a zone with daylight saving changes offset across the switch (New York, 2026-03-08)', () => {
    expect(localTime('2026-03-08T06:59:59.000Z', 'America/New_York')).toBe('2026-03-08T01:59:59-05:00')
    expect(localTime('2026-03-08T07:00:00.000Z', 'America/New_York')).toBe('2026-03-08T03:00:00-04:00')
    expect(localTime('2026-11-01T05:59:59.000Z', 'America/New_York')).toBe('2026-11-01T01:59:59-04:00')
    expect(localTime('2026-11-01T06:00:00.000Z', 'America/New_York')).toBe('2026-11-01T01:00:00-05:00')
  })
  test('a half-hour zone and a zone ahead of UTC are written with their own offset', () => {
    expect(localTime('2026-11-04T00:00:00.000Z', 'Asia/Kolkata')).toBe('2026-11-04T05:30:00+05:30')
    expect(localTime('2026-11-04T23:30:00.000Z', 'Pacific/Auckland')).toBe('2026-11-05T12:30:00+13:00')
  })
  test('midnight local is 00, never 24', () => {
    expect(localTime('2026-11-04T10:00:00.000Z', 'Pacific/Honolulu')).toBe('2026-11-04T00:00:00-10:00')
  })
  test('UTC is written +00:00', () => {
    expect(localTime('2026-11-04T07:00:00.000Z', 'UTC')).toBe('2026-11-04T07:00:00+00:00')
  })
  test('an unset or unknown zone falls back to the Mac zone, not to nothing', () => {
    const want = localTime('2026-11-04T07:00:00.000Z', systemZone())
    expect(want).toMatch(/^2026-11-0[345]T\d\d:\d\d:00[+-]\d\d:\d\d$/)
    expect(localTime('2026-11-04T07:00:00.000Z', undefined)).toBe(want)
    expect(localTime('2026-11-04T07:00:00.000Z', '')).toBe(want)
    expect(localTime('2026-11-04T07:00:00.000Z', 'Not/AZone')).toBe(want)
  })
  test('a time that does not parse gives nothing instead of "Invalid Date"', () => {
    expect(localTime('not a time', 'UTC')).toBeUndefined()
  })
})

describe('humanGap', () => {
  const at = (ms: number) => new Date(Date.parse('2026-11-04T12:00:00.000Z') + ms).toISOString()
  const prev = '2026-11-04T12:00:00.000Z'
  test('minutes, hours with minutes, and days', () => {
    expect(humanGap(prev, at(4 * 60_000))).toBe('4m')
    expect(humanGap(prev, at(130 * 60_000))).toBe('2h 10m')
    expect(humanGap(prev, at(120 * 60_000))).toBe('2h')
    expect(humanGap(prev, at(51 * 3600_000))).toBe('2d 3h')
    expect(humanGap(prev, at(48 * 3600_000))).toBe('2d')
  })
  test('under a minute is words with no angle bracket (meta values lose < and >)', () => {
    expect(humanGap(prev, at(20_000))).toBe('under 1m')
  })
  test('a previous time after this one (clock jump) or garbage gives nothing', () => {
    expect(humanGap(at(60_000), prev)).toBeUndefined()
    expect(humanGap('junk', prev)).toBeUndefined()
  })
})

let h: Harness
afterEach(async () => h?.stop())

const iso = (ms: number) => new Date(ms).toISOString()

describe('the clock on a real inbound message', () => {
  test('timezone set: local_time in that zone; the first message in a thread has no since_last', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'Pacific/Honolulu' }) })
    const ts = iso(Date.now())
    await h.app.sendMessage('general', 'first', { ts })
    await h.waitNotes(1)
    const m = h.notes[0]?.meta ?? {}
    expect(m.ts).toBe(ts)
    expect(m.local_time).toBe(localTime(ts, 'Pacific/Honolulu') as string)
    expect(m.local_time).toMatch(/-10:00$/)
    expect(m.since_last).toBeUndefined()
    ChannelMeta.parse(h.notes[0]?.meta)
  })

  test('a config the code cannot read a zone from (config requires one, so this is only a guard): the Mac zone', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    const ts = iso(Date.now())
    const ctx = { config: { config: {} }, store: h.bridge.ctx.store } as unknown as Parameters<typeof clockMeta>[0]
    expect(clockMeta(ctx, 'general', ts).local_time).toBe(localTime(ts, systemZone()) as string)
  })

  test('a second message in the same thread carries the gap; the other thread starts fresh', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    const t0 = Date.now() - 10 * 60_000
    await h.app.sendMessage('general', 'one', { ts: iso(t0) })
    await h.waitNotes(1)
    await h.app.sendMessage('general', 'two', { ts: iso(t0 + 4 * 60_000) })
    await h.waitNotes(2)
    expect(h.notes[1]?.meta.since_last).toBe('4m')
    expect(h.notes[1]?.meta.local_time).toMatch(/\+00:00$/)
    await h.app.sendMessage('inbox', 'elsewhere', { ts: iso(t0 + 5 * 60_000) })
    await h.waitNotes(3)
    expect(h.notes[2]?.meta.thread_id).toBe('inbox')
    expect(h.notes[2]?.meta.since_last).toBeUndefined()
  })

  test('a late-arriving older message measures from the one before it, not from a newer one', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    const t0 = Date.now() - 3 * 3600_000
    await h.app.sendMessage('general', 'early', { ts: iso(t0) })
    await h.waitNotes(1)
    await h.app.sendMessage('general', 'late', { ts: iso(t0 + 130 * 60_000) })
    await h.waitNotes(2)
    await h.app.sendMessage('general', 'middle', { ts: iso(t0 + 30 * 60_000) })
    await h.waitNotes(3)
    expect(h.notes[1]?.meta.since_last).toBe('2h 10m')
    expect(h.notes[2]?.meta.since_last).toBe('30m')
  })

  test('a voice note carries local_time', async () => {
    h = await startHarness({
      env: { TALOS_APP_STT_CMD: JSON.stringify([fixture('fake-stt.sh'), '{in}']) },
      config: (c) => ({ ...c, timezone: 'Asia/Kolkata' }),
    })
    const res = await fetch(`${h.relay.httpUrl}/api/media`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4', 'x-talos-name': 'note.m4a', 'x-talos-duration-ms': '5000' },
      body: 'audio bytes',
    })
    const ref = (await res.json()) as Record<string, unknown>
    await h.app.sendVoiceNote('general', { ...ref, kind: 'voice_note', role: 'attachment' })
    await h.waitNotes(1)
    const m = h.notes[0]?.meta ?? {}
    expect(m.kind).toBe('voice_note')
    expect(m.local_time).toBe(localTime(m.ts as string, 'Asia/Kolkata') as string)
    expect(m.local_time).toMatch(/\+05:30$/)
  })

  test('a spoken question on a live call carries local_time', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'Pacific/Honolulu' }) })
    await h.app.sendVoiceAsk('general', 'What is on my plate?', [])
    await h.waitNotes(1)
    const m = h.notes[0]?.meta ?? {}
    expect(m.kind).toBe('voice_delegation')
    expect(m.local_time).toBe(localTime(m.ts as string, 'Pacific/Honolulu') as string)
  })
})

const row = (over: Partial<MessageT> & { id: string; created_at: string }): MessageT =>
  ({
    thread_id: 'general',
    author: 'owner',
    kind: 'text',
    text: 'hi',
    format: 'plain',
    attachments: [],
    via: 'app',
    ...over,
  }) as MessageT

describe('previousOwnerAt (the real store)', () => {
  const T = (min: number) => new Date(Date.parse('2026-11-04T12:00:00.000Z') + min * 60_000).toISOString()
  const fresh = () => new HistoryStore(join(tempHome(), 'h.sqlite'))

  test("an agent row and a share row between do not count: it measures from the owner's own last message", () => {
    const s = fresh()
    s.addMessage(row({ id: 'o1', created_at: T(0) }))
    s.addMessage(row({ id: 'a1', created_at: T(5), author: 'agent' }))
    s.addMessage(
      row({ id: 'sh1', created_at: T(6), via: 'share', text: 'look', share_content: { url: 'https://x.test/' } }),
    )
    s.addMessage(
      row({ id: 'sh2', created_at: T(7), via: 'app', text: '  ', share_content: { url: 'https://x.test/' } }),
    )
    expect(s.previousOwnerAt('general', T(10))).toBe(T(0))
  })

  test('only share rows before it: there is no previous owner message', () => {
    const s = fresh()
    s.addMessage(row({ id: 'sh1', created_at: T(1), via: 'share', text: 'look' }))
    s.addMessage(row({ id: 'sh2', created_at: T(2), text: '', share_content: { url: 'https://x.test/' } }))
    expect(s.previousOwnerAt('general', T(10))).toBeUndefined()
  })

  test('typed words with shared material still count (the owner wrote something)', () => {
    const s = fresh()
    s.addMessage(row({ id: 'o1', created_at: T(3), text: 'see this', share_content: { url: 'https://x.test/' } }))
    expect(s.previousOwnerAt('general', T(10))).toBe(T(3))
  })

  test('another thread, a later time and the excepted id are all ignored', () => {
    const s = fresh()
    s.addMessage(row({ id: 'o1', created_at: T(1) }))
    s.addMessage(row({ id: 'other', created_at: T(2), thread_id: 'inbox' }))
    s.addMessage(row({ id: 'later', created_at: T(20) }))
    s.addMessage(row({ id: 'self', created_at: T(9) }))
    expect(s.previousOwnerAt('general', T(10), 'self')).toBe(T(1))
  })

  test('the query uses the (thread_id, author, created_at) index', () => {
    const s = fresh()
    const plan = s.db
      .query(
        "EXPLAIN QUERY PLAN SELECT created_at, json FROM messages WHERE thread_id = ? AND author = 'owner' AND created_at < ? AND id != ? ORDER BY created_at DESC",
      )
      .all('general', T(1), '') as Array<{ detail: string }>
    const text = plan.map((p) => p.detail).join(' | ')
    expect(text).toContain('messages_author_time')
    expect(text).not.toContain('USE TEMP B-TREE')
  })

  test('an old database (made before the index) gets the index when opened', () => {
    const home = tempHome()
    const path = join(home, 'h.sqlite')
    const a = new HistoryStore(path)
    a.db.exec('DROP INDEX messages_author_time')
    a.db.close()
    const b = new HistoryStore(path)
    const names = (
      b.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(names).toContain('messages_author_time')
  })
})

describe('the clock on a live bridge, with other rows around', () => {
  test('an agent row and a share row before the owner message: since_last measures from the real previous owner message', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    const t0 = Date.now() - 60 * 60_000
    await h.app.sendMessage('general', 'one', { ts: iso(t0) })
    await h.waitNotes(1)
    const store = h.bridge.ctx.store
    store.addMessage(row({ id: 'agent-1', created_at: iso(t0 + 20 * 60_000), author: 'agent' }))
    store.addMessage(row({ id: 'share-1', created_at: iso(t0 + 25 * 60_000), via: 'share', text: 'a page' }))
    await h.app.sendMessage('general', 'two', { ts: iso(t0 + 30 * 60_000) })
    await h.waitNotes(2)
    expect(h.notes[1]?.meta.since_last).toBe('30m')
  })

  test('the author filter matters: an agent row newer than the owner message does not become the "previous" one', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    const t0 = Date.now() - 60 * 60_000
    h.bridge.ctx.store.addMessage(row({ id: 'agent-only', created_at: iso(t0), author: 'agent' }))
    await h.app.sendMessage('general', 'first from the owner', { ts: iso(t0 + 10 * 60_000) })
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.since_last).toBeUndefined()
  })
})

const cardArgs = () => ({
  thread_id: 'general',
  kind: 'message',
  title: 'Send the update',
  primary_label: 'Send',
  kill_label: 'Kill draft',
  risk: 'low',
  origin: 'chat',
  destination: [{ label: 'To', value: 'someone@example.com' }],
  body: 'Draft body',
  fields: [],
})

describe('which notes carry since_last', () => {
  test('a typed message, a voice note and a Run tap do', async () => {
    h = await startHarness({
      env: { TALOS_APP_STT_CMD: JSON.stringify([fixture('fake-stt.sh'), '{in}']) },
      config: (c) => ({ ...c, timezone: 'UTC' }),
    })
    const t0 = Date.now() - 60 * 60_000
    await h.app.sendMessage('general', 'before', { ts: iso(t0) })
    await h.waitNotes(1)
    const res = await fetch(`${h.relay.httpUrl}/api/media`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4', 'x-talos-name': 'note.m4a', 'x-talos-duration-ms': '5000' },
      body: 'audio bytes',
    })
    const ref = (await res.json()) as Record<string, unknown>
    await h.app.sendVoiceNote('general', { ...ref, kind: 'voice_note', role: 'attachment' })
    await h.waitNotes(2)
    expect(h.notes[1]?.meta.kind).toBe('voice_note')
    expect(h.notes[1]?.meta.since_last).toMatch(/^(1h|59m|60m)/)
    const run = await h.app.buildMessage('general', runText('echo hi\n', 'sh') as string, {
      intent: 'run',
      run_block: { message_id: newId('m'), index: 0 },
    })
    h.app.send(run)
    await h.waitNotes(3)
    expect(h.notes[2]?.meta.run).toBe('tap')
    expect(h.notes[2]?.meta.since_last).toBeDefined()
  })

  test('a voice question on a call has local_time and no since_last, even after the owner wrote earlier', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    await h.app.sendMessage('general', 'before', { ts: iso(Date.now() - 20 * 60_000) })
    await h.waitNotes(1)
    await h.app.sendVoiceAsk('general', 'What is on my plate?', [])
    await h.waitNotes(2)
    expect(h.notes[1]?.meta.kind).toBe('voice_delegation')
    expect(h.notes[1]?.meta.local_time).toBeDefined()
    expect(h.notes[1]?.meta.since_last).toBeUndefined()
  })

  test('a card decision has local_time and no since_last, even after the owner wrote earlier', async () => {
    h = await startHarness({ config: (c) => ({ ...c, timezone: 'UTC' }) })
    await h.app.sendMessage('general', 'before', { ts: iso(Date.now() - 20 * 60_000) })
    await h.waitNotes(1)
    const r = await h.bridge.callTool('card', cardArgs())
    const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(r.content[0]?.text ?? '')?.[1]
    const card = (await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
    await h.app.resolveCard(card, 'primary', card.payload_hash)
    await h.waitNotes(2)
    expect(h.notes[1]?.meta.kind).toBe('card_action')
    expect(h.notes[1]?.meta.local_time).toBeDefined()
    expect(h.notes[1]?.meta.since_last).toBeUndefined()
  })

  test('a config card decision has local_time and no since_last', async () => {
    h = await startHarness({
      relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] },
      config: (c) => ({ ...c, timezone: 'UTC' }),
    })
    await h.app.sendMessage('general', 'please change my settings', { ts: iso(Date.now() - 20 * 60_000) })
    await h.waitNotes(1)
    const r = await h.bridge.callTool('config_propose', {
      thread_id: 'general',
      reason: 'you asked',
      changes: [{ path: 'agent.name', value: 'Hal' }],
    })
    expect(r.isError, r.content[0]?.text).toBeFalsy()
    const id = /card (c_\S+) pending/.exec(r.content[0]?.text ?? '')?.[1]
    const card = (await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
    await h.app.resolveCard(card, 'kill', card.payload_hash)
    await h.waitNotes(2)
    expect(h.notes[1]?.meta.kind).toBe('card_action')
    expect(h.notes[1]?.meta.local_time).toBeDefined()
    expect(h.notes[1]?.meta.since_last).toBeUndefined()
  })

  test('the instructions say exactly that', () => {
    expect(INSTRUCTIONS).toContain('A typed message, a voice note or a Run tap also carries `since_last`')
    expect(INSTRUCTIONS).toContain('card decisions, spoken questions on a call, and config or schedule cards do not')
  })
})

describe('the self-map', () => {
  test('native iPhone changes need a TestFlight build', () => {
    const t = selfMapBlock({ bridgeDir: '/home/alex/talos-app' }, '/home/alex')
    expect(t).toContain('apps/mobile/ios')
    expect(t).toContain('share extension')
    expect(t).toContain('entitlements')
    expect(t).toContain('TestFlight')
  })
  test('a dirty checkout is said; a clean one is not', () => {
    const dirty = selfMapBlock({ bridgeDir: '/home/alex/t', commit: 'abc1234', dirty: true }, '/home/alex')
    const clean = selfMapBlock({ bridgeDir: '/home/alex/t', commit: 'abc1234', dirty: false }, '/home/alex')
    expect(dirty).toContain('at commit abc1234 (with uncommitted changes)')
    expect(clean).toContain('at commit abc1234.')
    expect(clean).not.toContain('uncommitted')
    expect(
      agentInstructions({ worker: false, trust: false, self: { bridgeDir: '/x', commit: 'abc1234', dirty: true } }),
    ).toContain('uncommitted')
  })
  test('a HOME with a trailing slash (or several) still shortens the path', () => {
    for (const home of ['/home/alex/', '/home/alex//', '/home/alex'])
      expect(selfMapBlock({ bridgeDir: '/home/alex/talos-app' }, home)).toContain('runs from ~/talos-app')
    expect(selfMapBlock({ bridgeDir: '/srv/alexa/talos-app' }, '/srv/alex/')).toContain('/srv/alexa/talos-app')
  })
})
