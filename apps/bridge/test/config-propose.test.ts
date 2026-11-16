// O1 (SETTINGS-MAP 3.4): `config_propose`. The agent never writes config; the owner approves a card and the BRIDGE applies it.
// Real bridge + FakeRelay + a signing FakeApp. Every claim in the PR text about this tool is one of these tests.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  AGENT_CONFIG_ALLOWLIST,
  AGENT_CONFIG_REFUSED,
  AgentConfig,
  BRIDGE_ONLY_CARD_KINDS,
  bindingFrom,
  Card,
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  ConfigCardPayload,
  configCardCandidate,
  isAgentCardKind,
  parseFrame,
  payloadHash,
  readConfigPath,
  VOICE_CHOICES,
} from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { toolsFor } from '../src/tools/index.ts'
import {
  eventually,
  type Harness,
  pushCardResolvePastRelay,
  sleep,
  startHarness,
  stopRelay,
  waitFor,
} from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }
// The card flow: with "Lock Talos settings" on, a change the owner asked for is a card (settings-on-request.test.ts has the
// direct change the owner gets with the lock off, the default).
const start = (opts: Parameters<typeof startHarness>[0] = {}) =>
  startHarness({
    relay: RELAY,
    ...opts,
    config: (c) => ({ ...(opts.config ?? ((x) => x))(c), settings_lock: true }),
  })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const cfg = (x: Harness) => x.bridge.ctx.config.config
const cards = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)

async function ownerAsks(x: Harness, thread = 'general', msg = 'please change my settings') {
  await x.app.sendMessage(thread, msg)
  await waitFor(
    () =>
      x.bridge.ctx.store
        .ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 50)
        .some((m) => m.thread_id === thread && m.text === msg),
    4000,
    'owner row',
  )
}
const propose = (x: Harness, changes: unknown, extra: Record<string, unknown> = {}) =>
  x.bridge.callTool('config_propose', { thread_id: 'general', reason: 'you asked', changes, ...extra })
async function proposeOk(x: Harness, changes: unknown) {
  const r = await propose(x, changes)
  expect(r.isError, text(r)).toBeFalsy()
  const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
  await waitFor(() => cards(x).some((c) => c.id === id), 4000, 'card.create reached the relay')
  return cards(x).find((c) => c.id === id) as CardT
}
/** Every state the bridge sent for one card, in wire order. Each app keeps the LAST one, so the last one is what the owner sees. */
const cardStates = (x: Harness, id: string) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.update' && r.raw.card_id === id)
    .map((r) => r.raw.state as string)
const approve = async (x: Harness, card: CardT) => x.app.resolveCard(card, 'primary', card.payload_hash)
const noCardMinted = (x: Harness) => expect(cards(x).filter((c) => c.kind === 'config')).toHaveLength(0)

describe('what the list is', () => {
  test('the agent rows are the ones the table turns on (twenty-three), none of them a device, key, enrollment or security setting', () => {
    expect([...AGENT_CONFIG_ALLOWLIST]).toEqual([
      'agent.name',
      'agent.voice',
      'agent.voice_persona',
      'owner.display_name',
      'threads',
      'default_thread',
      'timezone',
      'quiet_window',
      'notifications.master',
      'notifications.show_thread_names',
      'voice_notes.reply_with_voice',
      'voice_notes.driving_until',
      'work.label',
      'work.ask_note',
      'session_models',
      'memory_browser',
      'media_keep_days',
      'always_allow',
      'dev.thread_fence',
      'dev.note_lookup',
      'settings_lock',
      'dedicated',
      'theme',
    ])
    // what proves who the owner is, or opens a door off the Mac, stays the owner's (the relay's passkey rows among them)
    for (const refused of [
      'permission_relay',
      'work.enabled',
      'work.thread',
      'work.retention',
      'trust_mode',
      'bug_webhook_url',
    ])
      expect(AGENT_CONFIG_REFUSED as readonly string[]).toContain(refused)
    for (const p of AGENT_CONFIG_ALLOWLIST) expect(p).not.toMatch(/device|key|enroll|passkey|secret|token|stepup/i)
  })

  test("kind 'config' is bridge-only: not in AGENT_CARD_KINDS, so the card tool and headless posts cannot mint it", async () => {
    expect(BRIDGE_ONLY_CARD_KINDS as readonly string[]).toContain('config')
    expect(isAgentCardKind('config')).toBe(false)
    h = await start()
    const r = await h.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'config',
      title: 'x',
      destination: [{ label: 'a', value: 'b' }],
      body: 'x',
      primary_label: 'Apply',
      kill_label: 'Keep',
    })
    expect(r.isError).toBe(true)
    noCardMinted(h)
  })
})

