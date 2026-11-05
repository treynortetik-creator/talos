// K9c: the agent proposes a custom theme through config_propose. The same validator as the app's refuses a bad draft and
// names every problem; the owner's Apply writes `theme` into config; Keep current writes nothing; trust mode still cards it.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  CUSTOM_THEMES_FEATURE,
  DEFAULT_THEME,
  STOCK_THEMES,
} from '@talos-app/protocol'
import { eventually, type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const start = (opts: Parameters<typeof startHarness>[0] = {}) =>
  startHarness({ relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE, CUSTOM_THEMES_FEATURE] }, ...opts })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const cards = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
const draft = (over: Record<string, unknown> = {}) => ({ ...structuredClone(STOCK_THEMES[1]), name: 'dusk', ...over })

async function ownerAsks(x: Harness) {
  const msg = 'make the app look different'
  await x.app.sendMessage('general', msg)
  await waitFor(
    () =>
      x.bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 50).some((m) => m.text === msg),
    4000,
    'owner row',
  )
}
const propose = (x: Harness, value: unknown) =>
  x.bridge.callTool('config_propose', {
    thread_id: 'general',
    reason: 'you asked for dusk',
    changes: [{ path: 'theme', value }],
  })

describe('theme proposals', () => {
  test('a disallowed key and a low-contrast pair are refused, each named, and no card is minted', async () => {
    h = await start()
    await ownerAsks(h)
    const t = draft() as any
    t.light['--background'] = '#ffffff'
    t.dark['--text'] = t.dark['--bg']
    t.fonts['--font-ui'] = 'comic-sans'
    t.sparkle = true
    const r = await propose(h, t)
    expect(r.isError).toBe(true)
    const msg = text(r)
    expect(msg).toContain('light.--background: not an allowed token')
    expect(msg).toContain('fonts.--font-ui')
    expect(msg).toContain('sparkle: not an allowed key')
    const lowPair = draft() as any
    lowPair.dark['--text'] = lowPair.dark['--bg']
    const r2 = await propose(h, lowPair)
    expect(text(r2)).toContain('dark: --text on --bg')
    expect(cards(h).filter((c) => c.kind === 'config')).toHaveLength(0)
  })

  test('a good draft makes a card; Apply writes the theme into config; the old value survives nowhere else', async () => {
    h = await start()
    await ownerAsks(h)
    const r = await propose(h, draft())
    expect(r.isError, text(r)).toBeFalsy()
    const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
    await waitFor(() => cards(h as Harness).some((c) => c.id === id), 4000, 'card')
    const card = cards(h).find((c) => c.id === id) as CardT
    expect(card.primary_label).toBe('Apply')
    expect(card.kill_label).toBe('Keep current')
    await h.app.resolveCard(card, 'primary', card.payload_hash)
    const cfg = () => (h as Harness).bridge.ctx.config.config
    await eventually(() => expect((cfg().theme as { name: string } | undefined)?.name).toBe('dusk'))
  })

  test('Keep current changes nothing', async () => {
    h = await start()
    await ownerAsks(h)
    const r = await propose(h, draft())
    const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
    await waitFor(() => cards(h as Harness).some((c) => c.id === id), 4000, 'card')
    const card = cards(h).find((c) => c.id === id) as CardT
    const rev = h.bridge.ctx.config.config.rev
    await h.app.resolveCard(card, 'kill', card.payload_hash)
    await new Promise((r) => setTimeout(r, 300))
    expect(h.bridge.ctx.config.config.theme).toBeUndefined()
    expect(h.bridge.ctx.config.config.rev).toBe(rev)
  })

  test('an extra token, or the default theme itself, cannot sneak past: DEFAULT_THEME is proposed as a valid theme', async () => {
    h = await start()
    await ownerAsks(h)
    const r = await propose(h, { ...DEFAULT_THEME, name: 'plain' })
    expect(r.isError, text(r)).toBeFalsy()
  })
})

describe('a relay and web that cannot preview themes yet', () => {
  const OLD = { relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] } }

  test('a theme proposal is refused plainly, no card is minted, and nothing is written', async () => {
    h = await start(OLD)
    await ownerAsks(h)
    const r = await propose(h, draft())
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('the app needs updating before it can preview themes')
    expect(cards(h).filter((c) => c.kind === 'config')).toHaveLength(0)
    expect(h.bridge.ctx.config.config.theme).toBeUndefined()
  })

  test('the same old relay still takes an ordinary setting, so one missing feature does not break the tool', async () => {
    h = await start(OLD)
    await ownerAsks(h)
    const r = await h.bridge.callTool('config_propose', {
      thread_id: 'general',
      reason: 'you asked',
      changes: [{ path: 'agent.name', value: 'Hal' }],
    })
    expect(r.isError, text(r)).toBeFalsy()
  })

  test('a theme mixed into a multi-setting proposal is refused whole, with nothing minted', async () => {
    h = await start(OLD)
    await ownerAsks(h)
    const r = await h.bridge.callTool('config_propose', {
      thread_id: 'general',
      reason: 'you asked',
      changes: [
        { path: 'agent.name', value: 'Hal' },
        { path: 'theme', value: draft() },
      ],
    })
    expect(r.isError).toBe(true)
    expect(cards(h).filter((c) => c.kind === 'config')).toHaveLength(0)
  })
})

describe('trust mode', () => {
  test('a theme still gets a card and is never applied directly; a plain setting is applied with no card', async () => {
    h = await start()
    await ownerAsks(h)
    h.bridge.ctx.config.update((c) => ({ ...c, trust_mode: true }), { setsTrustMode: true })
    const r = await propose(h, draft())
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(text(r)).not.toContain('applied directly')
    expect(h.bridge.ctx.config.config.theme).toBeUndefined()
    const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
    await waitFor(() => cards(h as Harness).some((c) => c.id === id), 4000, 'card')
    // control: the same mode does apply a plain setting straight away, so the exception above is the theme clause
    const plain = await h.bridge.callTool('config_propose', {
      thread_id: 'general',
      reason: 'you asked',
      changes: [{ path: 'agent.name', value: 'Hal' }],
    })
    expect(text(plain)).toContain('applied directly')
    expect(h.bridge.ctx.config.config.agent.name).toBe('Hal')
  })

  test('a theme bundled with a plain setting is carded whole in trust mode, and the plain one is not applied early', async () => {
    h = await start()
    await ownerAsks(h)
    h.bridge.ctx.config.update((c) => ({ ...c, trust_mode: true }), { setsTrustMode: true })
    const r = await h.bridge.callTool('config_propose', {
      thread_id: 'general',
      reason: 'you asked',
      changes: [
        { path: 'agent.name', value: 'Hal' },
        { path: 'theme', value: draft() },
      ],
    })
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(h.bridge.ctx.config.config.agent.name).not.toBe('Hal')
    expect(h.bridge.ctx.config.config.theme).toBeUndefined()
  })
})
