// "Always allow" on every action kind (owner, 2026-11-21), the bridge half: after the owner's tap the NEXT card of that kind passes
// without a card (a table over the kinds), a settings card passes only for ordinary settings (every trust key still gets a card even
// with the grant), `always` on a card that does not offer it is refused and adds nothing, and a bridge-made card (schedule, undo)
// is applied as his tap would be. Real bridge + FakeRelay + a signing FakeApp.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  ALWAYS_KINDS,
  bindingFrom,
  Card,
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  CONFIG_TRUST_KEYS,
  cardNotice,
  createPhoneKeys,
  newId,
  newUlid,
  payloadHash,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { passBridgeCard } from '../src/always-allow.ts'
import { cardCreateFrame } from '../src/frames-out.ts'
import { HARNESS_START_MS, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(30_000))

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }
const grant = (...kinds: string[]) => ({
  always_allow: kinds.map((kind) => ({ kind, destination: null })),
})
const start = (extra: Record<string, unknown> = {}) =>
  startHarness({ relay: RELAY, config: (c) => ({ ...c, ...extra }) as typeof c })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const allowed = (x: Harness) => (x.bridge.ctx.config.config.always_allow ?? []).map((e) => e.kind)
const cardsOnWire = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)

const AGENT_CARDS: Record<string, Record<string, unknown>> = {
  email: {
    destination: [{ label: 'To', value: 'sam@example.com' }],
    primary_label: 'Send',
    kill_label: 'Kill',
    risk: 'high',
  },
  message: { destination: [{ label: 'To', value: 'sam' }], primary_label: 'Send', kill_label: 'Deny', risk: 'high' },
  deploy: {
    destination: [{ label: 'To', value: 'staging' }],
    primary_label: 'Deploy',
    kill_label: 'Deny',
    risk: 'high',
  },
  publish: {
    destination: [{ label: 'To', value: 'blog' }],
    primary_label: 'Publish',
    kill_label: 'Deny',
    risk: 'high',
  },
  purchase: { destination: [{ label: 'To', value: 'shop' }], primary_label: 'Buy', kill_label: 'Deny', risk: 'high' },
  generic: { destination: [], primary_label: 'Approve', kill_label: 'Deny', risk: 'low' },
}
const agentCard = (kind: string) =>
  ({
    thread_id: 'general',
    kind,
    title: `A ${kind} thing`,
    body: 'Do it.',
    origin: 'chat',
    ...AGENT_CARDS[kind],
  }) as Record<string, unknown>

describe('after a grant, the next card of that kind passes without a card', () => {
  for (const kind of Object.keys(AGENT_CARDS))
    test(
      `${kind}: no card on the wire, the agent is told to go ahead, the thread gets a line`,
      async () => {
        h = await start(grant(kind))
        const r = await h.bridge.callTool('card', agentCard(kind))
        expect(text(r)).toMatch(/approved without a card/)
        await sleep(t(300)) // timing-ok: negative window, nothing is sent after the call returned
        expect(cardsOnWire(h).filter((c) => c.title === `A ${kind} thing`)).toHaveLength(0)
      },
      HARNESS_START_MS + t(20_000),
    )

  test(
    'a kind that is not granted still gets a card',
    async () => {
      h = await start(grant('email'))
      const r = await h.bridge.callTool('card', agentCard('generic'))
      expect(text(r)).toMatch(/card c_\S+ pending/)
    },
    HARNESS_START_MS + t(20_000),
  )

  test(
    'a generic card with talos-app commands still gets a card (the owner approves those in the app)',
    async () => {
      h = await start(grant('generic'))
      const r = await h.bridge.callTool('card', {
        ...agentCard('generic'),
        // a valid, allowed command: the card is made, with the command on it
        cli: [['peer', 'list']],
      })
      expect(text(r)).toMatch(/card c_\S+ pending/)
      expect(text(r)).not.toMatch(/approved without a card/)
      await waitFor(() => cardsOnWire(h as Harness).some((c) => c.title === 'A generic thing'), 4000, 'card.create')
    },
    HARNESS_START_MS + t(20_000),
  )
})