describe('the tool is registered where it should be, and nowhere else', () => {
  test('a live main session has it, a worker session has it for its own thread (over the hub), a headless process cannot run it', async () => {
    h = await start()
    expect(h.bridge.tools.map((t) => t.name)).toContain('config_propose')
    expect(toolsFor({ scheduler: 'auto' }).map((t) => t.name)).toContain('config_propose')
    expect(toolsFor({ scheduler: 'off' }).map((t) => t.name)).toContain('config_propose') // not a Schedules tool
    expect(toolsFor({ scheduler: 'auto', workerThread: 'trip' }).map((t) => t.name)).toContain('config_propose')
    expect(h.bridge.ctx.configProposals).toBeDefined()
  })

  test('a headless process is refused (it has no relay socket and no live owner)', async () => {
    const { Bridge } = await import('../src/bridge.ts')
    const { loadEnv } = await import('../src/config.ts')
    const { nullLogger } = await import('../src/log.ts')
    h = await start()
    const hl = await Bridge.create({
      env: loadEnv({ TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl }),
      logger: nullLogger,
      headless: true,
    })
    const r = await hl.callTool('config_propose', {
      thread_id: 'general',
      reason: 'x',
      changes: [{ path: 'timezone', value: 'Europe/Paris' }],
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/needs a live session/)
    await hl.stop()
  })
})

describe('propose time', () => {
  test('until the relay lists config-propose/1 nothing is minted (an older relay would refuse the card kind)', async () => {
    h = await startHarness({ relay: { relayFeatures: ['schedules/1'] } })
    await ownerAsks(h)
    const r = await propose(h, [{ path: 'timezone', value: 'Europe/Paris' }])
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/relay doesn't support settings proposals/)
    noCardMinted(h)
  })

  test('not asked: still a card (his check), never a change; asked or not, with the lock on it is a card', async () => {
    h = await start()
    const r = await propose(h, [{ path: 'timezone', value: 'Europe/Paris' }])
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(cfg(h).timezone).not.toBe('Europe/Paris')
    await ownerAsks(h, 'general')
    const asked = await propose(h, [{ path: 'agent.name', value: 'Hal' }])
    expect(text(asked)).toMatch(/^Talos settings are locked.*card c_\S+ pending/)
    expect(cfg(h).agent.name).not.toBe('Hal')
  })

  test.each([
    ...AGENT_CONFIG_REFUSED,
    'permission_stepup',
    'sessions_view',
    'mirror',
    'threads',
    'threads.trip.kind',
    'threads.general.session_opts',
    'work.enabled',
    'agent',
    'owner',
    'devices',
    'device.revoked',
    'bridge_key',
    'security',
    'rev',
    'version',
    '__proto__',
    'constructor.prototype',
    'voice_notes',
    '',
  ])('%p is refused, nothing is minted, nothing is written', async (path) => {
    h = await start()
    await ownerAsks(h)
    const before = JSON.stringify(cfg(h))
    const r = await propose(h, [{ path, value: 'x' }])
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/can't be changed by you|not a setting you may propose|needs a path|path/)
    noCardMinted(h)
    expect(JSON.stringify(cfg(h))).toBe(before)
  })

  test('one forbidden path in a list of good ones refuses the whole proposal', async () => {
    h = await start()
    await ownerAsks(h)
    const r = await propose(h, [
      { path: 'timezone', value: 'Europe/Paris' },
      { path: 'permission_relay', value: true },
    ])
    expect(r.isError).toBe(true)
    noCardMinted(h)
  })

  test.each([
    ['agent.name', ''],
    ['agent.name', 'x'.repeat(33)],
    ['agent.name', 'Hal‮9000'],
    ['agent.name', ' padded '],
    ['agent.name', 5],
    ['owner.display_name', 'a\nb'],
    ['timezone', 'Mars/Olympus'],
    ['timezone', 7],
    ['quiet_window', { start: '08:00', end: '08:00' }],
    ['quiet_window', { start: '25:00', end: '07:00' }],
    ['quiet_window', { start: '22:00', end: '07:00', extra: 1 }],
    ['quiet_window', 'always'],
    ['voice_notes.reply_with_voice', 'sometimes'],
    ['agent.voice', 'Not A Voice!'],
    ['agent.voice', 'onyx'], // a well-formed guess the live-call provider would refuse
  ])('a bad value for %p (%p) is refused with the reason', async (path, value) => {
    h = await start()
    await ownerAsks(h)
    const r = await propose(h, [{ path, value }])
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(path as string)
    noCardMinted(h)
  })

  test('agent.voice takes only a voice the Settings select offers, and the tool text names them', async () => {
    h = await start()
    await ownerAsks(h)
    const tool = h.bridge.tools.find((t) => t.name === 'config_propose')
    for (const v of VOICE_CHOICES) expect(JSON.stringify(tool?.inputSchema)).toContain(v)
    const card = await proposeOk(h, [{ path: 'agent.voice', value: 'cedar' }])
    expect(card.payload).toMatchObject({ changes: [{ path: 'agent.voice', new: 'cedar' }] })
  })

  test('a no-op, a duplicate path and too many changes are refused', async () => {
    h = await start()
    await ownerAsks(h)
    expect(text(await propose(h, [{ path: 'timezone', value: cfg(h).timezone }]))).toMatch(/already that value/)
    expect(
      text(
        await propose(h, [
          { path: 'timezone', value: 'Europe/Paris' },
          { path: 'timezone', value: 'Europe/Rome' },
        ]),
      ),
    ).toMatch(/twice/)
    expect(
      text(
        await propose(
          h,
          Array.from({ length: 7 }, () => ({ path: 'timezone', value: 'UTC' })),
        ),
      ),
    ).toMatch(/At most 6/)
    expect(text(await propose(h, []))).toMatch(/list of/)
    expect(text(await propose(h, 'timezone=Paris'))).toMatch(/list of/)
    noCardMinted(h)
  })

  test('unknown thread and missing reason are refused', async () => {
    h = await start()
    await ownerAsks(h)
    expect(text(await propose(h, [{ path: 'timezone', value: 'Europe/Paris' }], { thread_id: 'nope' }))).toMatch(
      /Unknown thread/,
    )
    expect(text(await propose(h, [{ path: 'timezone', value: 'Europe/Paris' }], { reason: '  ' }))).toMatch(
      /reason is required/,
    )
    noCardMinted(h)
  })

  test('5 pending at once; past 6 proposals an hour, a warning, not a refusal (Pantheon 2026-11-15)', async () => {
    h = await start()
    await ownerAsks(h)
    const zones = ['Europe/Paris', 'Europe/Rome', 'Europe/Oslo', 'Asia/Tokyo', 'Asia/Seoul']
    for (const z of zones) {
      const r = await propose(h, [{ path: 'timezone', value: z }])
      expect(r.isError, z).toBeFalsy()
      expect(text(r)).not.toContain('Warning')
    }
    expect(text(await propose(h, [{ path: 'timezone', value: 'Asia/Dubai' }]))).toMatch(
      /already 5 settings cards waiting/,
    )
    expect(cards(h).filter((c) => c.kind === 'config')).toHaveLength(5)
  })

  test('past 6 proposals an hour: proposed all the same, and the agent is warned', async () => {
    h = await start()
    await ownerAsks(h)
    const svc = h.bridge.ctx.configProposals as unknown as { proposalAt: number[] }
    const now = h.bridge.ctx.clock.now()
    svc.proposalAt = Array.from({ length: 6 }, (_, i) => now - 60_000 * (i + 1))
    const r = await propose(h, [{ path: 'timezone', value: 'Asia/Tokyo' }])
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/Warning: that is more than 6 setting proposals this hour/)
    // an hour later the count has gone by: no warning
    svc.proposalAt = Array.from({ length: 6 }, () => now - 3_700_000)
    expect(text(await propose(h, [{ path: 'timezone', value: 'Asia/Seoul' }]))).not.toContain('Warning')
  })
})

