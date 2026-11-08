// One refused setting, driven through every way into the bridge's settings: the agent's `config_propose` tool, the card the
// owner approves (apply time, on the bound payload), the owner's signed `config.patch` over the relay socket, and
// ConfigFile.applyPatch itself. Each refusal is read from the owner's side: the answer says so, the config on disk is
// untouched and nothing was minted. The relay's own refusal and the web fake's are in apps/relay/test/core/misc.test.ts and
// apps/web/test/fake-client-strict.test.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bindingFrom,
  Card,
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  configCardCandidate,
  payloadHash,
} from '@talos-app/protocol'
import { ConfigFile } from '../src/config-file.ts'
import { eventually, type Harness, pushCardResolvePastRelay, sleep, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const start = () => startHarness({ relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] } })
const onDisk = (x: Harness) => readFileSync(join(x.home, 'config.json'), 'utf8')
const minted = (x: Harness) =>
  x.relay.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'card.create' && (r.raw.card as CardT).kind === 'config',
  )

// The owner can change `agent.voice_persona` from Settings; the agent may not. `mirror` is no setting at all.
const OWNER_ONLY = 'agent.voice_persona'
const NOT_A_SETTING = 'mirror'

describe('a refused setting is refused at every entry point', () => {
  test('config_propose (propose time): the owner-only setting and the unknown one mint no card and name the refusal', async () => {
    h = await start()
    const before = onDisk(h)
    const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
    for (const path of [OWNER_ONLY, NOT_A_SETTING]) {
      const r = await h.bridge.callTool('config_propose', {
        thread_id: 'general',
        reason: 'you asked',
        changes: [{ path, value: 'x' }],
      })
      expect(r.isError, path).toBe(true)
      expect(text(r)).toContain(path)
      expect(text(r)).toMatch(/Allowed: agent\.name/)
    }
    expect(minted(h)).toHaveLength(0)
    expect(onDisk(h)).toBe(before)
  })

  test('the approved card (apply time): a bound payload naming the owner-only setting fails the card and writes nothing', async () => {
    h = await start()
    const base = configCardCandidate({
      cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V7',
      threadId: 'general',
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      origin: 'chat',
      baseRev: 0,
      reason: 'forged',
      changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }],
    })
    const payload = { v: 1, base_rev: 0, reason: 'forged', changes: [{ path: OWNER_ONLY, old: '', new: 'be rude' }] }
    const card = Card.parse({ ...base, payload })
    card.payload_hash = payloadHash(bindingFrom(card))
    h.bridge.ctx.ledger.create(card, 'bridge')
    const before = onDisk(h)
    await pushCardResolvePastRelay(h, card, card.payload_hash)
    await eventually(() => expect((h as Harness).bridge.ctx.ledger.get(card.id)?.state).toBe('failed'))
    expect(onDisk(h)).toBe(before)
  })

  test("the owner's signed config.patch over the socket: the relay turns the unknown field away, and the bridge turns away what the relay lets through", async () => {
    h = await start()
    const before = onDisk(h)
    // the relay checks the allowlist first: the app is told, the bridge never sees the frame
    const viaRelay = await h.app.sendConfigPatch(0, { agent: { name: 'Atlas' }, [NOT_A_SETTING]: { telegram: 'on' } })
    const e1 = await h.app.expectFrame('error', (f) => f.ref === viaRelay.id)
    expect(e1.code).toBe('config_field_forbidden')
    expect(e1.message).toBe(`field not allowed: ${NOT_A_SETTING}`)
    // a phone may turn the memory browser off, never on: the allowlist lets it by, the bridge's own rule refuses it
    const viaBridge = await h.app.sendConfigPatch(0, { memory_browser: true })
    const e2 = await h.relay.expectFrame('error', (f) => f.ref === viaBridge.id, { direction: 'from_bridge' })
    expect(e2.code).toBe('config_field_forbidden')
    expect(e2.message).toBe('the memory browser can only be turned on at your Mac (talos-app memory on)')
    await sleep(100)
    expect(onDisk(h)).toBe(before)
  })

  test('ConfigFile.applyPatch (the one apply path): refused with the same words, rev unchanged', async () => {
    h = await start()
    const file = new ConfigFile(join(h.home, 'config.json'))
    file.load()
    for (const patch of [{ [NOT_A_SETTING]: 1 }, { work: { surprise: 1 } }, { trust_mode: 'yes' }, { rev: 9 }]) {
      const r = file.applyPatch(0, patch)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('config_field_forbidden')
    }
    expect(file.config.rev).toBe(0)
  })
})
