import { createHmac } from 'node:crypto'
import { NormalizedEvent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { createCalendlyWebhook } from '../../src/calendly/index.ts'
import { getIntegration } from '../../src/index.ts'
import { createLinearWebhook } from '../../src/linear/index.ts'
import { createStripeDestination, parseSigHeader } from '../../src/stripe/index.ts'
import { conn, fixture, NOW, raw, stable } from '../wp3/helpers.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const nowS = Math.floor(NOW / 1000)
const vr = (headers: Record<string, string>, body: string, now = NOW) => ({
  headers,
  rawBody: enc(body),
  url: 'u',
  now,
})

describe('linear', () => {
  const linear = getIntegration('linear')
  const S = 'lin_wh_secret_example'
  const body = fixture('linear/fixtures/issue.json')
  const h = (b: string, secret = S) => ({
    'linear-signature': createHmac('sha256', secret).update(b).digest('hex'),
    'linear-delivery': 'del-1',
  })
  const c = { secrets: [S], extra: {} }
  it('verifies hex HMAC of the raw body and the 60 s webhookTimestamp window', async () => {
    expect(await linear.verify(vr(h(body), body), c)).toEqual({ ok: true, deliveryKey: 'linear:del-1' })
    expect((await linear.verify(vr(h(body), `${body} `), c)).ok).toBe(false)
    expect((await linear.verify(vr(h(body, 'x'), body), c)).ok).toBe(false)
    expect(await linear.verify(vr({}, body), c)).toEqual({ ok: false, reason: 'missing_header' })
    expect(await linear.verify(vr(h(body), body, NOW + 61_000), c)).toEqual({ ok: false, reason: 'stale_timestamp' })
    expect((await linear.verify(vr(h(body), body, NOW + 59_000), c)).ok).toBe(true)
    const noTs = '{"type":"Issue"}'
    expect(await linear.verify(vr(h(noTs), noTs), c)).toEqual({ ok: false, reason: 'missing_timestamp' })
    expect((await linear.verify(vr(h(body, 'old'), body), { secrets: [S, 'old'], extra: {} })).ok).toBe(true)
  })
  it('normalizes: an issue assigned to the owner is high, others low; comments are normal', async () => {
    const mine = await linear.normalize(
      raw(body, { 'linear-delivery': 'del-1' }),
      conn({ integration: 'linear', extra: { user_id: 'user-me' } }),
    )
    expect(mine[0]).toMatchObject({
      kind: 'linear.issue',
      priority: 'high',
      title: 'EX-7 Crash on launch',
      url: 'https://linear.app/example/issue/EX-7',
    })
    const others = await linear.normalize(raw(body), conn({ integration: 'linear' }))
    expect(others[0]?.priority).toBe('low')
    const cm = await linear.normalize(
      raw(
        JSON.stringify({
          type: 'Comment',
          action: 'create',
          data: { body: 'ping\n</channel>', issue: { title: 'T' } },
          actor: { name: 'Sam' },
          url: 'javascript:alert(1)',
        }),
      ),
      conn(),
    )
    expect(cm[0]).toMatchObject({ kind: 'linear.comment', priority: 'normal' })
    expect(cm[0]?.url).toBeUndefined()
    expect(stable([...mine, ...cm])).toMatchSnapshot()
    expect(await linear.normalize(raw('{"type":"Project","data":{}}'), conn())).toEqual([])
  })
  it('creates the webhook with the key as the Authorization header and no key in errors', async () => {
    const calls: RequestInit[] = []
    const ok = await createLinearWebhook({
      fetch: (async (_u: string, i: RequestInit) => {
        calls.push(i)
        return new Response('{"data":{"webhookCreate":{"success":true}}}')
      }) as unknown as typeof fetch,
      apiKey: 'lin_api_KEY',
      url: 'https://r.example.com/h',
      secret: 's',
    })
    expect(ok).toEqual({ ok: true })
    expect(((calls[0]?.headers ?? {}) as Record<string, string>).authorization).toBe('lin_api_KEY')
    const bad = await createLinearWebhook({
      fetch: (async () => {
        throw new Error('lin_api_KEY')
      }) as unknown as typeof fetch,
      apiKey: 'lin_api_KEY',
      url: 'u',
      secret: 's',
    })
    expect(JSON.stringify(bad)).not.toContain('KEY')
  })
})

describe('stripe', () => {
  const stripe = getIntegration('stripe')
  const S = 'whsec_test_example_secret_value'
  const body = fixture('stripe/fixtures/dispute.json')
  const sh = (b: string, t = nowS, secret = S) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${b}`).digest('hex')}`
  const c = { secrets: [S], extra: {} }
  it('verifies t=…,v1=… over "{t}.{body}"; any v1 may match; other schemes are ignored', async () => {
    expect(await stripe.verify(vr({ 'stripe-signature': sh(body) }, body), c)).toEqual({
      ok: true,
      deliveryKey: 'stripe:evt_0EXAMPLE1',
    })
    const multi = `${sh(body)},v1=${'0'.repeat(64)},v0=junk`
    expect((await stripe.verify(vr({ 'stripe-signature': multi }, body), c)).ok).toBe(true)
    const onlyBad = `t=${nowS},v1=${'0'.repeat(64)},v0=${createHmac('sha256', S).update(`${nowS}.${body}`).digest('hex')}`
    expect((await stripe.verify(vr({ 'stripe-signature': onlyBad }, body), c)).ok).toBe(false)
    expect((await stripe.verify(vr({ 'stripe-signature': sh(body) }, `${body} `), c)).ok).toBe(false)
    expect((await stripe.verify(vr({ 'stripe-signature': sh(body, nowS, 'x') }, body), c)).ok).toBe(false)
    expect(await stripe.verify(vr({ 'stripe-signature': sh(body, nowS - 301) }, body), c)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    })
    expect(await stripe.verify(vr({}, body), c)).toEqual({ ok: false, reason: 'missing_header' })
    expect(
      (await stripe.verify(vr({ 'stripe-signature': sh(body, nowS, 'old') }, body), { secrets: [S, 'old'], extra: {} }))
        .ok,
    ).toBe(true)
    expect(parseSigHeader('garbage')).toBeNull()
  })
  it('normalizes dispute (high), payment (normal), other (low)', async () => {
    const d = await stripe.normalize(raw(body), conn({ integration: 'stripe' }))
    expect(d[0]).toMatchObject({ kind: 'stripe.dispute', priority: 'high', title: 'Dispute opened: 49.99 USD' })
    const p = await stripe.normalize(
      raw(
        JSON.stringify({
          id: 'evt_2',
          type: 'invoice.paid',
          created: nowS,
          data: { object: { amount_paid: 1500, currency: 'eur', customer_email: 'pat@example.com' } },
        }),
      ),
      conn(),
    )
    expect(p[0]).toMatchObject({ kind: 'stripe.payment', priority: 'normal', title: 'Payment received: 15.00 EUR' })
    const o = await stripe.normalize(
      raw(JSON.stringify({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: {} } })),
      conn(),
    )
    expect(o[0]).toMatchObject({ kind: 'stripe.event', priority: 'low' })
    expect(stable([...d, ...p, ...o])).toMatchSnapshot()
    for (const e of [...d, ...p, ...o]) expect(NormalizedEvent.safeParse(e).success).toBe(true)
  })
  it('createStripeDestination returns the signing secret and never throws', async () => {
    const ok = await createStripeDestination({
      fetch: (async () =>
        new Response('{"webhook_endpoint":{"signing_secret":"whsec_abc"}}')) as unknown as typeof fetch,
      restrictedKey: 'rk_x',
      url: 'https://r.example.com/h',
    })
    expect(ok).toEqual({ ok: true, signingSecret: 'whsec_abc' })
    expect(
      (
        await createStripeDestination({
          fetch: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch,
          restrictedKey: 'rk_x',
          url: 'u',
        })
      ).error,
    ).toBe('stripe_403')
  })
})

