// Bug hunt 2026-11-10, relay #4 (the same bug as core #1, fixed on the client): a catch-up is paged (200 frames, then
// `more: true` and the app asks again), and the socket is in the live fan-out from `hello`, so a frame stored while a
// later page is still owed reaches the device ahead of the older frames. A client that counted that frame's seq at once
// said `hello{last_seq}` past the hole after a drop and never got the pages in between.
// The relay still sends the live frame early; the client holds its seq until the last page (the web client's
// `advanceSeq` / `holdSeq`, and the testkit's FakeApp, which follows the same rule). This test drives that rule against
// the real relay: the reconnect says the last page it finished, and paging from there brings every frame.
import { newId } from '@talos-app/protocol'
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const row = (n: number) => {
  const message = {
    id: newId('m'),
    thread_id: 'general',
    author: 'system',
    kind: 'text',
    text: `row ${n}`,
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date().toISOString(),
  }
  return mkFrame('message.stored', { client_msg_id: message.id, message })
}

it('a frame stored during a paged catch-up does not let a reconnect skip the pages not yet sent', async () => {
  relay = await startTestRelay()
  const hub = relay.runtime.hub
  const a = await kit(relay).connectedApp()
  await hub.toApps(row(0), { durable: true })
  await waitFor(() => a.lastSeq === 1, 10_000, 'first row')
  await a.close()

  for (let n = 1; n <= 450; n++) await hub.toApps(row(n), { durable: true }) // seq 2..451 while the phone is away
  const mark = a.rec.frames.length
  await a.connect() // hello{last_seq: 1} -> ready, catchup.batch 2..201 with more: true
  const first = await a.expectFrame('catchup.batch', () => true, { since: mark })
  expect(first.more).toBe(true)
  expect(first.to_seq).toBe(201)

  await hub.toApps(row(451), { durable: true }) // a reply lands before the app has asked for page two
  await a.expectFrame('message.stored', (f) => f.message.text === 'row 451', { since: mark })
  expect(a.lastSeq).toBe(201) // held: it is above pages this device does not have yet
  a.ws?.terminate() // ...and the connection drops there

  const got = new Set<number>()
  const again = a.rec.frames.length
  await a.connect() // hello{last_seq: 201}: the end of the last page it finished, not the live frame's 452
  let page = await a.expectFrame('catchup.batch', () => true, { since: again })
  expect(page.from_seq).toBe(202)
  for (let seen = a.rec.frames.length; page.more; seen = a.rec.frames.length) {
    a.send({ type: 'catchup.request', since_seq: page.to_seq })
    page = await a.expectFrame('catchup.batch', () => true, { since: seen })
  }
  for (const r of a.rec.frames) {
    const seq = (r.raw.relay as { seq?: number } | undefined)?.seq
    if (typeof seq === 'number') got.add(seq)
    if (r.raw.type === 'catchup.batch')
      for (const f of r.raw.frames as Array<{ relay: { seq: number } }>) got.add(f.relay.seq)
  }
  const missing = []
  for (let s = 1; s <= 452; s++) if (!got.has(s)) missing.push(s)
  expect(missing).toEqual([])
  expect(a.lastSeq).toBe(452)
})
