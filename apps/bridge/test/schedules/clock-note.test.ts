// A schedule card decision reaches the agent with the owner's local_time but not since_last (that is for the owner's own words).
import { afterEach, expect, test } from 'bun:test'
import type { CardT } from '@talos-app/protocol'
import { longTimeouts, type SchedHarness, startSched } from './harness.ts'

longTimeouts()
let h: SchedHarness | undefined
afterEach(async () => h?.stop())

test('KILL on an agent-proposed schedule card: local_time yes, since_last no', async () => {
  h = await startSched()
  await h.app.sendMessage('inbox', 'set up a nightly job please')
  await h.waitNotes(1)
  await h.advance(20 * 60_000)
  const res = await h.bridge.callTool('schedule_propose', {
    op: 'create',
    thread_id: 'inbox',
    reason: 'The owner asked.',
    name: 'Nightly',
    id: 'nightly-1',
    when: { type: 'weekdays', time: '22:00' },
    prompt: 'Do the thing.\n',
  })
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26}) pending/.exec(res.content[0]?.text ?? '')?.[1]
  const cc = await h.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
  const card = cc.card as CardT
  await h.app.resolveCard(card, 'kill', card.payload_hash)
  await h.waitNotes(2)
  const n = h.notes[1]
  expect(n?.meta.kind).toBe('card_action')
  expect(n?.meta.local_time).toBeDefined()
  expect(n?.meta.since_last).toBeUndefined()
})
