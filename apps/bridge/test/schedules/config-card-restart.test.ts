// A settings card (O1) approved just before a restart, with the scheduler RUNNING: the Schedules start-up sweep must leave
// it alone (its words are about schedules and the config may already be written); ConfigProposals.recover() answers it.
import { afterEach, expect, test } from 'bun:test'
import { type CardT, CONFIG_PROPOSE_FEATURE } from '@talos-app/protocol'
import { eventually, waitFor } from '../helpers.ts'
import { longTimeouts, restartBridge, type SchedHarness, startSched } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

async function approvedConfigCard(): Promise<string> {
  await h.app.sendMessage('general', 'rename yourself')
  await waitFor(
    () =>
      h.bridge.ctx.store
        .ownerRowsSince(new Date(h.clock.now() - 60_000).toISOString(), 50)
        .some((m) => m.text === 'rename yourself'),
    6000,
    'owner row',
  )
  const r = await h.bridge.callTool('config_propose', {
    thread_id: 'general',
    reason: 'you asked',
    changes: [{ path: 'agent.name', value: 'Hal' }],
  })
  expect(r.isError, r.content[0]?.text).toBeFalsy()
  const id = /card (c_\S+) pending/.exec(r.content[0]?.text ?? '')?.[1] as string
  const created = await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })
  const card = created.card as CardT
  const out = h.bridge.ctx.ledger.resolve(
    {
      card_id: id,
      action: 'primary',
      payload_hash: card.payload_hash as string,
      ts: new Date(h.clock.now()).toISOString(),
    },
    h.clock.now(),
  )
  expect(out.ok).toBe(true) // resolved, nothing written, nobody left to finish it
  return id
}

test('the Schedules start-up sweep never takes a settings card (it would say "Check it in Schedules")', async () => {
  h = await startSched({ relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] } })
  const id = await approvedConfigCard()
  await (h.bridge.ctx.schedules as unknown as { failStuckCards(): Promise<void> }).failStuckCards()
  expect(h.bridge.ctx.ledger.get(id)?.state).toBe('resolved')
})

test('with the scheduler on, an approved settings card cut off by a restart fails in settings words, not schedule words', async () => {
  h = await startSched({ relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] } })
  const id = await approvedConfigCard()
  h = await restartBridge(h)
  await eventually(() => expect(h.bridge.ctx.ledger.get(id)?.state).toBe('failed'), 10_000)
  const upd = await h.relay.expectFrame('card.update', (u) => u.card_id === id && u.state === 'failed', {
    direction: 'from_bridge',
  })
  expect(upd.result?.text).toMatch(/restarted before this was saved\. Nothing was changed/)
  expect(upd.result?.text).not.toMatch(/Schedules/)
})