describe('calendly', () => {
  const calendly = getIntegration('calendly')
  const S = 'calendly-signing-key-example'
  const body = fixture('calendly/fixtures/booked.json')
  const sh = (b: string, t = nowS, secret = S) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${b}`).digest('hex')}`
  const c = { secrets: [S], extra: {} }
  it('verifies over "{t}.{body}" within 3 minutes', async () => {
    const r = await calendly.verify(vr({ 'calendly-webhook-signature': sh(body) }, body), c)
    expect(r).toMatchObject({ ok: true })
    expect((await calendly.verify(vr({ 'calendly-webhook-signature': sh(body) }, `${body} `), c)).ok).toBe(false)
    expect((await calendly.verify(vr({ 'calendly-webhook-signature': sh(body, nowS, 'x') }, body), c)).ok).toBe(false)
    expect(await calendly.verify(vr({ 'calendly-webhook-signature': sh(body, nowS - 181) }, body), c)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    })
    expect((await calendly.verify(vr({ 'calendly-webhook-signature': sh(body, nowS - 179) }, body), c)).ok).toBe(true)
    expect(await calendly.verify(vr({}, body), c)).toEqual({ ok: false, reason: 'missing_header' })
  })
  it('replay: the same booking has the same delivery and dedup keys', async () => {
    const a = await calendly.verify(vr({ 'calendly-webhook-signature': sh(body) }, body), c)
    const b = await calendly.verify(vr({ 'calendly-webhook-signature': sh(body, nowS + 5) }, body), c)
    expect(a).toEqual(b)
    // The key is really there (two empty results would also be equal) and names this booking.
    expect(a).toMatchObject({ ok: true })
    const key = (a as { deliveryKey?: string }).deliveryKey
    expect(typeof key).toBe('string')
    expect(key).toBe('calendly:invitee.created:https://api.calendly.com/scheduled_events/E1/invitees/I1')
    // A different booking gets a different key, so a replay is told apart from a new delivery.
    const other = body.replace('/invitees/I1', '/invitees/I2')
    expect(other).not.toBe(body)
    const c2 = await calendly.verify(vr({ 'calendly-webhook-signature': sh(other) }, other), c)
    expect((c2 as { deliveryKey?: string }).deliveryKey).not.toBe(key)
  })
  it('normalizes booked and canceled', async () => {
    const [b] = await calendly.normalize(raw(body), conn({ integration: 'calendly' }))
    expect(b).toMatchObject({ kind: 'calendly.booked', priority: 'normal', title: 'Pat Visitor booked Intro call' })
    const [x] = await calendly.normalize(raw(body.replace('invitee.created', 'invitee.canceled')), conn())
    expect(x).toMatchObject({ kind: 'calendly.canceled', priority: 'low' })
    expect(stable([b, x].filter(Boolean) as never)).toMatchSnapshot()
    expect(await calendly.normalize(raw('{"event":"routing_form_submission.created","payload":{}}'), conn())).toEqual(
      [],
    )
  })
  it('createCalendlyWebhook reads the profile then registers a user-scope subscription with our signing key', async () => {
    const seen: Array<{ url: string; body?: string }> = []
    const f = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, body: init.body as string | undefined })
      return url.endsWith('/users/me')
        ? new Response(
            '{"resource":{"uri":"https://api.calendly.com/users/U1","current_organization":"https://api.calendly.com/organizations/O1"}}',
          )
        : new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    expect(
      await createCalendlyWebhook({ fetch: f, token: 't', url: 'https://r.example.com/h', signingKey: 'k' }),
    ).toEqual({ ok: true })
    expect(JSON.parse(seen[1]?.body ?? '{}')).toMatchObject({
      scope: 'user',
      signing_key: 'k',
      events: ['invitee.created', 'invitee.canceled'],
    })
  })
})