describe('the card', () => {
  test('kind config, no editing, revise allowed, bridge-owned, old and new in the body, hash binds what was shown, and the wire accepts it', async () => {
    h = await start()
    await ownerAsks(h)
    const before = { name: cfg(h).agent.name, tz: cfg(h).timezone }
    const card = await proposeOk(h, [
      { path: 'agent.name', value: 'Hal' },
      { path: 'quiet_window', value: { start: '21:30', end: '06:30' } },
      { path: 'voice_notes.reply_with_voice', value: 'never' },
    ])
    expect(card.kind).toBe('config')
    expect(card.allow_edit).toBe(false)
    expect(card.allow_revise).toBe(true)
    expect(card.thread_id).toBe('general')
    expect(card.risk).toBe('low')
    expect(h.bridge.ctx.ledger.get(card.id)?.actor).toBe('bridge')
    expect(card.body).toContain(`Agent name: ${before.name} → Hal`)
    expect(card.body).toContain('Quiet hours: off → 21:30 to 06:30')
    expect(card.body).toContain('Voice-note replies: when I send a voice note → never')
    expect(card.body).toContain('Why: you asked')
    expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
    const p = ConfigCardPayload.parse(card.payload)
    expect(p.changes.map((c) => c.path)).toEqual(['agent.name', 'quiet_window', 'voice_notes.reply_with_voice'])
    expect(p.base_rev).toBe(cfg(h).rev)
    expect(parseFrame({ ...mkFrame('card.create'), card }, { direction: 'bridge_to_relay' }).ok).toBe(true)
    // proposing writes nothing
    expect(cfg(h).agent.name).toBe(before.name)
    expect(cfg(h).quiet_window ?? null).toBeNull()
  })

  test('the hash changes if the body or the bound payload is altered after the fact (what was shown is what is bound)', async () => {
    h = await start()
    await ownerAsks(h)
    const card = await proposeOk(h, [{ path: 'agent.name', value: 'Hal' }])
    const swapped = {
      ...card,
      payload: { ...(card.payload as object), changes: [{ path: 'agent.name', old: 'Talos', new: 'Evil' }] },
    } as CardT
    expect(payloadHash(bindingFrom(swapped))).not.toBe(card.payload_hash)
    expect(payloadHash(bindingFrom({ ...card, body: 'Agent name: Talos → Evil' } as CardT))).not.toBe(card.payload_hash)
  })
})

