// "Extra lock on protected files" (config.os_sandbox) is an ordinary setting the agent changes when the owner asks, the same as the
// other guard switches: "Lock Talos settings" off, asked, quiet: made at once; with the lock on, a card. Real bridge + FakeRelay.
import { afterEach, describe, expect, test } from 'bun:test'
import { CONFIG_PROPOSE_FEATURE } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const start = (extra: Record<string, unknown> = {}) =>
  startHarness({
    relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] },
    config: (c) => ({ ...c, ...extra }) as typeof c,
  })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const cfg = (x: Harness) => x.bridge.ctx.config.config
const configCards = (x: Harness) =>
  x.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.raw.type === 'card.create' &&
      (r.raw.card as { kind: string }).kind === 'config',
  )
const propose = (x: Harness, value: boolean) =>
  x.bridge.callTool('config_propose', {
    thread_id: 'general',
    reason: 'you asked',
    changes: [{ path: 'os_sandbox', value }],
  })
async function ownerSays(x: Harness, msg: string) {
  await x.app.sendMessage('general', msg)
  await waitFor(
    () =>
      x.bridge.ctx.store
        .ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 50)
        .some((m) => m.thread_id === 'general' && m.text === msg),
    4000,
    'owner row',
  )
}

describe('an agent turning the extra lock on protected files on', () => {
  test(
    'lock off (the default), the owner asked: applied at once, no card; off by default before',
    async () => {
      h = await start()
      expect(cfg(h).os_sandbox).toBeUndefined()
      await ownerSays(h, 'turn on the extra lock on protected files')
      const r = await propose(h, true)
      expect(r.isError, text(r)).toBeFalsy()
      expect(text(r)).toContain('applied')
      expect(cfg(h).os_sandbox).toBe(true)
      expect(configCards(h)).toHaveLength(0)
    },
    t(30_000),
  )

  test(
    'lock on: a card, nothing applied',
    async () => {
      h = await start({ settings_lock: true })
      await ownerSays(h, 'turn on the extra lock on protected files')
      const r = await propose(h, true)
      expect(text(r)).toMatch(/card c_\S+ pending/)
      expect(cfg(h).os_sandbox).toBeUndefined()
      await waitFor(() => configCards(h as Harness).length === 1, 4000, 'the card')
    },
    t(30_000),
  )

  test(
    'lock off but the owner has not asked: a card (the ordinary rule for a settings change)',
    async () => {
      h = await start()
      const r = await propose(h, true)
      expect(text(r)).toMatch(/card c_\S+ pending/)
      expect(cfg(h).os_sandbox).toBeUndefined()
    },
    t(30_000),
  )

  test(
    'turned off again the same way',
    async () => {
      h = await start({ os_sandbox: true })
      await ownerSays(h, 'turn the extra lock off')
      const r = await propose(h, false)
      expect(text(r)).toContain('applied')
      expect(cfg(h).os_sandbox).toBe(false)
    },
    t(30_000),
  )
})
