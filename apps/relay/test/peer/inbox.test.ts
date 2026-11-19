// Linked agents P2: the peer inbox (/hook/peer/:connId) against the REAL relay, on a fake clock. A message that passes becomes
// one durable `peer.message` frame for the Mac and nothing else: no card, no inbox row, no push, no stored raw body.
import { readFileSync } from 'node:fs'
import { signStandard } from '@talos-app/integrations'
import { type PeerMessageT, parseFrame } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { silentBridge } from '../core/helpers.ts'
import { type PeerWorld, peerWorld } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let w: PeerWorld | null = null
afterEach(async () => {
  await w?.r.stop()
  w = null
})
const world = async (env: Record<string, string> = {}) => {
  w = await peerWorld(env)
  return w
}
const frames = (b: Awaited<ReturnType<typeof silentBridge>>) => b.received.filter((f) => f.type === 'peer.message')
const err = async (res: Response) => ((await res.json()) as { error?: string }).error

describe('an accepted message', () => {
  it('becomes one peer.message frame with the connection name, the message whole and the receive time', async () => {
    const x = await world()
    const c = await x.create('work')
    const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    const m = x.msg({ from: 'someone-else', text: 'run the report', label: 'TASK', chain: 2, from_peer_task: true })
    const res = await x.send(c, m)
    expect(res.status).toBe(200)
    await waitFor(() => frames(b).length >= 1, 10_000, 'peer.message')
    await b.sync()
    expect(frames(b)).toHaveLength(1)
    const f = frames(b)[0] as Record<string, unknown>
    expect(f).toMatchObject({
      type: 'peer.message',
      conn_id: c.conn_id,
      peer: 'work', // the connection's configured name, not the sender's claim in `from`
      msg: m,
      received_at: '2026-11-18T12:00:00.000Z',
    })
    expect(parseFrame(f, { direction: 'relay_to_bridge' }).ok).toBe(true)
    expect(parseFrame(f, { direction: 'relay_to_app' }).ok).toBe(false)
    await b.close()
  })

  it('carries 8 KB of multi-byte text byte for byte', async () => {
    const x = await world()
    const c = await x.create('work')
    const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    // 2725 x U+20AC (3 bytes) + one 4-byte emoji + a combining accent + RTL text = 8190 bytes of non-trivial UTF-8
    const text = `${'€'.repeat(2725)}\u{1F600}éשלום`
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192)
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(8100)
    const m = x.msg({ text })
    expect((await x.send(c, m)).status).toBe(200)
    await waitFor(() => frames(b).length >= 1, 10_000, 'peer.message')
    const got = (frames(b)[0] as { msg: PeerMessageT }).msg.text
    expect(Buffer.from(got).equals(Buffer.from(text))).toBe(true)
    await b.close()
  })

  it('leaves nothing else behind: no event, no raw body, no card or inbox row for the apps, no push', async () => {
    const x = await world()
    const c = await x.create('work')
    expect((await x.send(c, x.msg())).status).toBe(200)
    expect(x.storedTypes()).toEqual(['peer.message'])
    expect(x.count('hooks_events')).toBe(0)
    expect(x.count('hooks_inbound')).toBe(0) // the raw body is not kept at all, so `GET /bridge/raw/:id` has nothing to read
    expect(x.r.transport.sent).toHaveLength(0)
    const row = x.r.relay.services.db.prepare('select audience from core_events').get() as { audience: string }
    expect(row.audience).toBe('bridge')
  })

  it('does not put the text where the delivery list or the logs read it', async () => {
    const x = await world()
    const c = await x.create('work')
    await x.send(c, x.msg({ text: 'a-very-particular-sentence' }))
    const rows = JSON.stringify(x.r.relay.services.db.prepare('select * from hooks_deliveries').all())
    expect(rows).not.toContain('a-very-particular-sentence')
    const dump = x.r.relay.services.db.prepare('select body from core_events').all() as Array<{ body: Buffer }>
    expect(Buffer.concat(dump.map((d) => d.body)).includes('a-very-particular-sentence')).toBe(false) // sealed at rest
  })
})

