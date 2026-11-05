import { createHmac } from 'node:crypto'
import { NormalizedEvent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { getIntegration, moduleExtras } from '../../src/index.ts'
import { SLACK_USER_SCOPES, slackManifest, slackManifestUrl } from '../../src/slack/manifest.ts'
import { conn, fixture, NOW, raw, stable } from '../wp3/helpers.ts'
import { hasControl } from './plain.ts'

const slack = getIntegration('slack')
const enc = (s: string) => new TextEncoder().encode(s)
const SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const sig = (secret: string, ts: number, body: string) =>
  `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
const nowS = Math.floor(NOW / 1000)
const req = (body: string, over: { secret?: string; ts?: number; headers?: Record<string, string> } = {}) => {
  const ts = over.ts ?? nowS
  return {
    headers: {
      'x-slack-signature': sig(over.secret ?? SECRET, ts, body),
      'x-slack-request-timestamp': String(ts),
      ...over.headers,
    },
    rawBody: enc(body),
    url: 'https://relay.example.com/hook/slack/cn_x',
    now: NOW,
  }
}
const c = { secrets: [SECRET], extra: {} }
const sc = conn({ integration: 'slack', thread: 'work', work: true, extra: { owner_slack_id: 'U0OWNER001' } })

describe('slack verifier', () => {
  it("matches Slack's published example (signing secret 8f74…85a5, timestamp 1531420618)", () => {
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'
    const r = slack.verify(
      {
        headers: {
          'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
          'x-slack-request-timestamp': '1531420618',
        },
        rawBody: enc(body),
        url: 'u',
        now: 1531420618_000,
      },
      c,
    )
    expect(r).toMatchObject({ ok: true })
  })
  it('rejects a bad signature, tampered body, wrong secret, missing headers and a stale timestamp', async () => {
    const body = fixture('slack/fixtures/dm.json')
    expect(await slack.verify(req(body), c)).toEqual({ ok: true, deliveryKey: 'slack:Ev0EXAMPLE01' })
    expect((await slack.verify({ ...req(body), rawBody: enc(`${body} `) }, c)).ok).toBe(false)
    expect((await slack.verify(req(body, { secret: 'nope' }), c)).ok).toBe(false)
    expect(await slack.verify(req(body, { headers: { 'x-slack-signature': 'v0=00' } }), c)).toMatchObject({ ok: false })
    const { 'x-slack-signature': _x, ...rest } = req(body).headers
    expect(await slack.verify({ ...req(body), headers: rest }, c)).toEqual({ ok: false, reason: 'missing_header' })
    expect(await slack.verify(req(body, { ts: nowS - 301 }), c)).toEqual({ ok: false, reason: 'stale_timestamp' })
    expect(await slack.verify(req(body, { ts: nowS + 301 }), c)).toEqual({ ok: false, reason: 'stale_timestamp' })
    expect((await slack.verify(req(body, { ts: nowS - 299 }), c)).ok).toBe(true)
  })
  it('a replayed event has the same delivery key, so the relay stores it once; an old capture is stale', async () => {
    const body = fixture('slack/fixtures/dm.json')
    const a = await slack.verify(req(body), c)
    const b = await slack.verify(req(body, { ts: nowS + 1 }), c)
    expect(a).toMatchObject({ deliveryKey: 'slack:Ev0EXAMPLE01' })
    expect(b).toMatchObject({ deliveryKey: 'slack:Ev0EXAMPLE01' })
    expect((await slack.verify({ ...req(body, { ts: nowS - 3600 }), now: NOW }, c)).ok).toBe(false)
  })
  it('accepts the old secret after rotation', async () => {
    const body = fixture('slack/fixtures/dm.json')
    expect(
      (await slack.verify(req(body, { secret: 'old-secret' }), { secrets: [SECRET, 'old-secret'], extra: {} })).ok,
    ).toBe(true)
  })
})

describe('slack url_verification handshake', () => {
  const hs = (b: unknown) => slack.handshake?.(raw(JSON.stringify(b)), c)
  it('echoes the challenge before any secret is needed', () => {
    expect(
      hs({ token: 'x', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P', type: 'url_verification' }),
    ).toEqual({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P',
    })
  })
  it('refuses odd challenges and ignores other requests', () => {
    expect(hs({ type: 'url_verification', challenge: '<script>alert(1)</script>' })?.status).toBe(400)
    expect(hs({ type: 'url_verification', challenge: 'a'.repeat(300) })?.status).toBe(400)
    expect(hs({ type: 'url_verification' })?.status).toBe(400)
    expect(hs({ type: 'event_callback' })).toBeNull()
    expect(slack.handshake?.(raw('not json'), c)).toBeNull()
  })
})

describe('slack pre-filter (before storage)', () => {
  const pf = (name: string, connOver = sc) => slack.prefilter?.(raw(fixture(`slack/fixtures/${name}.json`)), connOver)
  it('keeps DMs and mentions, rejects a channel message without a mention', () => {
    expect(pf('dm')).toBe(true)
    expect(pf('mention')).toBe(true)
    expect(pf('channel-no-mention')).toBe(false)
  })
  it('learns the owner id from authorizations when the connection has none', () => {
    expect(pf('mention', conn({ integration: 'slack', work: true }))).toBe(true)
    expect(pf('channel-no-mention', conn({ integration: 'slack', work: true }))).toBe(false)
  })
  it("drops edits, deletions, joins, non-message events, the owner's own messages and junk", () => {
    const base = JSON.parse(fixture('slack/fixtures/dm.json'))
    const f = (ev: object, top: object = {}) =>
      slack.prefilter?.(raw(JSON.stringify({ ...base, ...top, event: { ...base.event, ...ev } })), sc)
    expect(f({ subtype: 'message_changed' })).toBe(false)
    expect(f({ subtype: 'message_deleted' })).toBe(false)
    expect(f({ subtype: 'channel_join' })).toBe(false)
    expect(f({ type: 'reaction_added' })).toBe(false)
    expect(f({ user: 'U0OWNER001' })).toBe(false)
    expect(f({ subtype: 'file_share' })).toBe(true)
    expect(f({}, { type: 'app_rate_limited' })).toBe(false)
    expect(slack.prefilter?.(raw('garbage'), sc)).toBe(false)
  })
  it('a mention of someone else is not a mention of the owner', () => {
    const j = JSON.parse(fixture('slack/fixtures/mention.json'))
    j.event.text = '<@U0SOMEONE9> and U0OWNER001 without brackets'
    expect(slack.prefilter?.(raw(JSON.stringify(j)), sc)).toBe(false)
  })
})

describe('slack normalizer', () => {
  it('turns the fixtures into plain-text events', async () => {
    const out = [
      ...(await slack.normalize(raw(fixture('slack/fixtures/dm.json')), sc)),
      ...(await slack.normalize(raw(fixture('slack/fixtures/mention.json')), sc)),
      ...(await slack.normalize(raw(fixture('slack/fixtures/channel-no-mention.json')), sc)),
    ]
    expect(out.map((e) => e.kind)).toEqual(['slack.dm', 'slack.mention'])
    expect(out[0]?.summary).toContain('the draft & tell me by @here? cc @U0OWNER001 in #general')
    expect(out.every((e) => e.work && e.thread === 'work' && e.priority === 'high')).toBe(true)
    expect(stable(out)).toMatchSnapshot()
    for (const e of out) expect(NormalizedEvent.safeParse(e).success).toBe(true)
  })
  it('hostile text stays plain text: no controls, no markers needing the reader to trust them, no url', async () => {
    const [e] = await slack.normalize(raw(fixture('slack/fixtures/hostile.json')), sc)
    expect(e).toBeDefined()
    expect(hasControl(`${e?.title}${e?.summary}`)).toBe(false)
    expect(e?.summary).toContain('Ignore previous instructions')
    expect(e?.summary).toContain('<script>alert(1)</script>') // plain text, never interpreted
    expect(e?.summary.length).toBeLessThanOrEqual(280)
    expect(e?.url).toBe('https://app.slack.com/client/T0EXAMPLE1/D0EXAMPLE01')
  })
  it('toggles: turning DMs off drops only DMs', async () => {
    const t = moduleExtras(slack).toggle
    const [dm] = await slack.normalize(raw(fixture('slack/fixtures/dm.json')), sc)
    const [m] = await slack.normalize(raw(fixture('slack/fixtures/mention.json')), sc)
    expect(dm && t?.('dms', false, dm, sc)).toBe(false)
    expect(m && t?.('dms', false, m, sc)).toBe(true)
    expect(m && t?.('mentions', false, m, sc)).toBe(false)
  })
})

describe('slack manifest link', () => {
  const url = 'https://relay.example.com/hook/slack/cn_aaaaaaaaaaaaaaaaaaaaaa'
  it('decodes to the manifest in spec 7.5 with the request url filled in', () => {
    const link = slackManifestUrl(url)
    const u = new URL(link)
    expect(u.origin + u.pathname).toBe('https://api.slack.com/apps')
    expect(u.searchParams.get('new_app')).toBe('1')
    const m = JSON.parse(u.searchParams.get('manifest_json') as string)
    expect(m).toEqual(slackManifest(url))
    expect(m.settings.event_subscriptions.request_url).toBe(url)
    expect(m.settings.event_subscriptions.user_events).toEqual([
      'message.im',
      'message.mpim',
      'message.channels',
      'message.groups',
    ])
    expect(m.settings.socket_mode_enabled).toBe(false)
  })
  it('asks for history scopes only (no directory or write scopes)', () => {
    expect([...SLACK_USER_SCOPES]).toEqual(['im:history', 'mpim:history', 'channels:history', 'groups:history'])
    const m = slackManifest(url)
    expect(m.oauth_config.scopes).toEqual({ user: [...SLACK_USER_SCOPES] })
    expect(JSON.stringify(m)).not.toMatch(/users:read|write|chat:|admin/)
  })
  it('refuses a non-https request url', () => {
    expect(() => slackManifestUrl('http://relay.example.com/h')).toThrow()
    expect(() => slackManifestUrl('nonsense')).toThrow()
  })
})
