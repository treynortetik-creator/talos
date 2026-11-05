// Review of PR #100 (v6 follow-ups), bridge part. Real Bridge + FakeRelay + FakeApp: every frame travels app -> relay ->
// bridge as in production. Each test names the finding it pins; every one was run red against the code before its fix.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CardT,
  createDeviceKey,
  HISTORY_UPDATE_APP_MESSAGE,
  MEDIA_FETCH_UPDATE_APP_MESSAGE,
  newId,
  newUlid,
  signOwnerFrame,
} from '@talos-app/protocol'
import { viewMessage } from '../src/apps/views.ts'
import { columnsOf } from '../src/search/columns.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'
import { longTimeouts, type SchedHarness, startSched } from './schedules/harness.ts'

longTimeouts()

let h: Harness | SchedHarness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const errsFor = (x: Harness, id: string) =>
  x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'error' && r.raw.ref === id)
const seenCount = (x: Harness) =>
  (x.bridge.ctx.store.db.query('SELECT COUNT(*) AS n FROM seen_ids').get() as { n: number }).n

/** An attachment the Mac knows (so media.fetch can re-upload it), removed from the relay's blob store. */
async function evictedMedia(x: Harness, bytes: string) {
  const p = join(x.home, 'media', 'old.txt')
  writeFileSync(p, bytes)
  await x.bridge.callTool('attach', { thread_id: 'general', path: p })
  const f = await x.relay.expectFrame('reply', (r) => r.message.kind === 'file', { direction: 'from_bridge' })
  const id = f.message.attachments[0]?.media_id as string
  x.relay.media.delete(id)
  return id
}

describe('media.fetch is a signed read (finding 1)', () => {
  test('an unsigned fetch uploads nothing and gets the fixed "update the app" answer', async () => {
    h = await startHarness()
    const id = await evictedMedia(h, 'SECRET-FILE-BYTES')
    const fid = newUlid()
    h.relay.sendToBridge(
      { v: 1, id: fid, ts: new Date().toISOString(), type: 'media.fetch', media_id: id },
      { durable: false },
    )
    await waitFor(() => errsFor(h as Harness, fid).length === 1, 3000, 'the refusal')
    await sleep(300)
    expect(h.relay.media.has(id)).toBe(false)
    const e = errsFor(h, fid)[0]?.raw as { code: string; message: string }
    expect(e.code).toBe('bad_frame')
    expect(e.message).toBe(MEDIA_FETCH_UPDATE_APP_MESSAGE)
  })

  test('a signature over another media id, or from an unpinned key, uploads nothing', async () => {
    h = await startHarness()
    const id = await evictedMedia(h, 'SECRET-FILE-BYTES')
    // signed for one id, the relay swaps in the one it wants
    const good = await h.app.buildMediaFetch(newId('md'))
    const swapped = { ...good, media_id: id }
    // a valid signature by a device the Mac never pinned
    const stranger = await createDeviceKey()
    const unpinned = await signOwnerFrame(
      {
        v: 1,
        id: newUlid(),
        ts: new Date().toISOString(),
        type: 'media.fetch',
        media_id: id,
        device_id: stranger.deviceId,
      },
      stranger.privateKey,
    )
    for (const f of [swapped, unpinned]) h.relay.sendToBridge(f, { durable: false })
    await waitFor(
      () => errsFor(h as Harness, swapped.id).length + errsFor(h as Harness, unpinned.id).length === 2,
      3000,
    )
    await sleep(300)
    expect(h.relay.media.has(id)).toBe(false)
    for (const f of [swapped, unpinned]) expect(errsFor(h, f.id).map((r) => r.raw.code)).toEqual(['sig_invalid'])
  })

  test('a signed fetch re-uploads once; the same bytes again are refused and upload nothing', async () => {
    h = await startHarness()
    const id = await evictedMedia(h, 'SECRET-FILE-BYTES')
    const req = await h.app.buildMediaFetch(id)
    h.relay.sendToBridge(req, { durable: false })
    await waitFor(() => (h as Harness).relay.media.has(id), 3000, 're-upload')
    expect(new TextDecoder().decode(h.relay.media.get(id)?.bytes)).toBe('SECRET-FILE-BYTES')
    h.relay.media.delete(id)
    h.relay.sendToBridge(req, { durable: false })
    await waitFor(() => errsFor(h as Harness, req.id).length === 1, 3000, 'the replay refusal')
    await sleep(300)
    expect(h.relay.media.has(id)).toBe(false)
  })
})

describe('a failed read is answered and forgotten (finding 3, seen_ids growth)', () => {
  test('forged history.request and media.fetch frames add no seen_ids rows; a valid one adds exactly one', async () => {
    h = await startHarness()
    const before = seenCount(h)
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      const hist = await h.app.buildHistoryRequest('general', { limit: 5 })
      const media = await h.app.buildMediaFetch(newId('md'))
      for (const f of [hist, media]) {
        ids.push(f.id)
        h.relay.sendToBridge({ ...f, osig: `${f.osig.slice(0, -4)}AAAA` }, { durable: false })
      }
    }
    await waitFor(() => ids.every((i) => errsFor(h as Harness, i).length === 1), 8000, 'every refusal')
    expect(seenCount(h)).toBe(before)
    const ok = await h.app.buildHistoryRequest('general', { limit: 5 })
    h.relay.sendToBridge(ok, { durable: false })
    await h.relay.expectFrame('history.page', (f) => f.request_id === ok.request_id, { direction: 'from_bridge' })
    expect(seenCount(h)).toBe(before + 1)
  })
})

