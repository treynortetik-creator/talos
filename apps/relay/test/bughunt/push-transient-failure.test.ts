// BUGHUNT (push retry): a `needs_you` push (a card is waiting on the owner) is sent once, fire-and-forget
// (src/core/hub.ts:402-406, src/core/hub-bridge-frames.ts:262-270). When the push service refuses it for a passing reason
// (HTTP 429/500/503, a timeout, an APNs connection that had to be replaced: `{ok:false, gone:false}`,
// src/core/push.ts:59-62 and src/core/push-apns.ts:245-250,301-306) nothing tries again and nothing is recorded as owed.
// A card with at least 2 h to live gets its one reminder an hour before it dies; a shorter one (an app card lives 10
// minutes, a card made with `expires_in_s`) gets nothing at all, and the owner finds out when the agent gives up.
// `card_expiring` itself retries five times (src/core/card-reminder.ts:131-134); the first push does not.
import { buildCard, fakeClock, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, silentBridge, sub } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a needs-you push the service refused once (503) is tried again while the card is open', async () => {
  const c = fakeClock('2026-10-28T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const r = relay
  r.runtime.store.putSub(sub(1))
  const real = r.transport.send.bind(r.transport)
  let attempts = 0 // sends about THIS card only (the bridge closing below earns its own, unrelated health push)
  let cardId = ''
  r.transport.send = async (...args: Parameters<typeof real>) => {
    if (args[1].talos.card_id !== cardId) return real(...args)
    attempts++
    if (attempts === 1) return { ok: false, gone: false } // one 503 from the push service
    return real(...args)
  }
  const b = await silentBridge(r, r.bridgeKey)
  const at = (ms: number) => new Date(c.now() + ms).toISOString()
  const card = buildCard({ thread_id: 'general', created_at: at(0), expires_at: at(30 * 60_000) }) // 30 minutes to answer
  cardId = card.id
  b.send(mkFrame('card.create', { card }))
  await waitFor(() => attempts === 1, 10_000, 'the refused push')
  await b.close()
  await advance(c, 29 * 60_000, 30_000) // the whole life of the card
  await new Promise((res) => setTimeout(res, 200))
  expect(attempts).toBeGreaterThan(1) // today 1: the owner was never told about this card
})

it('a needs-you push refused every time is tried five times in all, then left', async () => {
  const c = fakeClock('2026-10-28T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const r = relay
  r.runtime.store.putSub(sub(1))
  const real = r.transport.send.bind(r.transport)
  const attempts = new Map<string, number>()
  r.transport.send = async (...args: Parameters<typeof real>) => {
    const id = args[1].talos.card_id
    if (!id) return real(...args)
    attempts.set(id, (attempts.get(id) ?? 0) + 1)
    return { ok: false, gone: false } // the push service refuses every card push
  }
  const b = await silentBridge(r, r.bridgeKey)
  const at = (ms: number) => new Date(c.now() + ms).toISOString()
  const card = buildCard({ thread_id: 'general', created_at: at(0), expires_at: at(60 * 60_000) })
  b.send(mkFrame('card.create', { card }))
  await waitFor(() => attempts.get(card.id) === 1, 10_000, 'the refused push')
  await advance(c, 50 * 60_000, 30_000)
  await new Promise((res) => setTimeout(res, 200))
  expect(attempts.get(card.id)).toBe(5)
  expect(r.runtime.store.getState(`needs_you_owed:${card.id}`)).toBeNull()
  await b.close()
})