describe('what is refused', () => {
  it('a header id that is not the body id: 400 id_mismatch, nothing stored', async () => {
    const x = await world()
    const c = await x.create('work')
    const res = await x.send(c, x.msg(), { id: x.msg().id })
    expect(res.status).toBe(400)
    expect(await err(res)).toBe('id_mismatch')
    expect(x.count('core_events')).toBe(0)
    expect(x.count('hooks_dedup')).toBe(0)
  })

  it('a body that is not a PeerMessage: 400 bad_body, nothing stored', async () => {
    const x = await world()
    const c = await x.create('work')
    for (const body of [
      '{not json',
      '[]',
      JSON.stringify({ ...x.msg(), extra: 1 }),
      JSON.stringify({ ...x.msg(), text: 'a‮b' }),
      JSON.stringify({ ...x.msg(), text: 'x'.repeat(8193) }),
      JSON.stringify({ ...x.msg(), chain: 7 }),
      '',
    ]) {
      const res = await x.send(c, body, { id: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD' })
      expect(res.status, body.slice(0, 40)).toBe(400)
      expect(await err(res)).toBe('bad_body')
    }
    expect(x.count('core_events')).toBe(0)
    expect(x.count('hooks_dedup')).toBe(0)
    expect(x.count('hooks_inbound')).toBe(0)
  })

  it('a stale or far-future timestamp: 401', async () => {
    const x = await world()
    const c = await x.create('work')
    const now = Math.floor(x.clock.now() / 1000)
    expect((await x.send(c, x.msg(), { tsS: now - 301 })).status).toBe(401)
    expect((await x.send(c, x.msg(), { tsS: now + 301 })).status).toBe(401)
    expect((await x.send(c, x.msg(), { tsS: now - 290 })).status).toBe(200)
    expect(x.count('core_events')).toBe(1)
  })

  it('a bad signature: 401, and counted in the bad-signature bucket (21st in a minute: 429, one summary row)', async () => {
    const x = await world()
    const c = await x.create('work')
    const other = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
    const codes: number[] = []
    for (let i = 0; i < 21; i++) codes.push((await x.send(c, x.msg(), { secret: other })).status)
    expect(codes.slice(0, 20).every((s) => s === 401)).toBe(true)
    expect(codes[20]).toBe(429)
    const reasons = x.r.relay.services.db.prepare('select reason from hooks_deliveries').all() as Array<{
      reason: string
    }>
    expect(reasons.filter((r) => r.reason === 'signature_mismatch')).toHaveLength(20)
    expect(reasons.filter((r) => r.reason === 'bad_signature_flood')).toHaveLength(1)
    // a real sender is not charged for the junk: its verified message still lands
    expect((await x.send(c, x.msg())).status).toBe(200)
    expect(x.count('core_events')).toBe(1)
  })

  it('missing headers: 401', async () => {
    const x = await world()
    const c = await x.create('work')
    const res = await fetch(`${x.r.httpBase}/hook/peer/${c.conn_id}`, { method: 'POST', body: JSON.stringify(x.msg()) })
    expect(res.status).toBe(401)
    expect(x.count('core_events')).toBe(0)
  })

  it('a Bearer token is not a credential here, with or without Standard Webhooks headers', async () => {
    const x = await world()
    const c = await x.create('work')
    const m = x.msg()
    const bearer = { authorization: `Bearer ${c.secret}` }
    const plain = await fetch(`${x.r.httpBase}/hook/peer/${c.conn_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify(m),
    })
    expect(plain.status).toBe(401)
    // a bad signature next to a good Bearer is still a bad signature
    const mixed = await x.send(c, m, { secret: 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', headers: bearer })
    expect(mixed.status).toBe(401)
    expect(x.count('core_events')).toBe(0)
  })
})

describe('Standard Webhooks vectors (packages/protocol/fixtures/peer-message/headers.json)', () => {
  type Case = {
    name: string
    now_ms: number
    headers: Record<string, string>
    body: string
    seen_ids: string[]
    secrets?: Array<'current' | 'previous'>
    expect: { result: 'accepted' | 'refused' | 'duplicate'; reason?: string }
  }
  const file = JSON.parse(
    readFileSync(new URL('../../../../packages/protocol/fixtures/peer-message/headers.json', import.meta.url), 'utf8'),
  ) as { secret: string; secret_previous: string; cases: Case[] }

  for (const c of file.cases)
    it(c.name, async () => {
      const x = await world()
      const made = await x.create('work')
      x.clock.set(c.now_ms)
      // install the fixture's secrets as the connection's own (current, and the rotated one for its grace)
      const aad = `hooks_connections:${made.conn_id}`
      const seal = (s: string, purpose: string) =>
        Buffer.from(x.r.relay.services.crypto.encrypt(new TextEncoder().encode(s), `${aad}:${purpose}`))
      const has = c.secrets ?? ['current']
      const db = x.r.relay.services.db
      db.prepare(
        'update hooks_connections set secret_enc = ?, old_secret_enc = ?, old_secret_expires_at = ? where id = ?',
      ).run(
        seal(has.includes('current') ? file.secret : file.secret_previous, 'secret'),
        has.includes('previous') && has.includes('current') ? seal(file.secret_previous, 'old_secret') : null,
        has.includes('previous') && has.includes('current') ? c.now_ms + 3600_000 : null,
        made.conn_id,
      )
      for (const id of c.seen_ids) {
        // a duplicate case: the same delivery already went through once
        const first = await fetch(`${x.r.httpBase}/hook/peer/${made.conn_id}`, {
          method: 'POST',
          headers: c.headers,
          body: c.body,
        })
        expect(first.status).toBe(200)
        expect(id).toBe(c.headers['webhook-id'])
      }
      const before = x.count('core_events')
      const res = await fetch(`${x.r.httpBase}/hook/peer/${made.conn_id}`, {
        method: 'POST',
        headers: c.headers,
        body: c.body,
      })
      const added = x.count('core_events') - before
      if (c.expect.result === 'accepted') {
        expect(res.status).toBe(200)
        expect(added).toBe(1)
      } else if (c.expect.result === 'duplicate') {
        expect(res.status).toBe(200)
        expect(added).toBe(0)
        expect(x.count('core_events')).toBe(1)
      } else {
        expect(res.status).toBe(c.expect.reason === 'id_mismatch' ? 400 : c.expect.reason === 'bad_body' ? 400 : 401)
        if (c.expect.reason === 'id_mismatch' || c.expect.reason === 'bad_body')
          expect(await err(res)).toBe(c.expect.reason)
        expect(added).toBe(0)
      }
    })
})

describe('PeerMessage body vectors (packages/protocol/fixtures/peer-message/vectors.json)', () => {
  type Vec = { name: string; ok: boolean; body?: unknown; body_json?: string }
  const vectors = (
    JSON.parse(
      readFileSync(
        new URL('../../../../packages/protocol/fixtures/peer-message/vectors.json', import.meta.url),
        'utf8',
      ),
    ) as { cases: Vec[] }
  ).cases

  it('the inbox takes exactly the bodies the schema takes (one connection, all cases)', async () => {
    const x = await world()
    const c = await x.create('work', 500)
    const db = x.r.relay.services.db
    const wrong: string[] = []
    for (const v of vectors) {
      const raw = v.body_json ?? JSON.stringify(v.body)
      const parsedId = (() => {
        try {
          const j = JSON.parse(raw) as { id?: unknown }
          return typeof j.id === 'string' && j.id.length <= 200 ? j.id : 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD'
        } catch {
          return 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD'
        }
      })()
      db.prepare('delete from hooks_dedup').run() // the vectors reuse one id: each case is its own first delivery
      const res = await x.send(c, raw, { id: parsedId, raw })
      if ((res.status === 200) !== v.ok) wrong.push(`${v.name}: ${res.status}`)
      if (!v.ok && res.status !== 400) wrong.push(`${v.name}: refused with ${res.status}, want 400`)
    }
    expect(wrong).toEqual([])
  })
})

describe('duplicates and the daily cap', () => {
  it('a duplicate webhook-id is 2xx and delivers nothing again', async () => {
    const x = await world()
    const c = await x.create('work')
    const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    const m = x.msg()
    expect((await x.send(c, m)).status).toBe(200)
    expect((await x.send(c, m)).status).toBe(200)
    x.clock.advance(60_000)
    expect((await x.send(c, m)).status).toBe(200) // a retry with a newer timestamp, the same id
    await b.sync()
    // (the 60 s step also fires the unacked frame's timed resends: the same frame id again, never a second frame)
    expect(new Set(frames(b).map((f) => f.id)).size).toBe(1)
    expect(x.count('core_events')).toBe(1)
    const reasons = x.r.relay.services.db.prepare('select reason from hooks_deliveries').all() as Array<{
      reason: string
    }>
    expect(reasons.filter((r) => r.reason === 'duplicate')).toHaveLength(1) // one row a minute
    await b.close()
  })

  it("the dedupe key is the connection's own: another peer may use the same id", async () => {
    const x = await world()
    const a = await x.create('work')
    const h = await x.create('home')
    const m = x.msg()
    expect((await x.send(a, m)).status).toBe(200)
    expect((await x.send(h, m)).status).toBe(200)
    expect(x.count('core_events')).toBe(2)
  })

  it('accepts daily_cap messages a UTC day and answers 429 daily_cap on the next, with an audit row and nothing stored', async () => {
    const x = await world()
    const c = await x.create('work', 3)
    for (let i = 0; i < 3; i++) expect((await x.send(c, x.msg())).status).toBe(200)
    const fourth = x.msg()
    const res = await x.send(c, fourth)
    expect(res.status).toBe(429)
    expect(await err(res)).toBe('daily_cap')
    expect(x.count('core_events')).toBe(3)
    const rows = x.r.relay.services.db
      .prepare("select status, reason from hooks_deliveries where reason = 'daily_cap'")
      .all()
    expect(rows).toEqual([{ status: 429, reason: 'daily_cap' }])
    // the sender's retry lands tomorrow: the refused id was never recorded as seen
    x.clock.set(x.clock.now() + 12 * 3600_000) // moved, not replayed (setup.test.ts, the rotate test)
    expect((await x.send(c, fourth)).status).toBe(200)
    expect(x.count('core_events')).toBe(4)
  })

  it('a duplicate past the cap is 2xx, not 429', async () => {
    const x = await world()
    const c = await x.create('work', 1)
    const m = x.msg()
    expect((await x.send(c, m)).status).toBe(200)
    expect((await x.send(c, m)).status).toBe(200)
    expect((await x.send(c, x.msg())).status).toBe(429)
    expect(x.count('core_events')).toBe(1)
  })

  it('the cap is per connection', async () => {
    const x = await world()
    const a = await x.create('work', 1)
    const h = await x.create('home', 1)
    expect((await x.send(a, x.msg())).status).toBe(200)
    expect((await x.send(a, x.msg())).status).toBe(429)
    expect((await x.send(h, x.msg())).status).toBe(200)
  })
})

describe('a row that is not a peer inbox', () => {
  it('a `peer` connection the bridge route did not make is refused like an unknown one', async () => {
    const x = await world()
    const rt = (await import('../../src/hooks/runtime.ts')).runtimeFor(x.r.relay.services)
    const { insertConn } = await import('../../src/hooks/store.ts')
    const extras: Array<Record<string, string>> = [
      {},
      { peer: 'v0' },
      { daily_cap: '50' },
      { peer: 'yes' },
      { peer: 'v1' },
      { peer: 'v1', daily_cap: '0' },
    ]
    for (const extra of extras) {
      const made = insertConn(rt, {
        integration: 'peer',
        name: 'work',
        thread: 'inbox',
        filters: {},
        advanced: [],
        extra,
        creds: {},
      })
      x.clock.advance(61_000) // the unknown-connection throttle is 5 misses a minute
      const res = await x.send({ conn_id: made.id, secret: made.secret }, x.msg())
      expect(res.status, JSON.stringify(extra)).toBe(404)
    }
    expect(x.count('core_events')).toBe(0)
    expect(x.count('hooks_dedup')).toBe(0)
  })

  it("a connection of another integration cannot be used as a peer inbox, and a peer id is no other integration's", async () => {
    const x = await world()
    const c = await x.create('work')
    const m = x.msg()
    const headers = signStandard({
      secret: c.secret,
      id: m.id,
      timestampS: Math.floor(x.clock.now() / 1000),
      body: JSON.stringify(m),
    })
    const res = await fetch(`${x.r.httpBase}/hook/generic/${c.conn_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(m),
    })
    expect(res.status).toBe(404)
    expect(x.count('core_events')).toBe(0)
  })
})

describe('the Mac asleep', () => {
  it('a message that lands while the bridge is away is delivered once on reconnect, and not again after the ack', async () => {
    const x = await world()
    const c = await x.create('work')
    const m = x.msg()
    expect(x.r.runtime.hub.bridgeOnline()).toBe(false)
    expect((await x.send(c, m)).status).toBe(200)
    const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    await waitFor(() => frames(b).length >= 1, 10_000, 'peer.message on reconnect')
    await b.sync()
    expect(frames(b)).toHaveLength(1)
    const id = (frames(b)[0] as { id: string }).id
    expect((frames(b)[0] as { msg: PeerMessageT }).msg).toEqual(m)
    b.ack(id, 'delivered')
    b.ack(id, 'consumed')
    await b.sync()
    await b.close()
    const again = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    await again.sync()
    expect(frames(again)).toHaveLength(0)
    await again.close()
  })

  it('an unacked frame is resent, then stops once the Mac has it', async () => {
    const x = await world()
    const c = await x.create('work')
    const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    await x.send(c, x.msg())
    await waitFor(() => frames(b).length >= 1, 10_000, 'first send')
    const id = (frames(b)[0] as { id: string }).id
    x.clock.advance(5_000)
    await waitFor(() => frames(b).length >= 2, 10_000, 'resend')
    b.ack(id, 'consumed')
    await b.sync()
    const n = frames(b).length
    x.clock.advance(60_000)
    await b.sync()
    expect(frames(b)).toHaveLength(n)
    await b.close()
  })
})

describe('a failed hand-off to the outbox', () => {
  it("rolls the seen mark and the count back with the frame, so the sender's retry is stored, not dropped as a duplicate", async () => {
    const x = await world()
    const c = await x.create('work', 1)
    const hub = x.r.runtime.hub
    const real = hub.toBridge.bind(hub)
    const spy = vi.spyOn(hub, 'toBridge').mockImplementationOnce(async (_f, opts) => {
      x.r.runtime.store.db.transaction(() => {
        ;(opts as { alsoWrite?: () => void }).alsoWrite?.()
        throw new Error('disk full')
      })()
      return { queued: false }
    })
    const m = x.msg()
    const first = await x.send(c, m)
    expect(first.status).toBeGreaterThanOrEqual(500)
    expect(x.count('hooks_dedup')).toBe(0)
    expect(x.count('core_events')).toBe(0)
    spy.mockImplementation(real)
    expect((await x.send(c, m)).status).toBe(200) // the cap of 1 was not spent by the failure
    expect(x.count('core_events')).toBe(1)
  })
})

describe('what the relay keeps', () => {
  it('a consumed peer.message leaves no event and no outbox row', async () => {
    const x = await world()
    const c = await x.create('work')
    const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
    await x.send(c, x.msg())
    await waitFor(() => frames(b).length >= 1, 10_000, 'peer.message')
    const id = (frames(b)[0] as { id: string }).id
    b.ack(id, 'delivered')
    b.ack(id, 'consumed')
    await b.sync()
    expect(x.count('core_events')).toBe(0)
    expect(x.count('core_outbox')).toBe(0)
    await b.close()
  })
})

describe('revoke purges what is still queued', () => {
  for (const how of ['the Mac route', 'the app delete'] as const)
    it(`${how}: a queued frame is never delivered after the revoke`, async () => {
      const x = await world()
      const c = await x.create('work')
      const keep = await x.create('home')
      await x.send(c, x.msg())
      await x.send(keep, x.msg())
      expect(x.count('core_events')).toBe(2)
      expect(x.r.runtime.hub.presence().queue_depth).toBe(2)
      const res =
        how === 'the Mac route'
          ? await x.mac('DELETE', '/bridge/peers/work')
          : await fetch(`${x.r.httpBase}/api/connections/${c.conn_id}`, {
              method: 'DELETE',
              headers: { ...x.r.appHeaders, 'content-type': 'application/json' },
            })
      expect(res.status).toBeLessThan(300)
      expect(x.count('core_events')).toBe(1) // the other peer's frame stays
      expect(x.count('core_outbox')).toBe(1)
      expect(x.count('hooks_peer_frames')).toBe(1)
      expect(x.r.runtime.hub.presence().queue_depth).toBe(1) // what an app shows as "waiting for the Mac" is not stale
      const b = await silentBridge(x.r, x.r.bridgeKey, 0, ['peer/1'])
      await waitFor(() => frames(b).length >= 1, 10_000, 'the other peer')
      await b.sync()
      expect(frames(b).map((f) => f.peer)).toEqual(['home'])
      await b.close()
    })
})

describe('refusals and limits of the peer inbox', () => {
  it('a body over 16 KiB is 413 and nothing is stored', async () => {
    const x = await world()
    const c = await x.create('work')
    const res = await x.send(c, 'x'.repeat(16 * 1024 + 1), { id: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD' })
    expect(res.status).toBe(413)
    expect(x.count('core_events')).toBe(0)
  })

  it('a refusal writes at most one audit row a minute per reason', async () => {
    const x = await world()
    const c = await x.create('work')
    for (let i = 0; i < 5; i++) await x.send(c, '{bad', { id: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD' })
    for (let i = 0; i < 5; i++) await x.send(c, x.msg(), { id: x.msg().id })
    const dup = x.msg()
    for (let i = 0; i < 4; i++) await x.send(c, dup)
    const rows = x.r.relay.services.db.prepare('select reason from hooks_deliveries').all() as Array<{ reason: string }>
    expect(rows.filter((r) => r.reason === 'bad_body')).toHaveLength(1)
    expect(rows.filter((r) => r.reason === 'id_mismatch')).toHaveLength(1)
    expect(rows.filter((r) => r.reason === 'duplicate')).toHaveLength(1) // three duplicates, one row a minute
    x.clock.advance(61_000)
    await x.send(c, '{bad', { id: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD' })
    expect(
      (x.r.relay.services.db.prepare('select reason from hooks_deliveries').all() as Array<{ reason: string }>).filter(
        (r) => r.reason === 'bad_body',
      ),
    ).toHaveLength(2)
  })

  it('a peer row that is not active answers 404, never an unsigned 200', async () => {
    const x = await world()
    const c = await x.create('work')
    x.r.relay.services.db.prepare("update hooks_connections set status = 'paused'").run()
    const res = await fetch(`${x.r.httpBase}/hook/peer/${c.conn_id}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect((await x.send(c, x.msg())).status).toBe(404)
  })
})
