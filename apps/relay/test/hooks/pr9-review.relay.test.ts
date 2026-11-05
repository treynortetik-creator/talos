// PR9 review: failing tests that drive the REAL WP3b modules through the REAL WP3 relay pipeline.
// Run from a checkout of wp3b/integrations-batch2: copy to apps/relay/test/hooks/ and `pnpm vitest run <file>`.
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { setup } from './harness.ts'

afterEach(() => resetAuthImplementation())

const WORK_THREAD = {
  id: 'work',
  name: 'Work',
  icon: 'briefcase',
  kind: 'fixed' as const,
  order: 5,
  notify: 'all' as const,
  voice_context: 'recent' as const,
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}

const withWork = (enabled: string[], opts: { fetch?: typeof fetch } = {}) =>
  setup({
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    random: () => 0,
    config: (c) => {
      c.threads.push(WORK_THREAD)
      c.work.thread = 'work'
      // biome-ignore lint/suspicious/noExplicitAny: test config
      c.work.enabled = enabled as any
    },
  })

// F1 (BLOCKER): the vendor's signing secret is pasted into a `field` (stored in creds), but the relay hands verify()
// only the relay-generated `whsec_` connection secret. A genuinely Slack-signed event is therefore always 401.
describe('F1: vendor signing secrets never reach verify()', () => {
  it('Slack: an event signed with the pasted Signing Secret is accepted', async () => {
    const s = withWork(['slack'])
    const signing = '0123456789abcdef0123456789abcdef'
    const c = await s.create('slack', {
      fields: { signing_secret: signing },
    })
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T0EXAMPLE',
      event_id: 'Ev0EXAMPLE1',
      authorizations: [{ user_id: 'U0OWNER', is_bot: false }],
      event: {
        type: 'message',
        channel: 'D0EXAMPLE',
        channel_type: 'im',
        user: 'U0OTHER',
        text: 'hi',
        ts: '1761660000.0001',
      },
    })
    const ts = String(Math.floor(s.f.clock.now() / 1000))
    const sig = `v0=${createHmac('sha256', signing).update(`v0:${ts}:${body}`).digest('hex')}`
    const res = await s.post('slack', c.id, body, {
      'content-type': 'application/json',
      'x-slack-signature': sig,
      'x-slack-request-timestamp': ts,
    })
    expect(res.status).toBe(200) // actual: 401 signature_mismatch
  })

  it('Zoom: endpoint.url_validation answers with HMAC(pasted Secret Token, plainToken)', async () => {
    const s = withWork(['zoom'])
    const token = 'zoomsecrettokenEXAMPLE0001'
    const c = await s.create('zoom', { fields: { secret_token: token } })
    const plain = 'qgg8vlvZRS6UYooatFL8Aw'
    const res = await s.post(
      'zoom',
      c.id,
      JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: plain } }),
      {
        'content-type': 'application/json',
      },
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { encryptedToken: string }
    expect(j.encryptedToken).toBe(createHmac('sha256', token).update(plain).digest('hex')) // actual: HMAC(whsec_…)
  })

  it('Stripe: an event signed with the pasted whsec_ signing secret is accepted', async () => {
    const s = setup({})
    const signing = 'whsec_EXAMPLEexampleEXAMPLEexample00'
    const c = await s.create('stripe', { fields: { signing_secret: signing } })
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', created: 1761660000, data: { object: {} } })
    const t = String(Math.floor(s.f.clock.now() / 1000))
    const v1 = createHmac('sha256', signing).update(`${t}.${body}`).digest('hex')
    const res = await s.post('stripe', c.id, body, {
      'content-type': 'application/json',
      'stripe-signature': `t=${t},v1=${v1}`,
    })
    expect(res.status).toBe(200) // actual: 401
  })
})

// F3 (HIGH): the relay keeps polling Jira after the owner switches the work system off (poller.ts only checks the
// WORK_INTEGRATIONS env kill switch, not config.work.enabled). Data keeps leaving the work system.
describe('F3: a disabled work poller must not poll', () => {
  it('Jira stops fetching once jira is removed from config.work.enabled', async () => {
    const calls: string[] = []
    const f = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (String(url).endsWith('/_edge/tenant_info'))
        return new Response(JSON.stringify({ cloudId: '11111111-2222-3333-4444-555555555555' }))
      if (String(url).endsWith('/myself')) return new Response(JSON.stringify({ accountId: 'acct-me' }))
      return new Response(JSON.stringify({ issues: [] }))
    }) as typeof fetch
    const s = withWork(['jira'], { fetch: f })
    const c = await s.create('jira')
    await s.api('POST', `/api/connections/${c.id}/credentials`, {
      fields: { site: 'example.atlassian.net', email: 'alex@example.com', token: 'tok_example_0000' },
    })
    s.config((cfg) => {
      cfg.work.enabled = []
    })
    const before = calls.length
    s.f.clock.advance(10 * 60_000)
    await s.tick()
    expect(calls.length).toBe(before) // actual: polls search/jql again
  })
})

// F4 (HIGH): `forward` ships an Apps Script that claims its secret, but the relay's claim allowlist is
// gmail/gmail_work/gcal only, so the create response has no claim_code and /claim is 404.
describe('F4: forward cannot claim its secret', () => {
  it('creating a forward connection returns a claim code', async () => {
    const s = setup({})
    const c = await s.create('forward')
    expect(typeof c.claim_code).toBe('string') // actual: undefined (a raw secret is returned instead)
  })
})
