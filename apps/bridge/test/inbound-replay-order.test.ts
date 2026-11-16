// A bridge that comes back gets the relay's replay in the order the frames were sent, whatever lane each one waits on:
// three owner messages and then an integration event reach the main session as one, two, three, event. (An owner
// message waits for its undo point on its session's lane; a frame for that session queued behind it must not pass it.)
import { afterEach, expect, test } from 'bun:test'
import { newId } from '@talos-app/protocol'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const hookEvent = (summary: string) => ({
  type: 'hook.event',
  delivery: 'live',
  event: {
    id: newId('e'),
    source: 'github',
    connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
    kind: 'github.review_requested',
    title: 'Review requested',
    summary,
    actor: { name: 'octocat' },
    ts: new Date().toISOString(),
    thread: 'inbox',
    work: false,
    priority: 'high',
    dedup_key: 'github:order',
  },
})

test('a replay of three messages and an event: delivered in the order they were sent', async () => {
  h = await startHarness({ startBridge: false })
  const now = new Date().toISOString()
  let seq = 1
  for (const t of ['one', 'two', 'three'])
    h.relay.sendToBridge({ ...(await h.app.buildMessage('general', t)), relay: { seq: seq++, received_at: now } })
  h.relay.sendToBridge({ ...hookEvent('while down'), relay: { seq: seq++, received_at: now } })
  h.bridge.start()
  await h.waitNotes(4, 8000)
  await h.bridge.inbound?.idle()
  const seen = h.notes.filter((n) => ['text', 'hook_event'].includes(n.meta.kind ?? ''))
  expect(seen.map((n) => (n.meta.kind === 'hook_event' ? 'event' : n.content.split('\n').at(-1)))).toEqual([
    'one',
    'two',
    'three',
    'event',
  ])
})
