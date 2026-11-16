import { createHmac } from 'node:crypto'
import { NormalizedEvent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { getIntegration, moduleExtras } from '../../src/index.ts'
import {
  SLACK_USER_SCOPES,
  slackBotManifest,
  slackBotManifestUrl,
  slackManifest,
  slackManifestUrl,
} from '../../src/slack/manifest.ts'
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

// An agent's bot: a connection made with identity 'bot' listens to the bot user's events, not the owner's.
describe('slack bot connection', () => {
  const BOT = 'U0BOT00001'
  const OTHER_BOT = 'U0BOT00002'
  const APP = 'A0EXAMPLE1' // the fixture's api_app_id
  const base = JSON.parse(fixture('slack/fixtures/dm.json'))
  /** A delivery to the bot: its authorization is the bot user's. */
  const toBot = (ev: object = {}, top: object = {}, auth = BOT) =>
    raw(
      JSON.stringify({
        ...base,
        authorizations: [{ enterprise_id: null, team_id: 'T0EXAMPLE1', user_id: auth, is_bot: true }],
        ...top,
        event: { ...base.event, text: 'can you check the build?', ...ev },
      }),
    )
  let n = 0
  const bc = (extra: Record<string, string> = { identity: 'bot', bot_user_id: BOT, bot_app_id: APP }) =>
    conn({ id: `cn_bot${String(++n).padStart(19, '0')}`, integration: 'slack', thread: 'work', work: true, extra })
  const ex = moduleExtras(slack)
  /** `siblingExtra` as the relay calls it: the siblings with when they were made, and now. */
  const sibs = (c: ReturnType<typeof bc>, list: Array<ReturnType<typeof bc>>, madeAt = NOW, now = NOW) =>
    ex.siblingExtra?.(
      c,
      list.map((x) => ({ ...x, createdAt: madeAt })),
      now,
    )
  const kinds = async (r: ReturnType<typeof raw>, c = bc()) => (await slack.normalize(r, c)).map((e) => e.kind)

  it('keeps DMs, group DMs and channel mentions of the bot as bot kinds; drops the rest', async () => {
    expect(await kinds(toBot())).toEqual(['slack.bot_dm'])
    expect(await kinds(toBot({ channel: 'G0EXAMPLE01', channel_type: 'mpim' }))).toEqual(['slack.bot_mpim'])
    const mention = { channel: 'C0EXAMPLE01', channel_type: 'channel', text: `<@${BOT}> deploy please` }
    expect(await kinds(toBot(mention))).toEqual(['slack.bot_mention'])
    expect(await kinds(toBot({ channel: 'C0EXAMPLE01', channel_type: 'channel' }))).toEqual([])
    // a mention of the owner (or anyone else) in a channel is not addressed to the bot
    const owner = { channel: 'C0EXAMPLE01', channel_type: 'channel', text: '<@U0OWNER001> look' }
    expect(await kinds(toBot(owner))).toEqual([])
    expect(await kinds(toBot({ subtype: 'message_changed' }))).toEqual([])
    for (const r of [toBot(), toBot(mention)]) expect(slack.prefilter?.(r, bc())).toBe(true)
    expect(slack.prefilter?.(toBot(owner), bc())).toBe(false)
    const [e] = await slack.normalize(toBot(), bc())
    expect(e?.title).toBe('Direct message to the bot from @U0SENDER01')
    expect(e && NormalizedEvent.safeParse(e).success).toBe(true)
  })

  it('loop guard: the bot connection drops its own bot (by user id, bot_id or the bot_message subtype) and other bots', () => {
    const pf = (r: ReturnType<typeof raw>, c = bc()) => slack.prefilter?.(r, c)
    expect(pf(toBot({ user: BOT }))).toBe(false) // the agent's own reply comes back as an event
    expect(pf(toBot({ user: BOT, bot_id: 'B0BOT00001' }))).toBe(false)
    expect(pf(toBot({ subtype: 'bot_message', bot_id: 'B0BOT00001', user: undefined }))).toBe(false)
    expect(pf(toBot({ user: OTHER_BOT, bot_id: 'B0BOT00002' }))).toBe(false) // another app's bot: no bot-to-bot loops
    // before the id is known (first event): its own messages still go, by bot_id / subtype alone
    const fresh = bc({ identity: 'bot' })
    expect(pf(toBot({ user: BOT, bot_id: 'B0BOT00001' }), fresh)).toBe(false)
    expect(pf(toBot({ subtype: 'bot_message', bot_id: 'B0BOT00001' }), fresh)).toBe(false)
    expect(pf(toBot(), fresh)).toBe(true) // a person's DM is kept
    // a mention cannot be recognised without the id, so it is dropped rather than guessed
    expect(pf(toBot({ channel: 'C0EXAMPLE01', channel_type: 'channel', text: `<@${BOT}> hi` }), fresh)).toBe(false)
  })

  it("loop guard the other way: the owner's connection drops what its bot connections' bots say", () => {
    const owner = conn({ integration: 'slack', thread: 'work', work: true, extra: { owner_slack_id: 'U0OWNER001' } })
    const other = bc({ identity: 'bot', bot_user_id: OTHER_BOT, bot_app_id: 'A0EXAMPLE2' })
    const extra = sibs(owner, [bc(), other, owner]) ?? {}
    expect(extra).toEqual({ sibling_bot_ids: `${BOT},${OTHER_BOT}`, sibling_bot_apps: `${APP},A0EXAMPLE2` })
    const withSibs = { ...owner, extra: { ...owner.extra, ...extra } }
    const fromBot = (ev: object) =>
      raw(JSON.stringify({ ...base, event: { ...base.event, bot_id: 'B0BOT00001', text: 'done', ...ev } }))
    expect(slack.prefilter?.(fromBot({ user: BOT }), withSibs)).toBe(false)
    expect(slack.prefilter?.(fromBot({ user: OTHER_BOT }), withSibs)).toBe(false)
    // a bot posting under a custom name: no user id, only its bot_id and app id
    const custom = { user: undefined, subtype: 'bot_message', app_id: APP, username: 'Deploys' }
    expect(slack.prefilter?.(fromBot(custom), withSibs)).toBe(false)
    // other apps' bots and people still reach the owner
    expect(slack.prefilter?.(fromBot({ user: 'U0ELSEBOT1', app_id: 'A0ELSEAPP1' }), withSibs)).toBe(true)
    expect(slack.prefilter?.(raw(fixture('slack/fixtures/dm.json')), withSibs)).toBe(true)
  })

  it("first event: a new bot connection that has not learned its bot holds back bots' messages to the owner, for a day", () => {
    const owner = conn({ integration: 'slack', thread: 'work', work: true, extra: { owner_slack_id: 'U0OWNER001' } })
    const fresh = bc({ identity: 'bot' })
    expect(sibs(owner, [fresh])).toEqual({ sibling_bot_unknown: '1' })
    // a set user id but no app id yet is still unknown: a custom-name post would carry only the app id
    expect(sibs(owner, [bc({ identity: 'bot', bot_user_id: BOT })])).toEqual({
      sibling_bot_ids: BOT,
      sibling_bot_unknown: '1',
    })
    const held = { ...owner, extra: { ...owner.extra, sibling_bot_unknown: '1' } }
    const bodyFrom = (ev: object) => raw(JSON.stringify({ ...base, event: { ...base.event, ...ev } }))
    // refused with its own reason (Recent deliveries shows it), not silently pre-filtered
    expect(ex.learn?.(bodyFrom({ user: BOT, bot_id: 'B0BOT00001' }), held)).toEqual({ refuse: 'held_bot_unknown' })
    expect(ex.learn?.(bodyFrom({ subtype: 'bot_message', bot_id: 'B0BOT00009' }), held)).toEqual({
      refuse: 'held_bot_unknown',
    })
    expect(ex.learn?.(bodyFrom({}), held)).toBeNull() // people are never held back
    expect(ex.learn?.(bodyFrom({ user: BOT, bot_id: 'B0BOT00001' }), owner)).toBeNull()
    // never installed: a day after the bot connection was made, nothing is held back any more
    const DAY = 24 * 3_600_000
    expect(sibs(owner, [fresh], NOW - DAY + 1)).toEqual({ sibling_bot_unknown: '1' })
    expect(sibs(owner, [fresh], NOW - DAY)).toEqual({})
    // once known, only that bot is dropped; other bots reach the owner
    const known = { ...owner, extra: { ...owner.extra, ...sibs(owner, [bc()]) } }
    expect(known.extra.sibling_bot_unknown).toBeUndefined()
    expect(slack.prefilter?.(bodyFrom({ user: BOT, bot_id: 'B0BOT00001' }), known)).toBe(false)
    expect(slack.prefilter?.(bodyFrom({ user: 'U0ELSEBOT1', bot_id: 'B0ELSE0001' }), known)).toBe(true)
    // without any bot connection nothing is passed or held back
    expect(sibs(owner, [owner])).toEqual({})
    expect(slack.prefilter?.(bodyFrom({ user: BOT, bot_id: 'B0BOT00001' }), owner)).toBe(true)
    // and the bot connection never takes its own messages, learned or not
    expect(slack.prefilter?.(toBot({ user: BOT, bot_id: 'B0BOT00001' }), fresh)).toBe(false)
    // a bot connection takes nothing from its siblings; malformed ids are never passed on
    expect(sibs(bc(), [owner, bc()])).toEqual({})
    expect(sibs(owner, [bc({ identity: 'bot', bot_user_id: 'x,U0OWNER001', bot_app_id: 'A,B' })])).toEqual({
      sibling_bot_unknown: '1',
    })
  })

  it('an event Slack delivered for a person, or for another bot, is never taken by a bot connection', async () => {
    // one app with user scopes too: the owner's own DM arrives with the owner's (non-bot) authorization
    const forPerson = raw(fixture('slack/fixtures/dm.json'))
    expect(slack.prefilter?.(forPerson, bc())).toBe(false)
    expect(slack.prefilter?.(forPerson, bc({ identity: 'bot' }))).toBe(false)
    expect(await slack.normalize(forPerson, bc())).toEqual([])
    expect(ex.learn?.(forPerson, bc({ identity: 'bot' }))).toEqual({ refuse: 'not_bot' })
    const noAuth = raw(JSON.stringify({ ...base, authorizations: undefined }))
    expect(slack.prefilter?.(noAuth, bc())).toBe(false)
    expect(ex.learn?.(noAuth, bc())).toEqual({ refuse: 'not_bot' })
    expect(slack.prefilter?.(toBot({}, {}, OTHER_BOT), bc())).toBe(false)
  })

  it("learns the bot's user and app ids from its first event; refuses a different bot after that; a set id wins", () => {
    const learn = (r: ReturnType<typeof raw>, c: ReturnType<typeof bc>) => ex.learn?.(r, c)
    expect(learn(toBot(), bc({ identity: 'bot' }))).toEqual({ extra: { bot_user_id: BOT, bot_app_id: APP } })
    expect(learn(toBot(), bc({ identity: 'bot', bot_user_id: BOT }))).toEqual({ extra: { bot_app_id: APP } })
    expect(learn(toBot(), bc())).toBeNull() // already known, same bot
    expect(learn(toBot({}, {}, OTHER_BOT), bc())).toEqual({ refuse: 'other_bot' }) // not re-learned
    expect(learn(toBot({}, { api_app_id: 'A0EXAMPLE2' }), bc())).toEqual({ refuse: 'other_bot' })
    // an id set in setup is never replaced by what an event says
    expect(learn(toBot(), bc({ identity: 'bot', bot_user_id: OTHER_BOT }))).toEqual({ refuse: 'other_bot' })
    // a malformed bot authorization is not a bot's
    expect(learn(toBot({}, {}, 'not-an-id'), bc({ identity: 'bot' }))).toEqual({ refuse: 'not_bot' })
    // nothing to learn: junk, a handshake, or the owner's connection
    expect(learn(raw('garbage'), bc({ identity: 'bot' }))).toBeNull()
    expect(learn(raw(JSON.stringify({ type: 'url_verification', challenge: 'x' })), bc({ identity: 'bot' }))).toBeNull()
    expect(learn(toBot(), sc)).toBeNull()
  })

  it('the same switches cover the bot kinds', async () => {
    const t = ex.toggle
    const [dm] = await slack.normalize(toBot(), bc())
    const [g] = await slack.normalize(toBot({ channel: 'G0EXAMPLE01', channel_type: 'mpim' }), bc())
    const [m] = await slack.normalize(
      toBot({ channel: 'C0EXAMPLE01', channel_type: 'channel', text: `<@${BOT}> hi` }),
      bc(),
    )
    expect(dm && t?.('dms', false, dm, bc())).toBe(false)
    expect(g && t?.('group_dms', false, g, bc())).toBe(false)
    expect(m && t?.('mentions', false, m, bc())).toBe(false)
    expect(dm && t?.('mentions', false, dm, bc())).toBe(true)
    expect(m && t?.('dms', false, m, bc())).toBe(true)
  })

  it("the owner's connection is unchanged: same events, byte for byte, with or without the new settings", async () => {
    const names = ['dm', 'mention', 'channel-no-mention', 'hostile']
    // and another app's bot DMing the owner, as today
    const botDm = JSON.stringify({ ...base, event: { ...base.event, user: 'U0ELSEBOT1', bot_id: 'B0ELSE0001' } })
    const bodies = [...names.map((n) => fixture(`slack/fixtures/${n}.json`)), botDm]
    const run = async (c: typeof sc) => {
      for (const b of bodies) expect(ex.learn?.(raw(b), c)).toBeNull()
      return JSON.stringify(stable((await Promise.all(bodies.map((b) => slack.normalize(raw(b), c)))).flat()))
    }
    const before = await run(sc)
    expect(await run({ ...sc, extra: { ...sc.extra, identity: 'owner' } })).toBe(before)
    expect(await run({ ...sc, extra: { ...sc.extra, sibling_bot_ids: `${BOT},${OTHER_BOT}` } })).toBe(before)
    expect(await run({ ...sc, extra: { ...sc.extra, identity: 'nonsense' } })).toBe(before) // anything else = owner
    expect(JSON.parse(before).map((e: { kind: string }) => e.kind)).toEqual([
      'slack.dm',
      'slack.mention',
      'slack.dm',
      'slack.dm',
    ])
    expect(sibs(sc, [sc])).toEqual({})
  })

  it('a Slack retry of a bot event is the same delivery and the same event (stored once)', async () => {
    const body = new TextDecoder().decode(toBot().rawBody)
    const first = await slack.verify(req(body), c)
    const retry = await slack.verify(
      req(body, { headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' } }),
      c,
    )
    expect(first).toEqual({ ok: true, deliveryKey: 'slack:Ev0EXAMPLE01' })
    expect(retry).toEqual(first)
    const [a] = await slack.normalize(toBot(), bc())
    const [b] = await slack.normalize(toBot(), bc())
    expect(a?.dedup_key).toBe(b?.dedup_key)
  })
})

describe("slack bot app manifest (an agent's bot, a new app)", () => {
  const url = 'https://relay.example.com/hook/slack/cn_x'
  it('bot scopes and events only: DM, group DM and channel history, and chat:write for the Messages tab', () => {
    const m = slackBotManifest(url)
    expect(m.oauth_config.scopes).toEqual({ bot: ['im:history', 'mpim:history', 'channels:history', 'chat:write'] })
    expect(m.settings.event_subscriptions).toEqual({
      request_url: url,
      bot_events: ['message.im', 'message.mpim', 'message.channels'],
    })
    expect(m.settings.socket_mode_enabled).toBe(false)
    // people can DM the bot: a bot user and a Messages tab they can write in
    expect(m.features.bot_user.display_name).toBeTruthy()
    expect(m.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    })
    expect(m.display_information.name.length).toBeLessThanOrEqual(35) // Slack's limit
    // nothing for private channels, no user scopes, no directory or admin scopes
    expect(JSON.stringify(m)).not.toMatch(/groups:|users:|admin|user_events|"user"/)
  })
  it('the link decodes to that manifest, and refuses a non-https url like the owner link', () => {
    const href = slackBotManifestUrl(url)
    expect(href.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true)
    expect(JSON.parse(decodeURIComponent(href.split('manifest_json=')[1] ?? ''))).toEqual(slackBotManifest(url))
    expect(() => slackBotManifestUrl('http://relay.example.com/hook/slack/cn_x')).toThrow()
  })
})
