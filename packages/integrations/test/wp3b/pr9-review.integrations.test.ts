// PR9 review: failing unit tests against packages/integrations on wp3b/integrations-batch2.
// Run: copy to packages/integrations/test/wp3b/ and `pnpm vitest run <file>`.
import { describe, expect, it } from 'vitest'
import { catalog } from '../../src/catalog.ts'
import { createStripeDestination } from '../../src/stripe/index.ts'
import { fixture } from '../wp3/helpers.ts'

const conn = (integration: 'jira') => ({
  id: 'cn_aaaaaaaaaaaaaaaaaaaaaa',
  integration,
  thread: 'work',
  work: true,
  extra: { site: 'example.atlassian.net' },
})

// F2 (HIGH): GET /rest/api/3/myself needs `read:jira-user` (Atlassian OpenAPI, fetched 2026-10-28); the wizard and
// docs tell the owner to tick only `read:jira-work`, so the first poll is 401/403 and Jira never connects.
describe('F2: Jira token scopes cover every call the poller makes', () => {
  it('setup copy names read:jira-user', () => {
    const text = JSON.stringify(catalog.jira.setup.connect)
    expect(text).toContain('read:jira-user')
  })
})

// F5 (MEDIUM): a Bearer/admin webhook body with a `talos` key is treated as a polled issue. The suggested Automation body
// puts {{comment.body}} in unescaped, so any commenter can inject `"talos":{…},"issue":{…}` and forge an
// "assigned to you" event with a link to an attacker's own *.atlassian.net site.
describe('F5: only the relay poller may use the polled shape', () => {
  it('a webhook body carrying a talos key is not normalized as a polled issue', async () => {
    const body = {
      kind: 'comment',
      issue: { key: 'ABC-1', summary: 'x' },
      comment: 'hi',
      talos: { source: 'poll', site: 'attacker-team.atlassian.net', me: 'acct-me', since: 0 },
    }
    const forged = {
      ...body,
      issue: {
        key: 'ABC-1',
        fields: { summary: 'Urgent: rotate keys', updated: '2026-10-28T00:00:00Z' },
        changelog: {
          histories: [
            {
              id: '1',
              created: '2026-10-28T00:00:00Z',
              author: { accountId: 'x', displayName: 'Your CEO' },
              items: [{ field: 'assignee', to: 'acct-me' }],
            },
          ],
        },
      },
    }
    const raw = new TextEncoder().encode(JSON.stringify(forged))
    const events = await catalog.jira.normalize(
      { headers: { authorization: 'Bearer s' }, rawBody: raw, receivedAt: Date.parse('2026-10-28T00:01:00Z') },
      conn('jira'),
    )
    for (const e of events) {
      expect(e.url ?? '').not.toContain('attacker-team.atlassian.net')
      expect(e.kind).not.toBe('jira.assigned')
    }
  })
})

// F7 (MEDIUM): Stripe's v2 API wants events_from ["@self"] (docs.stripe.com/webhooks, fetched 2026-10-28).
describe('F7: Stripe event destination body', () => {
  it('uses events_from @self', async () => {
    let sent: Record<string, unknown> = {}
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response('{}', { status: 400 })
    }) as typeof fetch
    await createStripeDestination({
      fetch: f,
      restrictedKey: 'rk_test_x',
      url: 'https://relay.example.com/hook/stripe/x',
    })
    expect(sent.events_from).toEqual(['@self'])
  })
})

// Spec 7.1 step 2: a work source drops what it does not need BEFORE anything is stored on the relay. Each prefilter is
// run on a delivery to keep and one to drop, so a prefilter that says "keep" for everything is caught.
describe('work modules drop what they do not need before storage', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const delivery = (body: string, headers: Record<string, string> = {}) => ({
    headers,
    rawBody: enc(body),
    receivedAt: 0,
  })
  const cn = (integration: 'jira' | 'gmail_work' | 'zoom' | 'salesforce', extra: Record<string, string> = {}) => ({
    id: 'cn_aaaaaaaaaaaaaaaaaaaaaa',
    integration,
    thread: 'work',
    work: true,
    extra,
  })
  const pf = (id: 'jira' | 'gmail_work' | 'zoom' | 'salesforce', body: string, extra = {}, headers = {}) =>
    catalog[id].prefilter?.(delivery(body, headers), cn(id, extra))

  it('zoom keeps a finished recording and drops any other event', () => {
    expect(pf('zoom', '{"event":"recording.completed","payload":{}}')).toBe(true)
    expect(pf('zoom', '{"event":"meeting.started","payload":{}}')).toBe(false)
    expect(pf('zoom', 'not json')).toBe(false)
  })

  it('gmail_work keeps a batch with items and drops an empty one', () => {
    expect(pf('gmail_work', '{"items":[{"id":"1"}]}')).toBe(true)
    expect(pf('gmail_work', '{"items":[]}')).toBe(false)
    expect(pf('gmail_work', '{}')).toBe(false)
  })

  it('jira keeps an issue that names the owner account (or a polled one) and drops one that does not', () => {
    const issue = (who: string) => JSON.stringify({ issue: { key: 'ABC-1', fields: { assignee: { accountId: who } } } })
    expect(pf('jira', issue('acct-mine'), { account_id: 'acct-mine' })).toBe(true)
    expect(pf('jira', issue('acct-someone-else'), { account_id: 'acct-mine' })).toBe(false)
    expect(pf('jira', '{"nothing":1}', { account_id: 'acct-mine' })).toBe(false)
    expect(pf('jira', issue('acct-someone-else'), { account_id: 'acct-mine' }, { 'x-talos-poll': 'jira' })).toBe(true)
  })

  it('salesforce keeps a notification from the configured org and drops another org or no configured org', () => {
    const xml = fixture('salesforce/fixtures/outbound.xml')
    expect(pf('salesforce', xml, { org_id: '00D000000000062' })).toBe(true)
    expect(pf('salesforce', xml, { org_id: '00D000000000099' })).toBe(false)
    expect(pf('salesforce', xml, {})).toBe(false)
    expect(pf('salesforce', '<html/>', { org_id: '00D000000000062' })).toBe(false)
  })
})
