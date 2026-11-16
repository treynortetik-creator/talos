// Owner messages that arrive while the bridge process is down are delivered to the agent after it restarts: all of them,
// in order, each once, even when the relay replays ones that were already handled.
import { afterEach, describe, expect, test } from 'bun:test'
import { Bridge } from '../src/bridge.ts'
import { nullLogger } from '../src/log.ts'
import type { Notification } from '../src/notify.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness
let again: Bridge | undefined
afterEach(async () => {
  await again?.stop()
  again = undefined
  await h?.stop()
})

/** What the agent was told by the owner. The restart also says, once, that the first run may have left a message unanswered. */
const fromOwner = (notes: Notification[]) => notes.filter((n) => n.meta.kind === 'text')
const mentions = (notes: Notification[], text: string) =>
  fromOwner(notes).filter((n) => n.content.includes(text)).length

describe('owner messages while the bridge process is down', () => {
  test('all arrive after the restart, in order, once each, and a replay of handled ones adds nothing', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    await h.app.sendMessage('general', 'before-1')
    await h.waitNotes(1)
    await h.bridge.stop() // the process exits
    await waitFor(() => !h.relay.bridgeConnected, 4000, 'the relay to see the bridge go')

    for (let i = 2; i <= 6; i++) {
      const m = await h.app.sendMessage('general', `while-away-${i}`)
      await h.app.expectFrame('ack', (f) => f.ref === m.id)
    }

    again = await Bridge.create({
      env: h.bridge.ctx.env,
      logger: nullLogger,
      inbound: { settleMs: 20, maxSettleMs: 200 },
    })
    const notes: Notification[] = []
    again.setEmit(async (n) => {
      notes.push(n)
    })
    again.start()
    await waitFor(() => fromOwner(notes).length >= 5, 10_000, 'the five waiting messages')
    expect(fromOwner(notes).map((n) => /while-away-(\d)/.exec(n.content)?.[1])).toEqual(['2', '3', '4', '5', '6'])

    // the relay did not see the consume acks (a drop): it replays everything it still holds, then a new message follows
    for (const stored of h.relay.stored.filter((f) => f.type === 'message')) h.relay.sendToBridge(stored)
    await h.app.sendMessage('general', 'after-7')
    await waitFor(() => mentions(notes, 'after-7') === 1, 10_000, 'the message sent after the replay')
    for (let i = 2; i <= 6; i++) expect(mentions(notes, `while-away-${i}`)).toBe(1)
    expect(mentions(notes, 'before-1')).toBe(0) // handled by the first process: not delivered again
    expect(fromOwner(notes)).toHaveLength(6)
  }, 40_000)
})
