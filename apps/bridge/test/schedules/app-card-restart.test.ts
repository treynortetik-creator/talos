// An app card the bridge was running when it restarted fails in words that fit an app card, and a card someone else
// closed between the listing and the sweep's own close is left alone.
import { afterEach, expect, test } from 'bun:test'
import { sendAppCard } from '../../src/apps/cards.ts'
import { longTimeouts, type SchedHarness, startSched } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const sweep = () => (h.bridge.ctx.schedules as unknown as { failStuckCards(): Promise<void> }).failStuckCards()

async function approvedAppCard(): Promise<string> {
  const card = await sendAppCard(h.bridge.ctx, {
    threadId: 'general',
    title: 'Show Probe view result in this thread?',
    destination: [{ label: 'Server', value: 'probe' }],
    body: 'It will be stored on your relay.',
    warning: 'Asked for by an app.',
    primaryLabel: 'Show',
    killLabel: "Don't show",
    risk: 'low',
    payload: { kind: 'app_show', executor: 'bridge', thread_id: 'general', capture_id: 'toolu_1' },
  })
  const out = h.bridge.ctx.ledger.resolve(
    {
      card_id: card.id,
      action: 'primary',
      payload_hash: card.payload_hash as string,
      ts: new Date(h.clock.now()).toISOString(),
    },
    h.clock.now(),
  )
  expect(out.ok).toBe(true)
  return card.id
}

const failedUpdates = (id: string) =>
  h.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.frame.type === 'card.update' &&
      (r.raw as { card_id: string; state: string }).card_id === id &&
      (r.raw as { state: string }).state === 'failed',
  )

test('an app card cut off by a restart does not send the owner to Schedules', async () => {
  h = await startSched()
  const id = await approvedAppCard()
  await sweep()
  const upd = await h.relay.expectFrame('card.update', (u) => u.card_id === id && u.state === 'failed', {
    direction: 'from_bridge',
  })
  expect(upd.result?.text).not.toMatch(/Schedules/)
  expect(upd.result?.ran).toBe('unknown') // or the collapsed card offers a retry of a tool that may have run
  expect(h.bridge.ctx.ledger.get(id)?.state).toBe('failed')
})

test('a card closed by someone else before the sweep reaches it gets no second failure report', async () => {
  h = await startSched()
  const id = await approvedAppCard()
  h.bridge.ctx.ledger.finish(id, true)
  await sweep()
  expect(h.bridge.ctx.ledger.get(id)?.state).toBe('done')
  expect(failedUpdates(id)).toEqual([])
})
