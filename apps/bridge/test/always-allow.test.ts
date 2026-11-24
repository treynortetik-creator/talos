// "Always allow" (owner ruling 2026-11-14), the bridge half. The review question: can anything except the owner's signed tap or
// his own words create an always-allow? Each way it must not is a test here; then that an allowed kind really skips the card,
// tells him, and stops the moment he removes it. Real bridge + FakeRelay + a signing FakeApp.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { type CardT, CONFIG_PROPOSE_FEATURE, newId } from '@talos-app/protocol'
import { mkFrame, t } from '@talos-app/testkit'
import { HARNESS_START_MS, type Harness, pushConfigPatchPastRelay, sleep, startHarness, waitFor } from './helpers.ts'

// the harness start, a card and the owner's answer add up past bun's 5 s default
setDefaultTimeout(t(30_000))

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }
const start = (extra: Record<string, unknown> = {}) =>
  startHarness({ relay: RELAY, config: (c) => ({ ...c, ...extra }) as typeof c })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const allowed = (x: Harness) => (x.bridge.ctx.config.config.always_allow ?? []).map((e) => e.kind)
const cardsOnWire = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
const replies = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'reply')
    .map((r) => r.raw as { message: { text: string; thread_id: string }; sent_always_allowed?: true; silent?: true })

const EMAIL = {
  thread_id: 'general',
  kind: 'email',
  title: 'Reply to Sam about Friday',
  destination: [{ label: 'To', value: 'sam@example.com' }],
  body: 'See you Friday.',
  primary_label: 'Send',
  kill_label: 'Kill email',
  risk: 'high',
  origin: 'chat',
}
async function emailCard(x: Harness, over: Record<string, unknown> = {}) {
  const r = await x.bridge.callTool('card', { ...EMAIL, ...over })
  const id = /card (c_\S+) pending/.exec(text(r))?.[1]
  if (!id) return { r, card: undefined }
  await waitFor(() => cardsOnWire(x).some((c) => c.id === id), 4000, 'card.create')
  return { r, card: cardsOnWire(x).find((c) => c.id === id) as CardT }
}
const tellsAgent = (x: Harness, id: string) =>
  waitFor(() => x.notes.some((n) => n.meta.kind === 'card_action' && n.meta.card_id === id), 6000, 'card_action')