describe('approval applies it, through ConfigFile.applyPatch, and syncs like an owner patch', () => {
  test('PRIMARY writes exactly the bound values, bumps rev, syncs the config, finishes the card and tells the agent', async () => {
    h = await start()
    await ownerAsks(h)
    const rev0 = cfg(h).rev
    const card = await proposeOk(h, [
      { path: 'agent.name', value: 'Hal' },
      { path: 'timezone', value: 'Europe/Paris' },
      { path: 'quiet_window', value: { start: '21:30', end: '06:30' } },
    ])
    const syncsBefore = h.relay.frames.filter(
      (r) => r.direction === 'from_bridge' && r.raw.type === 'config.sync',
    ).length
    await approve(h, card)
    await eventually(() => expect(cfg(h as Harness).agent.name).toBe('Hal'))
    expect(cfg(h).timezone).toBe('Europe/Paris')
    expect(cfg(h).quiet_window).toEqual({ start: '21:30', end: '06:30' })
    expect(cfg(h).rev).toBe(rev0 + 1)
    expect(
      AgentConfig.safeParse(JSON.parse(require('node:fs').readFileSync(`${h.home}/config.json`, 'utf8'))).success,
    ).toBe(true)
    await eventually(() =>
      expect(
        h?.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'config.sync').length,
      ).toBeGreaterThan(syncsBefore),
    )
    const upd = await h.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
      direction: 'from_bridge',
    })
    expect(upd.result?.ok).toBe(true)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('done')
    expect(cardStates(h, card.id).at(-1)).toBe('done')
    await waitFor(
      () => h?.notes.some((n) => n.content.includes(`Card ${card.id}`) && n.content.includes('applied')) === true,
      4000,
      'agent told',
    )
    // nothing else changed
    expect(cfg(h).owner.display_name).toBe('You')
    expect(cfg(h).voice_notes.reply_with_voice).toBe('when_voice')
  })

  test('a value that changed since the card was drawn fails the card in words and writes nothing, not even the untouched ones', async () => {
    h = await start()
    await ownerAsks(h)
    const card = await proposeOk(h, [
      { path: 'agent.name', value: 'Hal' },
      { path: 'timezone', value: 'Europe/Paris' },
    ])
    // the owner changes the name from the app after the card was drawn
    const rev = cfg(h).rev
    const f = await h.app.sendConfigPatch(rev, { agent: { name: 'Owner picked' } })
    await h.relay.expectFrame('config.sync', (s) => s.config.agent.name === 'Owner picked', {
      direction: 'from_bridge',
    })
    void f
    const tzBefore = cfg(h).timezone
    await approve(h, card)
    const upd = await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
      direction: 'from_bridge',
    })
    expect(upd.result?.text).toMatch(/Agent name changed since this card was drawn, so nothing was changed/)
    expect(cfg(h).agent.name).toBe('Owner picked')
    expect(cfg(h).timezone).toBe(tzBefore) // the other setting on the same card was not written either
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('failed')
    // the app keeps the LAST frame: 'resolved' must come before 'failed', or the refusal is hidden behind "Working on it"
    await eventually(() => expect(cardStates(h as Harness, card.id)).toContain('failed'))
    expect(cardStates(h, card.id).at(-1)).toBe('failed')
    expect(cardStates(h, card.id)).toEqual(['resolved', 'failed'])
  })

  test('two cards for one setting, approved together: one winner, the other fails in words', async () => {
    h = await start()
    await ownerAsks(h)
    const a = await proposeOk(h, [{ path: 'agent.name', value: 'Hal' }])
    const b = await proposeOk(h, [{ path: 'agent.name', value: 'Atlas' }])
    await Promise.all([approve(h, a), approve(h, b)])
    await eventually(() => {
      const states = [a, b].map((c) => (h as Harness).bridge.ctx.ledger.get(c.id)?.state)
      expect(states.sort()).toEqual(['done', 'failed'])
    })
    expect(['Hal', 'Atlas']).toContain(cfg(h).agent.name)
    expect(cfg(h).rev).toBe(1) // exactly one write
  })

  test('the same card approved twice writes once', async () => {
    h = await start()
    await ownerAsks(h)
    const card = await proposeOk(h, [{ path: 'agent.name', value: 'Hal' }])
    await approve(h, card)
    await approve(h, card)
    await eventually(() => expect(cfg(h as Harness).agent.name).toBe('Hal'))
    await sleep(300)
    expect(cfg(h).rev).toBe(1)
  })

  test('KILL and REVISE write nothing and reach the agent with the owner’s note', async () => {
    h = await start()
    await ownerAsks(h)
    const k = await proposeOk(h, [{ path: 'agent.name', value: 'Hal' }])
    await h.app.resolveCard(k, 'kill', k.payload_hash)
    await waitFor(() => h?.bridge.ctx.ledger.get(k.id)?.state === 'done', 4000, 'killed card closed')
    await waitFor(
      () => h?.notes.some((n) => n.content.includes(`Card ${k.id}`) && n.content.includes('KILL')) === true,
      4000,
      'kill told',
    )
    const r = await proposeOk(h, [{ path: 'agent.name', value: 'Atlas' }])
    await h.app.resolveCard(r, 'revise', r.payload_hash, { note: 'call it Sol' })
    await waitFor(
      () => h?.notes.some((n) => n.content.includes(`Card ${r.id}`) && n.content.includes('call it Sol')) === true,
      4000,
      'revise told',
    )
    expect(cfg(h).agent.name).toBe('Talos')
    expect(cfg(h).rev).toBe(0)
  })

  test('the allowlist is checked AGAIN at apply, on the bound payload: a ledger row that names a forbidden path writes nothing', async () => {
    h = await start()
    await ownerAsks(h)
    const base = configCardCandidate({
      cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      threadId: 'general',
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      origin: 'chat',
      baseRev: 0,
      reason: 'forged',
      changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }],
    })
    let n = 0
    for (const forged of [
      { path: 'permission_relay', old: false, new: true },
      { path: 'default_thread', old: 'general', new: 'inbox' },
      { path: 'work.enabled', old: [], new: ['slack'] },
      { path: 'agent.voice', old: 'meridian', new: 'onyx' },
    ]) {
      const payload = { v: 1, base_rev: 0, reason: 'forged', changes: [forged] }
      const id = `c_01JBF3V7Q8K2M4N6P8R0S${String(++n).padStart(5, '0')}`
      const card = Card.parse({ ...base, id, payload })
      card.payload_hash = payloadHash(bindingFrom(card))
      h.bridge.ctx.ledger.create(card, 'bridge')
      const before = JSON.stringify(cfg(h))
      await pushCardResolvePastRelay(h, card, card.payload_hash)
      await eventually(() => expect((h as Harness).bridge.ctx.ledger.get(id)?.state).toBe('failed'))
      await eventually(() => expect(cardStates(h as Harness, id)).toContain('failed'))
      expect(cardStates(h, id).at(-1)).toBe('failed') // the refusal is the last frame the apps see
      expect(JSON.stringify(cfg(h))).toBe(before)
    }
  })

  describe.each([
    ['scheduler on', {}],
    ['scheduler off', { TALOS_APP_SCHEDULER: 'off' }],
  ])('a restart between the owner approving and the bridge finishing (%s)', (_label, env) => {
    // the crash window: ledger says resolved, nothing was written, nobody is left to call end()
    async function approvedThenCrashed(name: string) {
      h = await start({ env })
      await ownerAsks(h)
      const card = await proposeOk(h, [{ path: 'agent.name', value: name }])
      const out = h.bridge.ctx.ledger.resolve(
        {
          card_id: card.id,
          action: 'primary',
          payload_hash: card.payload_hash as string,
          ts: new Date().toISOString(),
        },
        Date.now(),
      )
      expect(out.ok).toBe(true)
      const home = h.home
      await h.stop()
      return { card, home }
    }

    test('nothing was written: the card fails in words that are not about schedules, once, and never stays on Working on it', async () => {
      const { card, home } = await approvedThenCrashed('Hal')
      h = await start({ env, home })
      await eventually(() => expect(h?.bridge.ctx.ledger.get(card.id)?.state).toBe('failed'))
      const upd = await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
        direction: 'from_bridge',
      })
      expect(upd.result?.text).toMatch(/restarted before this was saved\. Nothing was changed/)
      expect(upd.result?.text).not.toMatch(/Schedules/)
      expect(cfg(h).agent.name).not.toBe('Hal')
      expect(cardStates(h, card.id)).toEqual(['failed'])
    })

    test('the write had landed before the crash: the card says Saved, not failed', async () => {
      const { card, home } = await approvedThenCrashed('Hal')
      h = await start({ env, home, config: (c) => ({ ...c, agent: { ...c.agent, name: 'Hal' } }) })
      await eventually(() => expect(h?.bridge.ctx.ledger.get(card.id)?.state).toBe('done'))
      const upd = await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
        direction: 'from_bridge',
      })
      expect(upd.result?.text).toMatch(/^Saved\./)
    })
  })

  test('off mid-work: the Mac goes away between propose and approve, the card still applies once the bridge is back', async () => {
    h = await start()
    await ownerAsks(h)
    const card = await proposeOk(h, [{ path: 'timezone', value: 'Europe/Paris' }])
    // the card is only a ledger row on the Mac until approved: restarting the bridge keeps it pending
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    await approve(h, card)
    await eventually(() => expect(cfg(h as Harness).timezone).toBe('Europe/Paris'))
  })
})