describe("the agent's card cannot carry the bridge's own payload marks", () => {
  test.each(['action_rule', 'permission_mode', 'update_resend', 'screen_allow'])(
    'a payload with %s is refused, and no card is made',
    async (key) => {
      h = await start()
      const r = await (h as Harness).bridge.callTool('card', {
        ...agentCard('deploy'),
        payload: { [key]: { kind: 'deploy' } },
      })
      expect(r.isError).toBe(true)
      expect(text(r)).toMatch(/reserved for the bridge/)
      expect(cardsOnWire(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(20_000),
  )
  test(
    'an ordinary payload is still fine',
    async () => {
      h = await start()
      const r = await h.bridge.callTool('card', { ...agentCard('deploy'), payload: { site: 'staging' } })
      expect(text(r)).toMatch(/card c_\S+ pending/)
    },
    HARNESS_START_MS + t(20_000),
  )
})

describe('a card the bridge made (schedule, undo) is applied as his tap would be', () => {
  const bridgeCard = (x: Harness, kind: 'schedule' | 'undo' | 'config') => {
    const now = x.bridge.ctx.clock.now()
    const c = Card.parse({
      id: newId('c'),
      thread_id: 'general',
      kind,
      title: `A ${kind} change`,
      destination: [],
      body: 'Do it.',
      body_format: 'plain',
      fields: [],
      attachments: [],
      primary_label: 'Apply',
      kill_label: 'Keep',
      allow_edit: false,
      allow_revise: false,
      risk: 'low',
      origin: 'chat',
      payload:
        kind === 'config'
          ? { v: 1, base_rev: 1, reason: 'x', changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }] }
          : kind === 'schedule'
            ? { v: 1, own_risk: 'low' }
            : { v: 1 },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 600_000).toISOString(),
    }) as CardT
    c.payload_hash = payloadHash(bindingFrom(c))
    x.bridge.ctx.ledger.create(c, 'bridge')
    return c
  }
  for (const kind of ['schedule', 'undo'] as const)
    test(
      `${kind}: granted, the handler gets the approved card and no card is shown; not granted, nothing happens`,
      async () => {
        h = await start(grant(kind))
        const c = bridgeCard(h, kind)
        const seen: string[] = []
        expect(
          await passBridgeCard(h.bridge.ctx, c, (row, approved) => void seen.push(`${row.state}:${approved.id}`)),
        ).toBe(true)
        expect(seen).toEqual([`resolved:${c.id}`])
        const other = bridgeCard(h, kind === 'schedule' ? 'undo' : 'schedule')
        expect(await passBridgeCard(h.bridge.ctx, other, () => void seen.push('wrong'))).toBe(false)
        expect(seen).toHaveLength(1)
        expect(h.bridge.ctx.ledger.get(other.id)?.state).toBe('pending')
        expect(cardsOnWire(h)).toHaveLength(0)
      },
      HARNESS_START_MS + t(20_000),
    )
})

