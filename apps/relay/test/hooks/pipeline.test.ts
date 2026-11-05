import { signStandard } from '@talos-app/integrations'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { expectValidFrames, framesOf, type Setup, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

async function conn(s: Setup, integration: 'generic' | 'gmail' = 'generic') {
  const c = await s.create(integration)
  if (c.secret) return { id: c.id as string, secret: c.secret as string }
  // Apps Script connections hand their secret over once, through the claim route.
  const res = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/hook/${integration}/${c.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claim_code: c.claim_code }),
  })
  return { id: c.id as string, secret: ((await res.json()) as { secret: string }).secret }
}
const nothingStored = (s: Setup) => {
  for (const t of ['hooks_events', 'hooks_inbound', 'hooks_dedup']) expect(s.count(t), t).toBe(0)
}

describe('POST /hook/:integration/:connection_id', () => {
  it('a signed generic webhook becomes an Inbox item, a bridge event and a push', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    const res = await s.send('generic', id, secret, {
      title: 'Deploy finished',
      summary: 'ok',
      url: 'https://example.com/d/1',
      priority: 'high',
    })
    expect(res.status).toBe(200)
    await s.drain()
    const item = framesOf(s.f.bus.toAppsLog, 'inbox.item')
    expect(item).toHaveLength(1)
    expect(item[0]?.item).toMatchObject({
      title: 'Deploy finished',
      state: 'new',
      thread: 'inbox',
      priority: 'high',
      source: 'generic',
    })
    expect(item[0]?.item.dedup_key).toBeUndefined() // the app never sees relay internals
    const ev = framesOf(s.f.bus.toBridgeLog, 'hook.event')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      delivery: 'live',
      event: { title: 'Deploy finished', kind: 'generic.event', raw_ref: expect.stringMatching(/^e_/) },
    })
    expect(s.f.bus.toBridgeLog[0]?.opts).toMatchObject({ durable: true })
    expect(s.f.push.intents).toEqual([{ template: 'reply', thread_id: 'inbox' }])
    expectValidFrames(s.f)
  })

  it('a low-priority event is stored and shown but earns no push', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    await s.send('generic', id, secret, { title: 'FYI' })
    await s.drain()
    expect(s.events()).toHaveLength(1)
    expect(s.f.push.intents).toEqual([])
  })

  it('accepts the Bearer form too', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    const res = await s.post('generic', id, '{"title":"x"}', { authorization: `Bearer ${secret}` })
    expect(res.status).toBe(200)
    await s.drain()
    expect(s.events()).toHaveLength(1)
  })

  it('401s a tampered body, wrong secret, missing headers and a stale timestamp; stores nothing; logs the reason', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    const body = '{"title":"x"}'
    const good = signStandard({ secret, id: 'm1', timestampS: Math.floor(s.f.clock.now() / 1000), body })
    const other = signStandard({
      secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
      id: 'm2',
      timestampS: Math.floor(s.f.clock.now() / 1000),
      body,
    })
    const stale = signStandard({ secret, id: 'm3', timestampS: Math.floor(s.f.clock.now() / 1000) - 3600, body })
    const cases: Array<[string, string, Record<string, string>]> = [
      ['signature_mismatch', `${body} `, good],
      ['signature_mismatch', body, other],
      ['missing_header', body, {}],
      ['stale_timestamp', body, stale],
    ]
    for (const [, b, h] of cases) {
      const res = await s.post('generic', id, b, h)
      expect(res.status).toBe(401)
      const text = await res.text()
      expect(text).not.toMatch(/mismatch|stale|missing|signature/i) // the reason never reaches the caller
    }
    await s.drain()
    nothingStored(s)
    const deliveries = (await (await s.api('GET', `/api/connections/${id}/deliveries`)).json()) as Array<{
      status: number
      reason?: string
    }>
    expect(deliveries.map((d) => d.reason).reverse()).toEqual(cases.map((c) => c[0]))
    expect(deliveries.every((d) => d.status === 401)).toBe(true)
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
  })

  it('a replayed delivery id is acknowledged and stored once', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    expect((await s.send('generic', id, secret, { title: 'a' }, { id: 'msg_same' })).status).toBe(200)
    expect((await s.send('generic', id, secret, { title: 'a' }, { id: 'msg_same' })).status).toBe(200)
    await s.drain()
    expect(s.events()).toHaveLength(1)
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1)
    expect(s.count('hooks_inbound')).toBe(1)
  })

  it('the same event in two different deliveries is stored once (event-level dedup)', async () => {
    const s = setup()
    const { id, secret } = await conn(s, 'gmail')
    const batch = {
      v: 1,
      items: [
        {
          message_id: 'mm1',
          subject: 'Hi',
          from: 'a@example.com',
          text: 't',
          date: new Date(s.f.clock.now()).toISOString(),
        },
      ],
    }
    await s.send('gmail', id, secret, batch)
    await s.send('gmail', id, secret, batch)
    await s.drain()
    expect(s.events()).toHaveLength(1)
  })

  it('413s a 1.1 MB body, whether or not content-length is honest', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    const big = `{"title":"${'x'.repeat(1_100_000)}"}`
    const headers = signStandard({ secret, id: 'big', timestampS: Math.floor(s.f.clock.now() / 1000), body: big })
    expect((await s.post('generic', id, big, headers)).status).toBe(413)
    const lying = await s.post('generic', id, big, { ...headers, 'content-length': '10' })
    expect(lying.status).toBe(413)
    await s.drain()
    nothingStored(s)
    // and just under the cap still works
    const ok = `{"title":"${'x'.repeat(900_000)}"}`
    const okRes = await s.send('generic', id, secret, ok)
    expect(okRes.status).toBe(200)
  })

  it('404s an unknown connection; the 6th miss in a minute is a 429; time heals it', async () => {
    const s = setup()
    const unknown = 'cn_zzzzzzzzzzzzzzzzzzzzzz'
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await s.post('generic', unknown, '{}')).status)
    expect(codes).toEqual([404, 404, 404, 404, 404, 429])
    s.f.clock.advance(61_000)
    expect((await s.post('generic', unknown, '{}')).status).toBe(404)
  })

  it('treats a wrong integration for a real id, or a malformed id, as unknown', async () => {
    const s = setup()
    const { id } = await conn(s)
    expect((await s.post('rss', id, '{}')).status).toBe(404)
    expect((await s.post('generic', 'not-an-id', '{}')).status).toBe(404)
    expect((await s.post('nonsense', id, '{}')).status).toBe(404)
  })

  it('answers GET (and anything but POST) with 405', async () => {
    const s = setup()
    const { id } = await conn(s)
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/hook/generic/${id}`, { method })
      expect(res.status, method).toBe(405)
    }
  })

  it('a paused connection answers 200 and drops', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    expect((await s.api('PATCH', `/api/connections/${id}`, { status: 'paused' })).status).toBe(200)
    const res = await s.send('generic', id, secret, { title: 'x' })
    expect(res.status).toBe(200)
    await s.drain()
    nothingStored(s)
  })

  it('sheds past the per-connection hourly limit with 429 so the sender retries (nothing stored)', async () => {
    const s = setup()
    const { id, secret } = await conn(s)
    const now = s.f.clock.now()
    const ins = s.f.db.prepare("insert into hooks_deliveries (conn_id, at, status, reason) values (?, ?, 200, 'ok')")
    for (let i = 0; i < 600; i++) ins.run(id, now - 1000)
    const res = await s.send('generic', id, secret, { title: 'too many' })
    expect(res.status).toBe(429)
    await s.drain()
    nothingStored(s)
    const rows = s.f.db.prepare("select count(*) as n from hooks_deliveries where reason = 'over_limit'").get() as {
      n: number
    }
    expect(rows.n).toBe(1)
  })

  it('sheds with 429 when the raw payload store is over its share of the volume cap', async () => {
    const s = setup({ env: { VOLUME_SOFT_CAP_MB: '1' } })
    const { id, secret } = await conn(s)
    s.f.db
      .prepare(
        "insert into hooks_inbound (id, conn_id, received_at, headers, raw_enc, state) values ('hi_full', ?, ?, '{}', zeroblob(300000), 'done')",
      )
      .run(id, s.f.clock.now())
    expect((await s.send('generic', id, secret, { title: 'x' })).status).toBe(429)
    await s.drain()
    expect(s.events()).toHaveLength(0)
  })
})

describe('durable write first', () => {
  it('the row exists before the 200, encrypted, and survives a dead worker', async () => {
    const s = setup({ autoProcess: false })
    const { id, secret } = await conn(s)
    const res = await s.send('generic', id, secret, { title: 'survive-me-marker' })
    expect(res.status).toBe(200)
    // The worker never ran (killed): the delivery is still there, and nothing was normalized.
    const row = s.f.db.prepare('select raw_enc, state from hooks_inbound').get() as { raw_enc: Buffer; state: string }
    expect(row.state).toBe('pending')
    expect(Buffer.from(row.raw_enc).includes(Buffer.from('survive-me-marker'))).toBe(false) // ciphertext, not the payload
    expect(s.events()).toHaveLength(0)
    // A fresh process picks it up on its next tick.
    await s.tick()
    expect(s.events()).toHaveLength(1)
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')).toHaveLength(1)
  })

  it('a worker that throws leaves the row pending and gives up after five attempts', async () => {
    const boom = {
      ...(await import('@talos-app/integrations')).getIntegration('generic'),
      normalize: () => {
        throw new Error('boom')
      },
    }
    const s = setup({ modules: { generic: boom } })
    const { id, secret } = await conn(s)
    await s.send('generic', id, secret, { title: 'x' })
    await s.drain()
    const row = s.f.db.prepare('select state, attempts from hooks_inbound').get() as { state: string; attempts: number }
    expect(row).toEqual({ state: 'failed', attempts: 5 })
    expect(s.f.logs.some((l) => l.level === 'warn')).toBe(true)
    expect(JSON.stringify(s.f.logs)).not.toContain('boom') // error text is not logged, only its class
  })
})