describe('an unparseable history.request is not a seen-id oracle (finding 7)', () => {
  test('a seen id and an unseen id get the same single answer', async () => {
    h = await startHarness()
    const used = await h.app.buildHistoryRequest('general', { limit: 5 })
    h.relay.sendToBridge(used, { durable: false })
    await h.relay.expectFrame('history.page', (f) => f.request_id === used.request_id, { direction: 'from_bridge' })
    const junk = (id: string, extra: Record<string, unknown> = {}) => ({
      v: 1,
      id,
      ts: new Date().toISOString(),
      type: 'history.request',
      request_id: newUlid(),
      thread_id: 'general',
      limit: 9999, // refused by the schema
      ...extra,
    })
    const fresh = newUlid()
    h.relay.sendToBridge(junk(used.id), { durable: false })
    h.relay.sendToBridge(junk(fresh), { durable: false })
    await waitFor(() => errsFor(h as Harness, used.id).length >= 1 && errsFor(h as Harness, fresh).length >= 1, 3000)
    await sleep(200)
    const a = errsFor(h, used.id).map((r) => r.raw)
    const b = errsFor(h, fresh).map((r) => r.raw)
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(a[0]?.code).toBe(b[0]?.code)
    expect(a[0]?.message).toBe(b[0]?.message)
    // unsigned and unparseable: the same fixed "update the app" answer as an unsigned valid request
    expect((a[0] as { message: string }).message).toBe(HISTORY_UPDATE_APP_MESSAGE)
    expect(seenCount(h)).toBe(1) // only the one valid request
  })
})

describe('the stand-in for a row too large for a page keeps its seq (finding 2)', () => {
  test('a 40,000-char row at seq 40 pages back with seq 40, so it sorts below the live rows', async () => {
    h = await startHarness()
    const store = h.bridge.ctx.store
    const row = (text: string, seq: number, id = newId('m')) => ({
      id,
      thread_id: 'general',
      author: 'agent' as const,
      kind: 'text' as const,
      text,
      format: 'plain' as const,
      attachments: [],
      via: 'app' as const,
      created_at: new Date(Date.now() - (200 - seq) * 1000).toISOString(),
      seq,
    })
    const big = row('x'.repeat(40_000), 40)
    store.addMessage(big)
    store.addMessage(row('small', 41))
    const req = await h.app.buildHistoryRequest('general', { limit: 10, before_seq: 100 })
    h.relay.sendToBridge(req, { durable: false })
    const page = await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
      direction: 'from_bridge',
    })
    const stand = page.messages.find((m) => m.id === big.id)
    expect(stand?.text).toContain('too large')
    expect(stand?.seq).toBe(40)
  })
})

describe('before_seq paging uses the (thread, seq) index (finding 8)', () => {
  test('the SQL page() issues for a seq cursor has no temp b-tree, and the rows come back in seq order', () => {
    // no relay needed: the real store
    return (async () => {
      h = await startHarness()
      const store = h.bridge.ctx.store
      for (let i = 1; i <= 30; i++)
        store.addMessage({
          id: newId('m'),
          thread_id: 'general',
          author: 'agent',
          kind: 'text',
          text: `m${i}`,
          format: 'plain',
          attachments: [],
          via: 'app',
          created_at: new Date(Date.now() - (31 - i) * 1000).toISOString(),
          seq: i,
        })
      const sql: string[] = []
      const db = store.db as unknown as { query: (s: string) => unknown }
      const orig = db.query.bind(db)
      db.query = (s: string) => {
        sql.push(s)
        return orig(s)
      }
      const page = store.page({ thread_id: 'general', limit: 5, beforeSeq: 21 })
      db.query = orig
      expect(page.messages.map((m) => m.seq)).toEqual([16, 17, 18, 19, 20])
      expect(page.hasMore).toBe(true)
      const pageSql = sql.find((s) => /FROM messages WHERE/.test(s)) as string
      const plan = store.db
        .query(`EXPLAIN QUERY PLAN ${pageSql}`)
        .all('general', 21, 6)
        .map((r) => String((r as { detail: string }).detail))
        .join(' | ')
      expect(plan).toContain('messages_seq')
      expect(plan).not.toContain('TEMP B-TREE')
    })()
  })
})