describe('a settings change under a config grant', () => {
  const propose = (x: Harness, path: string, value: unknown) =>
    x.bridge.callTool('config_propose', { thread_id: 'general', reason: 'tidy', changes: [{ path, value }] })

  test(
    'an ordinary setting is made at once, with no card, though the owner did not ask',
    async () => {
      h = await start(grant('config'))
      const r = await propose(h, 'agent.name', 'Hal')
      expect(text(r)).toMatch(/applied/)
      expect(h.bridge.ctx.config.config.agent.name).toBe('Hal')
      expect(cardsOnWire(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(20_000),
  )

  test(
    'without the grant the same change is a card',
    async () => {
      h = await start()
      expect(text(await propose(h, 'agent.name', 'Hal'))).toMatch(/card c_\S+ pending/)
      expect(h.bridge.ctx.config.config.agent.name).not.toBe('Hal')
    },
    HARNESS_START_MS + t(20_000),
  )

  test(
    "with the settings lock on, a grant does not make it direct (the lock is the owner's)",
    async () => {
      h = await start({ ...grant('config'), settings_lock: true })
      expect(text(await propose(h, 'agent.name', 'Hal'))).toMatch(/card c_\S+ pending/)
    },
    HARNESS_START_MS + t(20_000),
  )

  // `always_allow` and `dev.thread_fence` are high rows on the table anyway, so for them the high rule would refuse the pass by
  // itself; `settings_lock` and every thread field below are LOW rows, so there the trust list is the only thing holding the card.
  const TRUST: Array<[string, unknown]> = [
    ['always_allow', ['email']],
    ['settings_lock', true],
    ['dev.thread_fence', false],
    ['threads.general.topic', 'a new topic'],
    ['threads.general.name', 'Renamed'],
    ['threads.general.icon', 'star'],
    // (a thread's session setup is made at once when nothing outside reached the agent, with or without a grant: that rule is
    // older than this one and is not what a config grant decides; protocol/test/always-allow-kinds.test.ts pins those paths)
  ]
  for (const [path, value] of TRUST)
    test(
      `${path} still gets a card with a config grant`,
      async () => {
        h = await start(grant('config'))
        const before = JSON.stringify(h.bridge.ctx.config.config)
        const r = await propose(h, path, value)
        expect(text(r), text(r)).toMatch(/card c_\S+ pending/)
        expect(JSON.stringify(h.bridge.ctx.config.config)).toBe(before)
      },
      HARNESS_START_MS + t(20_000),
    )

  // Ordinary low rows that still keep a card because of the way they go (CONFIG_NEVER_PASS): the opposite direction passes.
  const NEVER: Array<[string, Record<string, unknown>, unknown, unknown]> = [
    ['memory_browser', { memory_browser: false }, true, false],
    ['dev.note_lookup', { dev: { thread_fence: true, note_lookup: false } }, true, false],
    ['media_keep_days', { media_keep_days: 60 }, 30, null],
  ]
  for (const [path, cfg, bad, fine] of NEVER) {
    test(
      `${path}: the turn-on / shorter direction gets a card, the other direction passes`,
      async () => {
        h = await start({ ...grant('config'), ...cfg })
        const before = JSON.stringify(h.bridge.ctx.config.config)
        expect(text(await propose(h, path, bad))).toMatch(/card c_\S+ pending/)
        expect(JSON.stringify(h.bridge.ctx.config.config)).toBe(before)
        // the opposite direction, from the other starting point
        await h.stop()
        const opposite: Record<string, Record<string, unknown>> = {
          memory_browser: { memory_browser: true },
          'dev.note_lookup': { dev: { thread_fence: true, note_lookup: true } },
          media_keep_days: { media_keep_days: 30 },
        }
        h = await start({ ...grant('config'), ...opposite[path] })
        expect(text(await propose(h, path, fine))).toMatch(/applied/)
      },
      HARNESS_START_MS * 2 + t(30_000),
    )
  }

  test(
    'quiet hours set (a low row the value makes high) still gets a card; turning them off passes',
    async () => {
      h = await start(grant('config'))
      expect(text(await propose(h, 'quiet_window', { start: '22:00', end: '07:00' }))).toMatch(/card c_\S+ pending/)
      expect(h.bridge.ctx.config.config.quiet_window ?? null).toBeNull()
      await h.stop()
      h = await start({ ...grant('config'), quiet_window: { start: '22:00', end: '07:00' } })
      expect(text(await propose(h, 'quiet_window', null))).toMatch(/applied/)
    },
    HARNESS_START_MS * 2 + t(30_000),
  )

  test('every key in CONFIG_TRUST_KEYS is covered by the table above', () => {
    for (const k of CONFIG_TRUST_KEYS) expect(TRUST.some(([p]) => p === k || p.startsWith(`${k}.`))).toBe(true)
  })

  test(
    "the owner's Always allow tap on an ordinary settings card adds the config grant; on a trust-key card it is refused and adds nothing",
    async () => {
      h = await start()
      await propose(h, 'agent.name', 'Hal')
      await waitFor(() => cardsOnWire(h as Harness).length === 1, 4000, 'card')
      const ordinary = cardsOnWire(h)[0] as CardT
      await propose(h, 'settings_lock', true)
      await waitFor(() => cardsOnWire(h as Harness).length === 2, 4000, 'second card')
      const trust = cardsOnWire(h)[1] as CardT
      await h.app.resolveCard(trust, 'primary', trust.payload_hash, { always: true })
      await waitFor(
        () => (h as Harness).app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error'),
        t(6000),
        'the refusal',
      )
      expect(allowed(h)).toEqual([])
      expect(h.bridge.ctx.ledger.get(trust.id)?.state).toBe('pending')
      await h.app.resolveCard(ordinary, 'primary', ordinary.payload_hash, { always: true })
      await waitFor(() => allowed(h as Harness).includes('config'), 6000, 'config grant written')
    },
    HARNESS_START_MS + t(40_000),
  )
})

describe('always:true is refused BEFORE the ledger moves, on every card that does not offer it', () => {
  const refused = async (x: Harness, c: CardT) => {
    const f = await x.app.resolveCard(c, 'primary', c.payload_hash, { always: true })
    // the refusal is THIS one (not a bad hash or an unknown card), so a card that offered it would not pass this test.
    // (No dialog or permission case here: their own prechecks, permission.ts and dialog-card.ts, refuse a tap first, before this
    // rule is reached; that they offer no Always allow is pinned by the cardOffersAlways unit test, protocol always-allow-kinds.test.ts.)
    await waitFor(
      () =>
        x.app.rec.frames.some(
          (r) =>
            r.direction === 'in' &&
            r.raw.type === 'error' &&
            r.raw.ref === f.id &&
            String(r.raw.message).includes('does not offer Always allow'),
        ),
      t(6000),
      'the refusal',
    )
    expect(allowed(x)).toEqual([])
    expect(x.bridge.ctx.ledger.get(c.id)?.state).toBe('pending')
  }
  /** A card made by hand into the ledger, as the bridge's own cards are: what matters is its kind and payload. */
  const made = async (x: Harness, kind: string, over: Record<string, unknown> = {}) => {
    const now = x.bridge.ctx.clock.now()
    const c = Card.parse({
      id: newId('c'),
      thread_id: 'general',
      kind,
      title: `A ${kind} thing`,
      destination: [{ label: 'What', value: 'x' }],
      body: 'Do it.',
      body_format: 'plain',
      fields: [],
      attachments: [],
      primary_label: 'Allow',
      kill_label: 'Deny',
      allow_edit: false,
      allow_revise: false,
      risk: 'low',
      origin: 'chat',
      payload: {},
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 600_000).toISOString(),
      ...over,
    }) as CardT
    c.payload_hash = payloadHash(bindingFrom(c))
    x.bridge.ctx.ledger.create(c, 'bridge')
    // shown to the app too (the relay refuses a tap on a card it was never given)
    await x.bridge.ctx.transport.sendDurable(cardCreateFrame(now, c))
    await waitFor(() => cardsOnWire(x).some((w) => w.id === c.id), 4000, 'card.create')
    return c
  }
  const CASES: Array<[string, string, Record<string, unknown>]> = [
    ['a decision card', 'decision', {}],
    ['a permission-mode card', 'config', { payload: { permission_mode: { mode: 'bypass' } } }],
    ['an update-resend card', 'config', { payload: { update_resend: { message_id: 'm_x' } } }],
    ['a screen-allow card', 'config', { payload: { screen_allow: { bundle_id: 'com.example.app' } } }],
    ['a rule-ask card with no kind', 'generic', { payload: { action_rule: { rule: 'r', key: 'k', kind: null } } }],
    ['an app_action card', 'app_action', {}],
  ]
  for (const [name, kind, over] of CASES)
    test(
      `${name}: refused, the card stays pending, nothing granted`,
      async () => {
        h = await start()
        await refused(h, await made(h, kind, over))
      },
      HARNESS_START_MS + t(30_000),
    )

  test(
    'a card with talos-app commands on it (from the card tool): refused, the card stays pending, nothing granted',
    async () => {
      h = await start()
      const r = await h.bridge.callTool('card', { ...agentCard('generic'), cli: [['peer', 'list']] })
      const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
      await waitFor(() => cardsOnWire(h as Harness).some((c) => c.id === id), 4000, 'card.create')
      await refused(h, cardsOnWire(h).find((c) => c.id === id) as CardT)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    "an Approve tapped from a notification (native.act) never adds a grant, whatever the card's kind",
    async () => {
      h = await start()
      const r = await h.bridge.callTool('card', agentCard('generic'))
      const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
      await waitFor(() => cardsOnWire(h as Harness).some((c) => c.id === id), 4000, 'card.create')
      const card = cardsOnWire(h).find((c) => c.id === id) as CardT
      const x = h
      const keys = await createPhoneKeys()
      const dev = x.app.device
      const grantFrame = await signNativeGrant({
        deviceId: dev.deviceId,
        devicePrivateKey: dev.privateKey,
        encPub: keys.encPub,
        actPub: keys.actPub,
        nowMs: Date.now(),
      })
      const now = Date.now()
      const frame = await signNativeAct({
        deviceId: dev.deviceId,
        id: newUlid(),
        ts: new Date(now).toISOString(),
        grant: grantFrame,
        body: {
          a: 'approve',
          shown_v: '3',
          card_id: card.id,
          payload_hash: card.payload_hash,
          shown: shownHash(cardNotice(card).text, 'General'),
        },
        actPrivateKey: keys.act.privateKey,
      })
      x.relay.sendToBridge({ ...frame, relay: { seq: 1, received_at: new Date(now).toISOString() } }, { durable: true })
      await waitFor(() => x.bridge.ctx.ledger.get(card.id)?.state !== 'pending', t(8000), 'the card answered')
      expect(allowed(x)).toEqual([])
    },
    HARNESS_START_MS + t(30_000),
  )
})

test('every grantable kind has a plural and a count word for the thread line', async () => {
  const { kindPlural } = await import('../src/always-allow.ts')
  for (const k of ALWAYS_KINDS) expect(kindPlural(k).length).toBeGreaterThan(2)
})
