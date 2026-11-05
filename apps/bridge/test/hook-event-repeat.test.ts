// The relay may send the same hook.event or hook.digest frame twice (a retry after the Mac's ack was dropped on the
// relay's side). The Mac must show it to the agent once and answer the repeat with an ack.
import { afterEach, describe, expect, test } from 'bun:test'
import { newId, newUlid } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const event = (title: string) => ({
  id: newId('e'),
  source: 'github',
  connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
  kind: 'github.review_requested',
  title,
  summary: title,
  actor: { name: 'octocat' },
  ts: new Date().toISOString(),
  thread: 'inbox',
  work: false,
  priority: 'high',
  dedup_key: 'github:test',
})
/** How many times the Mac has acked this frame as consumed (the repeat is acked too, so a second ack is its answer). */
const consumedAcks = (ref: string) =>
  h.relay.frames.filter(
    (f) => f.direction === 'from_bridge' && f.raw.type === 'ack' && f.raw.ref === ref && f.raw.stage === 'consumed',
  ).length
const at = (seq: number) => ({ relay: { seq, received_at: new Date().toISOString() } })

describe('a repeated relay frame', () => {
  test('a hook.event sent twice under one id reaches the agent once and is acked both times', async () => {
    h = await startHarness()
    const frame = { type: 'hook.event', id: newUlid(), delivery: 'live', event: event('Deploy finished') }
    h.relay.sendToBridge({ ...frame, ...at(1) })
    await h.waitNotes(1)
    await waitFor(() => consumedAcks(frame.id) === 1, 5000, 'the first ack')
    h.relay.sendToBridge({ ...frame, ...at(1) })
    await waitFor(() => consumedAcks(frame.id) === 2, 5000, 'the repeat acked as well')
    expect(h.notes.filter((n) => n.content.includes('Deploy finished'))).toHaveLength(1)
  })

  test('a hook.digest sent twice under one id reaches the agent once', async () => {
    h = await startHarness()
    const frame = {
      type: 'hook.digest',
      id: newUlid(),
      window: { start: new Date(Date.now() - 3600_000).toISOString(), end: new Date().toISOString() },
      threads: [{ thread_id: 'inbox', counts: { github: 1 } }],
      events: [event('Overnight review')],
    }
    h.relay.sendToBridge({ ...frame, ...at(1) })
    await h.waitNotes(1)
    await waitFor(() => consumedAcks(frame.id) === 1, 5000, 'the first ack')
    h.relay.sendToBridge({ ...frame, ...at(1) })
    await waitFor(() => consumedAcks(frame.id) === 2, 5000, 'the repeat acked as well')
    expect(h.notes.filter((n) => n.content.includes('Overnight review'))).toHaveLength(1)
  })
})
