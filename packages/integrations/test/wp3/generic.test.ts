import { NormalizedEvent, SetupSpec } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { getIntegration } from '../../src/index.ts'
import { signStandard } from '../../src/standard-webhooks.ts'
import { conn, enc, fixture, NOW, OTHER_SECRET, raw, SECRET, signedReq, stable } from './helpers.ts'

const generic = getIntegration('generic')
const BODY = '{"title":"hello"}'
const req = (headers: Record<string, string>, body = BODY) => ({
  headers,
  rawBody: enc(body),
  url: 'https://relay.example.com/hook/generic/cn_x',
  now: NOW,
})

describe('generic verifier', () => {
  it('accepts a Bearer secret and dedups on Idempotency-Key, else the body hash', async () => {
    const a = await generic.verify(req({ authorization: `Bearer ${SECRET}` }), { secrets: [SECRET], extra: {} })
    expect(a.ok && a.deliveryKey?.startsWith('body:')).toBe(true)
    const b = await generic.verify(req({ authorization: `Bearer ${SECRET}`, 'idempotency-key': 'k1' }), {
      secrets: [SECRET],
      extra: {},
    })
    expect(b).toEqual({ ok: true, deliveryKey: 'idem:k1' })
  })

  it('rejects a wrong Bearer secret, a missing header and a malformed one', async () => {
    const c = { secrets: [SECRET], extra: {} }
    expect(await generic.verify(req({ authorization: `Bearer ${OTHER_SECRET}` }), c)).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    })
    expect(await generic.verify(req({}), c)).toEqual({ ok: false, reason: 'missing_header' })
    expect(await generic.verify(req({ authorization: `Basic ${SECRET}` }), c)).toEqual({
      ok: false,
      reason: 'bad_authorization',
    })
  })

  it('accepts a rotated (old) Bearer secret alongside the new one', async () => {
    const c = { secrets: [OTHER_SECRET, SECRET], extra: {} }
    expect((await generic.verify(req({ authorization: `Bearer ${SECRET}` }), c)).ok).toBe(true)
    expect((await generic.verify(req({ authorization: `Bearer ${OTHER_SECRET}` }), c)).ok).toBe(true)
  })

  it('also accepts Standard Webhooks headers, and checks them strictly', async () => {
    const c = { secrets: [SECRET], extra: {} }
    expect((await generic.verify(signedReq(BODY), c)).ok).toBe(true)
    expect((await generic.verify({ ...signedReq(BODY), rawBody: enc('{"title":"x"}') }, c)).ok).toBe(false)
    const stale = { ...signedReq(BODY), headers: signStandard({ secret: SECRET, id: 'm1', timestampS: 1, body: BODY }) }
    expect(await generic.verify(stale, c)).toEqual({ ok: false, reason: 'stale_timestamp' })
  })
})

describe('generic normalizer', () => {
  const run = (name: string, c = conn()) =>
    generic.normalize(raw(fixture(`generic/fixtures/${name}.json`), { 'webhook-id': 'msg_1' }), c)

  it('uses title, summary and url as given', async () => {
    const events = await run('basic')
    expect(stable(events)).toMatchSnapshot()
    for (const e of events) expect(NormalizedEvent.safeParse(e).success).toBe(true)
  })

  it('drops a javascript: url instead of passing it on', async () => {
    const [e] = await run('javascript-url')
    expect(e).toBeDefined()
    expect(e?.url).toBeUndefined()
    expect(NormalizedEvent.safeParse(e).success).toBe(true)
  })

  it('maps fields with the JSON pointers the wizard stored', async () => {
    const [e] = await run(
      'nested',
      conn({ extra: { map_title: '/issue/title', map_summary: '/issue/body', map_url: '/issue/html_url' } }),
    )
    expect(e).toMatchObject({
      title: 'Login fails on Safari',
      summary: 'Steps to reproduce are attached.',
      url: 'https://example.com/issues/7',
    })
  })

  it('survives non-JSON, arrays, empty bodies and hostile text', async () => {
    for (const body of [
      'not json at all',
      '[1,2,3]',
      '',
      '"just a string"',
      '{"title":"\\u0000\\u202e evil \\n\\n title"}',
    ]) {
      const events = await generic.normalize(raw(body), conn())
      expect(events).toHaveLength(1)
      expect(NormalizedEvent.safeParse(events[0]).success, body).toBe(true)
      for (const ch of events[0]?.title ?? '')
        expect(ch.charCodeAt(0) >= 32 && ch !== String.fromCharCode(0x202e)).toBe(true)
    }
  })

  it('clamps long strings to the schema limits', async () => {
    const [e] = await generic.normalize(
      raw(JSON.stringify({ title: 'x'.repeat(900), summary: 'y'.repeat(900) })),
      conn(),
    )
    expect(e?.title.length).toBeLessThanOrEqual(200)
    expect(e?.summary.length).toBeLessThanOrEqual(280)
  })

  it('sets source, connection, thread and work from the connection', async () => {
    const [e] = await generic.normalize(raw('{"title":"t"}'), conn({ thread: 'general', work: true }))
    expect(e).toMatchObject({
      source: 'generic',
      connection: 'cn_aaaaaaaaaaaaaaaaaaaaaa',
      thread: 'general',
      work: true,
    })
  })

  it("defaults to low priority and honours the sender's priority", async () => {
    const [low] = await generic.normalize(raw('{"title":"t"}'), conn())
    const [hi] = await generic.normalize(raw('{"title":"t","priority":"HIGH"}'), conn())
    expect(low?.priority).toBe('low')
    expect(hi?.priority).toBe('high')
  })
})

describe('zapier, make and n8n', () => {
  it('share the generic verifier and normalizer and carry their own copy', async () => {
    const specs = (['zapier', 'make', 'n8n'] as const).map((id) => getIntegration(id).setup)
    expect(new Set(specs.map((s) => s.connect[0] && 'md' in s.connect[0] && s.connect[0].md)).size).toBe(3)
    for (const id of ['generic', 'zapier', 'make', 'n8n'] as const) {
      const m = getIntegration(id)
      expect(SetupSpec.safeParse(m.setup).success).toBe(true)
      expect(m.id).toBe(id)
      expect((await m.verify(req({ authorization: `Bearer ${SECRET}` }), { secrets: [SECRET], extra: {} })).ok).toBe(
        true,
      )
      const [e] = await m.normalize(raw('{"title":"t"}'), conn({ integration: id }))
      expect(e?.source).toBe(id)
    }
  })
})
