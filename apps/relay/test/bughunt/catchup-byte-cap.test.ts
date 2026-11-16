// Bug hunt R18: a catch-up batch was cut at 200 rows and nothing else, so 200 long replies (32,000 characters each) made
// one ~6 MB frame. The batch is now cut by bytes too, under the frame cap, and says `more` so the app asks for the rest.
import { MAX_FRAME_BYTES } from '@talos-app/protocol'
import { sleep } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a catch-up batch of long replies stays under the frame cap and says there is more', async () => {
  relay = await startTestRelay()
  const k = kit(relay)
  const bridge = await k.bridge().connect()
  const long = 'x'.repeat(30_000)
  bridge.reply('general', 'the one this device has')
  for (let i = 0; i < 20; i++) bridge.reply('general', `${i} ${long}`) // ~600 KB in all
  await bridge.expectFrame('ack', (f) => f.seq === 21, { direction: 'in' })
  await sleep(50)
  const a = k.app({ lastSeq: 1 })
  await a.connect()
  const batch = await a.expectFrame('catchup.batch')
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  expect(batch.frames.length).toBeGreaterThan(0)
  expect(batch.frames.length).toBeLessThan(20)
  expect(batch.more).toBe(true)
  const last = batch.frames[batch.frames.length - 1] as unknown as { relay: { seq: number } }
  expect(batch.to_seq).toBe(last.relay.seq)
})
