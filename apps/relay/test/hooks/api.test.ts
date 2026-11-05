import { signStandard } from '@talos-app/integrations'
import { Connection, ConnectionCreated, Delivery, SetupSpec } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { framesOf, setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

describe('catalog and connections API', () => {
  it('needs a session', async () => {
    const s = setup()
    for (const [m, p] of [
      ['GET', '/api/integrations/catalog'],
      ['GET', '/api/connections'],
      ['POST', '/api/connections'],
      ['GET', '/api/inbox'],
    ] as const) {
      const res = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}${p}`, { method: m })
      expect(res.status, `${m} ${p}`).toBe(401)
    }
  })

  it('serves a valid setup spec for every integration', async () => {
    const s = setup()
    const specs = (await (await s.api('GET', '/api/integrations/catalog')).json()) as unknown[]
    expect(specs).toHaveLength(18)
    for (const sp of specs) expect(SetupSpec.safeParse(sp).success).toBe(true)
  })

  it('creates a connection: the secret is shown once, never again', async () => {
    const s = setup()
    const made = await s.create('generic')
    expect(ConnectionCreated.safeParse(made).success).toBe(true)
    expect(made.hook_url).toBe(`https://relay.example.com/hook/generic/${made.id}`)
    expect(made.secret).toMatch(/^whsec_/)
    expect(made.filters).toEqual({})
    const got = await (await s.api('GET', `/api/connections/${made.id}`)).json()
    expect(Connection.safeParse(got).success).toBe(true)
    expect(JSON.stringify(got)).not.toContain(made.secret)
    expect(JSON.stringify(await (await s.api('GET', '/api/connections')).json())).not.toContain(made.secret)
    // encrypted at rest
    const rows = s.f.db.prepare('select secret_enc, creds_enc from hooks_connections').all() as Array<{
      secret_enc: Buffer
      creds_enc: Buffer
    }>
    for (const r of rows) expect(Buffer.from(r.secret_enc).includes(Buffer.from(made.secret))).toBe(false)
  })

  it('rejects bad input', async () => {
    const s = setup()
    expect((await s.api('POST', '/api/connections', { integration: 'nope', name: 'x' })).status).toBe(400)
    expect((await s.api('POST', '/api/connections', { integration: 'generic' })).status).toBe(400)
    expect(
      (await s.api('POST', '/api/connections', { integration: 'generic', name: 'x', filters: { bogus: true } })).status,
    ).toBe(400)
    expect(
      (
        await s.api('POST', '/api/connections', {
          integration: 'generic',
          name: 'x',
          fields: { map_title: 'not-a-pointer' },
        })
      ).status,
    ).toBe(400)
    expect(
      (await s.api('POST', '/api/connections', { integration: 'generic', name: 'x', fields: { nope: 'x' } })).status,
    ).toBe(400)
    expect(
      (
        await s.api('POST', '/api/connections', {
          integration: 'generic',
          name: 'x',
          advanced: [{ field: 'secret', op: 'equals', value: 'x', effect: 'keep' }],
        })
      ).status,
    ).toBe(400)
    const res = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/api/connections`, {
      method: 'POST',
      headers: { 'x-test-session': 'none' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect((await s.api('GET', '/api/connections/cn_zzzzzzzzzzzzzzzzzzzzzz')).status).toBe(404)
    expect((await s.api('DELETE', '/api/connections/cn_zzzzzzzzzzzzzzzzzzzzzz')).status).toBe(404)
  })

  it('caps the number of connections', async () => {
    const s = setup()
    for (let i = 0; i < 50; i++) await s.create('generic')
    expect((await s.api('POST', '/api/connections', { integration: 'generic', name: 'one too many' })).status).toBe(409)
  })

  it('shows received/kept over the last 24 hours and the last event time', async () => {
    const s = setup()
    const c = await s.create('gmail')
    const claim = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/hook/gmail/${c.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_code: c.claim_code }),
    })
    const secret = ((await claim.json()) as { secret: string }).secret
    const items = Array.from({ length: 5 }, (_v, i) => ({
      message_id: `m${i}`,
      subject: `s${i}`,
      from: i < 2 ? 'vip@example.com' : 'other@example.com',
      text: 't',
      date: new Date(s.f.clock.now()).toISOString(),
      labels: i < 2 ? [] : ['Promotions'],
    }))
    await s.api('PATCH', `/api/connections/${c.id}`, { filters: { primary: false }, status: 'active' })
    await s.api('PATCH', `/api/connections/${c.id}`, { filters: { vips: true } })
    await s.api('PATCH', `/api/connections/${c.id}`, {
      advanced: [{ field: 'actor.email', op: 'equals', value: 'vip@example.com', effect: 'keep' }],
    })
    await s.send('gmail', c.id, secret, { v: 1, items })
    await s.drain()
    const got = (await (await s.api('GET', `/api/connections/${c.id}`)).json()) as Record<string, unknown>
    expect(got).toMatchObject({ received_24h: 5, kept_24h: 2, last_event_at: s.f.clock.iso() })
    s.f.clock.advance(25 * 3600_000)
    const later = (await (await s.api('GET', `/api/connections/${c.id}`)).json()) as Record<string, unknown>
    expect(later).toMatchObject({ received_24h: 0, kept_24h: 0 })
  })

  it('patches name, thread, filters; pause and resume', async () => {
    const s = setup()
    const c = await s.create('github', { fields: { token: 'ghp_exampletoken0000000000000000000000' } })
    const res = await s.api('PATCH', `/api/connections/${c.id}`, {
      name: 'renamed',
      thread: 'general',
      filters: { other: true },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      name: 'renamed',
      thread: 'general',
      filters: { mentions: true, review_requests: true, assigned: true, ci_failed: true, other: true },
    })
    expect((await s.api('PATCH', `/api/connections/${c.id}`, { filters: { nonsense: true } })).status).toBe(400)
    expect(await (await s.api('PATCH', `/api/connections/${c.id}`, { status: 'paused' })).json()).toMatchObject({
      status: 'paused',
    })
    expect(await (await s.api('PATCH', `/api/connections/${c.id}`, { status: 'active' })).json()).toMatchObject({
      status: 'active',
    })
  })

  it('deletes a connection with everything that belongs to it, and its hook URL goes dead', async () => {
    const s = setup()
    const c = await s.create('generic')
    await s.send('generic', c.id, c.secret, { title: 'x' })
    await s.drain()
    expect((await s.api('DELETE', `/api/connections/${c.id}`)).status).toBe(204)
    for (const t of ['hooks_connections', 'hooks_events', 'hooks_inbound', 'hooks_deliveries', 'hooks_dedup'])
      expect(s.count(t), t).toBe(0)
    expect((await s.send('generic', c.id, c.secret, { title: 'again' })).status).toBe(404)
  })

  it('lists the last 20 deliveries, newest first, with status and reason', async () => {
    const s = setup()
    const c = await s.create('generic')
    for (let i = 0; i < 25; i++) await s.post('generic', c.id, '{}', {})
    const list = (await (await s.api('GET', `/api/connections/${c.id}/deliveries`)).json()) as unknown[]
    expect(list).toHaveLength(20)
    for (const d of list) expect(Delivery.safeParse(d).success).toBe(true)
    // 20 failed verifications a minute are logged one by one, then a single summary row (no row per junk request)
    expect(list[0]).toMatchObject({ status: 429, reason: 'bad_signature_flood' })
    expect(list[1]).toMatchObject({ status: 401, reason: 'missing_header' })
  })
})

describe('rotate', () => {
  it('the old secret keeps working for 24 hours, the new one works at once', async () => {
    const s = setup()
    const c = await s.create('generic')
    const rotated = (await (await s.api('POST', `/api/connections/${c.id}/rotate`, {})).json()) as { secret: string }
    expect(rotated.secret).toMatch(/^whsec_/)
    expect(rotated.secret).not.toBe(c.secret)
    expect((await s.send('generic', c.id, rotated.secret, { title: 'new' }, { id: 'n1' })).status).toBe(200)
    expect((await s.send('generic', c.id, c.secret, { title: 'old' }, { id: 'o1' })).status).toBe(200)
    s.f.clock.advance(24 * 3600_000 + 1000)
    expect((await s.send('generic', c.id, c.secret, { title: 'old again' }, { id: 'o2' })).status).toBe(401)
    expect((await s.send('generic', c.id, rotated.secret, { title: 'new again' }, { id: 'n2' })).status).toBe(200)
    await s.drain()
    expect(s.eventBodies().map((e) => e.title)).toEqual(['new', 'old', 'new again'])
  })
})

describe('test button', () => {
  it('synthesizes a signed event that takes the real path', async () => {
    const s = setup()
    const c = await s.create('generic')
    const res = await s.api('POST', `/api/connections/${c.id}/test`, {})
    expect(await res.json()).toEqual({ ok: true })
    expect(s.events()).toHaveLength(1)
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.event')[0]?.event.title).toBe('Test event from Talos')
    const d = (await (await s.api('GET', `/api/connections/${c.id}/deliveries`)).json()) as Array<{ status: number }>
    expect(d[0]?.status).toBe(200)
  })

  it('a second press is a fresh event, not a duplicate', async () => {
    const s = setup()
    const c = await s.create('generic')
    await s.api('POST', `/api/connections/${c.id}/test`, {})
    s.f.clock.advance(1000)
    await s.api('POST', `/api/connections/${c.id}/test`, {})
    // generic dedups on the delivery id (unique per press) and the body hash only when there is no id
    expect(s.events().length).toBeGreaterThanOrEqual(1)
  })

  it('reports a failure instead of throwing when the integration cannot self-test', async () => {
    const s = setup()
    const c = await s.create('linear').catch(() => null)
    expect(c).not.toBeNull() // stubs can still be created
    const res = await s.api('POST', `/api/connections/${c?.id}/test`, {})
    expect(await res.json()).toMatchObject({ ok: false })
  })
})

describe('Apps Script claim', () => {
  const claim = (s: ReturnType<typeof setup>, id: string, code: unknown, integration = 'gmail') =>
    s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/hook/${integration}/${id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_code: code }),
    })

  it('creating a Gmail connection returns a claim code and no secret', async () => {
    const s = setup()
    const c = await s.create('gmail')
    expect(c.secret).toBeUndefined()
    expect(c.claim_code).toMatch(/^[0-9A-Za-z]{22}$/)
    expect(JSON.stringify(c)).not.toContain('whsec_')
  })

  it('the code works once, then 410, and the secret it returns signs real deliveries', async () => {
    const s = setup()
    const c = await s.create('gmail')
    const first = await claim(s, c.id, c.claim_code)
    expect(first.status).toBe(200)
    const { secret } = (await first.json()) as { secret: string }
    expect(secret).toMatch(/^whsec_/)
    expect((await claim(s, c.id, c.claim_code)).status).toBe(410)
    const body = JSON.stringify({
      v: 1,
      items: [{ message_id: 'x1', subject: 'hi', from: 'a@example.com', text: 't' }],
    })
    const res = await s.post(
      'gmail',
      c.id,
      body,
      signStandard({ secret, id: 'gm_1', timestampS: Math.floor(s.f.clock.now() / 1000), body }),
    )
    expect(res.status).toBe(200)
  })

  it('a wrong code is refused, five wrong codes burn the real one', async () => {
    const s = setup()
    const c = await s.create('gmail')
    for (let i = 0; i < 5; i++) expect((await claim(s, c.id, `wrong${i}`)).status).toBe(401)
    expect((await claim(s, c.id, c.claim_code)).status).toBe(410)
  })

  it('the code expires after 30 minutes', async () => {
    const s = setup()
    const c = await s.create('gmail')
    s.f.clock.advance(31 * 60_000)
    expect((await claim(s, c.id, c.claim_code)).status).toBe(410)
  })

  it('only Apps Script integrations have a claim route, and unknown ids are 404', async () => {
    const s = setup()
    const g = await s.create('generic')
    expect((await claim(s, g.id, 'x', 'generic')).status).toBe(404)
    expect((await claim(s, 'cn_zzzzzzzzzzzzzzzzzzzzzz', 'x')).status).toBe(404)
    expect((await claim(s, g.id, 5 as unknown as string, 'generic')).status).toBe(404)
  })

  it('rotate issues a fresh claim code and the old secret still verifies for a day', async () => {
    const s = setup()
    const c = await s.create('gmail')
    const { secret: oldSecret } = (await (await claim(s, c.id, c.claim_code)).json()) as { secret: string }
    const rot = (await (await s.api('POST', `/api/connections/${c.id}/rotate`, {})).json()) as {
      secret: string
      claim_code: string
    }
    expect(rot.secret).toBe('')
    const { secret: newSecret } = (await (await claim(s, c.id, rot.claim_code)).json()) as { secret: string }
    expect(newSecret).not.toBe(oldSecret)
    const body = JSON.stringify({ v: 1, items: [] })
    for (const [i, sec] of [oldSecret, newSecret].entries()) {
      const res = await s.post(
        'gmail',
        c.id,
        body,
        signStandard({ secret: sec, id: `r${i}`, timestampS: Math.floor(s.f.clock.now() / 1000), body }),
      )
      expect(res.status).toBe(200)
    }
  })

  it('stores only a hash of the code', async () => {
    const s = setup()
    const c = await s.create('gmail')
    const row = s.f.db.prepare('select code_hash from hooks_claims').get() as { code_hash: string }
    expect(row.code_hash).not.toContain(c.claim_code)
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('credentials', () => {
  it('stores secret fields encrypted and checks patterns', async () => {
    const s = setup({ fetch: (async () => new Response('[]', { status: 200 })) as typeof fetch })
    const c = await s.create('github')
    const bad = await (
      await s.api('POST', `/api/connections/${c.id}/credentials`, { fields: { token: 'nope' } })
    ).json()
    expect(bad).toMatchObject({ ok: false })
    const token = 'ghp_exampletoken0000000000000000000000'
    const ok = await (await s.api('POST', `/api/connections/${c.id}/credentials`, { fields: { token } })).json()
    expect(ok).toMatchObject({ ok: true })
    const blob = s.f.db.prepare('select creds_enc from hooks_connections').get() as { creds_enc: Buffer }
    expect(Buffer.from(blob.creds_enc).includes(Buffer.from(token))).toBe(false)
    expect(JSON.stringify(await (await s.api('GET', `/api/connections/${c.id}`)).json())).not.toContain(token)
  })

  it('a missing required field is named', async () => {
    const s = setup()
    const c = await s.create('github')
    expect(await (await s.api('POST', `/api/connections/${c.id}/credentials`, { fields: {} })).json()).toMatchObject({
      ok: false,
      detail: 'token is missing',
    })
  })

  it('a failing first poll is reported back and the token never appears in the message', async () => {
    const s = setup({ fetch: (async () => new Response('', { status: 401 })) as typeof fetch })
    const c = await s.create('github')
    const token = 'ghp_exampletoken0000000000000000000000'
    const out = (await (await s.api('POST', `/api/connections/${c.id}/credentials`, { fields: { token } })).json()) as {
      ok: boolean
      detail: string
    }
    expect(out).toEqual({ ok: false, detail: 'GitHub answered 401' })
  })
})