describe('app rows are searchable by label and tool (finding 13)', () => {
  test('the card column of a real viewMessage row holds its label and tool name, never its inputs', async () => {
    h = await startHarness()
    const app = {
      view_id: `vw_${newUlid()}`,
      thread_id: 'general',
      label: 'Weather Board',
      server: 'weather',
      tool: 'get_forecast',
      resource_uri: 'ui://weather/board',
      approval_key: 'a'.repeat(64),
      page: {
        media_id: newId('md'),
        kind: 'html',
        role: 'attachment',
        mime: 'text/html',
        name: 'p.html',
        size: 1,
        sha256: 'b'.repeat(64),
      },
      csp: {},
      tool_input: { city: 'SECRET-CITY' },
      tool_result: { content: [{ type: 'text', text: 'SECRET-RESULT' }] },
      calls_until: new Date(Date.now() + 86_400_000).toISOString(),
      shown_at: new Date().toISOString(),
    }
    // biome-ignore lint/suspicious/noExplicitAny: a hand-built view
    const m = viewMessage(h.bridge.ctx, app as any)
    const c = columnsOf(m)
    expect(c.card).toContain('Weather Board')
    expect(c.card).toContain('get_forecast')
    expect(c.card).not.toContain('SECRET')
    expect(c.text).toBe('')
  })
})

describe('B2 follow-ups: who counts as "the owner just spoke" (findings 14 and 15)', () => {
  const ownerRow = (s: SchedHarness, thread: string, text: string, over: Record<string, unknown> = {}) => ({
    id: newId('m'),
    thread_id: thread,
    author: 'owner' as const,
    kind: 'text' as const,
    text,
    format: 'plain' as const,
    attachments: [],
    via: 'app' as const,
    created_at: new Date(s.clock.now()).toISOString(),
    ...over,
  })
  const propose = async (s: SchedHarness, thread: string) => {
    const res = await s.bridge.callTool('schedule_propose', {
      op: 'create',
      thread_id: thread,
      reason: 'Because.',
      name: 'Quiet one',
      id: 'quiet-one',
      when: { type: 'weekdays', time: '22:00' },
      prompt: 'Do the thing.\n',
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const id = /card (c_[0-9A-HJKMNP-TV-Z]{26}) pending/.exec(res.content[0]?.text ?? '')?.[1]
    const cc = await s.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
    return (cc.card as CardT).origin
  }
  const shareRow = (s: SchedHarness) =>
    ownerRow(s, 'inbox', 'save this', { via: 'share', share_content: { url: 'https://example.com/a', title: 'A' } })

  test('control: the owner spoke in general, nothing else happened -> chat', async () => {
    const s = await startSched()
    h = s
    s.bridge.ctx.store.addMessage(ownerRow(s, 'general', 'set me up a quiet job'))
    expect(await propose(s, 'general')).toBe('chat')
  })

  test('14: owner words in general do not vouch for a proposal after a token share in inbox', async () => {
    const s = await startSched()
    h = s
    s.bridge.ctx.store.addMessage(ownerRow(s, 'general', 'about something else entirely'))
    await s.advance(60_000)
    s.bridge.ctx.store.addMessage(shareRow(s))
    expect(await propose(s, 'general')).toBe('background')
  })

  test('14: a share that came BEFORE the owner spoke does not demote the proposal', async () => {
    const s = await startSched()
    h = s
    s.bridge.ctx.store.addMessage(shareRow(s))
    await s.advance(60_000)
    s.bridge.ctx.store.addMessage(ownerRow(s, 'general', 'ok, do it'))
    expect(await propose(s, 'general')).toBe('chat')
  })

  test('15: a signed share with an empty note is not the owner speaking', async () => {
    const s = await startSched()
    h = s
    // exactly what the /share page sends: a signed message, text = the (empty) note, the material in share_content
    s.bridge.ctx.store.addMessage(
      ownerRow(s, 'general', '', { share_content: { url: 'https://example.com/a', title: 'A' } }),
    )
    expect(await propose(s, 'general')).toBe('background')
  })

  test('15: a signed share of files only (no note, no material) is not the owner speaking', async () => {
    const s = await startSched()
    h = s
    // the /share page marks every share with share_content, even an empty one; a bare PDF has no note and no material
    s.bridge.ctx.store.addMessage(
      ownerRow(s, 'general', '', {
        kind: 'file',
        share_content: {},
        attachments: [
          {
            media_id: newId('md'),
            kind: 'file',
            role: 'attachment',
            mime: 'application/pdf',
            name: 'a.pdf',
            size: 3,
            sha256: 'a'.repeat(64),
          },
        ],
      }),
    )
    expect(await propose(s, 'general')).toBe('background')
  })

  test('15: a voice note (empty text, no share_content) IS the owner speaking', async () => {
    const s = await startSched()
    h = s
    s.bridge.ctx.store.addMessage(ownerRow(s, 'general', '', { kind: 'voice_turn' }))
    expect(await propose(s, 'general')).toBe('chat')
  })

  test('15: the same share WITH a typed note is the owner speaking', async () => {
    const s = await startSched()
    h = s
    s.bridge.ctx.store.addMessage(
      ownerRow(s, 'general', 'file this under receipts', {
        share_content: { url: 'https://example.com/a', title: 'A' },
      }),
    )
    expect(await propose(s, 'general')).toBe('chat')
  })
})