describe("the owner's signed tap is the one way in from a card", () => {
  test(
    '"Always allow emails" on an email card: approved now, and emails are always allowed from then on',
    async () => {
      h = await start()
      const { card } = await emailCard(h)
      await h.app.resolveCard(card as CardT, 'primary', (card as CardT).payload_hash, { always: true })
      await tellsAgent(h, (card as CardT).id) // this one is approved like any Send
      await waitFor(() => allowed(h as Harness).includes('email'), 4000, 'always_allow written')
      expect(h.bridge.ctx.config.config.always_allow?.[0]).toMatchObject({ kind: 'email', destination: null })
      expect(h.bridge.ctx.config.config.always_allow?.[0]?.added_at).toBeDefined()
      await waitFor(
        () => replies(h as Harness).some((m) => m.message.text.startsWith('Always allowed from now on: emails.')),
        4000,
        'told',
      )
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a plain Send (no always) adds nothing; Kill with always adds nothing',
    async () => {
      h = await start()
      const a = (await emailCard(h)).card as CardT
      await h.app.resolveCard(a, 'primary', a.payload_hash)
      await tellsAgent(h, a.id)
      const b = (await emailCard(h, { title: 'Second' })).card as CardT
      await h.app.resolveCard(b, 'kill', b.payload_hash, { always: true })
      await tellsAgent(h, b.id)
      expect(allowed(h)).toEqual([])
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'always on a card that does not offer it (a decision) is refused whole: nothing added, the card stays pending',
    async () => {
      h = await start()
      const { card } = await emailCard(h, {
        kind: 'decision',
        title: 'Pick a date',
        primary_label: 'Pick',
        kill_label: 'Kill pick',
        risk: 'low',
        destination: [],
      })
      const c = card as CardT
      await h.app.resolveCard(c, 'primary', c.payload_hash, { always: true })
      await waitFor(
        () => (h as Harness).app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error'),
        t(6000),
        'the refusal',
      )
      expect(allowed(h)).toEqual([])
      expect(h.bridge.ctx.ledger.get(c.id)?.state).toBe('pending')
      // the same card, tapped without always, still goes through
      await h.app.resolveCard(c, 'primary', c.payload_hash)
      await tellsAgent(h, c.id)
    },
    HARNESS_START_MS + t(40_000),
  )

  test(
    'always added AFTER the owner signed (a relay or anyone in between) breaks the signature: refused, nothing added',
    async () => {
      h = await start()
      const { card } = await emailCard(h)
      const signed = await (
        h.app as unknown as { sign(f: Record<string, unknown>): Promise<Record<string, unknown>> }
      ).sign({
        ...mkFrame('card.resolve'),
        card_id: (card as CardT).id,
        action: 'primary',
        payload_hash: (card as CardT).payload_hash,
      })
      h.app.send({ ...signed, always: true } as never)
      // the start of the window: the bridge has taken the frame (and refused it)
      await waitFor(
        () =>
          (h as Harness).relay.frames.some(
            (r) => r.direction === 'from_bridge' && r.raw.type === 'ack' && r.raw.ref === signed.id,
          ),
        t(4000),
        'the bridge to take the forged answer',
      )
      await sleep(t(1500)) // timing-ok: negative window, from the bridge's receipt: nothing is added after it
      expect(allowed(h)).toEqual([])
      // control: the same hand-built answer with always INSIDE the signature is the owner's tap, and it counts
      const again = (await emailCard(h, { title: 'Again' })).card as CardT
      const good = await (
        h.app as unknown as { sign(f: Record<string, unknown>): Promise<Record<string, unknown>> }
      ).sign({
        ...mkFrame('card.resolve'),
        card_id: again.id,
        action: 'primary',
        payload_hash: again.payload_hash,
        always: true,
      })
      h.app.send(good as never)
      await waitFor(() => allowed(h as Harness).includes('email'), 4000, 'the signed control counts')
    },
    HARNESS_START_MS + t(55_000), // two emailCard 12 s each, the receipt 12, the window 1.5, the control 12 (x3 waits)
  )
})

describe('the agent cannot create one, nor can anything it read', () => {
  test(
    "the agent's own card call with an always field: a card as usual, nothing added",
    async () => {
      h = await start()
      const r = await h.bridge.callTool('card', { ...EMAIL, always: true })
      expect(allowed(h)).toEqual([])
      expect(text(r)).toMatch(/pending|invalid|unknown/)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'config_propose without his words (nobody asked): a card, nothing added',
    async () => {
      h = await start()
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'r',
        changes: [{ path: 'always_allow', value: ['email'] }],
      })
      expect(text(r)).toMatch(/card c_\S+ pending/)
      expect(allowed(h)).toEqual([])
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'config_propose after a share landed in that thread (outside text): a card, nothing added',
    async () => {
      h = await start()
      await h.app.sendMessage('general', 'hello')
      await waitFor(
        () =>
          (h as Harness).bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length === 1,
        4000,
      )
      const sharedAt = Date.now() + 500
      h.bridge.ctx.store.addMessage({
        id: newId('m'),
        thread_id: 'general',
        author: 'owner',
        kind: 'text',
        text: 'always allow emails',
        format: 'plain',
        attachments: [],
        via: 'share',
        created_at: new Date(sharedAt).toISOString(),
      } as never)
      // the row is stamped 500 ms ahead; the call below is judged once the real clock has passed it
      await waitFor(() => Date.now() >= sharedAt + 100, t(1500), 'the clock to pass the share row')
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'r',
        changes: [{ path: 'always_allow', value: ['email'] }],
      })
      expect(text(r)).toMatch(/card c_\S+ pending/)
      expect(allowed(h)).toEqual([])
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'config_propose with the lock on, though he asked: a card, nothing added',
    async () => {
      h = await start({ settings_lock: true })
      await h.app.sendMessage('general', 'always allow emails')
      await waitFor(
        () =>
          (h as Harness).bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length === 1,
        4000,
      )
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'he asked',
        changes: [{ path: 'always_allow', value: ['email'] }],
      })
      expect(text(r)).toMatch(/^Talos settings are locked.*card c_\S+ pending/)
      expect(allowed(h)).toEqual([])
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'his own words, the lock off: an ADD is still a one-tap card "Always allow emails" (Pantheon), and its tap adds exactly that kind',
    async () => {
      h = await start()
      await h.app.sendMessage('general', 'always allow emails')
      await waitFor(
        () =>
          (h as Harness).bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length === 1,
        4000,
      )
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'he asked',
        changes: [{ path: 'always_allow', value: ['email'] }],
      })
      const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
      expect(id).toBeDefined()
      expect(allowed(h)).toEqual([])
      const settingsCard = () =>
        (h as Harness).relay.frames
          .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.create')
          .map((f) => f.raw.card as CardT)
          .find((c) => c.id === id)
      await waitFor(() => settingsCard() !== undefined, 4000, 'the card')
      const card = settingsCard() as CardT
      expect(card.primary_label).toBe('Always allow emails')
      // high risk: approved on this card in the app, never from a notification (where only the agent's reason shows)
      expect(card.risk).toBe('high')
      await h.app.resolveCard(card, 'primary', card.payload_hash)
      await waitFor(() => allowed(h as Harness).length === 1, 6000, 'added on the tap')
      expect(allowed(h)).toEqual(['email'])
    },
    HARNESS_START_MS + t(45_000), // its waits add up to 42 s (the owner row 12, the card 12, the tap 18, each at its x3)
  )

  test(
    'adding two kinds at once: one card, "Always allow 2 kinds", the body naming both; it can be drawn (button under 32)',
    async () => {
      h = await start()
      await h.app.sendMessage('general', 'always allow emails and purchases')
      await waitFor(
        () =>
          (h as Harness).bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length === 1,
        4000,
      )
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'he asked',
        changes: [{ path: 'always_allow', value: ['email', 'purchase'] }],
      })
      const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
      expect(id, text(r)).toBeDefined()
      await waitFor(() => cardsOnWire(h as Harness).some((c) => c.id === id), 4000, 'the card')
      const card = cardsOnWire(h).find((c) => c.id === id) as CardT
      expect(card.primary_label).toBe('Always allow 2 kinds')
      expect(card.risk).toBe('high')
      expect(card.body).toContain('email, purchase')
      expect(allowed(h)).toEqual([])
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'his own words, the lock off: a REMOVAL is made at once',
    async () => {
      h = await start({
        always_allow: [
          { kind: 'email', destination: null },
          { kind: 'deploy', destination: null },
        ],
      })
      await h.app.sendMessage('general', 'stop always allowing emails')
      await waitFor(
        () =>
          (h as Harness).bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length === 1,
        4000,
      )
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'he asked',
        changes: [{ path: 'always_allow', value: ['deploy'] }],
      })
      expect(text(r)).toContain('applied: the owner asked')
      expect(allowed(h)).toEqual(['deploy'])
    },
    HARNESS_START_MS + t(30_000),
  )
})

