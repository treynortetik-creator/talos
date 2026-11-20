// Slack bot connections through the real relay pipeline: a connection made for an agent's bot learns the bot's user id
// from its first event and refuses another bot's events after that; the owner's connection drops what that bot says.
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
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}
const SIGNING = '0123456789abcdef0123456789abcdef'
const BOT = 'U0BOT00001'
const OTHER_BOT = 'U0BOT00002'

function slackRelay() {
  const s = setup({
    random: () => 0,
    config: (c) => {
      c.threads.push(WORK_THREAD)
      c.work.thread = 'work'
      c.work.enabled = ['slack']
    },
  })
  let n = 0
  const deliver = (
    connId: string,
    auth: { user_id: string; is_bot: boolean },
    ev: object,
    eventId = `Ev0B${++n}`,
    app = 'A0EXAMPLE',
  ) => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T0EXAMPLE',
      api_app_id: app,
      event_id: eventId,
      authorizations: [auth],
      event: { type: 'message', channel: 'D0EXAMPLE', channel_type: 'im', text: 'hi', ts: `1761660000.000${n}`, ...ev },
    })
    const ts = String(Math.floor(s.f.clock.now() / 1000))
    return s.post('slack', connId, body, {
      'content-type': 'application/json',
      'x-slack-signature': `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}`,
      'x-slack-request-timestamp': ts,
    })
  }
  const extra = (id: string) =>
    JSON.parse((s.f.db.prepare('select extra from hooks_connections where id = ?').get(id) as { extra: string }).extra)
  const reasons = (id: string) =>
    (
      s.f.db.prepare('select reason from hooks_deliveries where conn_id = ? order by at, id').all(id) as Array<{
        reason: string
      }>
    ).map((r) => r.reason)
  const kinds = async () => {
    await s.drain()
    return s.eventBodies().map((e) => (e as { kind: string }).kind)
  }
  return { s, deliver, extra, reasons, kinds }
}