describe('older peers and unknown values', () => {
  test('a card of an unknown kind never reaches config handling, and an old relay with no feature gets no card', async () => {
    h = await startHarness({ relay: { relayFeatures: [] } })
    await ownerAsks(h)
    expect((await propose(h, [{ path: 'timezone', value: 'Europe/Paris' }])).isError).toBe(true)
    noCardMinted(h)
    await stopRelay(h.relay).catch(() => {})
  })

  test('a payload with an unknown key, a wrong version, or an unlisted path does not parse', () => {
    const ok = { v: 1, base_rev: 0, reason: 'x', changes: [{ path: 'timezone', old: 'UTC', new: 'Europe/Paris' }] }
    expect(ConfigCardPayload.safeParse(ok).success).toBe(true)
    expect(ConfigCardPayload.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(ConfigCardPayload.safeParse({ ...ok, v: 2 }).success).toBe(false)
    expect(
      ConfigCardPayload.safeParse({ ...ok, changes: [{ path: 'permission_relay', old: false, new: true }] }).success,
    ).toBe(false)
    expect(ConfigCardPayload.safeParse({ ...ok, changes: [] }).success).toBe(false)
    expect(
      readConfigPath(AgentConfig.parse(require('../../../examples/config.default.json')), 'quiet_window'),
    ).toBeNull()
  })
})

describe('default_thread and notifications.show_thread_names are high (see app-control.test.ts); the Mac-only rows stay refused at apply', () => {
  // the card-under-trust cases for these rows are in app-control.test.ts; here the second look at apply for a row that stays the Mac's

  test.each(['permission_relay', 'work.enabled'])(
    'a card bound to %s is refused again at apply, with trust mode on',
    async (path) => {
      h = await start()
      await ownerAsks(h)
      h.bridge.ctx.config.update((c) => ({ ...c, trust_mode: true }), { setsTrustMode: true })
      const payload = { v: 1, base_rev: 0, reason: 'forged', changes: [{ path, old: true, new: false }] }
      const base = configCardCandidate({
        cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
        threadId: 'general',
        now: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        origin: 'chat',
        baseRev: 0,
        reason: 'forged',
        changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }],
      })
      const id = 'c_01JBF3V7Q8K2M4N6P8R0S9T9T9'
      const card = Card.parse({ ...base, id, payload })
      card.payload_hash = payloadHash(bindingFrom(card))
      h.bridge.ctx.ledger.create(card, 'bridge')
      const before = JSON.stringify(cfg(h))
      await pushCardResolvePastRelay(h, card, card.payload_hash)
      await eventually(() => expect((h as Harness).bridge.ctx.ledger.get(id)?.state).toBe('failed'))
      expect(JSON.stringify(cfg(h))).toBe(before)
    },
  )
})