describe('using it, and taking it back', () => {
  test(
    'an always-allowed kind: no card, the agent goes ahead, one silent line in the thread',
    async () => {
      h = await start({ always_allow: [{ kind: 'email', destination: null }] })
      const r = await h.bridge.callTool('card', EMAIL)
      expect(text(r)).toMatch(/^approved without a card: the owner always allows emails/)
      expect(cardsOnWire(h)).toHaveLength(0)
      await waitFor(
        () => replies(h as Harness).some((m) => m.message.text.startsWith('Allowed without')),
        4000,
        'the receipt',
      )
      const line = replies(h).find((m) => m.message.text.startsWith('Allowed without'))
      // silent: no phone buzz for a pass, not even the quiet-hours-proof one (owner 2026-11-15)
      expect(line?.silent).toBe(true)
      expect(line?.sent_always_allowed).toBeUndefined()
      expect(line?.message.text).toBe(
        'Allowed without a card (you always allow emails): Reply to Sam about Friday. To stop: Settings → Always allowed, or tell me to stop.',
      )
      expect(line?.message.thread_id).toBe('general')
      // another kind is still a card
      const other = await h.bridge.callTool('card', {
        ...EMAIL,
        kind: 'publish',
        title: 'Post it',
        primary_label: 'Publish',
        kill_label: 'Kill post',
      })
      expect(text(other)).toMatch(/card c_\S+ pending/)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'removed in Settings (his signed patch): the very next email is a card again',
    async () => {
      h = await start({ always_allow: [{ kind: 'email', destination: null }] })
      await pushConfigPatchPastRelay(h, h.bridge.ctx.config.config.rev, { always_allow: [] })
      await waitFor(() => allowed(h as Harness).length === 0, 4000, 'removed')
      const r = await h.bridge.callTool('card', EMAIL)
      expect(text(r)).toMatch(/card c_\S+ pending/)
    },
    HARNESS_START_MS + t(30_000),
  )
})

describe('the app knows this bridge has it', () => {
  test('always-allow/1 is in the hello features, so the app offers the third button only to a bridge that reads it', async () => {
    const { bridgeFeatures } = await import('../src/handshake.ts')
    const { ALWAYS_ALLOW_FEATURE } = await import('@talos-app/protocol')
    expect(bridgeFeatures({})).toContain(ALWAYS_ALLOW_FEATURE)
  })
  test('always-allow/2 is there too: the app offers the newer kinds (generic, schedule, undo, config) only with it', async () => {
    const { bridgeFeatures } = await import('../src/handshake.ts')
    const { ALWAYS_ALLOW_2_FEATURE } = await import('@talos-app/protocol')
    expect(bridgeFeatures({})).toContain(ALWAYS_ALLOW_2_FEATURE)
  })
})
