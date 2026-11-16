// BUGHUNT (history): the relay answers a scroll-back itself, with `has_more: false`, whenever its own sweep has never
// deleted anything (`floor() === null`, src/core/hub-history.ts:109-112: "nothing was ever pruned: the buffer holds the
// whole history"). That is only true for a relay that is as old as the conversation. After the volume was lost, restored
// from an older copy or replaced (the catch-up code right below handles exactly that case, hub-history.ts:149-154), the
// Mac holds months of history the new buffer never saw, and for the first 7 days (until the first sweep deletes a row)
// every thread ends at the oldest row of the new buffer: "Show more" is told there is nothing older and the Mac is never
// asked, although it is online. PLAUSIBLE: needs a relay volume younger than the Mac's history.
// Suggested fix: with the Mac online, forward a request the buffer cannot fill to it (the Mac answers an empty page when
// it has nothing older); keep the local short cut only for `rows.length > limit`.
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a scroll-back the buffer cannot fill is passed to the Mac when the Mac is online', async () => {
  relay = await startTestRelay() // a brand-new volume; the Mac behind it has an older history
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const sent = await a.sendMessage('general', 'first message on the new relay')
  const ack = await a.expectFrame('ack', (f) => f.ref === sent.id)
  const req = await a.sendHistoryRequest('general', { before_seq: ack.seq }) // "Show more" above the oldest row held
  const page = await a.expectFrame('history.page', (f) => f.request_id === req.request_id).catch(() => null)
  await b.sync()
  // Either the Mac was asked, or the relay said plainly that it cannot know. Today: an empty page, has_more false, from
  // the relay alone, and the Mac never hears of the request.
  const macAsked = b.count('history.request', req.id) === 1
  const relaySaidComplete = page !== null && page.has_more === false && page.unavailable === undefined
  expect({ macAsked, relaySaidComplete }).toEqual({ macAsked: true, relaySaidComplete: false })
  await b.close()
})