describe('trust_mode stays out of the agent paths, now that the owner can patch it', () => {
  // the app's config.patch is the only writer from outside the Mac: a card the agent forged, bound to trust_mode, goes
  // through ConfigProposer.apply on approval and must fail with nothing written, trust mode on or off
  test.each([true, false])(
    'a forged card naming trust_mode (new value %p) is refused at apply and nothing is written',
    async (value) => {
      h = await start()
      await ownerAsks(h)
      const base = configCardCandidate({
        cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
        threadId: 'general',
        now: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        origin: 'chat',
        baseRev: 0,
        reason: 'forged',
        changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }],
      })
      const id = 'c_01JBF3V7Q8K2M4N6P8R0S9T9T8'
      const payload = {
        v: 1,
        base_rev: 0,
        reason: 'forged',
        changes: [{ path: 'trust_mode', old: undefined, new: value }],
      }
      const card = Card.parse({ ...base, id, payload })
      card.payload_hash = payloadHash(bindingFrom(card))
      h.bridge.ctx.ledger.create(card, 'bridge')
      const before = JSON.stringify(cfg(h))
      await pushCardResolvePastRelay(h, card, card.payload_hash)
      await eventually(() => expect((h as Harness).bridge.ctx.ledger.get(id)?.state).toBe('failed'))
      expect(JSON.stringify(cfg(h))).toBe(before)
      expect('trust_mode' in cfg(h)).toBe(false)
    },
  )

  test('the direct path (trust mode on, owner asked) refuses it too', async () => {
    h = await start()
    await ownerAsks(h)
    h.bridge.ctx.config.update((c) => ({ ...c, trust_mode: true }), { setsTrustMode: true })
    const before = JSON.stringify(cfg(h))
    const r = await propose(h, [{ path: 'trust_mode', value: false }])
    expect(r.isError).toBe(true)
    noCardMinted(h)
    expect(JSON.stringify(cfg(h))).toBe(before)
  })
})

describe('threads[].session_opts.ops_read stays the owner’s (m5/lead-errors-read)', () => {
  test.each([
    'threads',
    'threads.session_opts.ops_read',
    'threads.0.session_opts.ops_read',
    'session_opts.ops_read',
    'ops_read',
  ])('%s is refused at propose, with no card and no write', async (path) => {
    h = await start()
    await ownerAsks(h)
    const before = JSON.stringify(cfg(h))
    const r = await propose(h, [{ path, value: true }])
    expect(r.isError).toBe(true)
    noCardMinted(h)
    expect(JSON.stringify(cfg(h))).toBe(before)
  })
})