describe('Slack bot connection (relay)', () => {
  it("learns the bot's id from its first event, keeps it, and refuses another bot's events", async () => {
    const { s, deliver, extra, reasons, kinds } = slackRelay()
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } })
    expect(extra(bot.id)).toEqual({ identity: 'bot' })
    expect((await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1' })).status).toBe(200)
    expect(extra(bot.id)).toEqual({ identity: 'bot', bot_user_id: BOT, bot_app_id: 'A0EXAMPLE' })
    expect(await kinds()).toEqual(['slack.bot_dm'])
    // its own reply comes back as an event: dropped before storage
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: BOT, bot_id: 'B0BOT00001' })
    // a different bot's event (a secret pasted into the wrong connection): refused, recorded, nothing learned
    expect((await deliver(bot.id, { user_id: OTHER_BOT, is_bot: true }, { user: 'U0PERSON1' })).status).toBe(200)
    expect(extra(bot.id)).toEqual({ identity: 'bot', bot_user_id: BOT, bot_app_id: 'A0EXAMPLE' })
    expect(reasons(bot.id).slice(-2)).toEqual(['prefiltered', 'other_bot'])
    expect(await kinds()).toEqual(['slack.bot_dm'])
  })

  it("the owner's connection holds back bot messages until the bot is known, then drops only its bot's", async () => {
    const { s, deliver, kinds, reasons } = slackRelay()
    const owner = await s.create('slack', { fields: { signing_secret: SIGNING } })
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } })
    const asOwner = { user_id: 'U0OWNER', is_bot: false }
    // first event case: the bot connection has not heard from Slack yet, so every bot message to the owner is held back
    await deliver(owner.id, asOwner, { user: BOT, bot_id: 'B0BOT00001', text: 'first' })
    await deliver(owner.id, asOwner, { user: 'U0PERSON1', text: 'a person' })
    expect(await kinds()).toEqual(['slack.dm'])
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1' }) // the bot learns its ids
    await deliver(owner.id, asOwner, { user: BOT, bot_id: 'B0BOT00001', text: 'second' })
    await deliver(owner.id, asOwner, {
      subtype: 'bot_message',
      bot_id: 'B0BOT00001',
      app_id: 'A0EXAMPLE',
      text: 'named',
    })
    await deliver(owner.id, asOwner, { user: 'U0ELSEBOT1', bot_id: 'B0ELSE0001', app_id: 'A0ELSEAPP1', text: 'ci' })
    expect(await kinds()).toEqual(['slack.dm', 'slack.bot_dm', 'slack.dm'])
    expect(reasons(owner.id)[0]).toBe('held_bot_unknown') // shown in Recent deliveries
  })

  it('a bot connection that is never installed holds nothing back after a day', async () => {
    const { s, deliver, kinds, reasons } = slackRelay()
    const owner = await s.create('slack', { fields: { signing_secret: SIGNING } })
    await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } }) // never hears from Slack
    const asOwner = { user_id: 'U0OWNER', is_bot: false }
    await deliver(owner.id, asOwner, { user: 'U0ELSEBOT1', bot_id: 'B0ELSE0001', text: 'held' })
    s.f.clock.advance(24 * 3_600_000)
    await deliver(owner.id, asOwner, { user: 'U0ELSEBOT1', bot_id: 'B0ELSE0001', text: 'through' })
    expect(await kinds()).toEqual(['slack.dm'])
    expect(reasons(owner.id)[0]).toBe('held_bot_unknown')
  })

  it('a new bot id or signing secret saved later is learned again, not refused forever', async () => {
    const { s, deliver, extra, kinds } = slackRelay()
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } })
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1' })
    expect(extra(bot.id)).toMatchObject({ bot_user_id: BOT, bot_app_id: 'A0EXAMPLE' })
    const creds = (fields: Record<string, string>) =>
      s.api('POST', `/api/connections/${bot.id}/credentials`, { fields })
    expect(await (await creds({ bot_user_id: OTHER_BOT })).json()).toMatchObject({ ok: true })
    const at = String(s.f.clock.now())
    expect(extra(bot.id)).toEqual({ identity: 'bot', bot_user_id: OTHER_BOT, bot_relearn_at: at }) // app id: again
    await deliver(bot.id, { user_id: OTHER_BOT, is_bot: true }, { user: 'U0PERSON1' }, 'Ev0NEW', 'A0OTHERAPP')
    expect(extra(bot.id)).toMatchObject({ bot_user_id: OTHER_BOT, bot_app_id: 'A0OTHERAPP' })
    expect(await kinds()).toEqual(['slack.bot_dm', 'slack.bot_dm'])
  })

  it('refuses events Slack delivered for a person on a bot connection, and a retry of a refused event', async () => {
    const { s, deliver, extra, reasons, kinds } = slackRelay()
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } })
    await deliver(bot.id, { user_id: 'U0OWNER', is_bot: false }, { user: 'U0PERSON1', text: 'private' })
    expect(extra(bot.id)).toEqual({ identity: 'bot' }) // nothing learned from a person's event
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1' }, 'Ev0FIRST')
    await deliver(bot.id, { user_id: OTHER_BOT, is_bot: true }, { user: 'U0PERSON1' }, 'Ev0WRONG')
    await deliver(bot.id, { user_id: OTHER_BOT, is_bot: true }, { user: 'U0PERSON1' }, 'Ev0WRONG') // Slack's retry
    const r = reasons(bot.id)
    expect([r[0], r.at(-2), r.at(-1)]).toEqual(['not_bot', 'other_bot', 'other_bot'])
    expect(r.filter((x) => x === 'other_bot' || x === 'not_bot')).toHaveLength(3)
    expect(await kinds()).toEqual(['slack.bot_dm'])
  })

  it('a Slack retry of a bot event is stored once', async () => {
    const { s, deliver, kinds } = slackRelay()
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot', bot_user_id: BOT } })
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1', ts: '1761660000.5' }, 'Ev0SAME')
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1', ts: '1761660000.5' }, 'Ev0SAME')
    expect(await kinds()).toEqual(['slack.bot_dm'])
  })

  it('setup takes identity and bot_user_id for Slack only, checked; identity only when the connection is made', async () => {
    const { s } = slackRelay()
    const make = (integration: string, fields: Record<string, string>) =>
      s.api('POST', '/api/connections', { integration, name: 'x', fields })
    expect((await make('slack', { signing_secret: SIGNING, identity: 'robot' })).status).toBe(400)
    for (const bad of ['U0OWNER,U0X', 'U0BOT00001\n', 'u0bot00001', ' U0BOT00001'])
      expect((await make('slack', { signing_secret: SIGNING, bot_user_id: bad })).status).toBe(400)
    expect((await make('slack', { signing_secret: SIGNING, sibling_bot_ids: BOT })).status).toBe(400)
    expect((await make('generic', { identity: 'bot' })).status).toBe(400)
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot', bot_user_id: BOT } })
    const creds = (fields: Record<string, string>) =>
      s.api('POST', `/api/connections/${bot.id}/credentials`, { fields })
    expect(await (await creds({ identity: 'owner' })).json()).toMatchObject({ ok: false })
    expect(await (await creds({ bot_user_id: OTHER_BOT })).json()).toMatchObject({ ok: true })
  })

  it('a new Signing Secret on a bot connection older than a day holds bots back again until it relearns', async () => {
    const { s, deliver, kinds, reasons } = slackRelay()
    const owner = await s.create('slack', { fields: { signing_secret: SIGNING } })
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } })
    const asOwner = { user_id: 'U0OWNER', is_bot: false }
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1' }) // learned
    s.f.clock.advance(2 * 24 * 3_600_000)
    const res = await s.api('POST', `/api/connections/${bot.id}/credentials`, {
      fields: { signing_secret: 'fedcba9876543210fedcba9876543210' },
    })
    expect(await res.json()).toMatchObject({ ok: true })
    // the ids are forgotten; the bot's message to the owner is held back, not let through
    await deliver(owner.id, asOwner, { user: BOT, bot_id: 'B0BOT00001', text: 'after the new secret' })
    expect(reasons(owner.id).at(-1)).toBe('held_bot_unknown')
    expect(await kinds()).toEqual(['slack.bot_dm'])
  })

  it('the connection list says whose Slack each connection hears, and nothing else from extra', async () => {
    const { s, deliver } = slackRelay()
    await s.create('slack', { fields: { signing_secret: SIGNING } })
    const bot = await s.create('slack', { fields: { signing_secret: SIGNING, identity: 'bot' } })
    expect(bot.identity).toBe('bot')
    await deliver(bot.id, { user_id: BOT, is_bot: true }, { user: 'U0PERSON1' }) // learns its ids
    const list = (await (await s.api('GET', '/api/connections')).json()) as Array<Record<string, unknown>>
    expect(list.map((c) => c.identity).sort()).toEqual(['bot', 'owner'])
    expect(JSON.stringify(list)).not.toMatch(/bot_user_id|bot_app_id|U0BOT00001|A0EXAMPLE|extra/)
  })
})
